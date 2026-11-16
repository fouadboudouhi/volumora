// Workout history from other apps' CSV exports (Hevy, Strong). The pure part turns a file into Volumora
// sessions and merges them into a history; `importParsed` is the thin storage wrapper around it.
// Exercises are matched to the catalogue by name; unknown names become custom exercises.
import { t } from './i18n.js';
import { allExercises } from './library.js';
import { LOCALES } from './locales/index.js';
import { annotateAll } from './records.js';
import { getCustomExercises, getHistory, saveCustomExercises, saveHistory } from './storage.js';
import { dayKey, doneSets, fold, number, uid, volumeOf } from './util.js';

const LB_TO_KG = 0.45359237;
const MILE_TO_KM = 1.609344;
const round3 = (x) => Math.round(x * 1000) / 1000;

// --- CSV ---------------------------------------------------------------------------------------------------

// RFC 4180-ish: quoted fields with doubled quotes, comma or semicolon (whichever the header uses more), any
// line ending. Rows that are entirely empty are dropped.
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const firstLine = src.slice(0, src.indexOf('\n') < 0 ? src.length : src.indexOf('\n'));
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((f) => f !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else field += c;
  }
  endRow();
  return rows;
}

// Header cells become snake_case keys: "Exercise Name" -> exercise_name, "weight_kg" stays.
const keyOf = (h) =>
  String(h)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
const toRecords = (rows) => {
  const [header, ...body] = rows;
  const keys = header.map(keyOf);
  return { keys, records: body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()]))) };
};

// --- Dates and durations ----------------------------------------------------------------------------------

const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  sept: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
// Hevy writes "12 Oct 2024, 10:03", Strong "2024-10-12 10:03:00"; both are local times.
export function parseStamp(value) {
  const s = String(value ?? '').trim();
  let m = /^(\d{1,2}) ([A-Za-z]{3,4})\.? (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()] != null)
    return new Date(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +m[4], +m[5], +(m[6] || 0));
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
// "1h 12m", "45m", "1h", "90s" -> seconds.
export function parseDurationText(value) {
  const s = String(value ?? '').toLowerCase();
  const take = (re) => number(re.exec(s)?.[1]);
  return take(/(\d+)\s*h/) * 3600 + take(/(\d+)\s*m(?!s)/) * 60 + take(/(\d+)\s*s/);
}

// --- Exercise matching ------------------------------------------------------------------------------------

// Spellings the apps use that the catalogue writes differently. Applied token by token to both sides.
const TOKEN_MAP = {
  bicep: 'biceps',
  tricep: 'triceps',
  machine: 'lever',
  flyes: 'fly',
  flys: 'fly',
  flies: 'fly',
  pullup: 'pull up',
  pullups: 'pull up',
  chinup: 'chin up',
  chinups: 'chin up',
  pushup: 'push up',
  pushups: 'push up',
  situp: 'sit up',
  situps: 'sit up',
  skullcrusher: 'skull crusher',
  skullcrushers: 'skull crusher',
  db: 'dumbbell',
  bb: 'barbell',
  kb: 'kettlebell',
  rdl: 'romanian deadlift',
  ohp: 'overhead press',
  dumbbells: 'dumbbell',
  kettlebells: 'kettlebell',
  deadlifts: 'deadlift',
  squats: 'squat',
  curls: 'curl',
  rows: 'row',
  raises: 'raise',
  presses: 'press',
  extensions: 'extension',
  dips: 'dip',
  lunges: 'lunge',
  crunches: 'crunch',
  shrugs: 'shrug',
  kickbacks: 'kickback',
  pulldowns: 'pulldown',
  swings: 'swing',
  bridges: 'bridge',
  thrusts: 'thrust',
  pullovers: 'pullover',
  planks: 'plank',
};
const NOISE = new Set(['v', '2', 'male', 'female', 'with', 'on', 'the', 'a', 'pov', 'version']);

// "Bench Press (Barbell)" -> "barbell bench press"; folded, punctuation-free, spellings unified.
export function normalizeName(raw) {
  let s = String(raw ?? '').trim();
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(s);
  if (m) s = `${m[2]} ${m[1]}`;
  s = fold(s)
    .replace(/smith machine/g, 'smith')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  // "Seated Cable Row (Cable)" carries the equipment twice; repeated words are dropped.
  return [...new Set(s.split(' ').flatMap((w) => (TOKEN_MAP[w] ?? w).split(' ')))].filter(Boolean).join(' ');
}
const tokensOf = (name) =>
  normalizeName(name)
    .split(' ')
    .filter((w) => w && !NOISE.has(w));

// Common Hevy/Strong names whose catalogue counterpart is named differently (import name -> dataset name).
const ALIASES = {
  'barbell squat': 'barbell full squat',
  'barbell back squat': 'barbell full squat',
  'barbell overhead press': 'barbell standing wide military press',
  'barbell military press': 'barbell standing wide military press',
  'barbell strict press': 'barbell standing wide military press',
  'dumbbell shoulder press': 'dumbbell seated shoulder press',
  'dumbbell overhead press': 'dumbbell standing overhead press',
  'cable lat pulldown': 'cable pulldown',
  'lat pulldown': 'cable pulldown',
  'wide grip lat pulldown': 'cable pulldown',
  'lever lat pulldown': 'lever front pulldown',
  'cable seated row': 'cable seated row',
  'seated cable row': 'cable seated row',
  'cable seated row v grip': 'cable seated row',
  'cable seated cable row': 'cable seated row',
  'lever seated cable row': 'lever seated row',
  'lever assisted chin up': 'lever assisted chin-up',
  dip: 'chest dip',
  'triceps dip': 'chest dip',
  'weighted dip': 'weighted triceps dip on high parallel bars',
  'barbell biceps curl': 'barbell curl',
  'cable biceps curl': 'cable curl',
  'ez bar curl': 'ez barbell curl',
  'ez bar biceps curl': 'ez barbell curl',
  'ez barbell biceps curl': 'ez barbell curl',
  'ez bar preacher curl': 'ez barbell close grip preacher curl',
  'leg press': 'sled 45° leg press (side pov)',
  'lever leg press': 'sled 45° leg press (side pov)',
  'sled leg press': 'sled 45° leg press (side pov)',
  'hack squat': 'sled hack squat',
  'lever hack squat': 'sled hack squat',
  'lever hip abduction': 'lever seated hip abduction',
  'lever hip adduction': 'lever seated hip adduction',
  'lever calf raise': 'lever standing calf raise',
  'lever calf press': 'sled calf press on leg press',
  'calf press on leg press': 'sled calf press on leg press',
  'lever leg curl': 'lever lying leg curl',
  'lever reverse fly': 'lever seated reverse fly',
  'lever rear delt reverse fly': 'lever seated reverse fly',
  'lever pec deck': 'lever seated fly',
  'pec deck': 'lever seated fly',
  'lever chest fly': 'lever seated fly',
  'dumbbell chest fly': 'dumbbell fly',
  'dumbbell incline chest fly': 'dumbbell incline fly',
  'cable fly crossovers': 'cable middle fly',
  'cable crossover': 'cable middle fly',
  'cable chest fly': 'cable middle fly',
  'cable fly': 'cable middle fly',
  'face pull': 'cable standing rear delt row (with rope)',
  'cable face pull': 'cable standing rear delt row (with rope)',
  'cable triceps pushdown': 'cable pushdown',
  'cable straight bar triceps pushdown': 'cable pushdown',
  'cable triceps pushdown straight bar': 'cable pushdown',
  'triceps pushdown': 'cable pushdown',
  'cable rope triceps pushdown': 'cable pushdown (with rope attachment)',
  'cable triceps pushdown rope': 'cable pushdown (with rope attachment)',
  'cable triceps rope pushdown': 'cable pushdown (with rope attachment)',
  'triceps rope pushdown': 'cable pushdown (with rope attachment)',
  'rope pushdown': 'cable pushdown (with rope attachment)',
  'dumbbell rear delt fly': 'dumbbell rear delt raise',
  'dumbbell reverse fly': 'dumbbell reverse fly',
  'lever seated shoulder press': 'lever shoulder press',
  'cable triceps extension': 'cable overhead triceps extension (rope attachment)',
  'cable overhead triceps extension': 'cable overhead triceps extension (rope attachment)',
  'barbell skull crusher': 'barbell lying triceps extension skull crusher',
  'ez bar skull crusher': 'barbell lying triceps extension skull crusher',
  'dumbbell skull crusher': 'dumbbell lying triceps extension',
  'dumbbell triceps extension': 'dumbbell standing triceps extension',
  'dumbbell overhead triceps extension': 'dumbbell standing triceps extension',
  'dumbbell triceps kickback': 'dumbbell kickback',
  'barbell hip thrust': 'barbell glute bridge',
  'hip thrust': 'barbell glute bridge',
  'glute bridge': 'low glute bridge on floor',
  'goblet squat': 'dumbbell goblet squat',
  'bulgarian split squat': 'dumbbell single leg split squat',
  'dumbbell bulgarian split squat': 'dumbbell single leg split squat',
  'dumbbell walking lunge': 'walking lunge',
  'dumbbell reverse lunge': 'dumbbell rear lunge',
  'barbell reverse lunge': 'barbell rear lunge',
  'step up': 'dumbbell step-up',
  'dumbbell calf raise': 'dumbbell standing calf raise',
  'standing calf raise': 'bodyweight standing calf raise',
  plank: 'weighted front plank',
  'front plank': 'weighted front plank',
  crunch: 'crunch floor',
  'sit up': 'sit-up v. 2',
  'cable crunch': 'cable kneeling crunch',
  'ab wheel': 'wheel rollerout',
  'ab wheel rollout': 'wheel rollerout',
  running: 'run',
  treadmill: 'walking on incline treadmill',
  cycling: 'stationary bike walk',
  'stationary bike': 'stationary bike walk',
  elliptical: 'walk elliptical cross trainer',
  'elliptical trainer': 'walk elliptical cross trainer',
  'stair climber': 'walking on stepmill',
  stairmaster: 'walking on stepmill',
  'battle ropes': 'battling ropes',
  'rack pull': 'barbell rack pull',
  't bar row': 'lever t bar row',
  'dumbbell row': 'dumbbell one arm bent-over row',
  'dumbbell single arm row': 'dumbbell one arm bent-over row',
  'dumbbell row unilateral': 'dumbbell one arm bent-over row',
  'dumbbell chest supported row': 'dumbbell incline row',
  'pistol squat': 'single leg squat (pistol) male',
  'cable pull through': 'cable pull through (with rope)',
  'back extension': 'hyperextension',
  'lever back extension': 'lever back extension',
  'hanging knee raise': 'hanging leg hip raise',
  'barbell sumo deadlift': 'barbell sumo deadlift',
  'trap bar deadlift': 'trap bar deadlift',
  'barbell upright row': 'barbell upright row',
};

let index = null;
let indexSize = -1;
// Normalised name -> catalogue id, built from dataset names, both dictionaries and the aliases; custom
// exercises are included so a second import of the same file lands on the same records.
function buildIndex() {
  const all = allExercises();
  if (index && indexSize === all.length) return index;
  const map = new Map();
  const add = (name, id) => {
    const k = normalizeName(name);
    if (k && !map.has(k)) map.set(k, id);
  };
  for (const ex of all) {
    add(ex.sourceName, ex.id);
    if (!ex.custom) for (const dict of Object.values(LOCALES)) add(dict[`ex.${ex.id}`], ex.id);
  }
  for (const [alias, target] of Object.entries(ALIASES)) {
    const id = map.get(normalizeName(target));
    if (id) add(alias, id);
  }
  index = map;
  indexSize = all.length;
  return map;
}

// Exact match first, then the single catalogue entry that contains every word of the import name with the
// fewest extra words; a tie means no match, so nothing is misattributed.
export function matchExercise(name) {
  const map = buildIndex();
  const key = normalizeName(name);
  if (map.has(key)) return map.get(key);
  const wanted = tokensOf(name);
  if (!wanted.length) return null;
  let best = null;
  let bestExtra = Infinity;
  let tie = false;
  for (const ex of allExercises()) {
    const have = tokensOf(ex.sourceName);
    if (!wanted.every((w) => have.includes(w))) continue;
    const extra = have.length - wanted.length;
    if (extra < bestExtra) {
      best = ex.id;
      bestExtra = extra;
      tie = false;
    } else if (extra === bestExtra && ex.id !== best) tie = true;
  }
  return tie ? null : best;
}

// --- Sessions ---------------------------------------------------------------------------------------------

const HEVY_TYPES = { normal: 'normal', warmup: 'warmup', dropset: 'drop', failure: 'failure' };
const strongType = (order) => ({ w: 'warmup', d: 'drop', f: 'failure' })[order[0]?.toLowerCase()] || 'normal';

const buildSet = ({ type = 'normal', weight = 0, reps = 0, time = 0, distance = 0, rpe = 0 }) => {
  const set = {
    weight: weight > 0 ? round3(weight) : '',
    reps: reps > 0 ? Math.round(reps) : '',
    rir: rpe > 0 ? Math.min(10, Math.max(0, 10 - rpe)) : '',
    done: true,
    warmup: type === 'warmup',
    type,
  };
  if (rpe > 0) set.rpe = rpe;
  if (time > 0) set.time = Math.round(time);
  if (distance > 0) set.distance = round3(distance);
  return set;
};
// What the sets hold decides how the exercise is tracked; the catalogue is only asked when they are empty.
const inferTrackType = (sets, lib) => {
  if (sets.some((s) => s.weight !== '' && s.reps !== '')) return 'weight_reps';
  if (sets.some((s) => s.distance)) return 'distance_time';
  if (sets.some((s) => s.time) && !sets.some((s) => s.reps !== '')) return 'time';
  if (sets.some((s) => s.reps !== '')) return 'reps';
  return lib?.trackType || 'weight_reps';
};
const buildEntry = ({ name, note, supersetId, sets }) => {
  const libraryId = matchExercise(name) || undefined;
  const trackType = inferTrackType(sets);
  sets.forEach((s) => {
    if (trackType === 'time' || trackType === 'distance_time') s.time ??= '';
    if (trackType === 'distance_time') s.distance ??= '';
  });
  return {
    exerciseId: uid(),
    libraryId,
    name: String(name).trim().slice(0, 80),
    trackType,
    ...(supersetId ? { supersetId } : {}),
    note: String(note || '').slice(0, 500),
    sets,
  };
};
const buildSession = (source, { title, start, end, duration, entries }) => {
  const finish = end && end > start ? end : new Date(start.getTime() + (duration || 3600) * 1000);
  const session = {
    id: uid(),
    planId: null,
    planName: '',
    dayId: null,
    dayName:
      String(title || '')
        .trim()
        .slice(0, 60) || t('workout.freeName'),
    startedAt: start.toISOString(),
    finishedAt: finish.toISOString(),
    day: dayKey(finish),
    duration: Math.max(60, Math.round((finish - start) / 1000)),
    markers: { deload: false, ill: false, pain: false },
    imported: { source, key: `${source}:${start.getTime()}:${normalizeName(title)}` },
    entries: entries.map(buildEntry),
  };
  session.totalSets = doneSets(session);
  session.volume = volumeOf(session);
  return session;
};

// Rows -> sessions, grouped by workout and, inside it, by exercise in order of appearance.
function groupRows(records, { sessionKey, exerciseKey, set, meta }) {
  const sessions = new Map();
  for (const r of records) {
    const sk = sessionKey(r);
    if (!sk) continue;
    if (!sessions.has(sk)) sessions.set(sk, { ...meta(r), entries: new Map() });
    const s = sessions.get(sk);
    const ek = exerciseKey(r);
    if (!ek.name) continue;
    if (!s.entries.has(ek.key)) s.entries.set(ek.key, { ...ek, sets: [] });
    const built = set(r);
    if (built) s.entries.get(ek.key).sets.push(built);
  }
  return [...sessions.values()]
    .filter((s) => s.start)
    .map((s) => ({ ...s, entries: [...s.entries.values()].filter((e) => e.sets.length) }))
    .filter((s) => s.entries.length);
}

function fromHevy(records, keys, source) {
  const lbs = keys.includes('weight_lbs');
  const miles = keys.includes('distance_miles');
  return groupRows(records, {
    sessionKey: (r) => `${r.start_time}|${r.title}`,
    meta: (r) => ({ title: r.title, start: parseStamp(r.start_time), end: parseStamp(r.end_time) }),
    exerciseKey: (r) => ({
      key: `${r.exercise_title}|${r.superset_id}`,
      name: r.exercise_title,
      note: r.exercise_notes,
      supersetId: r.superset_id ? `hevy-${r.superset_id}` : '',
    }),
    set: (r) =>
      buildSet({
        type: HEVY_TYPES[r.set_type] || 'normal',
        weight: lbs ? number(r.weight_lbs) * LB_TO_KG : number(r.weight_kg),
        reps: number(r.reps),
        time: number(r.duration_seconds),
        distance: miles ? number(r.distance_miles) * MILE_TO_KM : number(r.distance_km),
        rpe: number(r.rpe),
      }),
  }).map((s) => buildSession(source, s));
}

function fromStrong(records, keys, unit, source) {
  const toKg = (value, u) => (/lb/i.test(u || unit) ? number(value) * LB_TO_KG : number(value));
  const toKm = (value, u) =>
    /mi/i.test(u || '')
      ? number(value) * MILE_TO_KM
      : /^m$/i.test(u || '')
        ? number(value) / 1000
        : number(value);
  return groupRows(records, {
    sessionKey: (r) => `${r.date}|${r.workout_name}`,
    meta: (r) => ({
      title: r.workout_name,
      start: parseStamp(r.date),
      // Current exports write "Duration (sec)" as a number, older ones "1h 12m".
      duration:
        r.duration_sec !== undefined
          ? number(r.duration_sec)
          : parseDurationText(r.duration || r.workout_duration),
    }),
    exerciseKey: (r) => ({ key: r.exercise_name, name: r.exercise_name, note: r.notes }),
    // "Rest Timer" and "Note" rows carry no set.
    set: (r) =>
      /^[wdf]?\d*$/i.test(r.set_order) && r.set_order !== ''
        ? buildSet({
            type: strongType(r.set_order),
            // Some exports name the unit in the header: "Weight (kg)".
            weight:
              r.weight_kg !== undefined
                ? number(r.weight_kg)
                : r.weight_lbs !== undefined
                  ? number(r.weight_lbs) * LB_TO_KG
                  : toKg(r.weight, r.weight_unit),
            reps: number(r.reps),
            time: number(r.seconds),
            // Like the weight, the distance can carry its unit in the header: "Distance (meters)".
            distance:
              r.distance_meters !== undefined
                ? number(r.distance_meters) / 1000
                : r.distance_km !== undefined
                  ? number(r.distance_km)
                  : r.distance_miles !== undefined
                    ? number(r.distance_miles) * MILE_TO_KM
                    : toKm(r.distance, r.distance_unit),
            rpe: number(r.rpe),
          })
        : null,
  }).map((s) => buildSession(source, s));
}

// The file as sessions, plus what the import dialog needs to say.
export function parseImport(text, { unit = 'kg' } = {}) {
  const rows = parseCsv(text);
  const empty = { source: null, sessions: [], unknown: [], unitAssumed: false };
  if (rows.length < 2) return empty;
  const { keys, records } = toRecords(rows);
  const source =
    keys.includes('exercise_title') && keys.includes('set_index')
      ? 'hevy'
      : keys.includes('exercise_name') && keys.includes('set_order')
        ? 'strong'
        : null;
  if (!source) return empty;
  const sessions =
    source === 'hevy' ? fromHevy(records, keys, source) : fromStrong(records, keys, unit, source);
  sessions.sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));
  const unknown = [
    ...new Set(sessions.flatMap((s) => s.entries.filter((e) => !e.libraryId).map((e) => e.name))),
  ];
  // The unit is only assumed when neither a column nor the header names it.
  const unitNamed = ['weight_unit', 'weight_kg', 'weight_lbs'].some((k) => keys.includes(k));
  return { source, sessions, unknown, unitAssumed: source === 'strong' && !unitNamed };
}

// Merge into an existing history: sessions already imported (same source, start and title) are skipped,
// unknown exercises get a custom record once, record flags are recomputed over everything.
export function mergeImport(history, customs, parsed) {
  const known = new Set(history.map((s) => s.imported?.key).filter(Boolean));
  const list = customs.map((c) => ({ ...c }));
  const byName = new Map(list.map((c) => [normalizeName(c.name), c.id]));
  let created = 0;
  const customFor = (entry) => {
    const k = normalizeName(entry.name);
    if (!byName.has(k)) {
      const record = {
        id: uid(),
        name: entry.name,
        category: 'other',
        equipment: 'other',
        trackType: entry.trackType,
        note: '',
        createdAt: new Date().toISOString(),
      };
      list.push(record);
      byName.set(k, record.id);
      created++;
    }
    return byName.get(k);
  };
  const fresh = parsed.sessions.filter((s) => !known.has(s.imported.key));
  fresh.forEach((s) => s.entries.forEach((e) => (e.libraryId ||= customFor(e))));
  const merged = [...fresh, ...history].sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));
  annotateAll(merged);
  return {
    history: merged,
    customs: list,
    added: fresh.length,
    skipped: parsed.sessions.length - fresh.length,
    created,
  };
}

// `saved` is false when the device storage refused the history: the custom exercises written for it are taken
// back then, so a failed import leaves nothing behind and the caller can say so instead of reporting a count.
export function importParsed(parsed) {
  const customs = getCustomExercises();
  const result = mergeImport(getHistory(), customs, parsed);
  if (result.created && !saveCustomExercises(result.customs)) return { ...result, saved: false };
  if (result.added && !saveHistory(result.history)) {
    if (result.created) saveCustomExercises(customs);
    return { ...result, saved: false };
  }
  return { ...result, saved: true };
}
