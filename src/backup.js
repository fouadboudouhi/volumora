// JSON backup (export, validation, import) and CSV export.
import {
  LS,
  SCHEMA_VERSION,
  allPlans,
  clearActive,
  getBody,
  getCustomExercises,
  getHistory,
  getPrefs,
  getSettings,
  photos,
  promoteCustomExercises,
  saveBody,
  saveCustomExercises,
  saveHistory,
  savePlans,
  savePrefs,
  saveSettings,
  write,
} from './storage.js';
import { LANGUAGES, t } from './i18n.js';
import { GROUPS, exerciseName, normalizeLegacyExercise } from './library.js';
import { annotateAll } from './records.js';
import { SET_TYPES, TRACK_TYPES } from './sets.js';
import { dayKey, parseDate, setVolume, uid, volumeOf } from './util.js';

// Format number of the export file; independent of the storage schema version.
export const BACKUP_VERSION = 5;

export function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}
const stamp = () => new Date().toISOString().slice(0, 10);

export async function backupData() {
  const photoMap = await photos.entries().catch(() => ({}));
  const body = getBody().map(({ hasPhoto, ...e }) => ({
    ...e,
    photo: photoMap[e.id] || (typeof e.photo === 'string' ? e.photo : ''),
  }));
  const backup = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    plans: allPlans(),
    history: getHistory(),
    body,
    settings: getSettings(),
    exercisePrefs: getPrefs(),
    customExercises: getCustomExercises(),
  };
  return backup;
}

export async function exportBackup() {
  const backup = await backupData();
  download(`volumora-backup-${stamp()}.json`, JSON.stringify(backup, null, 2), 'application/json');
}

export function exportCsv() {
  const columns = [
    'date',
    'plan',
    'workout',
    'exercise',
    'set',
    'type',
    'weight',
    'reps',
    'rir',
    'rpe',
    'volume',
    'time',
    'distance',
  ];
  const rows = [columns.map((k) => t(`csv.${k}`))];
  const typeLabel = (set) => {
    const type = SET_TYPES.includes(set.type) ? set.type : set.warmup ? 'warmup' : 'normal';
    return t(type === 'normal' ? 'csv.work' : `csv.${type}`);
  };
  getHistory().forEach((h) =>
    h.entries.forEach((e) =>
      e.sets.forEach((s, i) =>
        rows.push([
          h.finishedAt,
          h.planName,
          h.dayName,
          exerciseName(e),
          i + 1,
          typeLabel(s),
          s.weight,
          s.reps,
          s.rir,
          s.rpe,
          setVolume({ ...s, done: true }, e.trackType),
          s.time ?? '',
          s.distance ?? '',
        ])
      )
    )
  );
  const csv = rows
    .map((r) => r.map((x) => `"${String(x ?? '').replaceAll('"', '""')}"`).join(';'))
    .join('\n');
  download(`volumora-training-${stamp()}.csv`, csv, 'text/csv;charset=utf-8');
}

// Every value of an imported file is coerced to the shape the app expects, so a hand-edited or foreign file
// cannot break rendering or smuggle markup into the page.
const asStr = (v, max = 300) =>
  typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
// Ids are written into attributes and used to find things again. One of any other shape than the app's own is
// swapped for a harmless one made from it. The same id always becomes the same new one, so plans and history that
// point at each other still do.
const SAFE_ID = /^[\w.:-]{1,80}$/;
const asId = (v) => {
  const id = asStr(v);
  if (!id || SAFE_ID.test(id)) return id;
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return `id-${(hash >>> 0).toString(36)}`;
};
const asNum = (v, fallback = 0, min = -Infinity, max = Infinity) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return v !== '' && v != null && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const asField = (v) =>
  v === '' || v == null
    ? ''
    : Number.isFinite(Number(String(v).replace(',', '.')))
      ? String(v).slice(0, 12)
      : '';
const asDate = (v) => parseDate(v)?.toISOString() || null;
const asUrl = (v) => (typeof v === 'string' && /^https:\/\//.test(v) ? v.slice(0, 500) : '');
const asPhoto = (v) =>
  typeof v === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : '';
const asSet = (s) => {
  const type = SET_TYPES.includes(s?.type) ? s.type : s?.warmup ? 'warmup' : 'normal';
  const time = asField(s?.time);
  const distance = asField(s?.distance);
  return {
    weight: asField(s?.weight),
    reps: asField(s?.reps),
    rir: asField(s?.rir),
    rpe: asField(s?.rpe),
    done: !!s?.done,
    warmup: type === 'warmup',
    type,
    ...(time ? { time } : {}),
    ...(distance ? { distance } : {}),
    ...(s?.pr ? { pr: true } : {}),
  };
};
const asExercise = (ex) =>
  normalizeLegacyExercise({
    id: asId(ex?.id) || uid(),
    libraryId: asId(ex?.libraryId) || undefined,
    name: asStr(ex?.name, 80) || t('exercise.fallback'),
    sourceName: asStr(ex?.sourceName, 80) || undefined,
    category: asStr(ex?.category, 40) || undefined,
    equipment: asStr(ex?.equipment, 40) || undefined,
    target: asStr(ex?.target, 40) || undefined,
    sets: asNum(ex?.sets, 3, 1, 12),
    range: asStr(ex?.range, 20) || '8–12',
    rest: asNum(ex?.rest, 0, 0, 600) || undefined,
    ...(asNum(ex?.increment, 0, 0.25, 50) ? { increment: asNum(ex.increment, 0, 0.25, 50) } : {}),
    gif: asUrl(ex?.gif),
    note: asStr(ex?.note, 300),
    ...(TRACK_TYPES.includes(ex?.trackType) ? { trackType: ex.trackType } : {}),
    ...(asId(ex?.supersetId) ? { supersetId: asId(ex.supersetId) } : {}),
    custom: ex?.custom ? true : undefined,
  });

export function validateBackup(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.plans?.items) || !Array.isArray(data.history))
    throw new Error('format');
  const plans = data.plans.items
    .filter((p) => p && typeof p === 'object' && Array.isArray(p.days))
    .map((p) => {
      const given = p.days.filter((d) => d && typeof d === 'object');
      const days = given.map((d) => ({
        id: asId(d.id) || uid(),
        name: asStr(d.name, 60) || t('day.fallback'),
        subtitle: asStr(d.subtitle, 80),
        exercises: (Array.isArray(d.exercises) ? d.exercises : []).map(asExercise),
      }));
      const assignments = {};
      days.forEach((d, i) => {
        const w = p.schedule?.assignments?.[given[i].id];
        if (Number.isInteger(w) && w >= 0 && w <= 6) assignments[d.id] = w;
      });
      return {
        id: asId(p.id) || uid(),
        name: asStr(p.name, 60) || t('plan.fallback'),
        description: asStr(p.description, 200),
        createdAt: asDate(p.createdAt) || new Date().toISOString(),
        schedule: { mode: p.schedule?.mode === 'fixed' ? 'fixed' : 'flexible', assignments },
        days,
      };
    });
  if (!plans.length) throw new Error('plans');
  const history = data.history
    .filter((h) => h && typeof h === 'object' && asDate(h.finishedAt))
    .map((h) => {
      const finishedAt = asDate(h.finishedAt);
      const session = {
        id: asId(h.id) || uid(),
        planId: asId(h.planId),
        planName: asStr(h.planName, 60),
        dayId: asId(h.dayId),
        dayName: asStr(h.dayName, 60) || asStr(h.day, 60),
        startedAt: asDate(h.startedAt) || finishedAt,
        finishedAt,
        day: /^\d{4}-\d{2}-\d{2}$/.test(h.day || '') ? h.day : dayKey(finishedAt),
        duration: asNum(h.duration, 0, 0),
        totalSets: asNum(h.totalSets, 0, 0),
        markers: { deload: !!h.markers?.deload, ill: !!h.markers?.ill, pain: !!h.markers?.pain },
        ...([1, 2, 3, 4, 5].includes(h.effort) ? { effort: h.effort } : {}),
        ...(asStr(h.imported?.key, 160)
          ? { imported: { source: asStr(h.imported.source, 20), key: asStr(h.imported.key, 160) } }
          : {}),
        ...(h.detached
          ? { detached: true, exercises: (Array.isArray(h.exercises) ? h.exercises : []).map(asExercise) }
          : {}),
        entries: (Array.isArray(h.entries) ? h.entries : []).map((e) => ({
          exerciseId: asId(e?.exerciseId),
          libraryId: asId(e?.libraryId) || undefined,
          name: asStr(e?.name, 80) || t('exercise.fallback'),
          note: asStr(e?.note, 500),
          ...(TRACK_TYPES.includes(e?.trackType) ? { trackType: e.trackType } : {}),
          ...(asId(e?.supersetId) ? { supersetId: asId(e.supersetId) } : {}),
          sets: (Array.isArray(e?.sets) ? e.sets : []).map(asSet),
        })),
      };
      session.volume = asNum(h.volume, 0, 0) || volumeOf(session);
      return session;
    });
  const body = (Array.isArray(data.body) ? data.body : [])
    .filter((e) => e && typeof e === 'object' && asDate(e.date))
    .map((e) => ({
      id: asId(e.id) || uid(),
      date: asDate(e.date),
      day: /^\d{4}-\d{2}-\d{2}$/.test(e.day || '') ? e.day : dayKey(e.date),
      weight: asNum(e.weight, 0, 0, 500) || '',
      waist: asNum(e.waist, 0, 0, 400) || '',
      chest: asNum(e.chest, 0, 0, 400) || '',
      arm: asNum(e.arm, 0, 0, 200) || '',
      thigh: asNum(e.thigh, 0, 0, 300) || '',
      photo: asPhoto(e.photo),
    }));
  const s = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const settings = {
    language: ['auto', ...LANGUAGES].includes(s.language) ? s.language : 'auto',
    theme: ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : 'auto',
    rest: asNum(s.rest, 90, 0, 600),
    increment: asNum(s.increment, 2.5, 0.25, 50),
    showRir: !!s.showRir,
    restTimer: s.restTimer !== false,
    restNotify: !!s.restNotify,
    unit: s.unit === 'lbs' ? 'lbs' : 'kg',
    weeklyGoal: asNum(s.weeklyGoal, 0, 0, 14),
    barWeight: asNum(s.barWeight, 20, 0, 50),
    restSound: s.restSound !== false,
    restVibrate: s.restVibrate !== false,
    defaultSets: asNum(s.defaultSets, 3, 1, 12),
    defaultRange: asStr(s.defaultRange, 20) || '8–12',
  };
  const prefs = data.exercisePrefs && typeof data.exercisePrefs === 'object' ? data.exercisePrefs : {};
  const exercisePrefs = {
    favorites: (Array.isArray(prefs.favorites) ? prefs.favorites : [])
      .map((x) => asId(x))
      .filter(Boolean)
      .slice(0, 200),
    recent: (Array.isArray(prefs.recent) ? prefs.recent : [])
      .map((x) => asId(x))
      .filter(Boolean)
      .slice(0, 12),
  };
  const customExercises = (Array.isArray(data.customExercises) ? data.customExercises : [])
    .filter((c) => c && typeof c === 'object' && asStr(c.name, 80))
    .slice(0, 500)
    .map((c) => ({
      id: asId(c.id) || uid(),
      name: asStr(c.name, 80),
      category: GROUPS.includes(c.category) ? c.category : 'other',
      equipment: asStr(c.equipment, 40) || 'other',
      trackType: TRACK_TYPES.includes(c.trackType) ? c.trackType : 'weight_reps',
      note: asStr(c.note, 300),
      createdAt: asDate(c.createdAt) || new Date().toISOString(),
    }));
  const wanted = asId(data.plans.activePlanId);
  const activePlanId = plans.some((p) => p.id === wanted) ? wanted : plans[0].id;
  return { plans: { activePlanId, items: plans }, history, body, settings, exercisePrefs, customExercises };
}

// Stores the photos of the given body entries and returns how many could not be stored. Those entries lose their
// photo flag in the list as it is stored by then: the person may have saved an entry while the photos were written.
async function storePhotos(entries) {
  const failed = new Set();
  for (const entry of entries) {
    if (!entry.photo) continue;
    await photos.set(entry.id, entry.photo).catch(() => failed.add(entry.id));
  }
  if (failed.size) saveBody(getBody().map((b) => (failed.has(b.id) ? { ...b, hasPhoto: false } : b)));
  return failed.size;
}

// Replaces all local data with the validated backup. Returns the number of photos that could not be stored.
// Throws when local storage is full; the existing data then stays as it was.
export async function importBackup(backup) {
  const keys = [LS.plans, LS.history, LS.body, LS.settings, LS.exercisePrefs, LS.customExercises];
  const before = keys.map((key) => localStorage.getItem(key));
  const body = backup.body.map(({ photo, ...rest }) => ({ ...rest, hasPhoto: !!photo }));
  const stored = [
    savePlans(backup.plans),
    saveHistory(backup.history),
    saveBody(body),
    saveSettings(backup.settings),
    savePrefs(backup.exercisePrefs),
    saveCustomExercises(backup.customExercises || []),
  ].every(Boolean);
  if (!stored) {
    keys.forEach((key, i) =>
      before[i] === null ? localStorage.removeItem(key) : localStorage.setItem(key, before[i])
    );
    throw new Error('storage');
  }
  await photos.clear().catch(() => {});
  const failed = await storePhotos(backup.body);
  // Older backups keep custom exercises inside plans; move them into the store like the migration does.
  promoteCustomExercises();
  clearActive();
  write(LS.schema, SCHEMA_VERSION);
  return failed;
}

// Brings another state of the same account onto this device without taking anything away: `theirs` is a validated
// backup, usually what the server holds. Workouts, body entries and own exercises are kept from both sides by their
// id, and where both have one, the copy on this device stays. Plans, settings and exercise preferences are one
// piece each: `keep` names those this device keeps, the others are taken over. A running workout and the photos
// already here are not touched. Everything but the new photos is stored before the first pause, so nothing else can
// be stored in between. Throws when local storage is full; the data then stays as it was.
export async function mergeBackup(theirs, keep = {}) {
  const keys = [LS.plans, LS.history, LS.body, LS.settings, LS.exercisePrefs, LS.customExercises];
  const before = keys.map((key) => localStorage.getItem(key));
  // Ids are compared the way the validation writes them: a record here whose id it would rewrite is the same record
  // as its rewritten copy over there. Nothing the other side holds twice is taken twice.
  const missingIn = (mine, others) => {
    const ids = new Set(mine.map((item) => asId(item.id)));
    return others.filter((item) => !ids.has(item.id) && ids.add(item.id));
  };
  const newest = (field) => (a, b) => new Date(b[field]) - new Date(a[field]);
  const sessions = missingIn(getHistory(), theirs.history);
  const entries = missingIn(getBody(), theirs.body);
  const customs = missingIn(getCustomExercises(), theirs.customExercises || []);
  const body = [...entries.map(({ photo, ...rest }) => ({ ...rest, hasPhoto: !!photo })), ...getBody()].sort(
    newest('date')
  );
  const stored = [
    keep.plans || savePlans(theirs.plans),
    // Record flags depend on everything that came before, so they are worked out again over the joined history.
    !sessions.length || saveHistory(annotateAll([...sessions, ...getHistory()].sort(newest('finishedAt')))),
    !entries.length || saveBody(body),
    keep.settings || saveSettings(theirs.settings),
    keep.exercisePrefs || savePrefs(theirs.exercisePrefs),
    !customs.length || saveCustomExercises([...getCustomExercises(), ...customs]),
  ].every(Boolean);
  if (!stored) {
    keys.forEach((key, i) =>
      before[i] === null ? localStorage.removeItem(key) : localStorage.setItem(key, before[i])
    );
    throw new Error('storage');
  }
  // Plans from an older version keep custom exercises inside; move them into the store like the migration does.
  if (!keep.plans) promoteCustomExercises();
  await storePhotos(entries);
}
