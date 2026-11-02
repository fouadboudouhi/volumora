// Personal records, derived from the history on demand and cached per history revision. Nothing is stored:
// editing, deleting or importing sessions keeps records correct by construction.
import { setComplete } from './sets.js';
import { getHistory, getHistoryRevision } from './storage.js';
import { dayKey, e1rm, exerciseKey, number } from './util.js';
import { entryTrackType } from './workout.js';

// Record kinds per exercise type; the first one is the headline record that decides `set.pr`.
export const KINDS = {
  weight_reps: ['e1rm', 'maxWeight', 'maxVolume'],
  reps: ['maxReps', 'maxWeight'],
  time: ['maxTime'],
  distance_time: ['maxDistance', 'maxTime'],
};
export const headlineKind = (trackType) => (KINDS[trackType] || KINDS.weight_reps)[0];

const valueOf = (kind, set) => {
  switch (kind) {
    case 'e1rm':
      return e1rm(set.weight, set.reps);
    case 'maxWeight':
      return number(set.weight);
    case 'maxVolume':
      return number(set.weight) * number(set.reps);
    case 'maxReps':
      return number(set.reps);
    case 'maxTime':
      return number(set.time);
    case 'maxDistance':
      return number(set.distance);
    default:
      return 0;
  }
};
const stamp = (session) => `${session.day || dayKey(session.finishedAt)}|${session.finishedAt || ''}`;
const chronological = (history) => history.slice().sort((a, b) => stamp(a).localeCompare(stamp(b)));

// Folds a session's completed working sets into `bests`: { [key]: { item, trackType, [kind]: { value, set, day, sessionId } } }.
function fold(session, bests) {
  const day = session.day || dayKey(session.finishedAt);
  for (const entry of session.entries || []) {
    const key = exerciseKey(entry);
    if (!key) continue;
    const trackType = entryTrackType(entry);
    const record = (bests[key] ||= {
      key,
      item: { exerciseId: entry.exerciseId, libraryId: entry.libraryId, name: entry.name },
      trackType,
    });
    for (const set of entry.sets) {
      if (!setComplete(set, trackType)) continue;
      for (const kind of KINDS[trackType] || KINDS.weight_reps) {
        const value = valueOf(kind, set);
        if (value > (record[kind]?.value || 0))
          record[kind] = {
            value,
            set: { weight: set.weight, reps: set.reps, time: set.time, distance: set.distance },
            day,
            sessionId: session.id,
          };
      }
    }
  }
  return bests;
}

// Flags the sets of `session` that beat the bests achieved before it (and earlier sets of the same session).
function mark(session, bests) {
  for (const entry of session.entries || []) {
    const key = exerciseKey(entry);
    const trackType = entryTrackType(entry);
    const kind = headlineKind(trackType);
    let best = bests[key]?.[kind]?.value || 0;
    // The first session of an exercise sets the baseline; it has nothing to beat yet.
    const hasBaseline = best > 0;
    for (const set of entry.sets) {
      const value = setComplete(set, trackType) ? valueOf(kind, set) : 0;
      set.pr = hasBaseline && value > best;
      if (value > best) best = value;
    }
  }
}

export const computeRecords = (history) => chronological(history).reduce((bests, s) => fold(s, bests), {});

// Bests before `session`: everything that happened earlier, the session itself excluded.
const before = (session, history) =>
  computeRecords(history.filter((h) => h.id !== session.id && stamp(h) < stamp(session)));

// Sets `set.pr` for a session that is about to be stored (or re-stored).
export function annotatePrs(session, history = getHistory()) {
  mark(session, before(session, history));
  return session;
}
// Recomputes every `set.pr` of the whole history in chronological order (idempotent).
export function annotateAll(history) {
  const bests = {};
  chronological(history).forEach((session) => {
    mark(session, bests);
    fold(session, bests);
  });
  return history;
}

// Records achieved in `session`: [{ key, item, trackType, kind, value, previous }], headline kinds first.
export function sessionRecords(session, history = getHistory()) {
  const earlier = before(session, history);
  const own = fold(session, {});
  const result = [];
  for (const record of Object.values(own)) {
    for (const kind of KINDS[record.trackType] || KINDS.weight_reps) {
      const value = record[kind]?.value || 0;
      const previous = earlier[record.key]?.[kind]?.value || 0;
      if (previous && value > previous)
        result.push({
          key: record.key,
          item: record.item,
          trackType: record.trackType,
          kind,
          value,
          previous,
        });
    }
  }
  return result;
}

let cache = { revision: -1, records: {} };
export function allRecords() {
  const revision = getHistoryRevision();
  if (cache.revision !== revision) cache = { revision, records: computeRecords(getHistory()) };
  return cache.records;
}
export const recordsFor = (key) => allRecords()[exerciseKey({ id: key })] || null;
