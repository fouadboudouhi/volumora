// Plan editor. Exercises come from the picker overlay; secondary actions live in "⋯" menus; rows can be dragged.
import { plural, t } from '../i18n.js';
import { icon } from '../icons.js';
import { alternativesFor, exerciseName } from '../library.js';
import {
  addDay,
  duplicateDay,
  duplicatePlan,
  linkSuperset,
  moveExerciseToDay,
  planExerciseFromLibrary,
  reorderExercises,
  supersetLetters,
  unlinkSuperset,
} from '../plans.js';
import { goBack, navigate, render } from '../render.js';
import { TRACK_TYPES, trackTypeLabel } from '../sets.js';
import { state } from '../state.js';
import { allPlans, persistPlan, savePlans } from '../storage.js';
import { actionSheet, toast, undoToast } from '../ui.js';
import { fieldValue, fromDisplay, unit } from '../units.js';
import { esc, normalizeRange, number, setsCount } from '../util.js';
import { usedEquipment } from '../workout.js';
import { openPicker } from './picker.js';
import { empty } from './shell.js';
import * as plansView from './plans.js';

const detailsOpen = (di, ei) => state.editorDetails?.has(`${di}:${ei}`);

const exerciseRow = (ex, di, ei, letters) =>
  `<article class="plan-exercise-row" data-ex-index="${ei}"><button type="button" class="drag-handle" data-drag="${ei}" aria-label="${esc(t('editor.dragHandle', { name: exerciseName(ex) }))}">${icon('drag')}</button>${ex.gif ? `<img class="exercise-gif" src="${esc(ex.gif)}" alt="" loading="lazy" decoding="async">` : `<div class="custom-exercise-icon">${icon('dumbbell')}</div>`}<div class="plan-exercise-main">${
    ex.custom
      ? `<input class="custom-name" data-prop="name" value="${esc(ex.name)}" aria-label="${t('editor.customName')}">`
      : `<h2>${esc(exerciseName(ex))}</h2>`
  }${ex.supersetId ? `<span class="superset-tag">${esc(t('editor.supersetTag'))} ${esc(letters[ex.supersetId] || '')}</span>` : ''}<div class="quick-fields"><label><span>${t('editor.sets')}</span><input data-prop="sets" type="number" min="1" max="12" value="${esc(ex.sets)}"></label><label><span>${t('editor.reps')}</span><input data-prop="range" value="${esc(ex.range)}"></label></div>${
    detailsOpen(di, ei) || ex.rest || ex.trackType || ex.increment || (ex.note && ex.custom)
      ? `<div class="detail-fields"><label><span>${t('editor.rest')}</span><input data-prop="rest" type="number" min="0" max="600" value="${esc(ex.rest || '')}" placeholder="${t('editor.restDefault')}"></label><label><span>${t('editor.increment')}</span><div class="unit-input"><input data-prop="increment" type="number" min="0" step="any" value="${esc(fieldValue(ex.increment))}" placeholder="${t('editor.restDefault')}"><i>${unit()}</i></div></label><label><span>${t('editor.note')}</span><input data-prop="note" value="${esc(ex.note || '')}"></label><label><span>${t('editor.trackType')}</span><select data-prop="trackType"><option value="">${t('editor.trackDefault')}</option>${TRACK_TYPES.map((type) => `<option value="${type}" ${ex.trackType === type ? 'selected' : ''}>${esc(trackTypeLabel(type))}</option>`).join('')}</select></label></div>`
      : ''
  }</div><button type="button" class="icon-btn quiet" data-exercise-menu="${di}:${ei}" aria-label="${esc(t('exercise.more', { name: exerciseName(ex) }))}">${icon('more')}</button></article>`;

export function view() {
  const p = allPlans().items.find((x) => x.id === state.editPlanId);
  if (!p) {
    state.view = 'plans';
    return plansView.view();
  }
  state.editorDayIndex = Math.min(state.editorDayIndex, p.days.length - 1);
  const di = Math.max(0, state.editorDayIndex);
  const d = p.days[di];
  return `<main class="shell simple-editor"><div class="backrow"><button class="back" id="editorBack" data-nav="plans" aria-label="${t('common.back')}">${icon('chevron-left')}</button><h1>${t('editor.title')}</h1><button type="button" class="icon-btn quiet backrow-action" id="planMenu" aria-label="${t('editor.planMenu')}">${icon('more')}</button></div>
    <section class="simple-plan-head"><label><span>${t('editor.planName')}</span><input id="planName" value="${esc(p.name)}" maxlength="60"></label><input id="planDescription" type="hidden" value="${esc(p.description || '')}"></section>
    <div class="editor-day-tabs">${p.days.map((day, i) => `<button class="${i === di ? 'active' : ''}" data-editor-day="${i}" aria-pressed="${i === di}">${esc(day.name)}</button>`).join('')}<button type="button" class="add-day" id="addDay" aria-label="${t('editor.newDay')}">${icon('plus')}</button></div>
    ${
      d
        ? `<div class="editor-days"><section class="editor-day" data-day-index="${di}"><div class="simple-day-head"><input class="day-name" value="${esc(d.name)}" aria-label="${t('editor.dayName')}"><button type="button" class="icon-btn quiet" data-day-menu="${di}" aria-label="${t('editor.dayMenu')}">${icon('more')}</button></div>
      <div class="editor-exercises">${d.exercises.length ? d.exercises.map((ex, ei) => exerciseRow(ex, di, ei, supersetLetters(d.exercises))).join('') : empty(t('editor.noExercisesTitle'), t('editor.noExercisesText'))}</div><button class="choose-exercise" data-add-exercise="${di}">${icon('plus')}<b>${t('editor.addExercise')}</b></button></section></div>`
        : ''
    }
    <div class="editor-footer"><span>${plural(p.days.length, 'trainingDays')}</span><button class="primary" id="savePlan">${t('common.done')}</button></div></main>`;
}

// Reads the editor form back into the plan and persists it.
function collectPlan() {
  const data = allPlans();
  const p = data.items.find((x) => x.id === state.editPlanId);
  p.name = document.querySelector('#planName').value.trim() || t('plan.defaultName');
  p.description = document.querySelector('#planDescription').value.trim();
  document.querySelectorAll('.editor-day').forEach((el) => {
    const di = number(el.dataset.dayIndex);
    const d = p.days[di];
    d.name = el.querySelector('.day-name').value.trim() || t('day.nth', { n: di + 1 });
    el.querySelectorAll('.plan-exercise-row').forEach((row) => {
      const ex = d.exercises[number(row.dataset.exIndex)];
      if (!ex) return;
      row.querySelectorAll('[data-prop]').forEach((input) => {
        const prop = input.dataset.prop;
        if (prop === 'trackType') {
          if (input.value) ex.trackType = input.value;
          else delete ex.trackType;
        } else if (prop === 'increment') {
          // A field that still shows the stored value stays untouched, so converting units cannot shift it.
          if (input.value === fieldValue(ex.increment ?? '')) return;
          const kg = Math.max(0, number(fromDisplay(input.value)));
          if (kg) ex.increment = kg;
          else delete ex.increment;
        } else if (prop === 'sets') {
          // Mid-typing an empty field keeps the stored count.
          if (input.value.trim()) ex.sets = setsCount(input.value);
        } else if (prop === 'rest') {
          ex.rest = Math.min(600, Math.max(0, Math.round(number(input.value))));
        } else if (prop === 'range') {
          ex.range = normalizeRange(input.value, ex.range);
        } else ex[prop] = input.value.trim();
      });
    });
  });
  savePlans(data);
  return p;
}

const currentPlan = () => allPlans().items.find((x) => x.id === state.editPlanId);

// Opens the picker for a day; with `replaceIndex` the chosen exercise takes that slot and keeps its targets.
function openLibrary(dayIndex, replaceIndex = null) {
  const plan = collectPlan();
  const replacing = replaceIndex !== null;
  openPicker({
    title: replacing ? t('picker.replaceTitle') : t('picker.title'),
    subtitle: replacing ? t('picker.replaceHint') : plan.days[dayIndex]?.name || t('day.fallback'),
    isAdded: (id) =>
      !replacing && !!currentPlan()?.days[dayIndex]?.exercises.some((x) => (x.libraryId || x.id) === id),
    closeOnPick: replacing,
    suggested: replacing
      ? alternativesFor(plan.days[dayIndex]?.exercises[replaceIndex], { equipment: usedEquipment() })
      : [],
    onPick: (source) => {
      const data = allPlans();
      const list = data.items.find((x) => x.id === state.editPlanId).days[dayIndex].exercises;
      const picked = planExerciseFromLibrary(source);
      if (replacing) {
        const old = list[replaceIndex];
        Object.assign(picked, { sets: old.sets, range: old.range, rest: old.rest });
        list[replaceIndex] = picked;
      } else list.push(picked);
      savePlans(data);
      render();
    },
  });
}

function bindPlanMenu() {
  document.querySelector('#planMenu')?.addEventListener('click', () => {
    const data = allPlans();
    const p = data.items.find((x) => x.id === state.editPlanId);
    const active = data.activePlanId === p.id;
    actionSheet(p.name, [
      !active && {
        label: t('editor.useActive'),
        onClick: () => {
          collectPlan();
          const d = allPlans();
          d.activePlanId = p.id;
          savePlans(d);
          render();
          toast(t('editor.nowActive'));
        },
      },
      {
        label: t('editor.duplicate'),
        onClick: () => {
          // Typed edits first, so both the original and the copy hold them.
          const copy = duplicatePlan(collectPlan());
          const d = allPlans();
          d.items.push(copy);
          savePlans(d);
          navigate('planEditor', { editPlanId: copy.id, editorDayIndex: 0 });
        },
      },
      data.items.length > 1 && {
        label: t('editor.deletePlan'),
        danger: true,
        onClick: () => {
          const d = allPlans();
          const index = d.items.findIndex((x) => x.id === p.id);
          const [removed] = d.items.splice(index, 1);
          const wasActive = d.activePlanId === removed.id;
          if (wasActive) d.activePlanId = d.items[0].id;
          savePlans(d);
          navigate('plans');
          undoToast(t('editor.deleted', { name: removed.name }), () => {
            const current = allPlans();
            current.items.splice(Math.min(index, current.items.length), 0, removed);
            if (wasActive) current.activePlanId = removed.id;
            savePlans(current);
            render();
          });
        },
      },
    ]);
  });
}

function removeDay(di) {
  const p = collectPlan();
  const [removed] = p.days.splice(di, 1);
  const weekday = p.schedule?.assignments?.[removed.id];
  state.editorDayIndex = Math.max(0, Math.min(state.editorDayIndex, p.days.length - 1));
  persistPlan(p);
  render();
  undoToast(t('editor.removed', { name: removed.name }), () => {
    const current = allPlans().items.find((x) => x.id === p.id);
    if (!current) return;
    current.days.splice(Math.min(di, current.days.length), 0, removed);
    if (weekday !== undefined)
      (current.schedule ||= { mode: 'flexible', assignments: {} }).assignments[removed.id] = weekday;
    state.editorDayIndex = di;
    persistPlan(current);
    render();
  });
}

function bindDayMenu() {
  document.querySelectorAll('[data-day-menu]').forEach((b) => {
    b.onclick = () => {
      const di = number(b.dataset.dayMenu);
      const p = collectPlan();
      actionSheet(p.days[di].name, [
        {
          label: t('editor.duplicateDay'),
          onClick: () => {
            const plan = collectPlan();
            duplicateDay(plan, di);
            state.editorDayIndex = plan.days.length - 1;
            persistPlan(plan);
            render();
          },
        },
        { label: t('editor.deleteDay'), danger: true, onClick: () => removeDay(di) },
      ]);
    };
  });
}

function bindExerciseMenus() {
  document.querySelectorAll('[data-exercise-menu]').forEach((b) => {
    b.onclick = () => {
      const [di, ei] = b.dataset.exerciseMenu.split(':').map(Number);
      const p = collectPlan();
      const list = p.days[di].exercises;
      const ex = list[ei];
      const move = (j) => {
        if (j < 0 || j >= list.length) return;
        [list[ei], list[j]] = [list[j], list[ei]];
        persistPlan(p);
        render();
      };
      const canLink = ei < list.length - 1 && (!ex.supersetId || list[ei + 1].supersetId !== ex.supersetId);
      actionSheet(exerciseName(ex), [
        { label: t('editor.replace'), hint: t('editor.replaceHint'), onClick: () => openLibrary(di, ei) },
        ei > 0 && { label: t('editor.moveUp'), onClick: () => move(ei - 1) },
        ei < list.length - 1 && { label: t('editor.moveDown'), onClick: () => move(ei + 1) },
        p.days.length > 1 && {
          label: t('editor.moveToDay'),
          onClick: () =>
            actionSheet(
              t('editor.moveToDayTitle'),
              p.days.map(
                (day, j) =>
                  j !== di && {
                    label: day.name,
                    onClick: () => {
                      const plan = collectPlan();
                      const moved = moveExerciseToDay(plan, di, ei, j);
                      if (!moved) return;
                      persistPlan(plan);
                      render();
                      toast(t('editor.movedTo', { name: plan.days[j].name }));
                    },
                  }
              )
            ),
        },
        canLink && {
          label: t('editor.linkSuperset'),
          hint: t('editor.linkSupersetHint'),
          onClick: () => {
            linkSuperset(list, ei);
            persistPlan(p);
            render();
          },
        },
        ex.supersetId && {
          label: t('editor.unlinkSuperset'),
          onClick: () => {
            unlinkSuperset(list, ei);
            persistPlan(p);
            render();
          },
        },
        {
          label: t('editor.restAndNote'),
          onClick: () => {
            (state.editorDetails ||= new Set()).add(`${di}:${ei}`);
            render();
          },
        },
        {
          label: t('editor.remove'),
          danger: true,
          onClick: () => {
            const [removed] = list.splice(ei, 1);
            persistPlan(p);
            render();
            undoToast(t('editor.removed', { name: exerciseName(removed) }), () => {
              const current = allPlans().items.find((x) => x.id === p.id);
              const day = current?.days[di];
              if (!day) return;
              day.exercises.splice(Math.min(ei, day.exercises.length), 0, removed);
              persistPlan(current);
              render();
            });
          },
        },
      ]);
    };
  });
}

// Drag-and-drop reordering with the handle: the dragged row follows the pointer through the list; on release
// the new order is read from the DOM and stored. "Nach oben/unten" in the menu remains the keyboard alternative.
function bindDrag() {
  document.querySelectorAll('.drag-handle').forEach((handle) => {
    handle.onpointerdown = (e) => {
      const row = handle.closest('.plan-exercise-row');
      const list = row.parentElement;
      const di = number(row.closest('.editor-day')?.dataset.dayIndex);
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      row.classList.add('dragging');
      const onMove = (ev) => {
        const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.plan-exercise-row');
        if (!target || target === row || target.parentElement !== list) return;
        const box = target.getBoundingClientRect();
        const before = ev.clientY < box.top + box.height / 2;
        list.insertBefore(row, before ? target : target.nextSibling);
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        row.classList.remove('dragging');
        const order = [...list.querySelectorAll('.plan-exercise-row')].map((r) => number(r.dataset.exIndex));
        if (order.some((v, i) => v !== i)) {
          const p = collectPlan();
          reorderExercises(p.days[di], order);
          persistPlan(p);
          render();
        }
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    };
  });
}

export function bind() {
  // Everything typed is stored right away, so no way of leaving the screen can lose it. When a field is done,
  // it shows the value that was actually kept.
  const editor = document.querySelector('.simple-editor');
  editor?.addEventListener('input', collectPlan);
  editor?.addEventListener('change', (e) => {
    const input = e.target;
    if (!['sets', 'range', 'rest'].includes(input.dataset?.prop)) return;
    const di = number(input.closest('.editor-day')?.dataset.dayIndex);
    const ei = number(input.closest('.plan-exercise-row')?.dataset.exIndex);
    const value = collectPlan().days[di]?.exercises[ei]?.[input.dataset.prop];
    input.value = value || '';
  });
  document.querySelectorAll('[data-editor-day]').forEach((b) => {
    b.onclick = () => {
      collectPlan();
      state.editorDayIndex = number(b.dataset.editorDay);
      render();
    };
  });
  const leave = () => {
    collectPlan();
    goBack(state.editorReturn || 'plans');
  };
  document.querySelector('#savePlan').onclick = leave;
  document.querySelector('#editorBack').onclick = leave;
  document.querySelector('#addDay').onclick = () => {
    const p = collectPlan();
    addDay(p);
    state.editorDayIndex = p.days.length - 1;
    persistPlan(p);
    render();
  };
  document.querySelectorAll('[data-add-exercise]').forEach((b) => {
    b.onclick = () => openLibrary(number(b.dataset.addExercise));
  });
  bindPlanMenu();
  bindDayMenu();
  bindExerciseMenus();
  bindDrag();
}
