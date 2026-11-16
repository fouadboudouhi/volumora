// Persistence: localStorage for structured data, IndexedDB for photos, plus versioned migrations.
import { t } from './i18n.js';
import { DEFAULT_PLAN_ID, GROUPS, defaultPlan, normalizeLegacyExercise, setCustomSource } from './library.js';
import { annotateAll } from './records.js';
import { setReady, trackTypeOf } from './sets.js';
import { toast } from './ui.js';
import { dayKey, doneSets, exerciseKey, uid, volumeOf } from './util.js';

export const LS = {
  schema: 'volumora-schema-version',
  plans: 'volumora-plans-v2',
  history: 'volumora-history-v2',
  active: 'volumora-active-v2',
  body: 'volumora-body-v2',
  settings: 'volumora-settings-v2',
  exercisePrefs: 'volumora-exercise-prefs-v1',
  rest: 'volumora-rest-until',
  onboarded: 'volumora-onboarded',
  customExercises: 'volumora-custom-exercises-v1',
  lastBackup: 'volumora-last-backup',
  deloadQuiet: 'volumora-deload-quiet',
  backupSnooze: 'volumora-backup-snooze',
  installTip: 'volumora-install-tip',
  aiKey: 'volumora-ai-key',
  aiChat: 'volumora-ai-chat',
  aiMemory: 'volumora-ai-memory',
  aiUsage: 'volumora-ai-usage',
};
// Prepora and the website live on the same address and share this storage and the caches with Volumora. Whatever
// Volumora clears is only what carries its own name.
export const OWN = /^volumora(-|$)/;
export function clearOwnStorage(storage = localStorage) {
  Array.from({ length: storage.length }, (_, i) => storage.key(i))
    .filter((key) => OWN.test(key))
    .forEach((key) => storage.removeItem(key));
}
export const DEFAULT_SETTINGS = {
  language: 'auto',
  theme: 'auto',
  rest: 90,
  increment: 2.5,
  showRir: false,
  restTimer: true,
  restNotify: false,
  unit: 'kg',
  weeklyGoal: 0,
  barWeight: 20,
  restSound: true,
  restVibrate: true,
  defaultSets: 3,
  defaultRange: '8–12',
};

export const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
// Who wants to know that stored data changed; the optional server copy listens here.
let changeListener = null;
export const onDataChange = (listener) => {
  changeListener = listener;
};
export const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    changeListener?.(key);
    return true;
  } catch (err) {
    console.error('Speichern fehlgeschlagen', err);
    toast(t('storage.full'), { duration: 9000 });
    return false;
  }
};

export const getSettings = () => ({ ...DEFAULT_SETTINGS, ...read(LS.settings, {}) });
export const saveSettings = (settings) => write(LS.settings, settings);

const defaultPlans = () => ({ activePlanId: DEFAULT_PLAN_ID, items: [defaultPlan()] });
export const isOnboarded = () => !!localStorage.getItem(LS.onboarded);
export const markOnboarded = () => localStorage.setItem(LS.onboarded, '1');
export const allPlans = () => read(LS.plans, defaultPlans());
export const savePlans = (plans) => write(LS.plans, plans);
export const findPlan = (planId) => allPlans().items.find((p) => p.id === planId);
export const activePlan = () => {
  const data = allPlans();
  return data.items.find((p) => p.id === data.activePlanId) || data.items[0];
};
export const getDay = (planId, dayId) => findPlan(planId)?.days.find((d) => d.id === dayId);
export function persistPlan(plan) {
  const data = allPlans();
  const index = data.items.findIndex((x) => x.id === plan.id);
  if (index < 0) data.items.push(plan);
  else data.items[index] = plan;
  savePlans(data);
}

export const getHistory = () => read(LS.history, []);
// Bumped on every write so derived data (records) can cache per revision.
let historyRevision = 0;
export const getHistoryRevision = () => historyRevision;
export const saveHistory = (history) => {
  historyRevision++;
  return write(LS.history, history);
};
export const getBody = () => read(LS.body, []);
export const saveBody = (entries) => write(LS.body, entries);
export const getPrefs = () => ({ favorites: [], recent: [], ...read(LS.exercisePrefs, {}) });
export const savePrefs = (prefs) => write(LS.exercisePrefs, prefs);

// Custom exercises: { id, name, category (group key), equipment, trackType, note, createdAt }.
export const getCustomExercises = () => read(LS.customExercises, []);
export const saveCustomExercises = (list) => write(LS.customExercises, list);
export function saveCustomExercise(record) {
  const list = getCustomExercises();
  const index = list.findIndex((x) => x.id === record.id);
  if (index < 0) list.push(record);
  else list[index] = record;
  saveCustomExercises(list);
  return record;
}
export function removeCustomExercise(id) {
  const list = getCustomExercises();
  const index = list.findIndex((x) => x.id === id);
  if (index < 0) return null;
  const [removed] = list.splice(index, 1);
  saveCustomExercises(list);
  return { removed, index };
}
setCustomSource(getCustomExercises);

// Custom exercises used to live inside plans (`custom: true`). They move into their own store, keeping their
// id, so plan exercises link to them like catalogue exercises and the history stays attached.
export function promoteCustomExercises() {
  const data = allPlans();
  const customs = getCustomExercises();
  let changed = false;
  data.items.forEach((p) =>
    p.days?.forEach((d) =>
      d.exercises?.forEach((ex) => {
        if (!ex.custom) return;
        if (!customs.some((c) => c.id === ex.id))
          customs.push({
            id: ex.id,
            name: ex.name || t('exercise.customName'),
            category: GROUPS.includes(ex.category) ? ex.category : 'other',
            equipment: ex.equipment || 'other',
            trackType: ex.trackType || 'weight_reps',
            note: ex.note || '',
            createdAt: new Date().toISOString(),
          });
        ex.libraryId = ex.id;
        delete ex.custom;
        delete ex.category;
        delete ex.equipment;
        changed = true;
      })
    )
  );
  if (!changed) return false;
  saveCustomExercises(customs);
  savePlans(data);
  return true;
}
// Everything lives on this device only, so the app asks for a backup: after five workouts without one, then when
// the last one is a month old and newer workouts exist. "Later" keeps it quiet for two weeks.
const DAY = 86400000;
export const getLastBackup = () => read(LS.lastBackup, null);
export const markBackup = () => write(LS.lastBackup, new Date().toISOString());
export const deloadQuietUntil = () => read(LS.deloadQuiet, 0);
export const quietDeload = (until) => write(LS.deloadQuiet, until);
export const snoozeBackup = (now = Date.now()) => write(LS.backupSnooze, now + 14 * DAY);
export function backupDue(history = getHistory(), now = Date.now()) {
  if (history.length < 5 || read(LS.backupSnooze, 0) > now) return false;
  const last = getLastBackup();
  if (!last) return true;
  return now - new Date(last).getTime() >= 30 * DAY && history.some((h) => h.finishedAt > last);
}
// The install tip waits on Heute after the first-run flow until it is dismissed or the app is installed.
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const queueInstallTip = () => {
  if (!installed()) localStorage.setItem(LS.installTip, '1');
};
export const installTipDue = () => !!localStorage.getItem(LS.installTip) && !installed();
export const dismissInstallTip = () => localStorage.removeItem(LS.installTip);
export const getActive = () => read(LS.active, null);
export const saveActive = (session) => write(LS.active, session);
export const clearActive = () => localStorage.removeItem(LS.active);
// The Claude API key stays out of the settings, so it never ends up in a backup file.
export const getAiKey = () => localStorage.getItem(LS.aiKey) || '';
export const hasAiKey = () => !!getAiKey();
export const saveAiKey = (key) => localStorage.setItem(LS.aiKey, key);
export const clearAiKey = () => localStorage.removeItem(LS.aiKey);
// The chat stays on this device too, the latest messages only.
const MAX_CHAT = 60;
// Only what the chat itself writes is read back: a message is a role and a text, a source a web address. A stored
// chat can also come from the account (a restore), so anything of another shape is dropped rather than drawn.
export const cleanChat = (chat) =>
  (Array.isArray(chat) ? chat : [])
    .filter(
      (m) =>
        m && typeof m === 'object' && typeof m.text === 'string' && ['user', 'assistant'].includes(m.role)
    )
    .map(({ sources, actions, ...message }) => ({
      ...message,
      ...(Array.isArray(sources)
        ? { sources: sources.filter((s) => s && typeof s === 'object' && /^https:\/\//.test(s.url)) }
        : {}),
      ...(Array.isArray(actions) ? { actions: actions.filter((a) => a && typeof a === 'object') } : {}),
    }));
export const getAiChat = () => cleanChat(read(LS.aiChat, []));
export const saveAiChat = (messages) => write(LS.aiChat, messages.slice(-MAX_CHAT));
// What the assistant keeps across chats. Like the chat, it stays on this device and out of backups.
export const getAiMemory = () => {
  const memory = read(LS.aiMemory, []);
  return Array.isArray(memory) ? memory : [];
};
export const saveAiMemory = (memory) => write(LS.aiMemory, memory);
const usageMonth = () => new Date().toISOString().slice(0, 7);
export const getAiCost = () => {
  const usage = read(LS.aiUsage, null);
  return usage?.month === usageMonth() ? Number(usage.dollars) || 0 : 0;
};
export const addAiCost = (dollars) =>
  write(LS.aiUsage, { month: usageMonth(), dollars: getAiCost() + dollars });
export const getRestUntil = () => Number(localStorage.getItem(LS.rest)) || 0;
export const saveRestUntil = (until) =>
  until ? localStorage.setItem(LS.rest, String(until)) : localStorage.removeItem(LS.rest);

// Progress photos live in IndexedDB. localStorage is limited to roughly 5 MB, which a handful of base64 photos would exhaust.
const PHOTO_DB = 'volumora-photos';
const PHOTO_STORE = 'photos';
const openPhotoDb = () =>
  new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB nicht verfügbar'));
    const req = indexedDB.open(PHOTO_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(PHOTO_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
const photoTx = (mode, fn) =>
  openPhotoDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, mode);
        const result = fn(tx.objectStore(PHOTO_STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
export const photos = {
  get: (id) =>
    photoTx('readonly', (s) => s.get(id))
      .then((req) => req.result)
      .catch(() => undefined),
  set: (id, dataUrl) => photoTx('readwrite', (s) => s.put(dataUrl, id)),
  remove: (id) => photoTx('readwrite', (s) => s.delete(id)).catch(() => {}),
  clear: () => photoTx('readwrite', (s) => s.clear()),
  entries: () =>
    photoTx('readonly', (s) => ({ keys: s.getAllKeys(), values: s.getAll() })).then(({ keys, values }) =>
      Object.fromEntries(keys.result.map((k, i) => [k, values.result[i]]))
    ),
};

// Each migration runs exactly once, in order, and bumps the stored schema version.
const MIGRATIONS = [
  // 1: history of the first FitFlow release used a different key and shape.
  () => {
    const old = read('ppl-history-v1', []);
    if (!old.length || localStorage.getItem(LS.history)) return;
    saveHistory(
      old.map((s) => ({
        ...s,
        id: uid(),
        planId: DEFAULT_PLAN_ID,
        planName: t('plan.ppl.name'),
        dayId: s.day,
        dayName: s.day?.[0].toUpperCase() + s.day?.slice(1),
        volume: volumeOf(s),
      }))
    );
  },
  // 2: photos move to IndexedDB (asynchronous, see migratePhotos below).
  () => {},
  // 3: sessions and measurements get a local day key so calendar and week views are time-zone stable.
  () => {
    const history = getHistory();
    history.forEach((s) => {
      if (!s.day) s.day = dayKey(s.finishedAt);
    });
    saveHistory(history);
    const body = getBody();
    body.forEach((e) => {
      if (!e.day) e.day = dayKey(e.date);
    });
    saveBody(body);
  },
  // 4: history entries remember the library exercise so progress survives renames and plan changes.
  () => {
    const byPlanExercise = {};
    allPlans().items.forEach((p) =>
      p.days.forEach((d) =>
        d.exercises.forEach((ex) => {
          byPlanExercise[ex.id] = exerciseKey(ex);
        })
      )
    );
    const history = getHistory();
    history.forEach((s) =>
      s.entries?.forEach((e) => {
        const key = byPlanExercise[e.exerciseId];
        if (!e.libraryId && key && key !== e.exerciseId) e.libraryId = key;
      })
    );
    saveHistory(history);
  },
  // 5: muscle groups and equipment on plan exercises are stored as keys instead of German labels, and copies of
  // catalogue fields are dropped, so the interface can be shown in any language.
  () => {
    const data = allPlans();
    data.items.forEach((p) => p.days?.forEach((d) => d.exercises?.forEach(normalizeLegacyExercise)));
    savePlans(data);
  },
  // 6: sets carry an explicit type, entries their exercise type, and record flags are recomputed from the
  // whole history so each exercise has exactly the bests it earned.
  () => {
    const history = getHistory();
    history.forEach((s) =>
      s.entries?.forEach((e) => {
        e.trackType ||= trackTypeOf(e);
        e.sets?.forEach((x) => {
          x.type ||= x.warmup ? 'warmup' : 'normal';
          x.warmup = x.type === 'warmup';
        });
      })
    );
    annotateAll(history);
    saveHistory(history);
  },
  // 7: custom exercises get their own store and plan exercises link to them by id.
  () => {
    promoteCustomExercises();
  },
  // 8: ticks without values no longer count as sets, warm-ups leave the set totals, runaway durations are capped,
  // record flags follow the rule that a first session has nothing to beat, and the rest timer is on by default.
  () => {
    const history = getHistory();
    history.forEach((s) => {
      s.entries?.forEach((e) => {
        const type = e.trackType || trackTypeOf(e);
        e.sets?.forEach((x) => {
          if (x.done && !setReady(x, type)) x.done = false;
        });
      });
      s.totalSets = doneSets(s);
      s.volume = volumeOf(s);
      if (!s.imported && Number(s.duration) > 21600) s.duration = 21600;
    });
    annotateAll(history);
    saveHistory(history);
    saveSettings({ ...getSettings(), restTimer: true });
  },
  // 9: iPhones cannot vibrate from a web app, so without the tone the end of a rest would pass unnoticed.
  () => {
    saveSettings({ ...getSettings(), restSound: true });
  },
];
export const SCHEMA_VERSION = MIGRATIONS.length;

// A fresh installation: no plans yet and the first-run flow has not run. It seeds the plan itself.
export const needsOnboarding = () => !isOnboarded() && !localStorage.getItem(LS.plans);
// Whether a person has made or set up anything here. A device without it has nothing to lose when someone signs in,
// and nothing that could end up in the wrong account.
export const hasPersonalData = () =>
  !needsOnboarding() ||
  !!getActive() ||
  hasAiKey() ||
  [LS.history, LS.body, LS.customExercises, LS.aiChat, LS.aiMemory].some((key) => read(key, []).length > 0);

export function runMigrations() {
  if (!localStorage.getItem(LS.settings)) saveSettings(DEFAULT_SETTINGS);
  if (needsOnboarding()) {
    write(LS.schema, SCHEMA_VERSION);
    return;
  }
  if (!localStorage.getItem(LS.plans)) savePlans(defaultPlans());
  // Installations from before the first-run flow existed count as onboarded.
  if (!isOnboarded()) markOnboarded();
  const current = read(LS.schema, 0);
  for (let v = current; v < MIGRATIONS.length; v++) MIGRATIONS[v]();
  if (current !== SCHEMA_VERSION) write(LS.schema, SCHEMA_VERSION);
}

export async function migratePhotos() {
  const entries = getBody();
  const inline = (e) => typeof e.photo === 'string' && e.photo.startsWith('data:');
  if (!entries.some(inline)) return false;
  for (const e of entries) {
    if (!inline(e)) continue;
    try {
      await photos.set(e.id, e.photo);
      e.hasPhoto = true;
      delete e.photo;
    } catch {
      /* keep inline until IndexedDB works */
    }
  }
  saveBody(entries);
  return true;
}
