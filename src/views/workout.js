import { aiAvailable } from '../aiAccess.js';
import { beep, buzz, primeAudio } from '../audio.js';
import { fmtNumber, plural, t } from '../i18n.js';
import { icon } from '../icons.js';
import { alternativesFor, exerciseName } from '../library.js';
import { BARS, PLATES, defaultBar, isBarbell, platesPerSide } from '../plates.js';
import { planExerciseFromLibrary, supersetLetters, supersetPosition } from '../plans.js';
import { navigate, render } from '../render.js';
import {
  SET_TYPES,
  describeSet,
  fmtDuration,
  missingField,
  parseDuration,
  setScore,
  setSetType,
} from '../sets.js';
import { state } from '../state.js';
import { clearActive, getActive, getSettings, saveActive, saveRestUntil, saveSettings } from '../storage.js';
import { actionSheet, confirmDialog, sheet, toast, undoToast } from '../ui.js';
import { fmtWeight, fromDisplay, toDisplay, unit } from '../units.js';
import { esc, isWorkSet, number } from '../util.js';
import {
  activeSession,
  addSessionExercise,
  carryFromSet,
  currentSpot,
  entryComplete,
  entryTrackType,
  finishCounts,
  finishSession,
  isRecord,
  logSet,
  moveSessionExercise,
  mutateSession,
  newSet,
  nextOpenSet,
  previousWork,
  removeSessionExercise,
  replaceSessionExercise,
  repsAtPercent,
  repsStart,
  resetWorkoutUi,
  restoreSessionExercise,
  sessionExercises,
  sessionStarted,
  setReference,
  suggestion,
  toggleSet,
  touchSession,
  usedEquipment,
  warmupSets,
  workSets,
} from '../workout.js';
import { openAi } from './ai.js';
import { openDictation } from './dictate.js';
import { openExerciseSheet } from './exercise.js';
import * as home from './home.js';
import { openPicker } from './picker.js';
import { placeholderFor, setHead, setRow } from './setRow.js';

// Time since the first logged value, once there is one.
const clockText = (session) =>
  sessionStarted(session)
    ? ` · ${fmtDuration((Date.now() - new Date(session.startedAt).getTime()) / 1000)}`
    : '';

const SUGGESTION_TEXT = {
  progress: 'workout.suggest',
  stall: 'workout.suggestStall',
  comeback: 'workout.suggestComeback',
  reduce: 'workout.suggestReduce',
  plateau: 'workout.suggestPlateau',
  confirm: 'workout.suggestConfirm',
};
const suggestionText = (s) =>
  t(SUGGESTION_TEXT[s.kind] || SUGGESTION_TEXT.confirm, { weight: fmtWeight(s.weight), weeks: s.weeks });

// The suggested weight with a button to take it over; once the open sets already hold it, only the text stays.
function suggestionRow(suggest, entry, index) {
  const open = entry.sets.filter((s) => isWorkSet(s) && !s.done);
  const applied = open.length > 0 && open.every((s) => number(s.weight) === suggest.weight);
  const text = `${icon('trend')}<span>${esc(suggestionText(suggest))}</span>`;
  return applied
    ? `<p class="suggest-row">${text}</p>`
    : `<button type="button" class="suggest-row" data-apply-suggestion="${index}" data-weight="${suggest.weight}">${text}<small>${t('workout.apply')}</small></button>`;
}

function exerciseSection(ex, index, entry, exercises, letters, showRir) {
  const complete = entryComplete(entry);
  const suggest = suggestion(ex);
  const prevSets = previousWork(ex);
  const name = exerciseName(ex);
  const trackType = entryTrackType(entry);
  const position = supersetPosition(exercises, index);
  const superset = ex.supersetId
    ? ` · <span class="superset-tag">${esc(t('workout.superset', { letter: letters[ex.supersetId] }))}</span>`
    : '';
  // An empty field shows in grey what a tick would take over: the last session's value, or the set before.
  const rows = entry.sets
    .map((set, i) =>
      setRow({
        set,
        index: i,
        exerciseIndex: index,
        trackType,
        workNumber: entry.sets.slice(0, i).filter(isWorkSet).length + 1,
        last: setReference(entry, i, prevSets),
        repsHint: repsStart(ex, prevSets),
        showRir,
      })
    )
    .join('');
  // The picture leads the head; without one, a quiet tile stands in. Both open the exercise sheet.
  const tile = `<button type="button" class="exercise-thumb ${ex.gif ? '' : 'placeholder'}" data-technique="${index}" aria-label="${t('workout.technique')}">${
    ex.gif
      ? `<img class="exercise-gif" src="${esc(ex.gif)}" alt="" loading="lazy" decoding="async">`
      : icon('dumbbell')
  }</button>`;
  const work = workSets(entry);
  const done = work.filter((s) => s.done).length;
  return `<section class="workout-exercise ${complete ? 'complete' : ''} ${position === 'single' ? '' : `superset-${position}`}" id="exercise-${index}">
      <div class="workout-exercise-head">${tile}<div><h2><button type="button" class="exercise-title" data-exercise-history="${index}" aria-label="${esc(t('workout.historyOf', { name }))}">${esc(name)}${icon('chevron-right')}</button></h2><p>${work.length} × ${esc(ex.range)}${ex.note && !ex.gif ? ` · ${esc(ex.note)}` : ''}${superset}</p></div><span class="exercise-count ${complete ? 'complete' : ''}">${complete ? icon('check') : `${done}/${work.length}`}</span></div>
      ${suggest.weight ? suggestionRow(suggest, entry, index) : ''}
      <div class="set-table ${showRir ? '' : 'no-rir'}">${setHead(trackType, showRir)}<div class="set-list">${rows}</div></div>
      <div class="exercise-tools"><button class="text-btn" data-add-set="${index}">${t('workout.addSet')}</button><button class="icon-btn quiet exercise-mic" data-dictate="${index}" aria-label="${esc(t('dictate.open', { name }))}">${icon('mic')}</button><button class="icon-btn quiet" data-exercise-menu="${index}" aria-label="${esc(t('exercise.more', { name }))}">${icon('more')}</button></div>
      ${entry.note || state.openNotes?.has(entry.exerciseId) ? `<label class="exercise-note"><span>${t('workout.note')}</span><textarea data-exercise-note="${index}" placeholder="${t('workout.notePlaceholder')}">${esc(entry.note || '')}</textarea></label>` : ''}
    </section>`;
}

export function view() {
  const session = activeSession(state.planId, state.dayId);
  const exercises = session ? sessionExercises(session) : [];
  if (!session || (!exercises.length && !session.detached)) {
    state.view = 'home';
    return home.view();
  }
  const showRir = !!getSettings().showRir;
  const work = session.entries.flatMap(workSets);
  const completed = work.filter((s) => s.done).length;
  const total = work.length;
  const letters = supersetLetters(exercises);
  const list = exercises
    .map((ex, index) => exerciseSection(ex, index, session.entries[index], exercises, letters, showRir))
    .join('');
  return `<main class="workout-shell" id="swipeArea"><div class="workout-top"><button class="back" id="exitWorkout" aria-label="${t('workout.exit')}">${icon('chevron-left')}</button><div><h1>${esc(session.dayName)}</h1><b>${t('workout.progress', { done: completed, total })}<span id="workoutClock">${clockText(session)}</span></b></div><div class="workout-top-actions"><button class="text-btn" id="finishWorkout">${t('workout.finish')}</button></div><div class="progress-line" role="progressbar" aria-label="${t('workout.progressAria', { done: completed, total })}" aria-valuenow="${completed}" aria-valuemax="${Math.max(1, total)}"><i style="width:${total ? (completed / total) * 100 : 0}%"></i></div></div>
    <div class="workout-exercise-list">${list || `<div class="empty"><strong>${t('workout.emptyTitle')}</strong><p>${t('workout.emptyText')}</p></div>`}</div>
    <button type="button" class="choose-exercise" id="addSessionExercise">${icon('plus')}<b>${t('workout.addExercise')}</b></button>
    <details class="session-status" id="session-status" ${Object.values(session.markers).some(Boolean) ? 'open' : ''}><summary>${t('workout.status')}</summary><div class="marker-row"><label><input type="checkbox" data-marker="deload" ${session.markers.deload ? 'checked' : ''}> ${t('marker.deload')}</label><label><input type="checkbox" data-marker="ill" ${session.markers.ill ? 'checked' : ''}> ${t('marker.ill')}</label><label><input type="checkbox" data-marker="pain" ${session.markers.pain ? 'checked' : ''}> ${t('marker.pain')}</label></div></details>
    <div class="rest-timer ${state.restUntil > Date.now() ? 'show' : ''}" id="restTimer" role="timer" aria-live="off"><div><span>${t('rest.title')}</span><b id="restCount">0:00</b></div><button data-rest-add aria-label="${t('rest.addAria')}">+30</button><button data-rest-skip>${t('rest.skip')}</button></div>
  </main>`;
}

const mutate = (fn, rerender = false) => {
  mutateSession(state.planId, state.dayId, fn);
  if (rerender) render();
};
const current = () => activeSession(state.planId, state.dayId);
const exerciseAt = (index) => sessionExercises(current())[index];

function openPlates(ex, entry) {
  const u = unit();
  const start = toDisplay(number(entry.sets.find(isWorkSet)?.weight) || suggestion(ex).weight || 0) || '';
  const bar = toDisplay(getSettings().barWeight) || defaultBar();
  const box = document.createElement('div');
  box.className = 'plates';
  box.innerHTML = `<div class="plates-inputs"><label><span>${t('plates.weight', { unit: u })}</span><input type="number" inputmode="decimal" step="0.5" min="0" id="plateTarget" value="${esc(start)}"></label><label><span>${t('plates.bar', { unit: u })}</span><select id="plateBar">${BARS[u].map((b) => `<option value="${b}" ${b === bar ? 'selected' : ''}>${b}</option>`).join('')}${BARS[u].includes(bar) ? '' : `<option value="${bar}" selected>${bar}</option>`}</select></label></div><div class="plates-result" id="plateResult"></div><p class="muted">${t('plates.info', { plates: PLATES[u].join(', '), unit: u })}</p>`;
  const result = box.querySelector('#plateResult');
  const update = () => {
    const target = number(box.querySelector('#plateTarget').value);
    const barValue = number(box.querySelector('#plateBar').value);
    const { plates, remainder, perSide } = platesPerSide(target, barValue);
    result.textContent = '';
    if (!target) {
      result.textContent = t('plates.enterTarget');
      return;
    }
    if (target < barValue) {
      result.textContent = t('plates.belowBar');
      return;
    }
    const counts = new Map();
    plates.forEach((p) => counts.set(p, (counts.get(p) || 0) + 1));
    const row = document.createElement('div');
    row.className = 'plate-row';
    counts.forEach((count, plate) => {
      const chip = document.createElement('span');
      chip.className = 'plate';
      chip.textContent = `${count} × ${plate}`;
      row.append(chip);
    });
    if (!counts.size) {
      const none = document.createElement('span');
      none.className = 'muted';
      none.textContent = t('plates.barOnly');
      row.append(none);
    }
    const summary = document.createElement('b');
    summary.textContent = t('plates.perSide', { weight: fmtNumber(perSide), unit: u });
    result.append(summary, row);
    if (remainder) {
      const rest = document.createElement('small');
      rest.className = 'muted';
      rest.textContent = t('plates.remainder', { weight: fmtNumber(remainder), unit: u });
      result.append(rest);
    }
  };
  box.querySelector('#plateTarget').oninput = update;
  box.querySelector('#plateBar').onchange = update;
  update();
  sheet({ title: t('plates.title'), content: box });
  setTimeout(() => box.querySelector('#plateTarget').focus({ preventScroll: true }), 50);
}

// Estimated one-rep max from a set, with the loads a share of it allows.
function openOneRm(entry) {
  const u = unit();
  const first = entry.sets.find(isWorkSet) || {};
  const box = document.createElement('div');
  box.className = 'onerm';
  box.innerHTML = `<div class="plates-inputs"><label><span>${t('onerm.weight', { unit: u })}</span><input type="number" inputmode="decimal" step="0.5" min="0" id="oneRmWeight" value="${esc(fieldDisplayWeight(first.weight))}"></label><label><span>${t('onerm.reps')}</span><input type="number" inputmode="numeric" min="1" max="30" id="oneRmReps" value="${esc(first.reps || '')}"></label></div><div class="plates-result"><b id="oneRmResult"></b><small class="muted">${t('onerm.estimate')}</small></div><div class="onerm-table" id="oneRmTable"></div>`;
  const update = () => {
    const weight = number(box.querySelector('#oneRmWeight').value);
    const reps = number(box.querySelector('#oneRmReps').value);
    const max = weight && reps ? weight * (1 + reps / 30) : 0;
    box.querySelector('#oneRmResult').textContent = max ? `${fmtNumber(Math.round(max))} ${u}` : '–';
    box.querySelector('#oneRmTable').innerHTML = max
      ? [100, 95, 90, 85, 80, 75, 70, 65, 60]
          .map(
            (p) =>
              `<div><span>${p} %</span><b>${fmtNumber(Math.round((max * p) / 100))} ${u}</b><small>${esc(plural(repsAtPercent(p), 'reps'))}</small></div>`
          )
          .join('')
      : '';
  };
  box.querySelector('#oneRmWeight').oninput = update;
  box.querySelector('#oneRmReps').oninput = update;
  update();
  sheet({ title: t('onerm.title'), content: box });
}
const fieldDisplayWeight = (kg) => (kg === '' || kg == null ? '' : String(toDisplay(kg)));

// The grey values of the following sets follow what is being typed.
function refreshHints(exerciseIndex) {
  const session = current();
  const entry = session.entries[exerciseIndex];
  const last = previousWork(sessionExercises(session)[exerciseIndex]);
  document.querySelectorAll(`[data-set-field][data-exercise="${exerciseIndex}"]`).forEach((input) => {
    if (input.dataset.setField === 'rir') return;
    input.placeholder = placeholderFor(
      input.dataset.setField,
      setReference(entry, number(input.dataset.index), last),
      repsStart(sessionExercises(session)[exerciseIndex], last)
    );
    const sizer = input.previousElementSibling;
    if (!input.value && sizer?.classList.contains('set-sizer')) sizer.textContent = input.placeholder;
  });
}

// Picker for adding exercises to the running session; it stays open for several picks.
function addExercises() {
  openPicker({
    addedLabel: t('picker.addedWorkout'),
    subtitle: current().dayName,
    isAdded: (id) => sessionExercises(current()).some((x) => (x.libraryId || x.id) === id),
    onPick: (source) => mutate((s) => addSessionExercise(s, planExerciseFromLibrary(source)), true),
  });
}
function replaceExercise(index) {
  openPicker({
    addedLabel: t('picker.addedWorkout'),
    title: t('picker.replaceTitle'),
    subtitle: t('picker.replaceHint'),
    closeOnPick: true,
    suggested: alternativesFor(sessionExercises(current())[index], { equipment: usedEquipment() }),
    onPick: (source) =>
      mutate((s) => replaceSessionExercise(s, index, planExerciseFromLibrary(source)), true),
  });
}

function tickSet(exerciseIndex, setIndex, values) {
  let record = null;
  let recordType = 'weight_reps';
  let empty = null;
  primeAudio();
  mutate((s) => {
    const entry = s.entries[exerciseIndex];
    const set = entry.sets[setIndex];
    const exercises = sessionExercises(s);
    const ex = exercises[exerciseIndex];
    if (values) logSet(s, exerciseIndex, setIndex, values);
    else if (!toggleSet(s, exerciseIndex, setIndex, previousWork(ex))) {
      empty = missingField(set, entryTrackType(entry));
      return;
    } else set.pr = set.done && isRecord(ex, set, entry);
    if (!set.done) return;
    if (set.pr) {
      record = set;
      recordType = entryTrackType(entry);
    }
    const settings = getSettings();
    // Inside a superset the rest comes after the round, i.e. after the last exercise of the group.
    const position = supersetPosition(exercises, exerciseIndex);
    if (settings.restTimer && (position === 'single' || position === 'last')) {
      state.restUntil = Date.now() + (number(ex.rest) || number(settings.rest) || 90) * 1000;
      saveRestUntil(state.restUntil);
      armRestNotification();
    }
    buzz(40);
  }, true);
  if (empty) {
    toast(t('workout.enterValues'));
    document
      .querySelector(
        `[data-set-field="${empty}"][data-exercise="${exerciseIndex}"][data-index="${setIndex}"]`
      )
      ?.focus();
    return;
  }
  if (record) toast(t('workout.record', { set: describeSet(record, recordType) }), { duration: 4000 });
}

// Saying a set fills the next open one and ticks it, the same as tapping its check.
function dictateSet(exerciseIndex) {
  const entry = current().entries[exerciseIndex];
  const trackType = entryTrackType(entry);
  let setIndex = entry.sets.findIndex((set) => !set.done && isWorkSet(set));
  const before = setIndex < 0 ? entry.sets : entry.sets.slice(0, setIndex);
  openDictation({
    title: t('dictate.title', {
      name: exerciseName(exerciseAt(exerciseIndex)),
      n: before.filter(isWorkSet).length + 1,
    }),
    trackType,
    onValues: (spoken) => {
      mutate((s) => {
        setIndex = nextOpenSet(s, exerciseIndex);
      });
      const values = {
        ...spoken,
        ...(spoken.weight !== undefined ? { weight: fromDisplay(spoken.weight) } : {}),
      };
      tickSet(exerciseIndex, setIndex, values);
      const done = current().entries[exerciseIndex].sets[setIndex];
      if (!done?.done) toast(t('workout.enterValues'));
    },
  });
}

// Coming back to a running workout lands on the next open set: its exercise under the header, the set in view.
export function scrollToCurrent(fallback) {
  const spot = currentSpot(current());
  const section = spot && document.getElementById(`exercise-${spot.exercise}`);
  if (!section) return fallback();
  // No entrance animation: it would falsify the measurement, and its leftover transform pins the fixed rest
  // timer to the end of the page instead of the screen.
  section.closest('main').classList.remove('view-enter', 'view-modal', 'view-push', 'view-pop', 'view-fade');
  section.style.scrollMarginTop = `${document.querySelector('.workout-top')?.offsetHeight || 0}px`;
  section.scrollIntoView({ block: 'start', behavior: 'instant' });
  section
    .querySelector(`[data-set="${spot.set}"]`)
    ?.closest('.set-row')
    ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}

export function bind() {
  // A free workout starts with the question what to do, not with an empty page.
  const session = current();
  if (session?.detached && !sessionExercises(session).length && state.pickerFor !== session.id) {
    state.pickerFor = session.id;
    setTimeout(addExercises, 50);
  }
  document.querySelectorAll('[data-marker]').forEach((x) => {
    x.onchange = () =>
      mutate((s) => {
        s.markers[x.dataset.marker] = x.checked;
      });
  });
  document.querySelectorAll('[data-set-field]').forEach((x) => {
    x.oninput = () => {
      const field = x.dataset.setField;
      if (field === 'weight' || field === 'distance') {
        const clean = x.value.replace(/[^\d.,]/g, '');
        if (clean !== x.value) x.value = clean;
      }
      const sizer = x.previousElementSibling;
      if (sizer?.classList.contains('set-sizer')) sizer.textContent = x.value || x.placeholder;
      mutate((s) => {
        const set = s.entries[number(x.dataset.exercise)].sets[number(x.dataset.index)];
        const name = x.dataset.setField;
        set[name] =
          name === 'weight'
            ? fromDisplay(x.value)
            : name === 'time'
              ? parseDuration(x.value)
              : name === 'distance'
                ? x.value.replace(',', '.')
                : x.value;
        set.touched = true;
        touchSession(s);
      });
      refreshHints(number(x.dataset.exercise));
    };
  });
  document.querySelectorAll('[data-set-done]').forEach((b) => {
    b.onclick = () => tickSet(number(b.dataset.exercise), number(b.dataset.setDone));
  });
  document.querySelectorAll('[data-dictate]').forEach((b) => {
    b.onclick = () => dictateSet(number(b.dataset.dictate));
  });
  // The set number opens the type picker: working, warm-up, drop or failure set.
  document.querySelectorAll('[data-set-type]').forEach((b) => {
    b.onclick = () => {
      const exerciseIndex = number(b.dataset.exercise);
      const setIndex = number(b.dataset.setType);
      actionSheet(t('workout.setType'), [
        ...SET_TYPES.map((type) => ({
          label: t(`setType.${type}`),
          onClick: () => mutate((s) => setSetType(s.entries[exerciseIndex].sets[setIndex], type), true),
        })),
        {
          label: t('workout.deleteSet'),
          danger: true,
          onClick: () =>
            document
              .querySelector(`[data-delete-set="${setIndex}"][data-exercise="${exerciseIndex}"]`)
              ?.click(),
        },
      ]);
    };
  });
  document.querySelectorAll('[data-delete-set]').forEach((b) => {
    b.onclick = () => {
      const exerciseIndex = number(b.dataset.exercise);
      const setIndex = number(b.dataset.deleteSet);
      const sets = current().entries[exerciseIndex].sets;
      if (sets.length <= 1) {
        toast(t('workout.minOneSet'));
        return;
      }
      const removed = sets[setIndex];
      mutate((s) => s.entries[exerciseIndex].sets.splice(setIndex, 1), true);
      undoToast(t('workout.setDeleted'), () =>
        mutate((s) => s.entries[exerciseIndex].sets.splice(setIndex, 0, removed), true)
      );
    };
  });
  document.querySelectorAll('.set-row').forEach((row) => {
    let startX = 0;
    let startY = 0;
    row.onpointerdown = (e) => {
      startX = e.clientX;
      startY = e.clientY;
    };
    row.onpointerup = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) {
        document
          .querySelectorAll('.set-row.swiped')
          .forEach((x) => x !== row && x.classList.remove('swiped'));
        row.classList.toggle('swiped', dx < 0);
      }
    };
  });
  document.querySelectorAll('[data-exercise-note]').forEach((x) => {
    x.oninput = () =>
      mutate((s) => {
        s.entries[number(x.dataset.exerciseNote)].note = x.value;
      });
  });
  document.querySelectorAll('[data-add-set]').forEach((b) => {
    b.onclick = () =>
      mutate((s) => {
        const entry = s.entries[number(b.dataset.addSet)];
        const lastWork = [...entry.sets].reverse().find(isWorkSet);
        entry.sets.push(newSet(entryTrackType(entry), carryFromSet(lastWork)));
      }, true);
  });
  // Thumbnail and title both open the exercise sheet: animation, muscles, note and the last sessions.
  document.querySelectorAll('[data-technique], [data-exercise-history]').forEach((b) => {
    b.onclick = () => openExerciseSheet(exerciseAt(number(b.dataset.technique ?? b.dataset.exerciseHistory)));
  });
  document.querySelector('#addSessionExercise')?.addEventListener('click', addExercises);
  document.querySelectorAll('[data-exercise-menu]').forEach((b) => {
    b.onclick = () => {
      const index = number(b.dataset.exerciseMenu);
      const session = current();
      const exercises = sessionExercises(session);
      const ex = exercises[index];
      const entry = session.entries[index];
      const showRir = getSettings().showRir;
      const weighted = entryTrackType(entry) === 'weight_reps';
      actionSheet(exerciseName(ex), [
        weighted && {
          label: t('workout.calcWarmups'),
          onClick: () => {
            const target = number(entry.sets.find(isWorkSet)?.weight) || suggestion(ex).weight;
            if (!target) {
              toast(t('workout.enterWorkWeight'));
              return;
            }
            mutate((s) => {
              const e = s.entries[index];
              e.sets = [...warmupSets(target), ...e.sets.filter(isWorkSet)];
            }, true);
          },
        },
        weighted && {
          label: t('workout.addWarmup'),
          onClick: () =>
            mutate(
              (s) => s.entries[index].sets.unshift(newSet('weight_reps', { warmup: true, type: 'warmup' })),
              true
            ),
        },
        isBarbell(ex) && { label: t('plates.title'), onClick: () => openPlates(ex, entry) },
        weighted && { label: t('workout.oneRm'), onClick: () => openOneRm(entry) },
        {
          label: entry.note ? t('workout.editNote') : t('workout.addNote'),
          onClick: () => {
            (state.openNotes ||= new Set()).add(entry.exerciseId);
            render();
            document.querySelector(`[data-exercise-note="${index}"]`)?.focus();
          },
        },
        {
          label: showRir ? t('workout.hideRir') : t('workout.showRir'),
          hint: t('workout.rirHint'),
          onClick: () => {
            const s = getSettings();
            s.showRir = !s.showRir;
            saveSettings(s);
            render();
          },
        },
        { label: t('workout.replace'), onClick: () => replaceExercise(index) },
        aiAvailable() && {
          label: t('workout.askAi'),
          onClick: () =>
            openAi('workout', {
              aiInput: t('workout.askAiDraft', { name: exerciseName(exerciseAt(index)) }),
            }),
        },
        index > 0 && {
          label: t('editor.moveUp'),
          onClick: () => mutate((s) => moveSessionExercise(s, index, index - 1), true),
        },
        index < exercises.length - 1 && {
          label: t('editor.moveDown'),
          onClick: () => mutate((s) => moveSessionExercise(s, index, index + 1), true),
        },
        {
          label: t('workout.removeExercise'),
          danger: true,
          onClick: () => {
            let removed = null;
            mutate((s) => {
              removed = removeSessionExercise(s, index);
            }, true);
            undoToast(t('workout.exerciseRemoved', { name: exerciseName(removed.ex) }), () =>
              mutate((s) => restoreSessionExercise(s, index, removed.ex, removed.entry), true)
            );
          },
        },
      ]);
    };
  });
  document.querySelectorAll('[data-apply-suggestion]').forEach((b) => {
    b.onclick = () =>
      mutate(
        (s) =>
          s.entries[number(b.dataset.applySuggestion)].sets.filter(isWorkSet).forEach((x) => {
            x.weight = String(b.dataset.weight);
          }),
        true
      );
  });
  document.querySelector('#finishWorkout').onclick = async () => {
    const session = current();
    if (!session.entries.length) {
      toast(t('workout.emptyText'));
      return;
    }
    const { done, typed, open } = finishCounts(session);
    if (!done && !typed) {
      const discard = await confirmDialog({
        title: t('workout.noSetsTitle'),
        text: t('workout.noSetsText'),
        confirmLabel: t('workout.discardConfirm'),
        cancelLabel: t('workout.keepGoing'),
        danger: true,
      });
      if (!discard) return;
      clearActive();
      resetWorkoutUi();
      armRestNotification();
      navigate('home', {}, { replace: true });
      undoToast(t('home.discarded', { name: session.dayName }), () => {
        saveActive(session);
        render();
      });
      return;
    }
    if (typed || open) {
      const text = [
        typed ? plural(typed, 'workout.finishTyped') : '',
        open ? plural(open, 'workout.finishOpen') : '',
      ]
        .filter(Boolean)
        .join(' ');
      const finish = await confirmDialog({
        title: t('workout.finishTitle'),
        text,
        confirmLabel: t('workout.finish'),
        cancelLabel: t('workout.keepGoing'),
      });
      if (!finish) return;
    }
    // A full storage reports itself; the workout stays open and nothing is lost.
    const saved = finishSession(session);
    if (!saved) return;
    resetWorkoutUi();
    armRestNotification();
    navigate('summary', { sessionId: saved.id }, { replace: true });
    toast(t('workout.saved'));
  };
  document.querySelector('#exitWorkout').onclick = () => navigate('home');
  document.querySelector('[data-rest-add]')?.addEventListener('click', () => {
    state.restUntil = Math.max(state.restUntil, Date.now()) + 30000;
    saveRestUntil(state.restUntil);
    armRestNotification();
    updateRest();
  });
  document.querySelector('[data-rest-skip]')?.addEventListener('click', () => {
    state.restUntil = 0;
    saveRestUntil(0);
    armRestNotification();
    document.querySelector('#restTimer')?.classList.remove('show');
  });
}

// Runs for the whole app: the rest may end while another screen is open. Only the pill belongs to this view.
export function updateRest() {
  const clock = document.querySelector('#workoutClock');
  if (clock) {
    const running = getActive();
    clock.textContent = running ? clockText(running) : '';
  }
  const left = Math.max(0, Math.ceil((state.restUntil - Date.now()) / 1000));
  const box = document.querySelector('#restTimer');
  const count = document.querySelector('#restCount');
  if (box && count) {
    box.classList.toggle('show', left > 0);
    count.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }
  if (left === 0 && state.restUntil) {
    // A rest that ended long ago, while the app was closed, is no news any more.
    const fresh = Date.now() - state.restUntil < 60000;
    state.restUntil = 0;
    saveRestUntil(0);
    if (!fresh) return;
    buzz([100, 80, 100]);
    beep();
    if (!box) toast(t('rest.notifyTitle'));
  }
}

// Fires a system notification at the end of the rest when the app is in the background.
let notifyTimer = null;
function armRestNotification() {
  clearTimeout(notifyTimer);
  if (
    !state.restUntil ||
    !getSettings().restNotify ||
    !('Notification' in window) ||
    Notification.permission !== 'granted'
  )
    return;
  notifyTimer = setTimeout(
    () => {
      if (document.visibilityState === 'visible' || !state.restUntil) return;
      const options = {
        body: t('rest.notifyBody'),
        tag: 'volumora-rest',
        icon: 'assets/icons/icon-192.png',
      };
      const title = t('rest.notifyTitle');
      navigator.serviceWorker
        ?.getRegistration()
        .then((reg) => (reg ? reg.showNotification(title, options) : new Notification(title, options)))
        .catch(() => {});
    },
    Math.max(0, state.restUntil - Date.now())
  );
}
