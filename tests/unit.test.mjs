// Unit tests for the pure modules. They run in Node without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, exerciseKey, fmtDate, parseDate, rangeMax, volumeOf } from '../src/util.js';
import { createSuggestedPlan, nextSession } from '../src/plans.js';
import { validateBackup } from '../src/backup.js';
import { platesPerSide } from '../src/plates.js';
import { plural, setLanguage, t } from '../src/i18n.js';
import { BUILT_IN, exerciseName } from '../src/library.js';
import { DEFAULT_SETTINGS } from '../src/storage.js';
import { matchExercise, mergeImport, parseImport } from '../src/importers.js';
import { readFileSync } from 'node:fs';
import de from '../src/locales/de.js';
import en from '../src/locales/en.js';

// Node reports the device language as en-US; the assertions below are written against the German texts.
setLanguage('de');
import { weekStats } from '../src/plans.js';

test('day keys are local and round-trip without shifting', () => {
  const d = new Date(2026, 0, 31, 23, 30);
  assert.equal(dayKey(d), '2026-01-31');
  assert.equal(dayKey('2026-01-31'), '2026-01-31');
  assert.equal(parseDate('2026-01-31').getHours(), 12, 'day keys are read as local noon');
  assert.equal(dayKey('not a date'), '');
  assert.equal(fmtDate('garbage'), '–');
});

test('exercise identity prefers the library id', () => {
  assert.equal(exerciseKey({ id: 'plan-uid', libraryId: '0025' }), '0025');
  assert.equal(exerciseKey({ exerciseId: 'plan-uid' }), 'plan-uid');
  assert.equal(exerciseKey({ id: 'custom' }), 'custom');
  assert.equal(rangeMax('8–12'), 12);
  assert.equal(rangeMax('AMRAP'), 12);
});

test('volume counts only completed working sets', () => {
  const session = {
    entries: [
      {
        sets: [
          { weight: '100', reps: '5', done: true },
          { weight: '50', reps: '5', done: true, warmup: true },
          { weight: '100', reps: '5', done: false },
        ],
      },
    ],
  };
  assert.equal(volumeOf(session), 500);
});

test('the assistant builds valid plans for every day count', () => {
  for (const days of [2, 3, 4, 5, 6]) {
    const plan = createSuggestedPlan('strength', days, 'fixed');
    assert.equal(plan.days.length, days);
    assert.equal(Object.keys(plan.schedule.assignments).length, days);
    plan.days.forEach((d) => {
      assert.equal(d.exercises.length, 6);
      d.exercises.forEach((ex) => {
        assert.ok(ex.libraryId, 'exercise links to the library');
        assert.notEqual(ex.id, ex.libraryId);
      });
    });
  }
  const strength = createSuggestedPlan('strength', 3);
  assert.equal(strength.days[0].exercises[0].range, '4–6');
});

test('the next session rotates through the plan after the last completed day', () => {
  const plan = {
    id: 'p',
    days: [
      { id: 'a', name: 'A', exercises: [{}] },
      { id: 'b', name: 'B', exercises: [{}] },
    ],
  };
  const monday = new Date(2026, 0, 5, 12);
  const done = (dayId) => [{ planId: 'p', dayId, finishedAt: monday.toISOString() }];
  assert.equal(nextSession(plan, [], monday).day.id, 'a');
  assert.equal(nextSession(plan, done('a'), monday).day.id, 'b');
  assert.equal(nextSession(plan, done('b'), monday).day.id, 'a');
  assert.equal(nextSession(plan, done('b'), monday).label, 'Als Nächstes');
});

test('backup validation coerces hostile input', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const backup = validateBackup({
    plans: {
      activePlanId: 'nope',
      items: [
        {
          id: 'p1',
          name: evil,
          days: [{ id: 'd1', exercises: [{ sets: 99, rest: 'x', gif: 'http://insecure' }] }],
        },
      ],
    },
    history: [
      {
        finishedAt: '2026-02-03T10:00:00Z',
        totalSets: '3',
        entries: [{ exerciseId: 'e', sets: [{ weight: '1,5', reps: 'x', done: 1 }] }],
      },
      { finishedAt: 'never' },
    ],
    body: [{ date: '2026-02-01', weight: '-5', photo: 'https://x' }],
    settings: { theme: 'neon', rest: 9999 },
  });
  assert.equal(backup.plans.activePlanId, 'p1');
  assert.equal(backup.plans.items[0].name, evil, 'strings are kept, escaping happens at render time');
  const ex = backup.plans.items[0].days[0].exercises[0];
  assert.equal(ex.sets, 12);
  assert.equal(ex.rest, undefined);
  assert.equal(ex.gif, '');
  assert.equal(backup.history.length, 1);
  assert.deepEqual(backup.history[0].entries[0].sets[0], {
    weight: '1,5',
    reps: '',
    rir: '',
    rpe: '',
    done: true,
    warmup: false,
    type: 'normal',
  });
  assert.equal(backup.history[0].day, dayKey('2026-02-03T10:00:00Z'));
  assert.equal(backup.body[0].weight, '');
  assert.equal(backup.body[0].photo, '');
  assert.deepEqual(backup.settings, { ...DEFAULT_SETTINGS, rest: 600 });
  assert.throws(() => validateBackup({ plans: {} }));
});

test('plate calculator loads the heaviest plates first', () => {
  assert.deepEqual(platesPerSide(100, 20, [25, 20, 15, 10, 5, 2.5, 1.25]).plates, [25, 15]);
  assert.deepEqual(platesPerSide(62.5, 20, [25, 20, 15, 10, 5, 2.5, 1.25]).plates, [20, 1.25]);
  assert.equal(platesPerSide(61, 20, [25, 20, 15, 10, 5, 2.5, 1.25]).remainder, 0.5);
  assert.deepEqual(platesPerSide(15, 20).plates, []);
});

test('weekly goal counts sessions per week and streaks of met weeks', () => {
  const monday = new Date(2026, 8, 28);
  const history = [
    { day: '2026-09-28' },
    { day: '2026-09-22' },
    { day: '2026-09-24' },
    { day: '2026-09-15' },
    { day: '2026-09-17' },
    { day: '2026-09-01' },
  ];
  assert.deepEqual(weekStats(history, 2, monday), { thisWeek: 1, streak: 2, goal: 2 });
  assert.deepEqual(weekStats(history, 1, monday), { thisWeek: 1, streak: 3, goal: 1 });
  assert.equal(weekStats([], 3, monday).streak, 0);
});

test('sw.js precaches every module under src/', async () => {
  const { readdirSync, readFileSync, statSync, existsSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const file = join(dir, name);
      return statSync(file).isDirectory() ? walk(file) : file.endsWith('.js') ? [file] : [];
    });
  const modules = walk(join(root, 'src')).map((f) => relative(root, f).split('\\').join('/'));
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const listed = [...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]);
  for (const file of modules) assert.ok(listed.includes(file), `${file} is missing from the precache list`);
  for (const file of listed.filter((f) => f.endsWith('.js')))
    assert.ok(existsSync(join(root, file)), `${file} is precached but does not exist`);
});

test('backup validation keeps personal-record flags on sets', () => {
  const backup = validateBackup({
    plans: {
      activePlanId: 'p1',
      items: [{ id: 'p1', name: 'P', days: [{ id: 'd1', name: 'D', exercises: [{ id: 'e', name: 'E' }] }] }],
    },
    history: [
      {
        finishedAt: '2026-02-03T10:00:00Z',
        entries: [
          {
            exerciseId: 'e',
            sets: [
              { weight: '50', reps: '8', done: true, pr: true },
              { weight: '40', reps: '8', done: true },
            ],
          },
        ],
      },
    ],
    body: [],
    settings: {},
  });
  const [first, second] = backup.history[0].entries[0].sets;
  assert.equal(first.pr, true);
  assert.equal('pr' in second, false);
});

test('translations: fallback chain, interpolation and plural forms', () => {
  setLanguage('de');
  assert.equal(t('nav.home'), 'Heute');
  assert.equal(t('wizard.step', { step: 2 }), 'Schritt 2 von 2');
  assert.equal(t('does.not.exist', null, 'Fallback'), 'Fallback');
  assert.equal(t('does.not.exist'), 'does.not.exist');
  assert.equal(plural(1, 'sets'), '1 Satz');
  assert.equal(plural(3, 'sets'), '3 Sätze');
  setLanguage('en');
  assert.equal(t('nav.home'), 'Today');
  assert.equal(plural(1, 'sets'), '1 set');
  assert.equal(plural(3, 'sets'), '3 sets');
  assert.equal(setLanguage('xx'), 'en', 'unknown languages fall back to English');
  setLanguage('de');
});

test('both dictionaries have the same keys and no empty texts', () => {
  const dk = Object.keys(de);
  const ek = Object.keys(en);
  assert.deepEqual(
    dk.filter((k) => !(k in en)),
    [],
    'missing in en'
  );
  assert.deepEqual(
    ek.filter((k) => !(k in de)),
    [],
    'missing in de'
  );
  for (const k of dk) assert.ok(typeof de[k] === 'string' && de[k].length, `${k} is empty in de`);
  for (const k of ek) assert.ok(typeof en[k] === 'string' && en[k].length, `${k} is empty in en`);
});

test('exercise names resolve per language for library, built-in and custom exercises', () => {
  setLanguage('de');
  assert.equal(exerciseName({ id: 'x', libraryId: '0025', name: 'alt' }), 'Bankdrücken mit Langhantel');
  assert.equal(exerciseName({ exerciseId: 'chest-press', name: 'Brustpresse' }), 'Brustpresse');
  assert.equal(exerciseName({ id: 'custom-1', name: 'Meine Übung', custom: true }), 'Meine Übung');
  setLanguage('en');
  assert.equal(exerciseName({ libraryId: '0025' }), 'Barbell Bench Press');
  assert.equal(exerciseName({ exerciseId: 'chest-press' }), 'Chest Press');
  assert.equal(exerciseName({ id: 'custom-1', name: 'Meine Übung' }), 'Meine Übung');
  setLanguage('de');
  assert.equal(Object.keys(BUILT_IN).length, 16);
});

test('backup validation maps legacy German labels to keys and strips catalogue copies', () => {
  const backup = validateBackup({
    plans: {
      activePlanId: 'p1',
      items: [
        {
          id: 'p1',
          name: 'P',
          days: [
            {
              id: 'd1',
              name: 'D',
              exercises: [
                {
                  id: 'a',
                  libraryId: '0025',
                  name: 'Bankdrücken',
                  category: 'Brust',
                  equipment: 'Langhantel',
                  target: 'pectorals',
                  sourceName: 'barbell bench press',
                },
                { id: 'b', name: 'Eigene', custom: true, category: 'Eigene Übung', equipment: 'Kurzhanteln' },
              ],
            },
          ],
        },
      ],
    },
    history: [],
  });
  const [a, b] = backup.plans.items[0].days[0].exercises;
  assert.equal(a.category, undefined);
  assert.equal(a.equipment, undefined);
  assert.equal(a.sourceName, undefined);
  assert.equal(b.category, 'other');
  assert.equal(b.equipment, 'dumbbell');
});

test('set and exercise types: tracking, volume, completeness, scores and durations', async () => {
  const { newSetFor, setComplete, setScore, setSetType, trackTypeOf, parseDuration, fmtDuration, shortSet } =
    await import('../src/sets.js');
  const { isWorkSet, setVolume, volumeOf: volume } = await import('../src/util.js');
  setLanguage('de');
  assert.equal(trackTypeOf({ libraryId: '0025' }), 'weight_reps');
  assert.equal(trackTypeOf({ libraryId: '0662' }), 'reps', 'push-ups count reps');
  assert.equal(trackTypeOf({ libraryId: '0630' }), 'reps', 'mountain climbers count reps, not distance');
  assert.equal(trackTypeOf({ libraryId: '3544' }), 'time', 'planks are timed');
  assert.equal(trackTypeOf({ exerciseId: 'leg-raise' }), 'reps', 'built-in bodyweight exercise');
  assert.equal(
    trackTypeOf({ id: 'c1', name: 'Rudern', custom: true, trackType: 'distance_time' }),
    'distance_time'
  );
  const w = newSetFor('weight_reps', { weight: '60', reps: '8', done: true });
  assert.equal(setVolume(w, 'weight_reps'), 480);
  assert.ok(setScore(w, 'weight_reps') > 60);
  const bw = newSetFor('reps', { reps: '12', done: true });
  assert.equal(setComplete(bw, 'reps'), true);
  assert.equal(setVolume(bw, 'reps'), 0);
  assert.equal(setScore(bw, 'reps'), 12);
  assert.equal(setComplete(newSetFor('weight_reps', { reps: '12', done: true }), 'weight_reps'), false);
  const drop = setSetType(newSetFor('weight_reps', { weight: '40', reps: '10', done: true }), 'drop');
  assert.equal(isWorkSet(drop), true);
  assert.equal(drop.warmup, false);
  const warm = setSetType({ weight: '20', reps: '5', done: true }, 'warmup');
  assert.equal(warm.warmup, true);
  assert.equal(setVolume(warm, 'weight_reps'), 0);
  assert.equal(parseDuration('1:30'), '90');
  assert.equal(parseDuration('90'), '90');
  assert.equal(parseDuration('1:02:03'), '3723');
  assert.equal(parseDuration(''), '');
  assert.equal(fmtDuration(90), '1:30');
  assert.equal(fmtDuration(3723), '1:02:03');
  assert.equal(shortSet({ weight: '50', reps: '8' }, 'weight_reps'), '50×8');
  assert.equal(shortSet({ reps: '12', weight: '' }, 'reps'), '12');
  assert.equal(shortSet({ time: '90' }, 'time'), '1:30');
  assert.equal(volume({ entries: [{ trackType: 'reps', sets: [bw] }, { sets: [w] }] }), 480);
});

test('a version-3 backup from the live site still restores', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/backup-v3.json', import.meta.url), 'utf8'));
  const backup = validateBackup(fixture);
  assert.equal(backup.plans.items.length, 1);
  const [library, builtIn] = backup.plans.items[0].days[0].exercises;
  assert.equal(library.category, undefined, 'German labels are gone');
  assert.equal(library.libraryId, '0025');
  assert.equal(builtIn.name, 'Brustpresse');
  const [warm, work] = backup.history[0].entries[0].sets;
  assert.equal(warm.type, 'warmup');
  assert.equal(work.type, 'normal');
  assert.equal(work.pr, true);
  assert.equal(backup.history[0].volume, 960);
  assert.equal(backup.settings.language, 'auto');
  assert.equal(backup.settings.restTimer, true);
  assert.equal(backup.body[0].weight, 80.5);
});

test('the exercise catalogue is complete and consistent', async () => {
  const { EXERCISES } = await import('../assets/data/exercises.js');
  const { EXERCISE_LIBRARY, GROUPS } = await import('../src/library.js');
  const stepsEn = (await import('../assets/data/steps.en.js')).default;
  const stepsDe = (await import('../assets/data/steps.de.js')).default;
  assert.ok(EXERCISES.length >= 290, `${EXERCISES.length} exercises`);
  assert.equal(new Set(EXERCISES.map((e) => e.id)).size, EXERCISES.length, 'ids are unique');
  for (const id of ['0025', '0662', '0630', '0199', '0652', '0043', '0032'])
    assert.ok(
      EXERCISES.some((e) => e.id === id),
      `${id} is still in the catalogue`
    );
  for (const ex of EXERCISES) {
    assert.match(ex.file, /^\d{4}-\w+\.gif$/, `${ex.id} file`);
    assert.ok(de[`ex.${ex.id}`] && en[`ex.${ex.id}`], `${ex.id} has names in both languages`);
    assert.ok(stepsEn[ex.id]?.length >= 1 && stepsEn[ex.id].length <= 6, `${ex.id} has 1–6 English steps`);
    assert.equal(stepsDe[ex.id]?.length, stepsEn[ex.id].length, `${ex.id} has matching German steps`);
    assert.ok(de[`equipment.${ex.equipment}`] && en[`equipment.${ex.equipment}`], `${ex.equipment} label`);
    assert.ok(de[`muscle.${ex.target}`] && en[`muscle.${ex.target}`], `${ex.target} label`);
    for (const m of ex.secondary || []) assert.ok(de[`muscle.${m}`] && en[`muscle.${m}`], `${m} label`);
  }
  for (const ex of EXERCISE_LIBRARY) {
    assert.ok(GROUPS.includes(ex.group), `${ex.id} group ${ex.group}`);
    assert.match(ex.gif, /^https:\/\//, `${ex.id} gif`);
  }
});

test('records: bests per kind, record flags in chronological order, session diffs', async () => {
  const { computeRecords, annotateAll, sessionRecords, headlineKind } = await import('../src/records.js');
  const session = (id, day, weight, reps = 8) => ({
    id,
    day,
    finishedAt: `${day}T10:00:00.000Z`,
    entries: [
      {
        exerciseId: 'x',
        libraryId: '0025',
        name: 'Bank',
        trackType: 'weight_reps',
        sets: [
          { weight: '20', reps: '5', done: true, warmup: true, type: 'warmup' },
          { weight: String(weight), reps: String(reps), done: true, type: 'normal' },
          { weight: String(weight), reps: String(reps), done: true, type: 'normal' },
        ],
      },
      {
        exerciseId: 'p',
        libraryId: '0662',
        trackType: 'reps',
        sets: [{ reps: String(reps + 4), done: true }],
      },
    ],
  });
  const history = [
    session('new', '2026-03-10', 60),
    session('old', '2026-01-10', 50),
    session('mid', '2026-02-10', 55, 10),
  ];
  const records = computeRecords(history);
  assert.equal(records['0025'].maxWeight.value, 60);
  assert.equal(records['0025'].maxWeight.day, '2026-03-10');
  assert.ok(records['0025'].e1rm.value > records['0025'].maxWeight.value);
  assert.equal(records['0025'].e1rm.sessionId, 'new', '60×8 estimates higher than 55×10');
  assert.equal(records['0025'].maxVolume.sessionId, 'mid', '55×10 is the biggest set');
  assert.equal(records['0662'].maxReps.value, 14);
  assert.equal(headlineKind('reps'), 'maxReps');
  annotateAll(history);
  const flags = (id) => history.find((h) => h.id === id).entries[0].sets.map((s) => !!s.pr);
  assert.deepEqual(flags('old'), [false, false, false], 'first session: nothing to beat yet');
  assert.deepEqual(flags('mid'), [false, true, false]);
  assert.deepEqual(flags('new'), [false, true, false], '60×8 beats the 1RM of 55×10');
  const diff = sessionRecords(
    history.find((h) => h.id === 'new'),
    history
  );
  assert.deepEqual(
    diff.map((r) => `${r.key}:${r.kind}`).sort(),
    ['0025:e1rm', '0025:maxWeight'].sort(),
    '1RM and weight improved; set volume (480 < 550) and push-up reps (12 < 14) did not'
  );
});

test('supersets link consecutive exercises; a free workout becomes a plan day', async () => {
  const { linkSuperset, unlinkSuperset, supersetLetters, supersetPosition, dayFromSession } =
    await import('../src/plans.js');
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  linkSuperset(list, 0);
  linkSuperset(list, 1);
  assert.equal(list[0].supersetId, list[2].supersetId);
  assert.equal(list[3].supersetId, undefined);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => supersetPosition(list, i)),
    ['first', 'mid', 'last', 'single']
  );
  assert.deepEqual(Object.values(supersetLetters(list)), ['A']);
  unlinkSuperset(list, 1);
  assert.ok(
    list.every((ex) => !ex.supersetId),
    'dissolving removes the whole group'
  );
  const day = dayFromSession({
    dayName: 'Frei',
    exercises: [{ id: 'x', libraryId: '0025', name: 'Bank', sets: 3, range: '8–12' }],
  });
  assert.equal(day.name, 'Frei');
  assert.equal(day.exercises.length, 1);
  assert.equal(day.exercises[0].id, 'x', 'exercise ids are kept');
  assert.ok(day.id);
});

test('every template resolves to catalogue exercises and the first-run picker fits the answers', async () => {
  const { TEMPLATES, planFromTemplate, pickTemplate } = await import('../src/templates.js');
  setLanguage('de');
  assert.ok(TEMPLATES.length >= 10);
  for (const template of TEMPLATES) {
    const plan = planFromTemplate(template.id);
    assert.equal(plan.days.length, template.days, template.id);
    assert.ok(plan.days.length >= 2 && plan.days.length <= 6, template.id);
    plan.days.forEach((d) => {
      assert.ok(d.exercises.length >= 3, `${template.id}: ${d.name}`);
      d.exercises.forEach((ex) =>
        assert.ok(ex.libraryId && ex.sets >= 1 && ex.range, `${template.id}: ${ex.name}`)
      );
    });
    assert.ok(
      de[`template.${template.id}.name`] && en[`template.${template.id}.name`],
      `${template.id} names`
    );
  }
  assert.equal(planFromTemplate('upperLower4', { level: 'beginner' }).days[0].exercises[0].sets, 3);
  assert.equal(pickTemplate({ days: 4, equipment: 'gym' }).id, 'upperLower4');
  assert.equal(pickTemplate({ days: 3, equipment: 'home' }).id, 'home3');
  assert.equal(pickTemplate({ days: 5, equipment: 'dumbbell' }).id, 'dumbbell3', 'nearest day count');
  assert.equal(
    pickTemplate({ days: 3, equipment: 'gym', goal: 'strength', level: 'beginner' }).id,
    'linear2'
  );
  assert.equal(pickTemplate({ days: 6, equipment: 'gym' }).id, 'ppl6');
});

test('backup validation keeps custom exercises within limits', () => {
  const backup = validateBackup({
    plans: { activePlanId: 'p1', items: [{ id: 'p1', name: 'P', days: [] }] },
    history: [],
    customExercises: [
      {
        id: 'c1',
        name: 'Farmer Walk',
        category: 'legs',
        equipment: 'dumbbell',
        trackType: 'distance_time',
        note: 'x',
      },
      { id: 'c2', name: '', category: 'legs' },
      { id: 'c3', name: 'Odd', category: 'nope', equipment: '', trackType: 'nope' },
    ],
  });
  assert.equal(backup.customExercises.length, 2, 'a nameless entry is dropped');
  assert.deepEqual(
    backup.customExercises.map((c) => [c.category, c.equipment, c.trackType]),
    [
      ['legs', 'dumbbell', 'distance_time'],
      ['other', 'other', 'weight_reps'],
    ]
  );
});

test('editor helpers: duplicate a day, move an exercise to another day, reorder', async () => {
  const { duplicateDay, moveExerciseToDay, reorderExercises } = await import('../src/plans.js');
  setLanguage('de');
  const plan = {
    days: [
      {
        id: 'a',
        name: 'A',
        exercises: [{ id: 'x', supersetId: 's' }, { id: 'y', supersetId: 's' }, { id: 'z' }],
      },
      { id: 'b', name: 'B', exercises: [] },
    ],
    schedule: { mode: 'flexible', assignments: {} },
  };
  const copy = duplicateDay(plan, 0);
  assert.equal(plan.days.length, 3);
  assert.equal(copy.name, 'A – Kopie');
  assert.notEqual(copy.exercises[0].id, 'x', 'copied exercises get fresh ids');
  const moved = moveExerciseToDay(plan, 0, 0, 1);
  assert.equal(moved.id, 'x');
  assert.equal(moved.supersetId, undefined, 'a moved exercise leaves its superset');
  assert.deepEqual(
    plan.days[1].exercises.map((e) => e.id),
    ['x']
  );
  reorderExercises(plan.days[0], [1, 0]);
  assert.deepEqual(
    plan.days[0].exercises.map((e) => e.id),
    ['z', 'y']
  );
  reorderExercises(plan.days[0], [0]);
  assert.equal(plan.days[0].exercises.length, 2, 'a wrong-sized order is ignored');
});

test('weekly stats: sets per group, weekly volume, frequency, record timeline, body vs strength', async () => {
  const { weeklySets, weeklyVolume, frequency, recordTimeline, strengthVsBodyweight, startOfWeek } =
    await import('../src/stats.js');
  const today = new Date(2026, 9, 29, 12); // Thursday
  const key = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const monday = startOfWeek(today);
  const thisWeek = key(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 1));
  const lastWeek = key(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 6));
  const session = (id, day, weight, pr = false) => ({
    id,
    day,
    finishedAt: `${day}T10:00:00.000Z`,
    dayName: 'Push',
    volume: weight * 8 * 2,
    entries: [
      {
        exerciseId: 'x',
        libraryId: '0025',
        name: 'Bank',
        trackType: 'weight_reps',
        sets: [
          { weight: String(weight), reps: '8', done: true, type: 'normal', pr },
          { weight: String(weight), reps: '8', done: true, type: 'normal' },
        ],
      },
    ],
  });
  const history = [session('a', thisWeek, 60, true), session('b', lastWeek, 50), session('c', lastWeek, 50)];
  assert.deepEqual(weeklySets(history, { weeks: 1, today }), [{ group: 'chest', sets: 2 }]);
  assert.deepEqual(weeklySets(history, { weeks: 4, today }), [{ group: 'chest', sets: 1.5 }]);
  // On request the groups that only help get a share: triceps and shoulders on the bench press.
  assert.deepEqual(weeklySets(history, { weeks: 1, today, helping: 0.5 }), [
    { group: 'chest', sets: 2 },
    { group: 'arms', sets: 1 },
    { group: 'shoulders', sets: 1 },
  ]);
  const volume = weeklyVolume(history, 3, today);
  assert.equal(volume.length, 3);
  assert.deepEqual(
    volume.map((p) => p.value),
    [0, 1600, 960]
  );
  assert.deepEqual(
    frequency(history, 3, today).map((p) => p.value),
    [0, 2, 1]
  );
  const timeline = recordTimeline(history);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].count, 1);
  const combo = strengthVsBodyweight(history, [{ day: thisWeek, weight: 80 }], '0025');
  assert.equal(combo.points.length, 3);
  assert.equal(combo.weight[2].value, 80, 'the measurement two days earlier counts');
  assert.equal(combo.weight[0].value, 80, 'a measurement within ten days counts for earlier sessions too');
});

test('progression: stall detection, per-exercise increment and 1RM reps table', async () => {
  const { suggestion, stalled, repsAtPercent } = await import('../src/workout.js');
  const session = (id, day, weight, reps) => ({
    id,
    day,
    finishedAt: `${day}T10:00:00.000Z`,
    entries: [
      {
        exerciseId: 'x',
        libraryId: '0025',
        trackType: 'weight_reps',
        sets: [{ weight: String(weight), reps: String(reps), done: true, type: 'normal' }],
      },
    ],
  });
  const ex = { id: 'x', libraryId: '0025', range: '8–12' };
  const flat = [
    session('c', '2026-03-03', 60, 8),
    session('b', '2026-02-24', 60, 8),
    session('a', '2026-02-17', 60, 8),
  ];
  assert.equal(stalled(ex, flat), true);
  const today = new Date('2026-03-04T12:00:00Z');
  const stall = suggestion(ex, flat, today);
  assert.equal(stall.kind, 'stall');
  assert.equal(stall.weight, 55, '10 % off 60 kg, rounded to the plate step');
  const rising = [
    session('c', '2026-03-03', 62.5, 8),
    session('b', '2026-02-24', 60, 8),
    session('a', '2026-02-17', 60, 8),
  ];
  assert.equal(stalled(ex, rising), false);
  assert.equal(suggestion(ex, rising, today).kind, 'confirm');
  const topOfRange = [session('c', '2026-03-03', 60, 12)];
  assert.equal(suggestion(ex, topOfRange, today).weight, 62.5, 'default increment');
  assert.equal(
    suggestion({ ...ex, increment: 1 }, topOfRange, today).weight,
    61,
    'plan exercise increment wins'
  );
  assert.equal(repsAtPercent(100), 1);
  assert.equal(repsAtPercent(80), 8);
});

test('settings validation covers the rest feedback and the defaults for new exercises', () => {
  const backup = validateBackup({
    plans: { activePlanId: 'p1', items: [{ id: 'p1', name: 'P', days: [] }] },
    history: [],
    settings: { restSound: 1, restVibrate: false, defaultSets: 99, defaultRange: '' },
  });
  assert.equal(backup.settings.restSound, true);
  assert.equal(backup.settings.restVibrate, false);
  assert.equal(backup.settings.defaultSets, 12);
  assert.equal(backup.settings.defaultRange, '8–12');
  assert.equal(
    validateBackup({ plans: { items: [{ id: 'p', name: 'P', days: [] }] }, history: [] }).settings
      .restVibrate,
    true
  );
});

test('Hevy export: sessions, set types, tracking per exercise, unknown names', () => {
  const parsed = parseImport(readFileSync(new URL('./fixtures/hevy.csv', import.meta.url), 'utf8'));
  assert.equal(parsed.source, 'hevy');
  assert.deepEqual(parsed.unknown, ['Banded Face Pull Special']);
  assert.deepEqual(
    parsed.sessions.map((s) => [s.day, s.dayName, s.volume, s.totalSets, s.duration]),
    [
      ['2024-10-14', 'Pull Day', 550, 4, 4200],
      ['2024-10-12', 'Push Day', 1500, 6, 4320],
    ]
  );
  const push = parsed.sessions[1];
  assert.deepEqual(
    push.entries.map((e) => [e.libraryId, e.trackType]),
    [
      ['0025', 'weight_reps'],
      ['1457', 'weight_reps'],
      ['2135', 'time'],
      [undefined, 'reps'],
    ]
  );
  const bench = push.entries[0];
  assert.equal(bench.note, 'Pause at the chest');
  assert.deepEqual(
    bench.sets.map((x) => [x.type, x.weight, x.reps, x.rir, x.done]),
    [
      ['warmup', 40, 10, '', true],
      ['normal', 60, 8, 2, true],
      ['normal', 60, 8, '', true],
    ]
  );
  assert.equal(push.entries[1].sets[1].type, 'drop');
  assert.equal(push.entries[2].sets[0].time, 60);
  const pull = parsed.sessions[0];
  assert.deepEqual(
    pull.entries.map((e) => [e.libraryId, e.trackType]),
    [
      ['0652', 'reps'],
      ['0198', 'weight_reps'],
      ['0685', 'distance_time'],
    ]
  );
  assert.equal(pull.entries[0].sets[1].type, 'failure');
  assert.deepEqual([pull.entries[2].sets[0].distance, pull.entries[2].sets[0].time], [3.2, 1080]);
});

test('Strong export: pounds become kilograms, timer and note rows are skipped, warm-ups are marked', () => {
  const parsed = parseImport(readFileSync(new URL('./fixtures/strong.csv', import.meta.url), 'utf8'));
  assert.equal(parsed.source, 'strong');
  assert.equal(parsed.unitAssumed, false);
  assert.deepEqual(parsed.unknown, []);
  const push = parsed.sessions[1];
  assert.deepEqual([push.dayName, push.duration, push.totalSets], ['Push Day', 4320, 3]);
  assert.deepEqual(
    push.entries.map((e) => [e.libraryId, e.sets.map((x) => `${x.type}:${x.weight}x${x.reps}`).join(' ')]),
    [
      ['0025', 'normal:61.235x8 normal:61.235x8'],
      ['0043', 'warmup:43.091x5 normal:83.915x5'],
    ]
  );
  assert.equal(push.entries[0].sets[0].rir, 2);
  const cardio = parsed.sessions[0];
  assert.deepEqual(
    [cardio.entries[0].trackType, cardio.entries[0].sets[0].distance, cardio.entries[0].sets[0].time],
    ['distance_time', 3.219, 1500]
  );
  // The newer Strong format has no unit column: the unit comes from the settings.
  const assumed = parseImport(
    'Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE\n2024-10-12 10:03:00,Legs,45m,Squat (Barbell),1,100,5,0,0,,,\n',
    { unit: 'lbs' }
  );
  assert.equal(assumed.unitAssumed, true);
  assert.equal(assumed.sessions[0].entries[0].sets[0].weight, 45.359);
  assert.equal(parseImport('a,b\n1,2\n').source, null);
});

test('merging an import skips sessions already there and creates each unknown exercise once', () => {
  const text = readFileSync(new URL('./fixtures/hevy.csv', import.meta.url), 'utf8');
  const once = mergeImport([], [], parseImport(text));
  assert.deepEqual([once.added, once.skipped, once.created], [2, 0, 1]);
  assert.deepEqual(
    once.customs.map((c) => [c.name, c.trackType, c.category]),
    [['Banded Face Pull Special', 'reps', 'other']]
  );
  const custom = once.history[1].entries[3];
  assert.equal(custom.libraryId, once.customs[0].id, 'the entry links to the custom exercise');
  assert.ok(
    once.history.every((h) => h.entries.every((e) => e.sets.every((x) => x.pr === false))),
    'record flags are computed over the merged history: first sessions set the baseline'
  );
  const twice = mergeImport(once.history, once.customs, parseImport(text));
  assert.deepEqual([twice.added, twice.skipped, twice.created, twice.history.length], [0, 2, 0, 2]);
  const backup = validateBackup({
    plans: { items: [{ id: 'p', name: 'P', days: [] }] },
    history: once.history,
  });
  assert.equal(
    backup.history[0].imported.key,
    once.history[0].imported.key,
    'the import marker survives a backup'
  );
});

test('exercise names from other apps land on the catalogue entry', () => {
  assert.deepEqual(
    [
      'Bench Press (Barbell)',
      'Squat (Barbell)',
      'Lat Pulldown (Cable)',
      'Seated Cable Row - V Grip (Cable)',
      'Bicep Curl (Machine)',
      'Triceps Rope Pushdown',
      'Pull Up',
      'Farmers Walk',
    ].map(matchExercise),
    ['0025', '0043', '0198', '0861', '0575', '0200', '0652', null]
  );
});

test('logging: a tick adopts the grey values, an empty set is refused, the clock starts with it', async () => {
  const { setReference, toggleSet, sessionStarted, finishCounts } = await import('../src/workout.js');
  const blank = () => ({ weight: '', reps: '', rir: '', done: false, type: 'normal' });
  const session = {
    startedAt: '2020-01-01T00:00:00.000Z',
    entries: [{ exerciseId: 'x', trackType: 'weight_reps', sets: [blank(), blank(), blank()] }],
  };
  const entry = session.entries[0];
  assert.equal(sessionStarted(session), false);
  assert.equal(toggleSet(session, 0, 0, []), false, 'nothing to log');
  assert.equal(entry.sets[0].done, false);
  assert.equal(sessionStarted(session), false);
  assert.equal(toggleSet(session, 0, 0, [{ weight: '50', reps: '8' }]), true, 'last session fills it');
  assert.deepEqual([entry.sets[0].weight, entry.sets[0].reps, entry.sets[0].done], ['50', '8', true]);
  assert.equal(sessionStarted(session), true);
  assert.notEqual(session.startedAt, '2020-01-01T00:00:00.000Z', 'the clock starts with the first set');
  assert.deepEqual(setReference(entry, 1, []), entry.sets[0], 'without a last session: the set before');
  assert.equal(toggleSet(session, 0, 0, []), true, 'unticking always works');
  assert.equal(entry.sets[0].done, false);
  toggleSet(session, 0, 0, []);
  entry.sets[1].reps = '10';
  entry.sets[1].weight = '50';
  entry.sets[1].touched = true;
  assert.deepEqual(finishCounts(session), { done: 1, typed: 1, open: 1 });
});

test('finishing: open sets drop out, duration ends with the last set and has a cap', async () => {
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
  });
  const { finishSession } = await import('../src/workout.js');
  const { getHistory, saveHistory, clearActive } = await import('../src/storage.js');
  saveHistory([]);
  clearActive();
  const hours = (n) => new Date(Date.now() - n * 3600000).toISOString();
  const set = (done, extra = {}) => ({ weight: '50', reps: '8', rir: '', done, type: 'normal', ...extra });
  const saved = finishSession({
    id: 's',
    startedAt: hours(72),
    lastSetAt: hours(71),
    markers: {},
    entries: [
      {
        exerciseId: 'a',
        trackType: 'weight_reps',
        sets: [set(true), set(false), set(false, { touched: true })],
      },
      { exerciseId: 'b', trackType: 'weight_reps', sets: [set(false)] },
    ],
  });
  assert.equal(saved.entries.length, 1, 'an exercise without sets drops out');
  assert.equal(saved.entries[0].sets.length, 2, 'typed set stays, open set goes');
  assert.equal(saved.totalSets, 2);
  assert.equal(saved.duration, 3600, 'three days open, but the last set came after an hour');
  assert.equal(saved.finishedAt, new Date(saved.finishedAt).toISOString());
  assert.equal(getHistory().length, 1);
  saveHistory([]);
});

test('plans: the rotation skips empty days and copies keep their history link', async () => {
  const { duplicatePlan } = await import('../src/plans.js');
  const ex = { id: 'chest-press', name: 'Brustpresse', sets: 3, range: '8–12' };
  const plan = {
    id: 'p',
    name: 'P',
    days: [
      { id: 'a', name: 'A', exercises: [ex] },
      { id: 'b', name: 'B', exercises: [] },
      { id: 'c', name: 'C', exercises: [{ ...ex, id: 'y' }] },
    ],
  };
  const after = (dayId) => nextSession(plan, [{ planId: 'p', dayId }]).day.id;
  assert.equal(after('a'), 'c');
  assert.equal(after('c'), 'a');
  const copy = duplicatePlan(plan);
  assert.notEqual(copy.days[0].exercises[0].id, 'chest-press');
  assert.equal(copy.days[0].exercises[0].libraryId, 'chest-press');
});

test('progression: advice cannot spiral down, drop sets do not block, values are cleaned', async () => {
  const { suggestion } = await import('../src/workout.js');
  const { normalizeRange, setsCount } = await import('../src/util.js');
  const ex = { id: 'x', libraryId: '0025', range: '8–12' };
  const row = (weight, reps, sets = []) => ({
    entries: [
      {
        exerciseId: 'x',
        libraryId: '0025',
        trackType: 'weight_reps',
        sets: [{ weight: String(weight), reps: String(reps), done: true, type: 'normal' }, ...sets],
      },
    ],
  });
  const flat = [row(100, 10), row(100, 10), row(100, 10)];
  assert.equal(suggestion(ex, flat).kind, 'stall');
  const lighter = [row(90, 10), row(90, 10), row(90, 10), ...flat];
  assert.equal(suggestion(ex, lighter).kind, 'confirm', 'already the lighter weeks: no second cut');
  const drop = { weight: '40', reps: '6', done: true, type: 'drop' };
  assert.equal(suggestion(ex, [row(60, 12, [drop])]).kind, 'progress');
  assert.equal(normalizeRange('8-12'), '8–12');
  assert.equal(normalizeRange('12 - 8'), '8–12');
  assert.equal(normalizeRange('10'), '10');
  assert.equal(normalizeRange('', '6–8'), '6–8');
  assert.equal(normalizeRange('30 s'), '30 s');
  assert.deepEqual([-1, 0, '', 2.5, 999, 4].map(setsCount), [3, 3, 3, 3, 12, 4]);
});

test('suggestions read the last weeks: a long break, too heavy, a plateau and the trend', async () => {
  const { strengthTrend, suggestion } = await import('../src/workout.js');
  const ex = { id: 'x', libraryId: '0025', range: '8–12' };
  const session = (day, weight, reps) => ({
    day,
    finishedAt: `${day}T10:00:00.000Z`,
    entries: [
      {
        exerciseId: 'x',
        libraryId: '0025',
        trackType: 'weight_reps',
        sets: [{ weight: String(weight), reps: String(reps), done: true, type: 'normal' }],
      },
    ],
  });
  const today = new Date('2026-06-01T12:00:00Z');

  const away = suggestion(ex, [session('2026-05-01', 60, 12)], today);
  assert.deepEqual(
    [away.kind, away.weight, away.weeks],
    ['comeback', 55, 4],
    'a month off beats the increase'
  );
  assert.equal(
    suggestion(ex, [session('2026-05-20', 60, 12)], today).kind,
    'progress',
    'twelve days are no break'
  );

  const heavy = [session('2026-05-28', 60, 6), session('2026-05-25', 60, 7)];
  const tooHeavy = suggestion(ex, heavy, today);
  assert.deepEqual([tooHeavy.kind, tooHeavy.weight], ['reduce', 57.5]);
  assert.equal(
    suggestion(ex, [session('2026-05-28', 60, 8), session('2026-05-25', 60, 7)], today).kind,
    'confirm',
    'reaching the range once is enough'
  );

  // Up and down for six weeks: never three flat sessions in a row, and no real gain either.
  const wavy = [
    session('2026-05-30', 60, 10),
    session('2026-05-22', 62.5, 8),
    session('2026-05-15', 60, 9),
    session('2026-05-08', 60, 10),
    session('2026-05-01', 62.5, 8),
    session('2026-04-24', 60, 10),
  ];
  const plateau = suggestion(ex, wavy, today);
  assert.equal(plateau.kind, 'plateau');
  assert.equal(plateau.weeks, 5);
  assert.ok(Math.abs(strengthTrend(ex, wavy, today).percent) < 1);

  const rising = [
    session('2026-05-30', 67.5, 10),
    session('2026-05-22', 65, 10),
    session('2026-05-15', 62.5, 10),
    session('2026-05-08', 60, 10),
  ];
  assert.ok(strengthTrend(ex, rising, today).percent > 5);
  assert.equal(strengthTrend(ex, rising.slice(0, 2), today), null, 'two sessions are no trend');
});

test('replacements train the same muscle and prefer the equipment in use', async () => {
  const { alternativesFor, libraryExercise } = await import('../src/library.js');
  const base = libraryExercise('0025');
  const options = alternativesFor(base, { equipment: ['dumbbell'] });
  assert.equal(options.length, 5);
  assert.ok(options.every((x) => x.target === base.target && x.id !== base.id));
  assert.equal(options[0].equipment === 'dumbbell' || options[0].equipment === 'body weight', true);
  const counts = {};
  options.forEach((x) => (counts[x.equipment] = (counts[x.equipment] || 0) + 1));
  assert.ok(
    Object.values(counts).every((n) => n <= 3),
    'a choice of equipment'
  );
  assert.deepEqual(alternativesFor({ name: 'Unknown', id: 'nope' }), []);
  const builtIn = alternativesFor({ id: 'squat' });
  assert.ok(builtIn.length && builtIn.every((x) => x.target === 'quads'), 'the default plan has them too');
  assert.ok(
    alternativesFor({ id: 'chest-press' }).every((x) => exerciseName(x) !== 'Brustpresse'),
    'the same exercise under another id is no replacement'
  );
});

const sse = (...events) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
  });
const textEvents = (text, stop = 'end_turn') => [
  { type: 'message_start', message: {} },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(0, 3) } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(3) } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: stop } },
  { type: 'message_stop' },
];
const toolEvents = (id, name, json) => [
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan it' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name, input: {} } },
  {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: json.slice(0, 2) },
  },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json.slice(2) } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
];
const USER = [{ role: 'user', content: 'u' }];

test('Claude client: browser headers, streamed text, errors and one retry', async () => {
  const { runTurn, errorCode, verifyKey } = await import('../src/ai.js');
  const original = globalThis.fetch;
  const ask = (extra = {}) => runTurn({ key: 'k', system: 's', messages: USER, ...extra });
  try {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return sse(...textEvents('Hallo Welt'));
    };
    const seen = [];
    const reply = await ask({ onText: (text) => seen.push(text) });
    assert.equal(reply.text, 'Hallo Welt', 'thinking stays out of the answer');
    assert.deepEqual(seen, ['Hal', 'Hallo Welt']);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0].init.headers['x-api-key'], 'k');
    assert.equal(calls[0].init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.stream, true);
    assert.equal(JSON.stringify(body).includes('"k"'), false, 'the key travels only in its header');

    const failing =
      (status, message = 'x') =>
      async () =>
        new Response(JSON.stringify({ error: { message } }), { status });
    globalThis.fetch = failing(401);
    await assert.rejects(ask(), { code: 'key' });
    globalThis.fetch = failing(400, 'Your credit balance is too low');
    await assert.rejects(ask(), { code: 'billing' });
    globalThis.fetch = failing(400, 'tools.0: bad field');
    await assert.rejects(ask(), { code: 'request', detail: 'tools.0: bad field' });

    let tries = 0;
    globalThis.fetch = async () => {
      tries++;
      return tries === 1 ? new Response('{}', { status: 529 }) : sse(...textEvents('Wieder da'));
    };
    assert.equal((await ask()).text, 'Wieder da');
    assert.equal(tries, 2, 'a busy service gets one more try');

    globalThis.fetch = async () => sse(...textEvents('Nein', 'refusal'));
    await assert.rejects(ask(), { code: 'refusal' });
    globalThis.fetch = async () => sse(...textEvents('Lange Antwort', 'max_tokens'));
    assert.equal((await ask()).stopReason, 'max_tokens', 'plain text that was cut off is still shown');

    globalThis.fetch = async () => {
      throw new TypeError('offline');
    };
    await assert.rejects(ask(), { code: 'network' });

    const controller = new AbortController();
    globalThis.fetch = (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('stop'), { name: 'AbortError' }))
        );
        controller.abort();
      });
    await assert.rejects(ask({ signal: controller.signal }), { code: 'aborted' });

    let verified = 0;
    globalThis.fetch = async (url) => {
      verified++;
      assert.match(url, /count_tokens$/);
      return new Response('{}', { status: 200 });
    };
    await verifyKey('sk-ant-api-test');
    assert.equal(verified, 1);
    await assert.rejects(verifyKey('sk-ant-oat-test'), { code: 'subscription' });
    assert.equal(verified, 1, 'a subscription token is not even sent');
    assert.equal(errorCode(404), 'model');
    assert.equal(errorCode(503), 'server');
  } finally {
    globalThis.fetch = original;
  }
});

test('a turn with tools sends thinking back unchanged and reports bad input to Claude', async () => {
  const { runTurn } = await import('../src/ai.js');
  const original = globalThis.fetch;
  try {
    const bodies = [];
    const script = [
      () => sse(...toolEvents('t1', 'list_plans', '{"a":1}')),
      () => sse(...toolEvents('t2', 'list_plans', '{"broken')),
      () => sse(...toolEvents('t3', 'boom', '{}')),
      () => sse(...textEvents('Fertig')),
    ];
    globalThis.fetch = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return script[bodies.length - 1]();
    };
    const executed = [];
    const reply = await runTurn({
      key: 'k',
      system: 'S',
      tools: [{ name: 'list_plans' }],
      messages: USER,
      execute: async (name, input) => {
        executed.push([name, input]);
        if (name === 'boom') throw new Error('kaputt');
        return { ok: true };
      },
    });
    assert.equal(reply.text, 'Fertig');
    assert.deepEqual(
      executed,
      [
        ['list_plans', { a: 1 }],
        ['boom', {}],
      ],
      'unreadable input is never run'
    );
    assert.ok(
      bodies.every((b) => b.system === 'S' && b.tools[0].name === 'list_plans'),
      'system and tools stay the same for the whole turn'
    );
    const second = bodies[1].messages;
    assert.deepEqual(second[0], USER[0]);
    assert.deepEqual(second[1].content[0], { type: 'thinking', thinking: 'plan it', signature: 'sig-1' });
    assert.deepEqual(second[1].content[1], {
      type: 'tool_use',
      id: 't1',
      name: 'list_plans',
      input: { a: 1 },
    });
    assert.deepEqual(second[2].content[0], {
      type: 'tool_result',
      tool_use_id: 't1',
      content: '{"ok":true}',
    });
    assert.deepEqual(bodies[2].messages.slice(0, 3), second, 'the transcript only grows');
    const bad = bodies[2].messages[4].content[0];
    assert.equal(bad.is_error, true);
    assert.match(bad.content, /INVALID_JSON/);
    assert.deepEqual(bodies[2].messages[3].content[1].input, {}, 'the API gets a valid object back');
    const failed = bodies[3].messages[6].content[0];
    assert.equal(failed.is_error, true);
    assert.match(failed.content, /kaputt/);

    let count = 0;
    globalThis.fetch = async () => {
      count++;
      return sse(...toolEvents(`t${count}`, 'list_plans', '{}'));
    };
    await assert.rejects(runTurn({ key: 'k', system: 'S', messages: USER, execute: async () => ({}) }), {
      code: 'steps',
    });
    assert.equal(count, 12, 'a turn cannot run forever');

    globalThis.fetch = async () =>
      sse(...toolEvents('t', 'list_plans', '{"a":').slice(0, -1), {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens' },
      });
    await assert.rejects(
      runTurn({ key: 'k', system: 'S', messages: USER, execute: async () => assert.fail('must not run') }),
      { code: 'truncated' }
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('assistant tools: plans change completely or not at all, deleting asks, undo checks for later changes', async () => {
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
  });
  // Changing settings applies the theme, which needs these two from the browser.
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.document = {
    documentElement: { dataset: {}, setAttribute: () => {}, style: { setProperty: () => {} } },
    querySelector: () => null,
  };
  const { runTool, aiTools } = await import('../src/aiTools.js');
  const {
    allPlans,
    clearActive,
    getActive,
    getAiMemory,
    getBody,
    getHistory,
    getSettings,
    saveActive,
    saveBody,
    saveHistory,
    savePlans,
    saveSettings,
  } = await import('../src/storage.js');
  const { assistantSystem } = await import('../src/aiPrompts.js');
  const { defaultPlan } = await import('../src/library.js');
  const first = defaultPlan();
  savePlans({ activePlanId: first.id, items: [first] });
  saveHistory([]);
  saveBody([]);
  saveSettings({});
  const run = (name, input = {}, confirm = async () => assert.fail('no question expected')) =>
    runTool(name, input, { confirm });

  assert.ok(aiTools().every((tool) => tool.input_schema.type === 'object' && tool.eager_input_streaming));
  assert.equal(new Set(aiTools().map((tool) => tool.name)).size, aiTools().length);
  const listed = (await run('list_plans')).result;
  assert.equal(listed.active_plan_id, first.id);
  assert.equal(listed.plans[0].days[0].exercises[0].exercise_id, 'chest-press');

  const found = (await run('search_exercises', { query: 'bankdruecken langhantel', limit: 3 })).result
    .exercises;
  assert.ok(
    found.some((x) => x.exercise_id === '0025'),
    'German words without umlauts find it'
  );
  assert.ok(
    (await run('search_exercises', { group: 'legs' })).result.exercises.every((x) => x.group === 'legs')
  );
  assert.match((await run('get_exercise_stats', { exercise_id: 'nope' })).error, /Unknown/);
  assert.equal((await run('get_exercise_stats', { exercise_id: '0025' })).result.exercise_id, '0025');
  assert.deepEqual((await run('get_training_history')).result.sessions, []);
  assert.equal((await run('get_stats')).result.total_sessions, 0);
  assert.deepEqual((await run('get_body_data')).result.entries, []);
  assert.match((await run('nonsense')).error, /Unknown tool/);

  // A wrong id stops everything.
  const refused = await run('create_plan', {
    name: 'X',
    days: [{ name: 'A', exercises: [{ exercise_id: '0025' }, { exercise_id: 'made-up' }] }],
  });
  assert.match(refused.error, /made-up/);
  assert.equal(allPlans().items.length, 1);
  assert.match((await run('create_plan', { name: 'X', days: [] })).error, /at least one day/);

  const created = await run('create_plan', {
    name: 'Kurzhantel',
    description: 'Passt.',
    days: [
      {
        name: 'Tag A',
        exercises: [
          { exercise_id: '0025', sets: 99, range: '8-12', note: 'x'.repeat(500), rest_seconds: 120 },
          { exercise_id: '0025' },
          { exercise_id: '0003' },
        ],
      },
    ],
  });
  const id = created.result.plan_id;
  let plan = allPlans().items.find((p) => p.id === id);
  assert.equal(allPlans().activePlanId, id);
  assert.equal(plan.days[0].exercises.length, 2, 'doubles are dropped');
  const [one] = plan.days[0].exercises;
  assert.deepEqual([one.sets, one.range, one.note.length, one.rest], [12, '8–12', 200, 120]);
  assert.ok(plan.schedule.assignments[plan.days[0].id] !== undefined);

  // Update: unknown fields stay, the same exercise keeps what it had, days keep their id.
  const dayId = plan.days[0].id;
  const oneId = one.id;
  const updated = await run('update_plan', {
    plan_id: id,
    days: [{ id: dayId, name: 'Neu', exercises: [{ exercise_id: '0025', sets: 4 }] }],
  });
  assert.ok(updated.action);
  plan = allPlans().items.find((p) => p.id === id);
  assert.equal(plan.name, 'Kurzhantel');
  assert.equal(plan.days[0].id, dayId);
  assert.deepEqual(
    [
      plan.days[0].name,
      plan.days[0].exercises[0].id,
      plan.days[0].exercises[0].sets,
      plan.days[0].exercises[0].rest,
    ],
    ['Neu', oneId, 4, 120]
  );
  assert.match((await run('update_plan', { plan_id: 'nope' })).error, /Unknown plan_id/);

  // Undo works only while nothing else has changed.
  const rename = await run('update_plan', { plan_id: id, name: 'Anders' });
  const activate = await run('set_active_plan', { plan_id: first.id });
  assert.equal(rename.action.undo(), false, 'a later change blocks an older undo');
  assert.equal(allPlans().activePlanId, first.id);
  assert.equal(activate.action.undo(), true);
  assert.equal(allPlans().activePlanId, id);
  assert.equal(rename.action.undo(), true, 'in reverse order it works again');
  assert.equal(allPlans().items.find((p) => p.id === id).name, 'Kurzhantel');

  // Deleting always asks.
  const asked = [];
  const declined = await run('delete_plan', { plan_id: id }, async (o) => {
    asked.push(o);
    return false;
  });
  assert.equal(declined.result.deleted, false);
  assert.match(asked[0].title, /Kurzhantel/);
  assert.equal(asked[0].danger, true);
  assert.ok(allPlans().items.some((p) => p.id === id));
  const deleted = await run('delete_plan', { plan_id: id }, async () => true);
  assert.equal(deleted.result.deleted, true);
  assert.equal(allPlans().activePlanId, first.id, 'another plan becomes active');
  assert.match((await run('delete_plan', { plan_id: first.id })).error, /only plan/);
  assert.equal(deleted.action.undo(), true);
  assert.ok(allPlans().items.some((p) => p.id === id));

  // Settings: checked, limited, with the unit's usual steps.
  assert.match((await run('update_settings', {})).error, /Nothing to change/);
  assert.match((await run('update_settings', { theme: 'pink' })).error, /theme/);
  const before = getSettings();
  const changed = await run('update_settings', { rest_seconds: 9999, show_rir: true, unit: 'lbs' });
  const after = getSettings();
  assert.deepEqual([after.rest, after.showRir, after.unit], [600, true, 'lbs']);
  assert.ok(Math.abs(after.increment * 2.20462 - 5) < 0.01);
  assert.match(changed.action.label, /RIR/);
  assert.equal(changed.action.undo(), true);
  assert.deepEqual(getSettings(), before);
  setLanguage('de');

  // Memory: kept, removable, with an undo.
  const kept = await run('remember', { fact: 'Schulter links empfindlich' });
  assert.deepEqual(
    getAiMemory().map((m) => m.text),
    ['Schulter links empfindlich']
  );
  assert.match(kept.action.label, /Gemerkt/);
  assert.match((await run('forget', { id: 'nope' })).error, /Unknown/);
  const gone = await run('forget', { id: kept.result.id });
  assert.deepEqual(getAiMemory(), []);
  assert.equal(gone.action.undo(), true);
  assert.equal(getAiMemory().length, 1);
  assert.match((await run('remember', { fact: ' ' })).error, /empty/);
  assert.match(assistantSystem('X'), /Schulter links empfindlich/);

  // Body data and a workout told in the chat.
  assert.match((await run('add_body_entry', {})).error, /at least one/);
  const body = await run('add_body_entry', { weight: 82, date: '2026-10-30' });
  assert.equal(getBody()[0].day, '2026-10-30');
  assert.equal(body.action.undo(), true);
  assert.deepEqual(getBody(), []);
  assert.match((await run('log_past_workout', { date: '2999-01-01', exercises: [] })).error, /future/);
  assert.match(
    (await run('log_past_workout', { date: '2026-10-30', exercises: [{ exercise_id: 'x', sets: [] }] }))
      .error,
    /Unknown/
  );
  const past = await run('log_past_workout', {
    date: '2026-10-30',
    name: 'Nachtrag',
    exercises: [
      {
        exercise_id: '0025',
        sets: [
          { weight: 60, reps: 10 },
          { weight: 60, reps: 8 },
        ],
      },
    ],
  });
  const [saved] = getHistory();
  assert.deepEqual(
    [saved.day, saved.dayName, saved.totalSets, saved.volume],
    ['2026-10-30', 'Nachtrag', 2, 1080]
  );
  assert.equal((await run('get_training_history', { days: 3650 })).result.sessions.length, 1);
  assert.equal(past.action.undo(), true);
  assert.deepEqual(getHistory(), []);

  // The running workout.
  assert.match((await run('update_active_workout', { action: 'log', index: 0 })).error, /No workout/);
  assert.equal((await run('get_active_workout')).result.running, false);
  const { freshFreeSession, addSessionExercise } = await import('../src/workout.js');
  const { planExerciseFromLibrary } = await import('../src/plans.js');
  const { libraryExercise } = await import('../src/library.js');
  const session = freshFreeSession();
  addSessionExercise(session, planExerciseFromLibrary(libraryExercise('0025')));
  saveActive(session);
  assert.equal((await run('get_active_workout')).result.exercises[0].exercise_id, '0025');
  const logged = await run('update_active_workout', {
    action: 'log',
    index: 0,
    sets: [{ weight: 50, reps: 12 }],
  });
  let live = getActive();
  assert.deepEqual(
    [live.entries[0].sets[0].weight, live.entries[0].sets[0].reps, live.entries[0].sets[0].done],
    ['50', '12', true]
  );
  assert.equal(logged.action.undo(), true);
  assert.equal(getActive().entries[0].sets[0].done, false);
  assert.match(
    (await run('update_active_workout', { action: 'replace', index: 0, exercise_id: 'x' })).error,
    /Unknown/
  );
  await run('update_active_workout', { action: 'replace', index: 0, exercise_id: '0003' });
  assert.equal(getActive().entries[0].libraryId, '0003');
  await run('update_active_workout', { action: 'add', exercise_id: '0025' });
  await run('update_active_workout', { action: 'remove', index: 0 });
  live = getActive();
  assert.deepEqual(
    live.entries.map((e) => e.libraryId),
    ['0025']
  );
  clearActive();

  delete globalThis.matchMedia;
  delete globalThis.document;
  setLanguage('de');
});

test('a spoken or typed set becomes its values', async () => {
  const { parseSet } = await import('../src/speech.js');
  const cases = [
    ['60 Kilo, 12 Wiederholungen', { weight: 60, reps: 12 }],
    ['12 Wiederholungen mit 60 kg', { weight: 60, reps: 12 }],
    ['sechzig Kilo zwölf Wiederholungen', { weight: 60, reps: 12 }],
    ['zweiundsechzig Komma fünf Kilo acht Wiederholungen', { weight: 62.5, reps: 8 }],
    ['62,5 kg 8', { weight: 62.5, reps: 8 }],
    ['12 mal 60', { weight: 60, reps: 12 }],
    ['60 x 12', { weight: 60, reps: 12 }],
    ['60×12', { weight: 60, reps: 12 }],
    ['zehn Wiederholungen', { reps: 10 }],
    ['10', { reps: 10 }],
    ['70 Kilo', { weight: 70 }],
    ['ten reps with 100 pounds', { weight: 100, reps: 10 }],
    ['hundert Kilo fünf Wiederholungen', { weight: 100, reps: 5 }],
    ['einhundertzwanzig Kilo drei', { weight: 120, reps: 3 }],
  ];
  for (const [text, expected] of cases) assert.deepEqual(parseSet(text), expected, text);
  assert.equal(parseSet('keine Ahnung'), null);
  assert.equal(parseSet(''), null);
  assert.deepEqual(parseSet('15 Wiederholungen', 'reps'), { reps: 15 });
  assert.deepEqual(parseSet('10 Kilo, 15 Wiederholungen', 'reps'), { weight: 10, reps: 15 });
  assert.deepEqual(parseSet('20', 'reps'), { reps: 20 });
  assert.deepEqual(parseSet('45 Sekunden', 'time'), { time: 45 });
  assert.deepEqual(parseSet('eine Minute 30 Sekunden', 'time'), { time: 90 });
  assert.deepEqual(parseSet('1:15', 'time'), { time: 75 });
  assert.deepEqual(parseSet('60', 'time'), { time: 60 });
  assert.deepEqual(parseSet('5 km in 25 Minuten', 'distance_time'), { distance: 5, time: 1500 });
  assert.deepEqual(parseSet('fünf Kilometer', 'distance_time'), { distance: 5 });
});

test('cost, search and citations: paid searches are counted, a refused search tool does not stop the chat', async () => {
  const { runTurn, costOf } = await import('../src/ai.js');
  assert.ok(
    Math.abs(
      costOf({
        input_tokens: 1000000,
        output_tokens: 1000000,
        cache_creation_input_tokens: 1000000,
        cache_read_input_tokens: 1000000,
        server_tool_use: { web_search_requests: 2 },
      }) - 29.22
    ) < 1e-9
  );
  assert.equal(costOf(undefined), 0);
  const original = globalThis.fetch;
  try {
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.tools?.some((tool) => tool.name === 'web_search'))
        return new Response(JSON.stringify({ error: { message: 'web search is not enabled' } }), {
          status: 400,
        });
      return sse(...textEvents('Ohne Suche'));
    };
    const plain = await runTurn({
      key: 'k',
      system: 'S',
      messages: USER,
      serverTools: [{ type: 'web_search_20260209', name: 'web_search' }],
    });
    assert.equal(plain.text, 'Ohne Suche');
    assert.equal(bodies.length, 2);

    // A paused search goes on with the same conversation; sources come from the citations.
    const paused = [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"kreatin"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 5 } },
    ];
    const cited = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Belegt.' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'citations_delta', citation: { url: 'https://a.example/x', title: 'Studie' } },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'citations_delta', citation: { url: 'https://a.example/x', title: 'Studie' } },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'citations_delta', citation: { url: 'javascript:alert(1)', title: 'Nein' } },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ];
    const replies = [paused, cited];
    const sent = [];
    globalThis.fetch = async (url, init) => {
      sent.push(JSON.parse(init.body));
      return sse(...replies.shift());
    };
    const usage = [];
    const reply = await runTurn({ key: 'k', system: 'S', messages: USER, onUsage: (u) => usage.push(u) });
    assert.equal(reply.text, 'Belegt.');
    assert.deepEqual(reply.sources, [{ url: 'https://a.example/x', title: 'Studie' }]);
    assert.deepEqual(usage[0], { input_tokens: 10, output_tokens: 5 });
    assert.equal(sent[1].messages.length, 2, 'no extra user message');
    assert.deepEqual(sent[1].messages[1].content[0], {
      type: 'server_tool_use',
      id: 's1',
      name: 'web_search',
      input: { query: 'kreatin' },
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('chat history keeps text and what was done, and answer buttons come off the text', async () => {
  const { chatMessages, replyHtml, splitReplies } = await import('../src/aiPrompts.js');
  assert.deepEqual(chatMessages([{ role: 'assistant', text: 'x' }]), []);
  const long = Array.from({ length: 25 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: String(i),
  }));
  const trimmed = chatMessages(long);
  assert.ok(trimmed.length <= 20);
  assert.equal(trimmed[0].role, 'user', 'a conversation starts with the person');
  assert.equal(trimmed.at(-1).content, '24');
  const [, done, again] = chatMessages([
    { role: 'user', text: 'Plan?' },
    { role: 'assistant', text: '', actions: [{ label: 'Plan angelegt', undone: true }] },
    { role: 'user', text: 'Danke' },
  ]);
  assert.match(done.content, /Plan angelegt \(the person undid this\)/);
  assert.equal(again.content, 'Danke');
  assert.deepEqual(splitReplies('Wie oft?\n\n[[2 Tage | 3 Tage|4 Tage ]]'), {
    body: 'Wie oft?',
    options: ['2 Tage', '3 Tage', '4 Tage'],
  });
  assert.deepEqual(
    splitReplies('Wie oft? [[2 Tage | 3'),
    { body: 'Wie oft?', options: [] },
    'still arriving'
  );
  assert.deepEqual(splitReplies('Ein [[Satz]] mittendrin.'), {
    body: 'Ein [[Satz]] mittendrin.',
    options: [],
  });
  assert.equal(
    replyHtml('**Stark** <img src=x>\n\n- eins\n- **zwei**\nEnde'),
    '<p><b>Stark</b> &lt;img src=x&gt;</p><ul><li>eins</li><li><b>zwei</b></li></ul><p>Ende</p>'
  );
  const card = replyHtml(
    'Dein Plan:\n\n## Tag 1 · <Oben>\n- Übung A | 3×8–12\n\n- Übung B | 3×6–10 | 3 Min. Pause\n## Tag 2\n- Übung C | 3×8–12\nPasst das?'
  );
  assert.equal(
    card,
    '<p>Dein Plan:</p>' +
      '<section class="chat-card"><h3>Tag 1 · &lt;Oben&gt;</h3>' +
      '<div class="chat-row"><span>Übung A</span><b>3×8–12</b></div>' +
      '<div class="chat-row"><span>Übung B<small>3 Min. Pause</small></span><b>3×6–10</b></div></section>' +
      '<section class="chat-card"><h3>Tag 2</h3><div class="chat-row"><span>Übung C</span><b>3×8–12</b></div></section>' +
      '<p>Passt das?</p>'
  );
  assert.equal(replyHtml('## Nur Titel\nText'), '<h3 class="chat-heading">Nur Titel</h3><p>Text</p>');
  assert.equal(
    replyHtml('- A | 1\n- B <i> | **2**'),
    '<section class="chat-card"><div class="chat-row"><span>A</span><b>1</b></div><div class="chat-row"><span>B &lt;i&gt;</span><b><b>2</b></b></div></section>',
    'rows without a heading, and everything escaped'
  );
  assert.equal(replyHtml('**<script>**'), '<p><b>&lt;script&gt;</b></p>');
  const tappable = replyHtml('## Tag\n- brustpresse | 3×8–12');
  assert.match(tappable, /<button type="button" class="chat-row" data-exercise="/, 'found by its name');
});

test('the system prompt carries the data and the language', async () => {
  const { assistantSystem } = await import('../src/aiPrompts.js');
  const system = assistantSystem('DATA');
  assert.match(system, /<training_data>\nDATA/);
  assert.match(system, /Deutsch/);
  assert.match(system, /\[\[3 days \| 4 days \| 5 days\]\]/);
});

test('calories come from duration and body weight, and only with both', async () => {
  const { caloriesOf } = await import('../src/calories.js');
  const session = { day: '2026-11-01', duration: 3600 };
  const body = [
    { day: '2026-01-01', weight: 90 },
    { day: '2026-10-30', weight: 80 },
  ];
  assert.equal(caloriesOf(session, body), 280);
  assert.equal(caloriesOf({ ...session, effort: 5 }, body), 400);
  assert.equal(caloriesOf(session, []), null);
  assert.equal(caloriesOf({ ...session, duration: 0 }, body), null);
});

test('the middle of a range starts an exercise without history', async () => {
  const { rangeMid } = await import('../src/util.js');
  assert.equal(rangeMid('8–12'), 10);
  assert.equal(rangeMid('10–15'), 13);
  assert.equal(rangeMid('5'), 5);
  assert.equal(rangeMid(''), null);
});

test('a backup keeps the effort rating and drops an invalid one', () => {
  const backup = (effort) => ({
    app: 'Volumora',
    version: 5,
    plans: {
      activePlanId: 'p',
      items: [{ id: 'p', name: 'Plan', days: [{ id: 'd', name: 'Tag', exercises: [] }] }],
    },
    history: [
      {
        id: 'a',
        finishedAt: '2026-11-01T10:00:00.000Z',
        effort,
        entries: [],
      },
    ],
  });
  const read = (effort) => validateBackup(backup(effort)).history?.[0]?.effort;
  assert.equal(read(4), 4);
  assert.equal(read(9), undefined);
});

test('the sync server keeps accounts apart, needs invitations and refuses stale uploads', async () => {
  const { createSyncServer, store } = await import('../sync-server/server.js');
  const { mkdtemp, rm, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = await mkdtemp(join(tmpdir(), 'volumora-sync-'));
  let clock = Date.UTC(2026, 10, 1);
  const server = createSyncServer({
    dataDir,
    origins: ['https://app.test'],
    maxBytes: 1000,
    now: () => clock,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const post = (path, body) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  const snapshot = (token, options = {}) =>
    fetch(`${base}/snapshot`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...options.headers },
    });
  const put = (token, body, version) =>
    snapshot(token, { method: 'PUT', body, headers: version ? { 'if-match': `"${version}"` } : {} });
  try {
    const invite = await store(dataDir).createInvite();
    assert.equal((await post('/register', { username: 'anna', password: 'short', invite })).status, 400);
    assert.equal(
      (await post('/register', { username: 'Anna!', password: 'long-enough', invite })).status,
      400
    );
    assert.equal(
      (await post('/register', { username: 'anna', password: 'long-enough', invite: 'nope' })).status,
      403
    );
    const anna = (
      await (await post('/register', { username: 'Anna', password: 'long-enough', invite })).json()
    ).token;
    assert.ok(anna.startsWith('anna.'));
    assert.equal(
      (await post('/register', { username: 'ben', password: 'long-enough', invite })).status,
      403,
      'used once'
    );
    assert.equal((await post('/login', { username: 'anna', password: 'wrong-wrong' })).status, 401);
    const again = (await (await post('/login', { username: 'ANNA ', password: 'long-enough' })).json()).token;
    assert.ok(again.startsWith('anna.') && again !== anna);
    assert.equal((await snapshot('anna.made-up')).status, 401);
    assert.equal((await snapshot(anna)).status, 404);
    assert.equal((await put(anna, '{"a":1}')).status, 200);
    const first = await snapshot(again);
    assert.deepEqual(await first.json(), { a: 1 }, 'every session of the account sees the same data');
    const version = first.headers.get('etag').replaceAll('"', '');
    assert.equal((await put(anna, '{"a":2}')).status, 412, 'an upload must name the version it builds on');
    assert.equal((await put(anna, 'not json', version)).status, 400);
    assert.equal((await put(anna, `{"a":"${'x'.repeat(2000)}"}`, version)).status, 413);
    clock += 1000;
    const second = await put(anna, '{"a":2}', version);
    assert.equal(second.status, 200);
    assert.equal(
      (await put(anna, '{"a":3}', version)).status,
      412,
      'an old version can not replace a newer one'
    );
    // A second account never sees the first one.
    const ben = (
      await (
        await post('/register', {
          username: 'ben',
          password: 'long-enough',
          invite: await store(dataDir).createInvite(),
        })
      ).json()
    ).token;
    assert.equal((await snapshot(ben)).status, 404);
    await put(ben, '{"b":1}');
    assert.deepEqual(await (await snapshot(anna)).json(), { a: 2 });
    let latest = (await second.json()).version;
    for (let i = 0; i < 30; i++) {
      clock += 1000;
      latest = (await (await put(anna, `{"i":${i}}`, latest)).json()).version;
    }
    assert.ok(
      (await readdir(join(dataDir, 'users', 'anna', 'snapshots'))).length <= 21,
      'old versions are thinned out'
    );
    // A new password ends every session; logging out ends one.
    await store(dataDir).setPassword('anna', 'another-one');
    assert.equal((await snapshot(anna)).status, 401);
    const third = (await (await post('/login', { username: 'anna', password: 'another-one' })).json()).token;
    assert.equal(
      (await fetch(`${base}/logout`, { method: 'POST', headers: { authorization: `Bearer ${third}` } }))
        .status,
      200
    );
    assert.equal((await snapshot(third)).status, 401);
    const preflight = await fetch(`${base}/snapshot`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.test' },
    });
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.test');
    const stranger = await fetch(`${base}/snapshot`, {
      method: 'OPTIONS',
      headers: { origin: 'https://other.test' },
    });
    assert.equal(stranger.headers.get('access-control-allow-origin'), null);
    for (let i = 0; i < 10; i++) await post('/login', { username: 'anna', password: 'wrong-wrong' });
    assert.equal((await post('/login', { username: 'anna', password: 'another-one' })).status, 429);
  } finally {
    server.close();
    server.closeAllConnections?.();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Stands in for Anthropic: accepts one key, streams a short answer with usage figures.
async function fakeAnthropic({ key = 'sk-ant-api-good', inputTokens = 100000, outputTokens = 10000 } = {}) {
  const { createServer } = await import('node:http');
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      calls.push({
        url: req.url,
        key: req.headers['x-api-key'],
        version: req.headers['anthropic-version'],
        body,
      });
      if (req.headers['x-api-key'] !== key) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } })
        );
      }
      if (req.url.endsWith('/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 1 }));
      }
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: inputTokens, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hallo vom Server.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, calls, url: `http://127.0.0.1:${server.address().port}` };
}

test('the server forwards to Claude with its own key, counts the cost and stops at the budget', async () => {
  const { createSyncServer, store, costOf } = await import('../sync-server/server.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = await mkdtemp(join(tmpdir(), 'volumora-ai-'));
  let clock = Date.UTC(2026, 10, 2);
  const claude = await fakeAnthropic();
  const server = createSyncServer({
    dataDir,
    origins: ['https://app.test'],
    now: () => clock,
    anthropicUrl: claude.url,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const db = store(dataDir);
  const request = (path, token, options = {}) =>
    fetch(`${base}${path}`, {
      ...options,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  const json = (path, token, method, body) =>
    request(path, token, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const ask = (token) =>
    json('/ai/messages', token, 'POST', {
      model: 'x',
      stream: true,
      messages: [{ role: 'user', content: 'Hi' }],
    });
  try {
    const invite = await db.createInvite();
    const anna = (
      await (
        await json('/register', null, 'POST', { username: 'anna', password: 'long-enough', invite })
      ).json()
    ).token;
    const fouadInvite = await db.createInvite();
    const fouad = (
      await (
        await json('/register', null, 'POST', {
          username: 'fouad',
          password: 'long-enough',
          invite: fouadInvite,
        })
      ).json()
    ).token;
    await db.setAdmin('fouad', true);

    // Nothing to forward to without a key, and only the admin may store one.
    assert.equal((await ask(anna)).status, 503);
    assert.deepEqual((await (await json('/me', anna, 'GET')).json()).ai, {
      available: false,
      budget: 5,
      used: 0,
      month: '2026-11',
    });
    assert.equal((await json('/admin/ai', anna, 'PUT', { key: 'sk-ant-api-good' })).status, 403);
    assert.equal((await json('/admin/overview', anna, 'GET')).status, 403);
    assert.equal((await json('/admin/ai', fouad, 'PUT', { key: 'sk-ant-api-wrong' })).status, 400);
    assert.deepEqual(await db.ai(), {}, 'a rejected key is not kept');
    const saved = await json('/admin/ai', fouad, 'PUT', { key: 'sk-ant-api-good', defaultBudget: 2 });
    assert.deepEqual(await saved.json(), { configured: true, defaultBudget: 2 });
    const overview = await (await json('/admin/overview', fouad, 'GET')).json();
    assert.equal(overview.ai.configured, true);
    assert.equal(overview.users.find((u) => u.username === 'anna').budget, 2);
    assert.ok(!JSON.stringify(overview).includes('sk-ant'), 'the key is never handed out');

    // The answer streams through unchanged, with the server's key, and its cost lands on the account.
    const reply = await ask(anna);
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-type'), /event-stream/);
    assert.match(await reply.text(), /Hallo vom Server/);
    assert.equal(claude.calls.at(-1).key, 'sk-ant-api-good');
    assert.match(claude.calls.at(-1).body, /"stream":true/);
    const cost = costOf({ input_tokens: 100000, output_tokens: 10000 });
    assert.equal(cost, 0.6);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(db.usedThisMonth(await db.account('anna'), clock), cost);
    const me = await (await json('/me', anna, 'GET')).json();
    assert.deepEqual(me.ai, { available: true, budget: 2, used: 0.6, month: '2026-11' });

    // Over budget: refused with a clear word, and Claude is not called.
    assert.equal((await json('/admin/users/anna', fouad, 'PUT', { budget: 0.5 })).status, 200);
    const calls = claude.calls.length;
    const refused = await ask(anna);
    assert.equal(refused.status, 402);
    assert.deepEqual(await refused.json(), { error: 'budget', used: 0.6, budget: 0.5 });
    assert.equal(claude.calls.length, calls);
    assert.equal((await json('/admin/users/anna', fouad, 'PUT', { budget: 'abc' })).status, 400);
    assert.equal((await json('/admin/users/nobody', fouad, 'PUT', { budget: 1 })).status, 404);
    // A new month starts fresh; an empty budget means the default again.
    clock = Date.UTC(2026, 11, 1);
    assert.equal((await json('/admin/users/anna', fouad, 'PUT', { budget: null })).status, 200);
    assert.equal((await ask(anna)).status, 200);
    // Invitations come from the admin screen too, and a session that was logged out gets nothing.
    const { code } = await (await json('/admin/invites', fouad, 'POST')).json();
    assert.match(code, /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    assert.equal((await json('/admin/invites', anna, 'POST')).status, 403);
    assert.equal((await ask('anna.nope')).status, 401);
  } finally {
    server.close();
    server.closeAllConnections?.();
    claude.server.close();
    claude.server.closeAllConnections?.();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('usage keeps older months and a token with an odd name is no session', async () => {
  const { createSyncServer, store } = await import('../sync-server/server.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = await mkdtemp(join(tmpdir(), 'volumora-usage-'));
  const server = createSyncServer({ dataDir, origins: [] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const db = store(dataDir);
  try {
    const invite = await db.createInvite();
    await db.register('anna', 'long-enough', invite);
    await db.addUsage('anna', 1, Date.UTC(2026, 9, 15));
    await db.addUsage('anna', 2, Date.UTC(2026, 10, 15));
    assert.deepEqual((await db.account('anna')).usage, { '2026-10': 1, '2026-11': 2 });
    const odd = await fetch(`http://127.0.0.1:${server.address().port}/v1/me`, {
      headers: { authorization: 'Bearer ../anna.secret' },
    });
    assert.equal(odd.status, 401);
  } finally {
    server.close();
    server.closeAllConnections?.();
    await rm(dataDir, { recursive: true, force: true });
  }
});
