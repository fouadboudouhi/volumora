// Session logic: creating, resuming and finishing a workout, progression suggestions, warm-up sets.
import { t } from './i18n.js';
import { annotateAll, annotatePrs } from './records.js';
import { fillFromReference, newSetFor, setReady, setScore, setType, trackTypeOf } from './sets.js';
import { state } from './state.js';
import {
  activePlan,
  clearActive,
  findPlan,
  getActive,
  getHistory,
  getSettings,
  saveActive,
  saveHistory,
  saveRestUntil,
} from './storage.js';
import { libraryOf } from './library.js';
import { plateStep, roundToStep } from './units.js';
import {
  clone,
  dayKey,
  doneSets,
  exerciseKey,
  isWorkSet,
  number,
  parseDate,
  rangeMax,
  rangeMid,
  rangeMin,
  setsCount,
  uid,
  volumeOf,
} from './util.js';

const HOUR = 3600000;
const MAX_DURATION = 6 * HOUR;

// What a new set inherits from the matching set of the last session: weight, time and distance, never reps.
const carry = (set) =>
  set
    ? {
        weight: set.weight ?? '',
        ...(set.time !== undefined ? { time: set.time } : {}),
        ...(set.distance !== undefined ? { distance: set.distance } : {}),
      }
    : {};

const loggedSets = (entry) => entry.sets.filter((s) => s.done && isWorkSet(s));
// Newest history entry in which the exercise was actually trained, in any plan.
export function previousEntry(ex) {
  const key = exerciseKey(ex);
  for (const session of getHistory()) {
    const entry = session.entries?.find((e) => exerciseKey(e) === key);
    if (entry && loggedSets(entry).length) return entry;
  }
  return null;
}
// The completed working sets of the last time, the values a new workout starts from.
export const previousWork = (ex) => {
  const entry = previousEntry(ex);
  return entry ? loggedSets(entry) : [];
};
// What a set falls back to while it is empty: the same set of the last session, else the set before it.
export function setReference(entry, index, lastWork) {
  const set = entry.sets[index];
  if (!isWorkSet(set)) return null;
  const workIndex = entry.sets.slice(0, index).filter(isWorkSet).length;
  if (lastWork[workIndex]) return lastWork[workIndex];
  for (let i = index - 1; i >= 0; i--) {
    const s = entry.sets[i];
    if (isWorkSet(s) && [s.weight, s.reps, s.time, s.distance].some((v) => number(v) > 0)) return s;
  }
  return null;
}
// Reps to start from for an exercise done for the first time: the middle of its range.
export const repsStart = (ex, lastWork = []) =>
  lastWork.length || !['weight_reps', 'reps'].includes(trackTypeOf(ex)) ? null : rangeMid(ex?.range);
// Ticks or unticks a set. Returns false when it holds nothing to log yet.
export function toggleSet(session, exerciseIndex, setIndex, lastWork = []) {
  const entry = session.entries[exerciseIndex];
  const set = entry.sets[setIndex];
  if (set.done) {
    set.done = false;
    set.pr = false;
    return true;
  }
  const trackType = entryTrackType(entry);
  fillFromReference(set, setReference(entry, setIndex, lastWork), trackType);
  // The grey start value counts like any other, but only once the set can be logged with it.
  const start = repsStart(sessionExercises(session)[exerciseIndex], lastWork);
  if (start && !number(set.reps) && setReady({ ...set, reps: start }, trackType)) set.reps = start;
  if (!setReady(set, trackType)) return false;
  set.done = true;
  touchSession(session);
  session.lastSetAt = session.lastActivityAt;
  entry.lastSetAt = session.lastActivityAt;
  return true;
}
// Where the user is in a running workout: the next open set after the exercise ticked last, so a skipped
// exercise does not pull them back. Inside a superset that is the member the round has not reached yet.
export function currentSpot(session) {
  const entries = session?.entries || [];
  const lastDone = (entry) => entry.sets.findLastIndex((set) => set.done);
  const openSet = (entry) => entry.sets.findIndex((set, i) => !set.done && i > lastDone(entry));
  let anchor = -1;
  entries.forEach((entry, i) => {
    if (lastDone(entry) < 0) return;
    if (anchor < 0 || (entry.lastSetAt || '') >= (entries[anchor].lastSetAt || '')) anchor = i;
  });
  if (anchor < 0) return null;
  const exercises = sessionExercises(session);
  for (let step = 0; step < entries.length; step++) {
    const index = (anchor + step) % entries.length;
    const id = exercises[index]?.supersetId;
    const group = entries
      .map((_, i) => i)
      .filter((i) => (id ? exercises[i]?.supersetId === id : i === index));
    const open = group.filter((i) => openSet(entries[i]) >= 0);
    if (!open.length) continue;
    const doneIn = (i) => entries[i].sets.filter((set) => set.done).length;
    const exercise = open.reduce((best, i) => (doneIn(i) < doneIn(best) ? i : best));
    return { exercise, set: openSet(entries[exercise]) };
  }
  return { exercise: anchor, set: lastDone(entries[anchor]) };
}
// The set that comes next for an exercise: the first open working set, or a new one when all are done.
export function nextOpenSet(session, exerciseIndex) {
  const entry = session.entries[exerciseIndex];
  const open = entry.sets.findIndex((set) => !set.done && isWorkSet(set));
  if (open >= 0) return open;
  entry.sets.push(newSetFor(entryTrackType(entry)));
  return entry.sets.length - 1;
}
// Writes values into a set and ticks it. Weight in kilograms, time in seconds, distance in kilometres.
export function logSet(session, exerciseIndex, setIndex, values) {
  const entry = session.entries[exerciseIndex];
  const set = entry.sets[setIndex];
  for (const key of ['weight', 'reps', 'distance'])
    if (values[key] !== undefined) set[key] = String(values[key]);
  if (values.time !== undefined) set.time = values.time;
  const ex = sessionExercises(session)[exerciseIndex];
  if (!toggleSet(session, exerciseIndex, setIndex, previousWork(ex))) return false;
  set.pr = isRecord(ex, set, entry);
  return true;
}
// The clock starts with the first thing logged, not with opening the screen.
export function touchSession(session, at = new Date().toISOString()) {
  if (!session.begun) {
    session.begun = true;
    session.startedAt = at;
  }
  session.lastActivityAt = at;
}
export const workSets = (entry) => entry.sets.filter(isWorkSet);
export const entryComplete = (entry) => workSets(entry).length > 0 && workSets(entry).every((s) => s.done);
export const entryTrackType = (entry) => entry.trackType || trackTypeOf(entry);

// The exercises a session trains: its own list once detached (free workouts, edits during the workout),
// otherwise the plan day's.
export const sessionExercises = (session) =>
  session?.exercises || findPlan(session?.planId)?.days.find((d) => d.id === session?.dayId)?.exercises || [];

const entryFor = (ex) => {
  const trackType = trackTypeOf(ex);
  const last = previousWork(ex);
  return {
    exerciseId: ex.id,
    libraryId: ex.libraryId || undefined,
    name: ex.name,
    trackType,
    ...(ex.supersetId ? { supersetId: ex.supersetId } : {}),
    note: '',
    sets: Array.from({ length: setsCount(ex.sets) }, (_, i) => newSetFor(trackType, carry(last[i]))),
  };
};
const blankSession = () => ({
  id: uid(),
  startedAt: new Date().toISOString(),
  markers: { deload: false, ill: false, pain: false },
});

export function freshSession(planId, dayId) {
  const plan = findPlan(planId);
  const day = plan?.days.find((d) => d.id === dayId);
  if (!plan || !day) return null;
  return {
    ...blankSession(),
    planId,
    planName: plan.name,
    dayId,
    dayName: day.name,
    entries: day.exercises.map(entryFor),
  };
}
// A workout without a plan: exercises are added as you go.
export const freshFreeSession = () => ({
  ...blankSession(),
  planId: null,
  planName: '',
  dayId: null,
  dayName: t('workout.freeName'),
  detached: true,
  exercises: [],
  entries: [],
});

// A plan exercise rebuilt from its entry, for when the plan no longer holds it.
const exerciseFromEntry = (entry) => {
  const lib = libraryOf(entry);
  return {
    id: entry.exerciseId,
    ...(entry.libraryId ? { libraryId: entry.libraryId } : {}),
    name: entry.name,
    gif: lib?.gif,
    sets: entry.sets.length,
    range: lib?.range || getSettings().defaultRange || '8–12',
    note: '',
    ...(entry.trackType ? { trackType: entry.trackType } : {}),
    ...(entry.supersetId ? { supersetId: entry.supersetId } : {}),
  };
};
const worked = (entry) => entry.sets.some((s) => s.done || s.touched);

// The plan day may have been edited while this session was open: entries follow the current exercise list and
// new exercises get fresh sets. A removed exercise goes too, unless it already holds work: then the session
// detaches from the day and keeps it. Returns true when something changed.
export function syncSessionWithDay(session, day) {
  const before = (session.entries || []).map((e) => e.exerciseId).join('|');
  const template = freshSession(session.planId, session.dayId);
  const orphans = (session.entries || []).filter(
    (e) => worked(e) && !day.exercises.some((ex) => ex.id === e.exerciseId)
  );
  session.entries = day.exercises.map((ex, i) => {
    const existing = session.entries?.find((e) => e.exerciseId === ex.id);
    if (existing) {
      existing.name = ex.name;
      existing.libraryId = ex.libraryId || undefined;
      existing.trackType ||= template.entries[i].trackType;
      return existing;
    }
    return template.entries[i];
  });
  session.dayName = day.name;
  if (orphans.length) {
    session.exercises = [...clone(day.exercises), ...orphans.map(exerciseFromEntry)];
    session.entries.push(...orphans);
    session.detached = true;
  }
  return session.entries.map((e) => e.exerciseId).join('|') !== before;
}

// The stored running workout, brought in line with its plan. If its day is gone, a begun session keeps going on
// its own and an untouched one simply ends.
export function reconcileActive() {
  const saved = getActive();
  if (!saved || saved.detached) return saved;
  const day = findPlan(saved.planId)?.days.find((d) => d.id === saved.dayId);
  if (day) {
    if (syncSessionWithDay(saved, day)) saveActive(saved);
    return saved;
  }
  if (!sessionStarted(saved)) {
    clearActive();
    return null;
  }
  saved.exercises = saved.entries.map(exerciseFromEntry);
  saved.detached = true;
  saveActive(saved);
  return saved;
}

// `planId` null means the free workout. A running workout is never replaced implicitly: a stale history entry or
// shortcut lands in it. Discarding it first is the only way to start another one.
export function activeSession(planId, dayId) {
  const saved = reconcileActive();
  const free = planId == null;
  if (
    saved &&
    (sessionStarted(saved) ||
      (free ? saved.planId == null : saved.planId === planId && saved.dayId === dayId))
  )
    return saved;
  const fresh = free ? freshFreeSession() : freshSession(planId, dayId);
  if (fresh) saveActive(fresh);
  return fresh;
}

// Edits during a workout detach the session from its plan day; the plan itself stays as it is.
export function detachSession(session) {
  if (session.detached) return session;
  session.exercises = clone(sessionExercises(session));
  session.detached = true;
  return session;
}
export function addSessionExercise(session, ex) {
  detachSession(session);
  touchSession(session);
  session.exercises.push(ex);
  session.entries.push(entryFor(ex));
}
export function removeSessionExercise(session, index) {
  detachSession(session);
  touchSession(session);
  const [ex] = session.exercises.splice(index, 1);
  const [entry] = session.entries.splice(index, 1);
  return { ex, entry };
}
export function restoreSessionExercise(session, index, ex, entry) {
  detachSession(session);
  const at = Math.min(index, session.exercises.length);
  session.exercises.splice(at, 0, ex);
  session.entries.splice(at, 0, entry);
}
export function moveSessionExercise(session, from, to) {
  detachSession(session);
  if (to < 0 || to >= session.exercises.length) return;
  for (const list of [session.exercises, session.entries]) [list[from], list[to]] = [list[to], list[from]];
}
// The replacement keeps the slot's targets (sets, range, rest, superset) and starts with fresh sets.
export function replaceSessionExercise(session, index, ex) {
  detachSession(session);
  touchSession(session);
  const old = session.exercises[index];
  const next = { ...ex, sets: old.sets, range: old.range, rest: old.rest };
  if (old.supersetId) next.supersetId = old.supersetId;
  session.exercises[index] = next;
  session.entries[index] = entryFor(next);
}
export function mutateSession(planId, dayId, fn) {
  const session = activeSession(planId, dayId);
  fn(session);
  saveActive(session);
  return session;
}
// Something would be lost if this session went away: a ticked set, typed values or a changed exercise list.
export const sessionStarted = (session) =>
  !!session?.entries?.length && (!!session.begun || session.entries.some((e) => e.sets.some((s) => s.done)));
// Leftovers of a workout that ended: the running rest and open note fields must not reach the next one.
export function resetWorkoutUi() {
  state.restUntil = 0;
  saveRestUntil(0);
  state.openNotes = null;
}

// Progressive overload for weight × reps exercises: every working set hit the top of the range (with at least
// one rep in reserve when RIR was logged) -> add the increment; otherwise repeat the weight and add reps.
// The last `limit` history entries of an exercise, newest first.
export function recentEntries(ex, limit = 3, history = getHistory()) {
  const key = exerciseKey(ex);
  const rows = [];
  for (const session of history) {
    const entry = session.entries?.find((e) => exerciseKey(e) === key);
    if (entry && loggedSets(entry).length) rows.push(entry);
    if (rows.length >= limit) break;
  }
  return rows;
}
const bestScoreOf = (entry) => Math.max(0, ...entry.sets.map((s) => setScore(s, entryTrackType(entry))));

// Three sessions in a row without a better estimated 1RM, close to the all-time best: time for a lighter week.
// Sessions already well below the best are that lighter week, so the advice cannot spiral downwards.
export function stalled(ex, history = getHistory()) {
  const all = recentEntries(ex, Infinity, history).map(bestScoreOf);
  const recent = all.slice(0, 3);
  if (recent.length < 3 || recent.some((v) => !v)) return false;
  const [newest, middle, oldest] = recent;
  return newest <= oldest && middle <= oldest && newest >= Math.max(...all) * 0.95;
}

const DAY_MS = 86400000;
const TREND_DAYS = 56;
const COMEBACK_DAYS = 21;
const sessionTime = (session) => parseDate(session.finishedAt || session.day)?.getTime() || 0;

// Best estimated strength per session of an exercise, newest first.
function strengthPoints(ex, history) {
  const key = exerciseKey(ex);
  return history.flatMap((session) => {
    const entry = session.entries?.find((e) => exerciseKey(e) === key);
    return entry && loggedSets(entry).length ? [{ at: sessionTime(session), score: bestScoreOf(entry) }] : [];
  });
}

// Direction of the last eight weeks as a straight line through the sessions: the change in percent, or null when
// fewer than three sessions over two weeks say too little.
export function strengthTrend(ex, history = getHistory(), today = new Date()) {
  const points = strengthPoints(ex, history).filter(
    (p) => p.at && p.score && today.getTime() - p.at <= TREND_DAYS * DAY_MS
  );
  if (points.length < 3) return null;
  const first = Math.min(...points.map((p) => p.at));
  const days = (Math.max(...points.map((p) => p.at)) - first) / DAY_MS;
  if (days < 14) return null;
  const meanX = points.reduce((sum, p) => sum + (p.at - first) / DAY_MS, 0) / points.length;
  const meanY = points.reduce((sum, p) => sum + p.score, 0) / points.length;
  const slope =
    points.reduce((sum, p) => sum + ((p.at - first) / DAY_MS - meanX) * (p.score - meanY), 0) /
    points.reduce((sum, p) => sum + ((p.at - first) / DAY_MS - meanX) ** 2, 0);
  return { percent: (slope * days * 100) / meanY, weeks: Math.round(days / 7), sessions: points.length };
}

// Weeks of training without getting stronger, even if single sessions go up and down, so `stalled` misses it.
// Recent lighter sessions count as the break already taken.
function plateaued(ex, history, today) {
  const trend = strengthTrend(ex, history, today);
  if (!trend || trend.sessions < 5 || trend.weeks < 4 || trend.percent >= 1) return false;
  const scores = strengthPoints(ex, history).map((p) => p.score);
  return scores.slice(0, 3).every((score) => score >= Math.max(...scores) * 0.95);
}

const belowRange = (entry, min) =>
  Math.max(0, ...entry.sets.filter((s) => isWorkSet(s) && s.done).map((s) => number(s.reps))) < min;

// The working weight for today, from the last session and the weeks before it. Each kind says why, so the row can too.
export function suggestion(ex, history = getHistory(), today = new Date()) {
  if (trackTypeOf(ex) !== 'weight_reps') return { kind: 'start', weight: null };
  const previous = recentEntries(ex, 1, history)[0];
  if (!previous) return { kind: 'start', weight: null };
  // A drop set is meant to be lighter and shorter: it says nothing about the working weight.
  const work = previous.sets.filter((s) => isWorkSet(s) && s.done && setType(s) !== 'drop');
  const max = rangeMax(ex.range);
  const best = Math.max(...work.map((s) => number(s.weight)), 0);
  const lastAt = strengthPoints(ex, history)[0]?.at;
  const away = lastAt ? (today.getTime() - lastAt) / DAY_MS : 0;
  if (best && away >= COMEBACK_DAYS)
    return { kind: 'comeback', weight: roundToStep(best * 0.9), weeks: Math.floor(away / 7) };
  const hasRir = work.some((s) => s.rir !== '' && s.rir !== undefined);
  const averageRir = work.reduce((a, s) => a + number(s.rir), 0) / (work.length || 1);
  const ready = work.length && work.every((s) => number(s.reps) >= max) && (!hasRir || averageRir >= 1);
  // The plan exercise may carry its own increment; otherwise the setting, doubled for the heavy lower-body lifts.
  const base = number(ex.increment) || number(getSettings().increment) || 2.5;
  const lib = libraryOf(ex);
  const heavy = lib
    ? /squat|deadlift|leg press/.test(lib.sourceName)
    : /squat|deadlift|leg press|kniebeuge|kreuzheben|beinpresse/i.test(ex.name || '');
  const inc = number(ex.increment) || (heavy ? Math.max(plateStep() * 2, base) : base);
  if (ready) return { kind: 'progress', weight: best + inc };
  if (stalled(ex, history)) return { kind: 'stall', weight: roundToStep(best * 0.9) };
  const min = rangeMin(ex.range);
  const lastTwo = recentEntries(ex, 2, history);
  if (min && best > inc && lastTwo.length === 2 && lastTwo.every((entry) => belowRange(entry, min)))
    return { kind: 'reduce', weight: roundToStep(best - inc) };
  if (plateaued(ex, history, today)) {
    const trend = strengthTrend(ex, history, today);
    return { kind: 'plateau', weight: roundToStep(best * 0.9), weeks: trend.weeks };
  }
  return { kind: 'confirm', weight: best };
}

// The equipment this person trains with: from the active plan and the recent sessions.
export function usedEquipment(history = getHistory()) {
  const items = [
    ...(activePlan()?.days || []).flatMap((day) => day.exercises),
    ...history.slice(0, 30).flatMap((session) => session.entries || []),
  ];
  return [...new Set(items.map((item) => libraryOf(item)?.equipment).filter(Boolean))];
}

// Epley: estimated one-rep max, and the reps a given share of it allows.
export const repsAtPercent = (percent) => Math.max(1, Math.round(30 * (100 / percent - 1)));

export function warmupSets(target) {
  return [
    [0.4, 8],
    [0.6, 5],
    [0.8, 3],
  ].map(([factor, reps]) =>
    newSetFor('weight_reps', {
      weight: String(Math.round(roundToStep(target * factor) * 1000) / 1000),
      reps,
      warmup: true,
      type: 'warmup',
    })
  );
}
export const newSet = (trackType, overrides) => newSetFor(trackType, overrides);
export { carry as carryFromSet };

const typedOpen = (set, trackType) => !set.done && set.touched && setReady(set, trackType);
// What finishing would do with the working sets: done ones, typed but unticked ones, and the rest that drops out.
export function finishCounts(session) {
  const counts = { done: 0, typed: 0, open: 0 };
  for (const entry of session.entries) {
    const trackType = entryTrackType(entry);
    for (const set of workSets(entry)) {
      if (set.done) counts.done++;
      else if (typedOpen(set, trackType)) counts.typed++;
      else counts.open++;
    }
  }
  return counts;
}

// Stores the workout: typed sets count as done, everything else drops out. Returns the stored session, or null
// when storage is full; the running workout then stays exactly as it was.
export function finishSession(running) {
  const session = clone(running);
  for (const entry of session.entries) {
    const trackType = entryTrackType(entry);
    entry.sets.forEach((set) => {
      if (typedOpen(set, trackType)) set.done = true;
      delete set.touched;
    });
    entry.sets = entry.sets.filter((set) => set.done);
  }
  session.entries = session.entries.filter((entry) => entry.sets.length);
  // A workout left open ends with its last set, not whenever the app was opened again.
  const now = Date.now();
  const lastSet = session.lastSetAt ? new Date(session.lastSetAt).getTime() : now;
  const end = now - lastSet > HOUR ? lastSet : now;
  session.finishedAt = new Date(end).toISOString();
  session.day = dayKey(session.finishedAt);
  session.duration = Math.round(
    Math.min(MAX_DURATION, Math.max(60000, end - new Date(session.startedAt).getTime())) / 1000
  );
  delete session.begun;
  delete session.lastSetAt;
  delete session.lastActivityAt;
  session.entries.forEach((entry) => delete entry.lastSetAt);
  session.totalSets = doneSets(session);
  session.volume = volumeOf(session);
  session.entries.forEach((e) =>
    e.sets.forEach((x) => {
      x.rpe = x.rir === '' ? '' : 10 - number(x.rir);
    })
  );
  const history = getHistory();
  // Final record flags against everything stored before this session (the live toast only looked at done sets).
  annotatePrs(session, history);
  history.unshift(session);
  if (!saveHistory(history)) return null;
  clearActive();
  return session;
}

// Best completed working set of an exercise across the whole history (optionally ignoring one session).
export function bestBefore(key, { excludeSessionId } = {}) {
  let weight = 0;
  let best = 0;
  for (const session of getHistory()) {
    if (session.id === excludeSessionId) continue;
    for (const entry of session.entries || []) {
      if (exerciseKey(entry) !== key) continue;
      const type = entryTrackType(entry);
      for (const s of entry.sets) {
        const score = setScore(s, type);
        if (!score) continue;
        weight = Math.max(weight, number(s.weight));
        best = Math.max(best, score);
      }
    }
  }
  return { weight, score: best, e1rm: best };
}

// A set is a personal record when its score (estimated 1RM, reps, time or distance) beats every other
// completed set of the exercise, in the history and in the current session. The first time has nothing to beat.
export function isRecord(ex, set, entry) {
  const type = entry.trackType || trackTypeOf(ex);
  const value = setScore(set, type);
  if (!value) return false;
  const previous = bestBefore(exerciseKey(ex)).score;
  if (!previous) return false;
  const inSession = Math.max(0, ...entry.sets.filter((s) => s !== set).map((s) => setScore(s, type)));
  return value > previous && value > inSession;
}

// The last sessions that contained this exercise, newest first.
export function exerciseHistory(key, limit = 5) {
  const rows = [];
  for (const session of getHistory()) {
    const entry = session.entries?.find((e) => exerciseKey(e) === key);
    if (!entry) continue;
    const type = entryTrackType(entry);
    const sets = entry.sets.filter((s) => setScore(s, type) > 0);
    if (!sets.length) continue;
    rows.push({
      day: session.day || dayKey(session.finishedAt),
      dayName: session.dayName,
      trackType: type,
      bestSet: sets.reduce((top, s) => (setScore(s, type) > setScore(top, type) ? s : top)),
      sets: sets.map((s) => ({
        weight: number(s.weight),
        reps: number(s.reps),
        time: s.time ?? '',
        distance: s.distance ?? '',
        pr: !!s.pr,
      })),
      best: Math.max(...sets.map((s) => setScore(s, type))),
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

// Recomputes the derived fields of a finished session after editing and stores it.
export function saveEditedSession(session) {
  session.entries.forEach((e) =>
    e.sets.forEach((x) => {
      if (x.done && !setReady(x, entryTrackType(e))) x.done = false;
    })
  );
  session.totalSets = doneSets(session);
  session.volume = volumeOf(session);
  session.entries.forEach((e) =>
    e.sets.forEach((x) => {
      x.rpe = x.rir === '' || x.rir === undefined ? '' : 10 - number(x.rir);
    })
  );
  const history = getHistory();
  const index = history.findIndex((h) => h.id === session.id);
  if (index < 0) return false;
  history[index] = session;
  // Other sessions' record flags depend on this one, so all of them are recomputed.
  annotateAll(history);
  saveHistory(history);
  return true;
}
export function deleteSession(id) {
  const history = getHistory();
  const index = history.findIndex((h) => h.id === id);
  if (index < 0) return null;
  const [removed] = history.splice(index, 1);
  annotateAll(history);
  saveHistory(history);
  return { removed, index };
}
// Old workouts saved without a single logged value. They still count as training until they are removed.
const holdsNothing = (session) =>
  !(session.entries || []).some((entry) =>
    (entry.sets || []).some(
      (s) => s.done || number(s.reps) > 0 || number(s.time) > 0 || number(s.distance) > 0
    )
  );
export const emptySessionCount = (history = getHistory()) => history.filter(holdsNothing).length;
// Removes them and returns the history as it was, so the step can be undone.
export function removeEmptySessions() {
  const history = getHistory();
  const before = clone(history);
  const kept = history.filter((session) => !holdsNothing(session));
  annotateAll(kept);
  saveHistory(kept);
  return before;
}
export function restoreHistory(history) {
  annotateAll(history);
  saveHistory(history);
}
export function restoreSession(session, index) {
  const history = getHistory();
  history.splice(Math.min(index, history.length), 0, session);
  annotateAll(history);
  saveHistory(history);
}
