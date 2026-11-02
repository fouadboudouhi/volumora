import { drawAnalytics, historyInRange, strengthSeries, volumeByMuscle } from '../charts.js';
import { fmtNumber, plural, t } from '../i18n.js';
import { icon } from '../icons.js';
import { exerciseName, groupLabel } from '../library.js';
import { navigate, render } from '../render.js';
import { state } from '../state.js';
import { groupSetsPerWeek, recordTimeline, weeklySets } from '../stats.js';
import { getBody, getHistory } from '../storage.js';
import { fmtVolume, toDisplay, unit } from '../units.js';
import { esc, exerciseKey, fmtLong, number, volumeOf } from '../util.js';
import { empty } from './shell.js';

const RANGES = ['4w', '3m', '1y', 'all'];
const TABS = ['overview', 'strength', 'sessions'];
const markerText = (h) =>
  [
    h.markers?.deload ? t('marker.deload') : '',
    h.markers?.ill ? t('marker.ill') : '',
    h.markers?.pain ? t('marker.pain') : '',
  ]
    .filter(Boolean)
    .join(', ');

// Sets per muscle group this week or averaged over four weeks, with the 10–20 guideline marked on each bar.
function weeklySetsSection() {
  const avg = state.analyticsWeekMode === 'avg';
  let rows = weeklySets(getHistory(), { weeks: avg ? 4 : 1 });
  // A week that has not started yet says nothing; the last one does.
  let fallback = '';
  if (!avg && !rows.length) {
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    rows = weeklySets(getHistory(), { weeks: 1, today: lastWeek });
    if (rows.length) fallback = `<p class="muted analytics-hint">${t('analytics.lastWeekShown')}</p>`;
  }
  const scale = Math.max(24, ...rows.map((r) => r.sets));
  const toggle = `<div class="segmented small" role="group" aria-label="${t('analytics.weeklySets')}"><button type="button" class="${avg ? '' : 'active'}" data-week-mode="week" aria-pressed="${!avg}">${t('analytics.thisWeek')}</button><button type="button" class="${avg ? 'active' : ''}" data-week-mode="avg" aria-pressed="${avg}">${t('analytics.fourWeekAvg')}</button></div>`;
  const list = rows.length
    ? `<div class="bar-list weekly-sets"><div class="bar-scale" aria-hidden="true"><small style="left:${(10 / scale) * 100}%">10</small><small style="left:${(20 / scale) * 100}%">20</small></div>${rows.map((r) => `<div class="bar-row"><span>${esc(groupLabel(r.group))}</span><div class="bar-track target"><i style="width:${Math.max(2, (r.sets / scale) * 100)}%"></i><em style="left:${(10 / scale) * 100}%"></em><em style="left:${(20 / scale) * 100}%"></em></div><b>${fmtNumber(r.sets, { maximumFractionDigits: 1 })}</b></div>`).join('')}</div><p class="muted analytics-hint">${t('analytics.setsTarget')}</p>`
    : `<p class="muted">${t('analytics.noWeeklySets')}</p>`;
  return `<section class="chart-section"><div class="section-head"><h2>${t('analytics.weeklySets')}</h2></div>${toggle}${fallback}${list}</section>`;
}

const MAX_ROWS = 8;
const SPARK_POINTS = 12;

// A small line for one row. Shapes only: the numbers stand next to it, and the big chart opens on a tap.
function sparkline(values) {
  const w = 72;
  const h = 26;
  const pad = 3;
  const list = values.slice(-SPARK_POINTS);
  if (!list.length) return '';
  const low = Math.min(...list);
  const high = Math.max(...list);
  const x = (i) => (list.length > 1 ? pad + (i / (list.length - 1)) * (w - pad * 2) : w / 2);
  const y = (v) => (high === low ? h / 2 : h - pad - ((v - low) / (high - low)) * (h - pad * 2));
  const dot = `<circle cx="${x(list.length - 1).toFixed(1)}" cy="${y(list.at(-1)).toFixed(1)}" r="2.5"></circle>`;
  const line =
    list.length > 1
      ? `<polyline points="${list.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"></polyline>`
      : '';
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${line}${dot}</svg>`;
}

// Whether a series went up, down or stayed, from its first point to its last.
function direction(values) {
  if (values.length < 2) return '';
  const first = values[0];
  const last = values.at(-1);
  const kind = last > first * 1.01 ? 'up' : last < first * 0.99 ? 'down' : 'flat';
  return `<span class="trend-arrow ${kind}" role="img" aria-label="${t(`analytics.trend.${kind}`)}">${{ up: '↗', down: '↘', flat: '→' }[kind]}</span>`;
}

const trendRow = ({ attrs, name, value, values, open, detail }) =>
  `<button type="button" class="row trend-row" ${attrs} aria-expanded="${open}"><span class="row-main"><b>${esc(name)}</b></span>${sparkline(values)}<span class="row-value"><b>${esc(value)}</b>${direction(values)}</span>${icon('chevron-right')}</button>${open ? `<div class="trend-detail">${detail}</div>` : ''}`;

function exerciseRows(history, exercises, selected) {
  const counts = new Map();
  history.forEach((h) =>
    new Set((h.entries || []).map(exerciseKey)).forEach((key) => counts.set(key, (counts.get(key) || 0) + 1))
  );
  const keys = [...exercises.keys()].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
  const shown = state.analyticsAll ? keys : keys.slice(0, MAX_ROWS);
  if (selected && !shown.includes(selected)) shown[shown.length - 1] = selected;
  const oldestFirst = history.slice().reverse();
  const rows = shown.map((key) => {
    const { points, suffix } = strengthSeries(oldestFirst, key);
    const values = points.map((p) => p.value);
    return trendRow({
      attrs: `data-trend-exercise="${esc(key)}"`,
      name: exercises.get(key),
      value: values.length ? `${fmtNumber(values.at(-1))}${suffix}` : '–',
      values,
      open: key === selected && !state.analyticsCollapsed,
      detail: `<canvas id="strengthChart" height="200" role="img" aria-label="${t('history.strengthAria')}"></canvas>`,
    });
  });
  const more =
    keys.length > MAX_ROWS && !state.analyticsAll
      ? `<button type="button" class="text-btn" id="trendAll">${t('analytics.allExercises', { n: keys.length })}</button>`
      : '';
  return `<div class="list trend-list">${rows.join('')}</div>${more}<p class="muted analytics-hint">${t('analytics.strengthHint')}</p>`;
}

function groupRows() {
  const all = getHistory();
  const groups = weeklySets(all, { weeks: 12 }).map((g) => g.group);
  if (!groups.length) return `<p class="muted">${t('analytics.noWeeklySets')}</p>`;
  const rows = groups.map((group) => {
    const values = groupSetsPerWeek(all, group).map((p) => p.value);
    return trendRow({
      attrs: `data-trend-group="${esc(group)}"`,
      name: groupLabel(group),
      value: t('analytics.setsPerWeekValue', { n: fmtNumber(values.at(-1) || 0) }),
      values,
      open: group === state.analyticsGroup,
      detail: `<canvas id="groupChart" height="180" role="img" aria-label="${esc(t('analytics.groupChartAria', { group: groupLabel(group) }))}"></canvas>`,
    });
  });
  return `<div class="list trend-list">${rows.join('')}</div><p class="muted analytics-hint">${t('analytics.groupHint')}</p>`;
}

// Everything side by side instead of one exercise behind a menu; a tap opens the big chart in place.
function trendSection(history, exercises, selected) {
  const groups = state.analyticsListMode === 'groups';
  const toggle = `<div class="segmented small" role="group" aria-label="${t('history.strength')}"><button type="button" class="${groups ? '' : 'active'}" data-list-mode="exercises" aria-pressed="${!groups}">${t('analytics.modeExercises')}</button><button type="button" class="${groups ? 'active' : ''}" data-list-mode="groups" aria-pressed="${groups}">${t('analytics.modeGroups')}</button></div>`;
  return `<section class="chart-section"><div class="section-head"><h2>${t('history.strength')}</h2></div>${toggle}${groups ? groupRows() : exerciseRows(history, exercises, selected)}</section>`;
}

function timelineSection(history) {
  const rows = recordTimeline(history, 10);
  if (!rows.length) return '';
  return `<section class="list-section"><h2>${t('analytics.records')}</h2><div class="list">${rows
    .map(
      (r) =>
        `<button type="button" class="row" data-session-record="${esc(r.sessionId)}"><span class="row-main"><b>${esc(r.items.map(exerciseName).join(' · '))}</b><small>${fmtLong(r.day)} · ${esc(r.dayName || '')}</small></span><span class="chip chip-green">${plural(r.count, 'records')}</span>${icon('chevron-right')}</button>`
    )
    .join('')}</div></section>`;
}

export function view() {
  const range = state.analyticsRange || '3m';
  const history = historyInRange(range);
  const exercises = new Map();
  history.forEach((h) =>
    h.entries?.forEach((e) => {
      if (!exercises.has(exerciseKey(e))) exercises.set(exerciseKey(e), exerciseName(e));
    })
  );
  if (!exercises.has(state.analyticsExercise))
    state.analyticsExercise = exercises.keys().next().value || null;
  const selected = state.analyticsExercise;
  const totalVolume = history.reduce((s, h) => s + (h.volume || volumeOf(h)), 0);
  const muscles = volumeByMuscle(history);
  const maxMuscle = muscles[0]?.volume || 1;
  const hasBody = getBody().some((b) => number(b.weight));
  const rangeControl = `<div class="segmented" role="group" aria-label="${t('range.aria')}">${RANGES.map((key) => `<button type="button" class="${key === range ? 'active' : ''}" data-range="${key}" aria-pressed="${key === range}">${t(`range.${key}`)}</button>`).join('')}</div>`;
  const rows = history
    .map(
      (h) =>
        `<button type="button" class="row" data-session="${esc(h.id)}"><span class="row-main"><b>${esc(h.dayName || h.day)}</b><small>${fmtLong(h.day || h.finishedAt)}${markerText(h) ? ` · ${markerText(h)}` : ''}</small></span><span class="row-value"><b>${fmtVolume(h.volume || volumeOf(h))}</b><small>${plural(number(h.totalSets), 'sets')}</small></span>${icon('chevron-right')}</button>`
    )
    .join('');
  const head = `<section class="page-head"><h1>${t('history.title')}</h1><div class="page-actions"><button class="text-btn" data-nav="records">${t('history.records')}</button><button class="text-btn" data-nav="calendar">${t('history.calendar')}</button></div></section>`;
  if (!history.length) {
    return `<main class="shell">${head}${rangeControl}${empty(t('history.emptyTitle'), t('history.emptyText'), { label: t('history.emptyAction'), attrs: 'data-nav="home"' })}</main>`;
  }
  const tab = TABS.includes(state.analyticsTab) ? state.analyticsTab : 'overview';
  const tabs = `<div class="segmented analytics-tabs" role="tablist" aria-label="${t('history.title')}">${TABS.map((key) => `<button type="button" role="tab" class="${key === tab ? 'active' : ''}" data-analytics-tab="${key}" aria-selected="${key === tab}">${t(`analytics.tab.${key}`)}</button>`).join('')}</div>`;
  const sections = {
    overview: `<div class="stat-row"><div><b>${history.length}</b><span>${t('history.sessions')}</span></div><div><b>${fmtNumber(Math.round(toDisplay(totalVolume)))}</b><span>${t('history.volume', { unit: unit() })}</span></div><div><b>${history.reduce((n, h) => n + number(h.totalSets), 0)}</b><span>${t('history.sets')}</span></div></div>
    ${weeklySetsSection()}
    <section class="chart-section"><h2>${t('analytics.weeklyVolume')}</h2><canvas id="weeklyVolumeChart" height="180" role="img" aria-label="${t('analytics.weeklyVolumeAria')}"></canvas></section>
    <section class="chart-section"><h2>${t('analytics.frequency')}</h2><canvas id="frequencyChart" height="160" role="img" aria-label="${t('analytics.frequencyAria')}"></canvas></section>`,
    strength: `${trendSection(history, exercises, selected)}
    ${hasBody ? `<section class="chart-section"><h2>${esc(t('analytics.bodyStrengthOf', { name: exercises.get(selected) || '' }))}</h2><canvas id="bodyStrengthChart" height="200" role="img" aria-label="${t('analytics.bodyStrengthAria')}"></canvas><p class="muted analytics-hint" id="bodyStrengthHint">${t('analytics.bodyStrengthHint')}</p><p class="muted analytics-hint" id="bodyStrengthEmpty" hidden>${t('analytics.bodyStrengthEmpty')}</p></section>` : ''}
    <section class="chart-section"><h2>${t('history.muscles')}</h2><div class="bar-list">${muscles.map((m) => `<div class="bar-row"><span>${esc(groupLabel(m.group))}</span><div class="bar-track"><i style="width:${Math.max(2, (m.volume / maxMuscle) * 100)}%"></i></div><b>${fmtVolume(m.volume)}</b></div>`).join('')}</div><p class="muted analytics-hint">${t('analytics.musclesHint')}</p></section>`,
    sessions: `<section class="chart-section"><h2>${t('history.volumeChart')}</h2><canvas id="volumeChart" height="200" role="img" aria-label="${t('history.volumeChartAria')}"></canvas></section>
    ${timelineSection(history)}
    <section class="list-section"><h2>${t('history.sessions')}</h2><div class="list">${rows}</div></section>`,
  };
  return `<main class="shell">${head}
    ${rangeControl}
    ${tabs}
    ${sections[tab]}</main>`;
}

export function bind() {
  document.querySelectorAll('[data-trend-exercise]').forEach((b) => {
    b.onclick = () => {
      // A second tap folds the open chart away; the choice stays for the chart with the body weight.
      state.analyticsCollapsed =
        b.dataset.trendExercise === state.analyticsExercise && !state.analyticsCollapsed;
      state.analyticsExercise = b.dataset.trendExercise;
      render();
    };
  });
  document.querySelectorAll('[data-trend-group]').forEach((b) => {
    b.onclick = () => {
      state.analyticsGroup = b.dataset.trendGroup === state.analyticsGroup ? null : b.dataset.trendGroup;
      render();
    };
  });
  document.querySelectorAll('[data-list-mode]').forEach((b) => {
    b.onclick = () => {
      state.analyticsListMode = b.dataset.listMode;
      render();
    };
  });
  document.querySelector('#trendAll')?.addEventListener('click', () => {
    state.analyticsAll = true;
    render();
  });
  document.querySelectorAll('[data-analytics-tab]').forEach((b) => {
    b.onclick = () => {
      state.analyticsTab = b.dataset.analyticsTab;
      render();
    };
  });
  document.querySelectorAll('[data-range]').forEach((b) => {
    b.onclick = () => {
      state.analyticsRange = b.dataset.range;
      render();
    };
  });
  document.querySelectorAll('[data-week-mode]').forEach((b) => {
    b.onclick = () => {
      state.analyticsWeekMode = b.dataset.weekMode;
      render();
    };
  });
  document.querySelectorAll('[data-session], [data-session-record]').forEach((b) => {
    b.onclick = () =>
      navigate('session', {
        sessionFrom: 'analytics',
        sessionId: b.dataset.session || b.dataset.sessionRecord,
      });
  });
}
