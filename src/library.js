// Exercise catalogue: dataset records with stable keys, the built-in default plan, and name/label resolution.
// Muscle groups, equipment and target muscles are stored as dataset keys; labels come from the dictionary.
import { EXERCISES } from '../assets/data/exercises.js';
import { t } from './i18n.js';
import { exerciseKey, titleCase } from './util.js';

const DEMOS = {
  chest: 'https://static.exercisedb.dev/media/DOoWcnA.gif',
  incline: 'https://static.exercisedb.dev/media/jHAnWmT.gif',
  pushdown: 'https://static.exercisedb.dev/media/dU605di.gif',
  rotation: 'https://static.exercisedb.dev/media/FWdVhcW.gif',
  scaption: 'https://static.exercisedb.dev/media/c9MnDRp.gif',
  lat: 'https://static.exercisedb.dev/media/rkg41Fb.gif',
  row: 'https://static.exercisedb.dev/media/fUBheHs.gif',
  highrow: 'https://static.exercisedb.dev/media/nZZZy9m.gif',
  curl: 'https://static.exercisedb.dev/media/6TG6x2w.gif',
  hammer: 'https://static.exercisedb.dev/media/slDvUAU.gif',
  squat: 'https://static.exercisedb.dev/media/iYzB0Cz.gif',
  rdl: 'https://static.exercisedb.dev/media/wQ2c4XD.gif',
  legcurl: 'https://static.exercisedb.dev/media/17lJ1kr.gif',
  extension: 'https://static.exercisedb.dev/media/my33uHU.gif',
  calf: 'https://static.exercisedb.dev/media/ykUOVze.gif',
  raise: 'https://static.exercisedb.dev/media/9IxJdtC.gif',
};

export const DEFAULT_PLAN_ID = 'ppl-default';
export const GROUPS = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core', 'cardio'];
const GROUP_OF_BODY_PART = {
  chest: 'chest',
  back: 'back',
  shoulders: 'shoulders',
  neck: 'shoulders',
  'upper arms': 'arms',
  'lower arms': 'arms',
  'upper legs': 'legs',
  'lower legs': 'legs',
  waist: 'core',
  cardio: 'cardio',
};
export const groupOfBodyPart = (part) => GROUP_OF_BODY_PART[part] || (GROUPS.includes(part) ? part : 'other');
export const groupLabel = (key) => t(`group.${key}`, null, key);
export const equipmentLabel = (key) => (key ? t(`equipment.${key}`, null, titleCase(key)) : '');
export const muscleLabel = (key) => (key ? t(`muscle.${key}`, null, titleCase(key)) : '');

// Labels that versions before schema 5 stored on plan exercises, mapped to the keys used since.
export const LEGACY_GROUPS = {
  Brust: 'chest',
  Rücken: 'back',
  Schulter: 'shoulders',
  Arme: 'arms',
  Beine: 'legs',
  Core: 'core',
  Ausdauer: 'cardio',
  Sonstige: 'other',
  'Eigene Übung': 'other',
};
export const LEGACY_EQUIPMENT = {
  Langhantel: 'barbell',
  Kurzhanteln: 'dumbbell',
  Kabelzug: 'cable',
  Körpergewicht: 'body weight',
  Maschine: 'leverage machine',
  Beinpresse: 'sled machine',
  'SZ-Stange': 'ez barbell',
  Band: 'band',
  Zusatzgewicht: 'weighted',
  'Ab-Roller': 'wheel roller',
};

// The 16 exercises of the built-in plan keep their slug ids forever: history entries point at them.
// Muscles that help, named the way the catalogue names them, so sets count half for their groups.
const builtIn = (id, category, equipment, target, gif, secondary = []) => [
  id,
  {
    id,
    sourceName: id.replaceAll('-', ' '),
    category,
    equipment,
    target,
    gif,
    group: groupOfBodyPart(category),
    secondary,
    builtIn: true,
  },
];
export const BUILT_IN = Object.fromEntries([
  builtIn('chest-press', 'chest', 'leverage machine', 'pectorals', DEMOS.chest, ['triceps', 'shoulders']),
  builtIn('incline-chest-press', 'chest', 'leverage machine', 'pectorals', DEMOS.incline, [
    'triceps',
    'shoulders',
  ]),
  builtIn('triceps-pushdown', 'upper arms', 'cable', 'triceps', DEMOS.pushdown),
  builtIn('cable-external-rotation', 'shoulders', 'cable', 'delts', DEMOS.rotation, ['rotator cuff']),
  builtIn('scaption-raise', 'shoulders', 'dumbbell', 'delts', DEMOS.scaption, ['traps']),
  builtIn('lat-pulldown-neutral', 'back', 'cable', 'lats', DEMOS.lat, ['biceps', 'forearms']),
  builtIn('seated-cable-row', 'back', 'cable', 'upper back', DEMOS.row, ['biceps', 'rear deltoids']),
  builtIn('high-row-machine', 'back', 'leverage machine', 'upper back', DEMOS.highrow, [
    'biceps',
    'rear deltoids',
  ]),
  builtIn('ez-bar-curl', 'upper arms', 'ez barbell', 'biceps', DEMOS.curl, ['forearms']),
  builtIn('hammer-curl', 'upper arms', 'dumbbell', 'biceps', DEMOS.hammer, ['forearms']),
  builtIn('squat', 'upper legs', 'barbell', 'quads', DEMOS.squat, ['glutes', 'hamstrings', 'core']),
  builtIn('romanian-deadlift', 'upper legs', 'barbell', 'hamstrings', DEMOS.rdl, ['glutes', 'lower back']),
  builtIn('leg-curl', 'upper legs', 'leverage machine', 'hamstrings', DEMOS.legcurl, ['calves']),
  builtIn('leg-extension', 'upper legs', 'leverage machine', 'quads', DEMOS.extension),
  builtIn('calf-raise', 'lower legs', 'leverage machine', 'calves', DEMOS.calf),
  builtIn('leg-raise', 'waist', 'body weight', 'abs', DEMOS.raise, ['hip flexors']),
]);

// Exercises whose tracking differs from what category and equipment suggest: holds are timed, and a few
// cardio moves count reps rather than distance.
const trackOverride = (name) =>
  /plank|hold|wall sit|l-sit|dead hang/.test(name)
    ? 'time'
    : /mountain climber|burpee|jumping jack|jump rope|high knee|skater/.test(name)
      ? 'reps'
      : undefined;

// Animations are hot-linked from the dataset repository; the catalogue only stores the file name.
export const GIF_BASE = 'https://raw.githubusercontent.com/YaKohen/exercises-dataset/main/videos/';

export const EXERCISE_LIBRARY = EXERCISES.map((ex) => ({
  ...ex,
  sourceName: ex.name,
  name: titleCase(ex.name),
  group: groupOfBodyPart(ex.category),
  gif: ex.gif || (ex.file ? GIF_BASE + ex.file : ''),
  secondary: ex.secondary || [],
  trackType: ex.trackType || trackOverride(ex.name),
  sets: 3,
  range: ex.category === 'waist' || ex.target === 'calves' ? '12–15' : '8–12',
  note: '',
}));
const BY_ID = new Map(EXERCISE_LIBRARY.map((ex) => [ex.id, ex]));
export const EQUIPMENT_KEYS = [...new Set(EXERCISE_LIBRARY.map((x) => x.equipment).filter(Boolean)), 'other'];
export const libraryExercise = (id) => BY_ID.get(id);
export const libraryBySourceName = (name) => EXERCISE_LIBRARY.find((x) => x.sourceName === name);

// Custom exercises live in storage; storage.js registers the reader so this module stays free of persistence.
let customSource = () => [];
export const setCustomSource = (fn) => {
  customSource = fn;
};
// A stored custom exercise as a catalogue-like record: same fields the picker, sheet and tracking rely on.
export const customRecord = (item) => ({
  ...item,
  sourceName: item.name,
  group: GROUPS.includes(item.category) ? item.category : 'other',
  equipment: item.equipment || 'other',
  target: '',
  secondary: [],
  gif: '',
  trackType: item.trackType || 'weight_reps',
  sets: 3,
  range: '8–12',
  custom: true,
});
export const customExercises = () => customSource().map(customRecord);
export const customExercise = (id) => {
  const item = customSource().find((x) => x.id === id);
  return item ? customRecord(item) : null;
};
// Catalogue plus custom exercises, for the picker.
export const allExercises = () => [...EXERCISE_LIBRARY, ...customExercises()];

// Replacements for an exercise: same target muscle (the group when it has none), preferring equipment this person
// already uses, the same equipment and shared helper muscles. At most three per equipment, so the list offers a choice.
export function alternativesFor(item, { equipment = [], limit = 5 } = {}) {
  const base = libraryOf(item);
  if (!base) return [];
  const owned = new Set(equipment);
  const score = (x) =>
    (owned.has(x.equipment) || x.equipment === 'body weight' ? 3 : 0) +
    (x.equipment === base.equipment ? 2 : 0) +
    (x.secondary || []).filter((muscle) => (base.secondary || []).includes(muscle)).length;
  const perEquipment = {};
  return EXERCISE_LIBRARY.filter(
    (x) =>
      x.id !== base.id &&
      exerciseName(x) !== exerciseName(base) &&
      (base.target ? x.target === base.target : x.group === base.group)
  )
    .map((x) => [score(x), x])
    .sort((a, b) => b[0] - a[0])
    .map(([, x]) => x)
    .filter((x) => (perEquipment[x.equipment] = (perEquipment[x.equipment] || 0) + 1) <= 3)
    .slice(0, limit);
}

// The record behind a plan exercise, session entry or picker item: built-in, catalogue or custom; null otherwise.
export const libraryOf = (item) => {
  const key = exerciseKey(item);
  return BUILT_IN[key] || BY_ID.get(key) || customExercise(key) || null;
};

// Display name in the active language. Custom exercises keep whatever the user typed.
export const exerciseName = (item) => {
  const lib = libraryOf(item);
  if (!lib) return item?.name || t('exercise.fallback');
  return t(`ex.${lib.id}`, null, lib.name || titleCase(lib.sourceName));
};
// Muscle group key of a plan exercise, a session entry or a catalogue record.
export const groupOf = (item) => {
  const lib = libraryOf(item);
  if (lib) return lib.group;
  const raw = item?.category;
  return LEGACY_GROUPS[raw] || (GROUPS.includes(raw) ? raw : 'other');
};

// Exercises saved by older versions carry German labels and copies of catalogue fields. Labels become keys;
// the copies go away when the catalogue record can be resolved.
export function normalizeLegacyExercise(ex) {
  if (!ex || typeof ex !== 'object') return ex;
  if (ex.libraryId && (BY_ID.has(ex.libraryId) || BUILT_IN[ex.libraryId])) {
    delete ex.category;
    delete ex.equipment;
    delete ex.target;
    delete ex.sourceName;
    return ex;
  }
  if (ex.category) ex.category = LEGACY_GROUPS[ex.category] || ex.category;
  if (ex.equipment) ex.equipment = LEGACY_EQUIPMENT[ex.equipment] || ex.equipment;
  return ex;
}

const planExercise = (id, sets, range) => ({
  id,
  name: t(`ex.${id}`),
  sets,
  range,
  gif: BUILT_IN[id].gif,
  note: t(`exNote.${id}`),
});

// The plan every new installation starts with, built in the active language.
export function defaultPlan() {
  return {
    id: DEFAULT_PLAN_ID,
    name: t('plan.ppl.name'),
    description: t('plan.ppl.description'),
    createdAt: new Date().toISOString(),
    days: [
      {
        id: 'push',
        name: 'Push',
        subtitle: t('plan.ppl.pushSubtitle'),
        exercises: [
          planExercise('chest-press', 3, '10–15'),
          planExercise('incline-chest-press', 3, '10–15'),
          planExercise('triceps-pushdown', 3, '10–15'),
          planExercise('cable-external-rotation', 2, '15–20'),
          planExercise('scaption-raise', 2, '12–15'),
        ],
      },
      {
        id: 'pull',
        name: 'Pull',
        subtitle: t('plan.ppl.pullSubtitle'),
        exercises: [
          planExercise('lat-pulldown-neutral', 3, '8–12'),
          planExercise('seated-cable-row', 3, '8–12'),
          planExercise('high-row-machine', 3, '10–12'),
          planExercise('ez-bar-curl', 3, '8–12'),
          planExercise('hammer-curl', 2, '10–15'),
        ],
      },
      {
        id: 'legs',
        name: 'Legs',
        subtitle: t('plan.ppl.legsSubtitle'),
        exercises: [
          planExercise('squat', 3, '8–12'),
          planExercise('romanian-deadlift', 3, '8–12'),
          planExercise('leg-curl', 3, '10–15'),
          planExercise('leg-extension', 3, '12–15'),
          planExercise('calf-raise', 3, '12–20'),
          planExercise('leg-raise', 3, '10–15'),
        ],
      },
    ],
  };
}
