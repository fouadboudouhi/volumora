import { deloadHint, deloadQuietDate } from '../deload.js';
import { syncConfig } from '../sync.js';
import { openSyncForm } from './sync.js';
import { fmtNumber, plural, t, weekdayShort } from '../i18n.js';
import { exerciseName } from '../library.js';
import { icon } from '../icons.js';
import { nextSession, setCount, weekStats } from '../plans.js';
import { navigate, render } from '../render.js';
import { state } from '../state.js';
import {
  activePlan,
  deloadQuietUntil,
  clearActive,
  dismissInstallTip,
  getActive,
  getHistory,
  getSettings,
  installTipDue,
  saveActive,
  quietDeload,
} from '../storage.js';
import { startOfWeek } from '../stats.js';
import { confirmDialog, infoDialog, undoToast } from '../ui.js';
import { fmtVolume, toDisplay, unit } from '../units.js';
import { dayKey, doneSets, esc, fmtLong, number, volumeOf, weekdayIndex } from '../util.js';
import { reconcileActive, resetWorkoutUi, sessionExercises, sessionStarted } from '../workout.js';
import { empty } from './shell.js';

// How long this day usually takes: the last few finished sessions of it.
function usualMinutes(history, planId, dayId) {
  const times = history
    .filter((h) => h.planId === planId && h.dayId === dayId && number(h.duration) > 0)
    .slice(0, 5)
    .map((h) => number(h.duration));
  if (!times.length) return 0;
  return Math.round(times.reduce((a, b) => a + b, 0) / times.length / 60 / 5) * 5;
}
// The first exercises of the day in one line, so the card says what is coming.
const previewOf = (exercises) => {
  const names = exercises.slice(0, 3).map((ex) => exerciseName(ex));
  return names.join(' · ') + (exercises.length > 3 ? ' …' : '');
};
// "heute", "gestern", "vor 3 Tagen" or the date.
function relativeDay(key, today) {
  const diff = Math.round((new Date(dayKey(today)) - new Date(key)) / 86400000);
  if (diff <= 0) return t('home.ago0');
  if (diff === 1) return t('home.ago1');
  if (diff < 7) return t('home.agoDays', { n: diff });
  return fmtLong(key);
}
// The last finished workout in one row.
function lastRow(history, today) {
  const last = history.find((h) => (h.entries || []).some((e) => e.sets.some((s) => s.done)));
  if (!last) return '';
  const records = (last.entries || []).reduce((m, e) => m + (e.sets || []).filter((x) => x.pr).length, 0);
  const parts = [
    relativeDay(last.day || dayKey(last.finishedAt), today),
    fmtVolume(number(last.volume) || volumeOf(last)),
  ];
  if (records) parts.push(plural(records, 'records'));
  return `<section class="list-section"><h2>${t('home.last')}</h2><div class="list"><button type="button" class="row" data-last-session="${esc(last.id)}"><span class="row-main"><b>${esc(last.dayName || last.day)}</b><small>${esc(parts.join(' · '))}</small></span>${icon('chevron-right')}</button></div></section>`;
}
// Seven dots for the week, done days filled, today marked.
function weekDots(weekSessions, today) {
  const done = new Set(
    weekSessions.map((h) => weekdayIndex(new Date((h.day || dayKey(h.finishedAt)) + 'T12:00:00')))
  );
  const now = weekdayIndex(today);
  return `<div class="week-dots" aria-hidden="true">${[0, 1, 2, 3, 4, 5, 6].map((i) => `<span class="${done.has(i) ? 'done' : ''} ${i === now ? 'today' : ''}"><i>${done.has(i) ? icon('check') : ''}</i><small>${weekdayShort(i)}</small></span>`).join('')}</div>`;
}

const dayRow = (plan, d) =>
  `<button type="button" class="row" data-start="${d.id}" data-plan="${plan.id}"><span class="row-main"><b>${esc(d.name)}</b><small>${plural(d.exercises.length, 'exercises')}</small></span>${icon('chevron-right')}</button>`;

// A suggestion, not a task: it can be waved away and then stays quiet for weeks.
function deloadCard(history, today) {
  if (deloadQuietUntil() > today.getTime()) return '';
  const hint = deloadHint(history, today);
  if (!hint) return '';
  return `<section class="list-section"><div class="list"><div class="row backup-row" id="deloadCard"><span class="backup-main"><span class="row-icon">${icon('trend')}</span><span class="row-main"><b>${t('deload.title')}</b><small>${esc(t(`deload.${hint.reason}`, { n: hint.count }))}</small></span></span><button type="button" class="text-btn" id="deloadLater">${t('deload.later')}</button></div></div></section>`;
}

export function view() {
  const today = new Date();
  const plan = activePlan();
  const history = getHistory();
  const readyDays = plan?.days?.filter((d) => d.exercises.length) || [];
  const goal = Number(getSettings().weeklyGoal) || readyDays.length;
  const stats = weekStats(history, goal, today);
  const fromKey = dayKey(startOfWeek(today));
  const weekSessions = history.filter((h) => (h.day || dayKey(h.finishedAt)) >= fromKey);
  const volume = weekSessions.reduce((sum, h) => sum + (number(h.volume) || volumeOf(h)), 0);
  const records = weekSessions.reduce(
    (n, h) => n + (h.entries || []).reduce((m, e) => m + (e.sets || []).filter((x) => x.pr).length, 0),
    0
  );

  let { day: next, label: nextLabel } = nextSession(plan, history, today);
  // A running workout leads the screen, whatever became of its plan day in the meantime.
  const active = reconcileActive();
  const resume = !!(active && sessionStarted(active));
  const freeActive = resume && active.planId == null;
  if (resume) {
    next = { id: active.dayId || '', name: active.dayName, exercises: sessionExercises(active) };
    nextLabel = t('home.resumeLabel');
  }
  const startAttr = freeActive
    ? 'id="startFree"'
    : next?.exercises.length
      ? `data-start="${next.id}" data-plan="${resume ? active.planId : plan.id}"`
      : 'id="editActivePlan"';
  const minutes = next && !resume ? usualMinutes(history, plan?.id, next.id) : 0;
  const nextCard = next
    ? `<section class="next-card ${resume ? 'resume-card' : ''} ${next.exercises.length ? '' : 'empty-plan-card'}"><span class="next-label">${esc(next.exercises.length ? nextLabel : t('home.completePlan'))}</span><h2>${esc(next.name)}</h2><p>${
        resume
          ? doneSets(active)
            ? plural(doneSets(active), 'home.setsDone')
            : t('home.valuesTyped')
          : next.exercises.length
            ? `${plural(next.exercises.length, 'exercises')} · ${plural(setCount(next), 'sets')}${minutes ? ` · ${t('home.about', { n: minutes })}` : ''}`
            : t('home.pickExercises')
      }</p>${next.exercises.length && !resume ? `<p class="next-preview">${esc(previewOf(next.exercises))}</p>` : ''}<button class="primary start-main" ${startAttr}>${
        resume ? t('home.resume') : next.exercises.length ? t('home.start') : t('home.chooseExercises')
      }</button>${resume ? `<button type="button" class="text-btn discard-btn" id="discardSession">${t('home.discard')}</button>` : ''}</section>`
    : empty(t('home.emptyTitle'), t('home.emptyText'), {
        label: t('home.emptyAction'),
        attrs: 'id="editActivePlan"',
      });
  const others = readyDays.filter((d) => d.id !== next?.id);
  // The week as seven dots, the count against the goal, and the numbers only once there are any.
  const weekStrip = readyDays.length
    ? `<section class="week week-line" aria-label="${t('home.weeklyGoal')}"><h2>${t('home.thisWeek')}${stats.streak ? `<em>${plural(stats.streak, 'home.streak')}</em>` : ''}</h2>${weekDots(weekSessions, today)}<p class="week-count">${t('home.weekCount', { done: stats.thisWeek, goal })} ${t('home.kpiSessions')}</p>${
        volume
          ? `<div class="kpis"><div class="kpi"><b>${fmtNumber(Math.round(toDisplay(volume)))}<u>${unit()}</u></b><span>${t('home.kpiVolume')}</span></div><div class="kpi"><b>${records}</b><span>${t('home.kpiRecords')}</span></div></div>`
          : ''
      }</section>`
    : '';
  const freeRow = freeActive
    ? ''
    : `<button type="button" class="row" id="startFree"><span class="row-icon">${icon('plus')}</span><span class="row-main"><b>${t('home.free')}</b><small>${t('home.freeHint')}</small></span>${icon('chevron-right')}</button>`;
  return `<main class="shell home-shell">
    <section class="home-intro"><h1>${t('home.title')}</h1><p>${fmtLong(today)}${plan ? ` · ${esc(plan.name)}` : ''}</p></section>
    ${nextCard}
    ${weekStrip}
    ${resume ? '' : lastRow(history, today)}
    ${
      installTipDue()
        ? `<section class="list-section"><div class="list"><div class="row backup-row"><button type="button" class="backup-main" id="installNow"><span class="row-icon">${icon('install')}</span><span class="row-main"><b>${t('home.installTitle')}</b><small>${t('home.installText')}</small></span></button><button type="button" class="text-btn" id="installLater">${t('home.backupLater')}</button></div></div></section>`
        : ''
    }
    ${
      syncConfig()?.problem === 'session'
        ? `<section class="list-section"><div class="list"><div class="row backup-row"><button type="button" class="backup-main" id="signInAgain"><span class="row-icon">${icon('backup')}</span><span class="row-main"><b>${t('sync.expiredTitle')}</b><small>${t('sync.expiredText')}</small></span></button></div></div></section>`
        : ''
    }
    ${resume ? '' : deloadCard(history, today)}
    <section class="list-section">${others.length ? `<h2>${t('home.otherSessions')}</h2>` : ''}<div class="list">${others.map((d) => dayRow(plan, d)).join('')}${freeRow}</div></section>
  </main>`;
}

// Starting a different session than the one in progress asks first.
async function start(planId, dayId) {
  const saved = getActive();
  const other = saved && (saved.planId !== planId || saved.dayId !== dayId);
  if (other && sessionStarted(saved)) {
    const ok = await confirmDialog({
      title: t('home.discardTitle'),
      text: t('home.discardText', { name: saved.dayName }),
      confirmLabel: t('home.discardConfirm'),
      danger: true,
    });
    if (!ok) return;
    clearActive();
    resetWorkoutUi();
  }
  navigate('workout', { planId, dayId });
}

export function bind() {
  document
    .querySelector('[data-last-session]')
    ?.addEventListener('click', (e) =>
      navigate('session', { sessionId: e.currentTarget.dataset.lastSession, sessionFrom: 'home' })
    );
  document.querySelector('#signInAgain')?.addEventListener('click', () => openSyncForm({ mode: 'login' }));
  document.querySelector('#deloadLater')?.addEventListener('click', () => {
    quietDeload(deloadQuietDate());
    render();
  });
  document
    .querySelector('#installNow')
    ?.addEventListener('click', () =>
      state.installPrompt
        ? state.installPrompt.prompt()
        : infoDialog(t('more.install'), t('more.installText'))
    );
  document.querySelector('#installLater')?.addEventListener('click', () => {
    dismissInstallTip();
    render();
  });
  document.querySelector('#editActivePlan')?.addEventListener('click', () =>
    navigate('planEditor', {
      editPlanId: activePlan().id,
      editorDayIndex: Math.max(
        0,
        activePlan().days.findIndex((d) => !d.exercises.length)
      ),
      editorReturn: 'home',
    })
  );
  document.querySelector('#discardSession')?.addEventListener('click', () => {
    const session = getActive();
    clearActive();
    resetWorkoutUi();
    render();
    undoToast(t('home.discarded', { name: session?.dayName || '' }), () => {
      saveActive(session);
      render();
    });
  });
  document.querySelectorAll('[data-start]').forEach((b) => {
    b.onclick = () => start(b.dataset.plan, b.dataset.start);
  });
  document.querySelector('#startFree')?.addEventListener('click', () => start(null, null));
}
