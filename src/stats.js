// Aggregations over sessions for summaries and analytics.
import { groupOf, libraryOf } from './library.js';
import { setScore } from './sets.js';
import {
  dayKey,
  exerciseKey,
  fmtDate,
  isWorkSet,
  number,
  parseDate,
  volumeOf,
  weekdayIndex,
} from './util.js';
import { entryTrackType } from './workout.js';

// Completed working sets per muscle group of one session, largest first: [{ group, sets }].
export function setsByGroup(session) {
  const totals = new Map();
  for (const entry of session.entries || []) {
    const sets = entry.sets.filter((s) => s.done && isWorkSet(s)).length;
    if (!sets) continue;
    const group = groupOf(entry);
    totals.set(group, (totals.get(group) || 0) + sets);
  }
  return [...totals].map(([group, sets]) => ({ group, sets })).sort((a, b) => b.sets - a.sets);
}

const sessionDay = (h) => h.day || dayKey(h.finishedAt);
// Monday 00:00 of the week that contains `date`.
export function startOfWeek(date = new Date()) {
  const d = new Date(date);
  d.setDate(d.getDate() - weekdayIndex(d));
  d.setHours(0, 0, 0, 0);
  return d;
}

// Where a set lands when a muscle only helps: biceps on a row, triceps on a press. The catalogue names muscles,
// the bars show groups.
const GROUP_OF_MUSCLE = {
  hamstrings: 'legs',
  quadriceps: 'legs',
  calves: 'legs',
  glutes: 'legs',
  soleus: 'legs',
  shoulders: 'shoulders',
  deltoids: 'shoulders',
  'rear deltoids': 'shoulders',
  'rotator cuff': 'shoulders',
  forearms: 'arms',
  triceps: 'arms',
  biceps: 'arms',
  brachialis: 'arms',
  core: 'core',
  'hip flexors': 'core',
  obliques: 'core',
  'lower abs': 'core',
  chest: 'chest',
  'upper chest': 'chest',
  'lower back': 'back',
  'upper back': 'back',
  traps: 'back',
  trapezius: 'back',
  rhomboids: 'back',
  'latissimus dorsi': 'back',
};
// Groups an exercise works on the side, without the one it is for.
export function helpingGroups(entry) {
  const main = groupOf(entry);
  const groups = (libraryOf(entry)?.secondary || []).map((muscle) => GROUP_OF_MUSCLE[muscle]).filter(Boolean);
  return [...new Set(groups)].filter((group) => group !== main);
}
// What each working set adds per group: one for the muscle it is for, `helping` for each one it works on the side.
function setsByGroupOf(entry, helping) {
  const sets = entry.sets.filter((s) => s.done && isWorkSet(s)).length;
  if (!sets) return [];
  return [[groupOf(entry), sets], ...(helping ? helpingGroups(entry).map((g) => [g, sets * helping]) : [])];
}

// Working sets per muscle group over the last `weeks` calendar weeks (the current one included), per week. Sets of
// an exercise count half for the groups that only help, the usual way of counting.
export function weeklySets(history, { weeks = 1, today = new Date(), helping = 0.5 } = {}) {
  const from = startOfWeek(today);
  from.setDate(from.getDate() - 7 * (weeks - 1));
  const fromKey = dayKey(from);
  const totals = new Map();
  history.forEach((h) => {
    if (sessionDay(h) < fromKey) return;
    for (const entry of h.entries || [])
      for (const [group, sets] of setsByGroupOf(entry, helping))
        totals.set(group, (totals.get(group) || 0) + sets);
  });
  return [...totals]
    .map(([group, sets]) => ({ group, sets: Math.round((sets / weeks) * 10) / 10 }))
    .sort((a, b) => b.sets - a.sets);
}

// One point per calendar week for the last `weeks` weeks, oldest first: [{ label, value }].
function perWeek(history, weeks, today, valueOf) {
  const start = startOfWeek(today);
  start.setDate(start.getDate() - 7 * (weeks - 1));
  const buckets = Array.from({ length: weeks }, (_, i) => {
    const monday = new Date(start);
    monday.setDate(start.getDate() + 7 * i);
    return { key: dayKey(monday), label: fmtDate(monday), value: 0 };
  });
  history.forEach((h) => {
    const day = sessionDay(h);
    const monday = startOfWeek(parseDate(day) || new Date());
    const bucket = buckets.find((b) => b.key === dayKey(monday));
    if (bucket) bucket.value += valueOf(h);
  });
  return buckets.map(({ label, value }) => ({ label, value }));
}
export const weeklyVolume = (history, weeks = 12, today = new Date()) =>
  perWeek(history, weeks, today, (h) => number(h.volume) || volumeOf(h));
export const frequency = (history, weeks = 12, today = new Date()) => perWeek(history, weeks, today, () => 1);
// Working sets of one muscle group per week, for its trend.
export const groupSetsPerWeek = (history, group, weeks = 12, today = new Date()) =>
  perWeek(history, weeks, today, (h) =>
    (h.entries || []).reduce(
      (n, e) => n + setsByGroupOf(e, 0.5).reduce((m, [g, sets]) => (g === group ? m + sets : m), 0),
      0
    )
  );

// Sessions with records, newest first: [{ sessionId, day, dayName, count, items }].
export function recordTimeline(history, limit = 10) {
  const rows = [];
  for (const h of history) {
    const items = (h.entries || []).filter((e) => e.sets.some((s) => s.pr));
    if (!items.length) continue;
    rows.push({
      sessionId: h.id,
      day: sessionDay(h),
      dayName: h.dayName,
      count: items.reduce((n, e) => n + e.sets.filter((s) => s.pr).length, 0),
      items: items.map((e) => ({ exerciseId: e.exerciseId, libraryId: e.libraryId, name: e.name })),
    });
    if (rows.length >= limit) break;
  }
  return rows.sort((a, b) => b.day.localeCompare(a.day));
}

// Best score of one exercise per session next to the body weight measured closest to that day (±10 days).
export function strengthVsBodyweight(history, bodyEntries, key) {
  const sessions = history
    .map((h) => {
      const e = h.entries?.find((x) => exerciseKey(x) === key);
      if (!e) return null;
      const type = entryTrackType(e);
      const best = Math.max(0, ...e.sets.map((s) => setScore(s, type)));
      return best ? { day: sessionDay(h), value: best } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.day.localeCompare(b.day));
  const weights = bodyEntries
    .filter((b) => number(b.weight))
    .map((b) => ({ day: b.day || dayKey(b.date), kg: number(b.weight) }));
  const nearest = (day) => {
    const target = parseDate(day)?.getTime() || 0;
    let best = null;
    weights.forEach((w) => {
      const diff = Math.abs((parseDate(w.day)?.getTime() || 0) - target);
      if (diff <= 10 * 86400000 && (!best || diff < best.diff)) best = { diff, kg: w.kg };
    });
    return best ? best.kg : null;
  };
  return {
    points: sessions.map((s) => ({ label: fmtDate(s.day), value: s.value })),
    weight: sessions.map((s) => ({ value: nearest(s.day) })),
  };
}
