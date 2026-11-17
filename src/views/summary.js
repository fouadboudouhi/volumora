// Shown right after a workout was saved: numbers, new records, muscle split, sharing.
import { plural, t } from '../i18n.js';
import { exerciseName, groupLabel } from '../library.js';
import { addDay, dayFromSession } from '../plans.js';
import { headlineKind, sessionRecords } from '../records.js';
import { navigate, render } from '../render.js';
import { previousView } from '../router.js';
import { describeSet } from '../sets.js';
import { shareText, summaryText } from '../share.js';
import { state } from '../state.js';
import { setsByGroup } from '../stats.js';
import { aiAvailable } from '../aiAccess.js';
import { activePlan, getHistory, persistPlan } from '../storage.js';
import { toast } from '../ui.js';
import { fmtVolume } from '../units.js';
import { esc, exerciseKey, number } from '../util.js';
import { openAi } from './ai.js';
import { bindEffort, effortHtml } from './effort.js';
import * as home from './home.js';

// Headline records of the session with the set that achieved them.
function newRecords(session) {
  return sessionRecords(session)
    .filter((r) => r.kind === headlineKind(r.trackType))
    .map((r) => {
      const entry = session.entries.find((e) => exerciseKey(e) === r.key);
      // Each flagged set beat the one before it, so the last one is the best.
      const flagged = entry?.sets.filter((s) => s.pr) || [];
      const best = flagged[flagged.length - 1] || entry?.sets[entry.sets.length - 1] || {};
      return { ...r, set: best, headline: true };
    });
}

export function view() {
  const session = getHistory().find((h) => h.id === state.sessionId);
  if (!session) {
    state.view = 'home';
    return home.view();
  }
  const records = newRecords(session);
  const groups = setsByGroup(session);
  const max = groups[0]?.sets || 1;
  return `<main class="shell narrow summary"><section class="page-head compact"><div><span class="next-label">${t('summary.title')}</span><h1>${esc(session.dayName)}</h1></div></section>
    <div class="stat-row"><div><b>${fmtVolume(session.volume || 0)}</b><span>${t('session.volume')}</span></div><div><b>${number(session.totalSets)}</b><span>${t('session.sets')}</span></div><div><b>${t('session.minutes', { n: Math.round(number(session.duration) / 60) })}</b><span>${t('session.duration')}</span></div></div>
    ${effortHtml(session)}
    <section class="list-section"><h2>${t('summary.newRecords')}</h2>${
      records.length
        ? `<div class="list">${records.map((r) => `<div class="row"><span class="row-main"><b>${esc(exerciseName(r.item))}</b><small>${esc(describeSet(r.set, r.trackType))}</small></span><span class="chip chip-green">${t('workout.pr')}</span></div>`).join('')}</div>`
        : `<p class="muted">${t('summary.noRecords')}</p>`
    }</section>
    ${groups.length ? `<section class="chart-section"><h2>${t('summary.muscles')}</h2><div class="bar-list">${groups.map((g) => `<div class="bar-row"><span>${esc(groupLabel(g.group))}</span><div class="bar-track"><i style="width:${Math.max(4, (g.sets / max) * 100)}%"></i></div><b>${plural(g.sets, 'sets')}</b></div>`).join('')}</div></section>` : ''}
    <div class="preview-actions"><button class="primary" id="summaryDone">${t('summary.done')}</button><button class="secondary" id="summaryShare">${t('summary.share')}</button>${aiAvailable() ? `<button type="button" class="text-btn" id="summaryAi">${t('summary.ai')}</button>` : ''}<button type="button" class="text-btn" id="summaryView">${t('summary.view')}</button>${session.detached && session.exercises?.length && !savedAsDay.has(session.id) ? `<button class="secondary" id="summarySaveDay">${t('summary.saveDay')}</button>` : ''}</div></main>`;
}

// Sessions already turned into a plan day during this visit, so the button does not offer it twice.
const savedAsDay = new Set();

export function bind() {
  bindEffort(state.sessionId);
  document.querySelector('#summaryDone')?.addEventListener('click', () =>
    // Straight back to where the workout started, without a second "Heute" in the history.
    previousView() === 'home' ? history.back() : navigate('home', {}, { replace: true })
  );
  document
    .querySelector('#summaryView')
    ?.addEventListener('click', () =>
      navigate('session', { sessionId: state.sessionId, sessionFrom: 'analytics' }, { replace: true })
    );
  document
    .querySelector('#summaryAi')
    ?.addEventListener('click', () =>
      openAi('summary', { aiInput: t('summary.aiQuestion'), aiAutoSend: true })
    );
  document.querySelector('#summaryShare')?.addEventListener('click', () => {
    const session = getHistory().find((h) => h.id === state.sessionId);
    if (session) shareText(summaryText(session, newRecords(session)));
  });
  document.querySelector('#summarySaveDay')?.addEventListener('click', () => {
    const session = getHistory().find((h) => h.id === state.sessionId);
    const plan = activePlan();
    if (!session || !plan) return;
    const day = addDay(plan, dayFromSession(session));
    if (!persistPlan(plan)) return;
    savedAsDay.add(session.id);
    render();
    toast(t('summary.daySaved', { name: day.name }));
  });
}
