// End-to-end smoke tests against the real app in Chromium. Run with `npm test`.
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { chromium } = require('playwright');
const { createServer } = require('./serve.js');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

let server, browser, baseURL, context, page, errors;
const SCHEMA = 9;
const BACKUP_VERSION = 5;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});
beforeEach(async () => {
  context = await browser.newContext({ acceptDownloads: true, locale: 'de-DE' });
  // Every test starts as an installation that has already passed the first-run flow and signed in; the server
  // never answers, so uploads fail quietly.
  await context.addInitScript(() => {
    localStorage.setItem('volumora-onboarded', '1');
    localStorage.setItem(
      'volumora-sync',
      JSON.stringify({ url: 'http://127.0.0.1:9', username: 'test', token: 'test.t' })
    );
  });
  page = await context.newPage();
  errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/net::ERR|Failed to load resource/.test(m.text()))
      errors.push(`console: ${m.text()}`);
  });
  page.on('dialog', (d) => d.accept());
  await page.route(/githubusercontent\.com|exercisedb\.dev/, (r) =>
    r.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.alloc(0) })
  );
  await page.goto(baseURL + '/');
  await page.waitForSelector('.next-card');
});
afterEach(async () => {
  const e = errors;
  await context.close();
  assert.deepEqual(e, [], 'no runtime errors');
});

test('home shows the default plan and the next session', async () => {
  assert.match(await page.textContent('.home-intro p'), /Push · Pull · Legs/);
  assert.match(await page.textContent('.next-card h2'), /Push/);
  assert.equal(
    (await page.getAttribute('html', 'data-theme')) !== null,
    true,
    'theme is set before first paint'
  );
});

test('an unfinished workout survives editing the plan day', async () => {
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  const before = await page.locator('.workout-exercise').count();
  await page.fill('.workout-exercise:nth-child(2) input[data-set-field="weight"][data-index="0"]', '42');
  await page.fill('.workout-exercise:nth-child(2) input[data-set-field="reps"][data-index="0"]', '8');
  await page.click('.workout-exercise:nth-child(2) [data-set-done="0"]');
  await page.click('#exitWorkout');
  await page.waitForSelector('.next-card.resume-card');
  assert.match(await page.textContent('.resume-card p'), /1 Satz erledigt/);
  // Edit the plan: remove the first exercise, add one from the library.
  await page.click('[data-nav="plans"]');
  await page.click('[data-edit-plan]');
  await page.click('[data-exercise-menu="0:0"]');
  await page.getByRole('button', { name: 'Entfernen' }).click();
  await page.click('[data-add-exercise="0"]');
  await page.waitForSelector('.exercise-library');
  await page.click('.library-item:not([hidden]) [data-pick-exercise]:not([disabled])');
  await page.click('#closeLibraryBottom');
  await page.click('#savePlan');
  await page.click('[data-nav="home"]');
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  assert.equal(await page.locator('.workout-exercise').count(), before, 'one removed, one added');
  const kept = page.locator('.workout-exercise').first();
  assert.equal(
    await kept.locator('input[data-set-field="weight"][data-index="0"]').inputValue(),
    '42',
    'logged set of the kept exercise is preserved'
  );
  assert.equal(await kept.locator('[data-set-done="0"]').getAttribute('aria-pressed'), 'true');
});

test('plan assistant creates and activates a plan', async () => {
  await page.click('[data-nav="plans"]');
  await page.click('#newPlan');
  await page.getByRole('button', { name: /Mit Assistent/ }).click();
  await page.check('input[name="goal"][value="strength"]');
  await page.selectOption('select[name="days"]', '4');
  await page.click('#assistantForm button[type="submit"]');
  assert.match(await page.textContent('.preview-head h1'), /Kraft · 4 Tage/);
  await page.click('#useSuggestedPlan');
  await page.waitForSelector('.next-card');
  assert.match(await page.textContent('.home-intro p'), /Kraft · 4 Tage/);
});

test('body photos are stored in IndexedDB and included in the JSON backup', async () => {
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="body"]');
  await page.fill('input[name="weight"]', '80.5');
  await page.setInputFiles('input[name="photo"]', { name: 'p.png', mimeType: 'image/png', buffer: PNG });
  await page.click('#bodyForm button[type="submit"]');
  await page.waitForFunction(() =>
    document.querySelector('.body-entry img')?.src.startsWith('data:image/jpeg')
  );
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-body-v2')));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].hasPhoto, true);
  assert.equal('photo' in stored[0], false, 'no base64 in localStorage');
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="backup"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportJson')]);
  const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.equal(backup.version, BACKUP_VERSION);
  assert.match(backup.body[0].photo, /^data:image\/jpeg;base64,/);
  assert.equal(backup.body[0].weight, 80.5);
  assert.ok(backup.exercisePrefs);
});

test('a hostile backup is sanitised on import', async () => {
  const evil = '"><img src=x onerror="window.__pwned=1">';
  const backup = {
    version: 2,
    plans: {
      activePlanId: 'p1',
      items: [
        {
          id: 'p1',
          name: evil,
          days: [
            {
              id: 'd1',
              name: 'Tag',
              exercises: [
                {
                  id: 'e1',
                  name: evil,
                  sets: evil,
                  range: evil,
                  gif: 'javascript:alert(1)',
                  note: evil,
                  rest: 'x',
                },
              ],
            },
          ],
        },
      ],
    },
    history: [
      {
        id: 'h1',
        planId: 'p1',
        dayId: 'd1',
        dayName: evil,
        finishedAt: '2026-01-05T10:00:00Z',
        totalSets: evil,
        duration: 'x',
        entries: [{ exerciseId: 'e1', name: evil, sets: [{ weight: evil, reps: '8', done: true }] }],
      },
      { finishedAt: 'not a date' },
    ],
    body: [{ id: 'b1', date: '2026-01-02', weight: evil, photo: 'https://evil.example/x.png' }],
    settings: { theme: evil, rest: 'x' },
  };
  const file = path.join(os.tmpdir(), 'volumora-evil.json');
  fs.writeFileSync(file, JSON.stringify(backup));
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="backup"]');
  await page.setInputFiles('#importJson', file);
  await page.click('.sheet [data-ok]');
  await page.waitForSelector('.home-intro');
  for (const view of ['plans', 'analytics', 'calendar', 'more', 'body', 'more', 'settings']) {
    // The calendar is reached from the Trainings tab.
    if (view === 'calendar') await page.click('[data-analytics-tab="sessions"]');
    await page.click(`[data-nav="${view}"]`);
    await page.waitForTimeout(50);
  }
  await page.click('[data-nav="plans"]');
  await page.click('[data-edit-plan]');
  await page.click('[data-nav="plans"]');
  await page.click('[data-nav="home"]');
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  assert.equal(await page.evaluate(() => window.__pwned), undefined, 'no injected script ran');
  assert.equal(await page.locator('img[src^="x"]').count(), 0);
  const plans = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-plans-v2')));
  assert.equal(plans.items[0].days[0].exercises[0].sets, 3, 'invalid set count falls back');
  assert.equal(plans.items[0].days[0].exercises[0].gif, '', 'non-https media dropped');
  const body = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-body-v2')));
  assert.equal(body[0].hasPhoto, false, 'remote photo URL dropped');
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-settings-v2')));
  const { DEFAULT_SETTINGS } = await import('../src/storage.js');
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-history-v2')));
  assert.equal(history.length, 1, 'session without a valid date dropped');
});

test('calendar can move between months and the library closes on Escape', async () => {
  await page.click('[data-nav="analytics"]');
  await page.click('[data-nav="calendar"]');
  const current = await page.textContent('.calendar-head h1');
  await page.click('[data-calendar-shift="-1"]');
  assert.notEqual(await page.textContent('.calendar-head h1'), current);
  await page.click('[data-calendar-shift="0"]');
  assert.equal(await page.textContent('.calendar-head h1'), current);
  await page.click('[data-nav="plans"]');
  await page.click('[data-edit-plan]');
  await page.click('[data-add-exercise="0"]');
  await page.waitForSelector('.exercise-library');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'librarySearch', 'search gets focus');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.exercise-library').count(), 0);
});

test('offline start page is served by the service worker', async () => {
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 10000 });
  await page.reload();
  await page.waitForSelector('.next-card');
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('.next-card');
  assert.match(await page.textContent('.next-card h2'), /Push/);
});

test('legacy data is migrated: day keys, library ids and photos in IndexedDB', async () => {
  const legacy = {
    plans: {
      activePlanId: 'p1',
      items: [
        {
          id: 'p1',
          name: 'Alt',
          days: [
            {
              id: 'd1',
              name: 'Tag',
              exercises: [
                { id: 'ex1', libraryId: '0025', name: 'Bankdrücken', sets: 3, range: '8–12', gif: '' },
              ],
            },
          ],
        },
      ],
    },
    history: [
      {
        id: 'h1',
        planId: 'p1',
        dayId: 'd1',
        dayName: 'Tag',
        startedAt: '2026-03-10T09:00:00.000Z',
        finishedAt: '2026-03-10T10:00:00.000Z',
        entries: [
          { exerciseId: 'ex1', name: 'Bankdrücken', sets: [{ weight: '60', reps: '8', done: true }] },
        ],
      },
    ],
    body: [
      {
        id: 'b1',
        date: '2026-03-09T11:00:00.000Z',
        weight: 80,
        photo: 'data:image/png;base64,' + PNG.toString('base64'),
      },
    ],
  };
  await page.evaluate((data) => {
    localStorage.clear();
    localStorage.setItem('volumora-plans-v2', JSON.stringify(data.plans));
    localStorage.setItem('volumora-history-v2', JSON.stringify(data.history));
    localStorage.setItem('volumora-body-v2', JSON.stringify(data.body));
  }, legacy);
  await page.reload();
  await page.waitForSelector('.next-card');
  await page.waitForFunction(() => !JSON.parse(localStorage.getItem('volumora-body-v2'))[0].photo);
  const { schema, history, body } = await page.evaluate(() => ({
    schema: JSON.parse(localStorage.getItem('volumora-schema-version')),
    history: JSON.parse(localStorage.getItem('volumora-history-v2')),
    body: JSON.parse(localStorage.getItem('volumora-body-v2')),
  }));
  assert.equal(schema, SCHEMA);
  assert.equal(history[0].day, '2026-03-10');
  assert.equal(history[0].entries[0].libraryId, '0025', 'history entry now points at the library exercise');
  assert.equal(body[0].day, '2026-03-09');
  assert.equal(body[0].hasPhoto, true);
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="body"]');
  await page.waitForFunction(() =>
    document.querySelector('.body-entry img')?.src.startsWith('data:image/png')
  );
  // Progress follows the library exercise: a new plan with the same library exercise sees the old weight.
  await page.click('[data-nav="plans"]');
  await page.click('#newPlan');
  await page.getByRole('button', { name: /Leeren Plan/ }).click();
  await page.click('[data-add-exercise="0"]');
  await page.fill('#librarySearch', 'Bankdrücken mit Langhantel');
  await page.click('.library-item:not([hidden]) [data-pick-exercise="0025"]');
  await page.click('#closeLibraryBottom');
  await page.click('#savePlan');
  await page.locator('[data-edit-plan]').nth(1).click();
  await page.click('#planMenu');
  await page.getByRole('button', { name: /aktiven Plan/ }).click();
  await page.click('[data-nav="plans"]');
  await page.click('[data-nav="home"]');
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  assert.equal(
    await page.inputValue('.workout-exercise input[data-set-field="weight"][data-index="0"]'),
    '60'
  );
  // The fixture dates from months ago, so the suggestion treats this as a restart after a break.
  assert.match(await page.textContent('.suggest-row span'), /Wochen Pause: Einstieg mit 55 kg/);
});

test('deleting a set can be undone and open details survive a re-render', async () => {
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  const first = page.locator('.workout-exercise').first();
  await page.click('#session-status summary');
  await first.locator('input[data-set-field="weight"][data-index="1"]').fill('40');
  await first.locator('input[data-set-field="reps"][data-index="1"]').fill('8');
  await first.locator('[data-set-done="1"]').click();
  assert.equal(
    await page.locator('#session-status').getAttribute('open'),
    '',
    'Tagesform stays open after marking a set'
  );
  assert.equal(await first.locator('.set-row').count(), 3);
  await first.locator('[data-delete-set="2"]').dispatchEvent('click'); // revealed by swipe in the real UI
  assert.equal(await first.locator('.set-row').count(), 2);
  await page.waitForSelector('.toast.show');
  await page.click('.toast-action');
  assert.equal(await first.locator('.set-row').count(), 3, 'undo restores the set');
  await page.click('#exitWorkout');
  // Starting another day asks first; cancelling keeps the session.
  await page.click('.list [data-start]');
  await page.waitForSelector('.sheet-backdrop.show');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.resume-card');
  assert.match(await page.textContent('.resume-card p'), /1 Satz erledigt/);
});

test('deleting a plan can be undone', async () => {
  await page.click('[data-nav="plans"]');
  await page.click('#newPlan');
  await page.getByRole('button', { name: /Leeren Plan/ }).click();
  await page.click('#savePlan');
  assert.equal(await page.locator('[data-edit-plan]').count(), 2);
  await page.locator('[data-edit-plan]').nth(1).click();
  await page.click('#planMenu');
  await page.getByRole('button', { name: 'Plan löschen' }).click();
  await page.waitForSelector('.toast.show');
  assert.equal(await page.locator('[data-edit-plan]').count(), 1);
  await page.click('.toast-action');
  assert.equal(await page.locator('[data-edit-plan]').count(), 2);
});

// WCAG 2.0 A/AA check of the current page; only serious and critical violations fail.
const axeCheck = async (name) => {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] }));
  const serious = result.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  assert.deepEqual(
    serious.map((v) => `${v.id}: ${v.nodes.length} nodes`),
    [],
    `${name} has accessibility violations`
  );
};

test('no serious accessibility violations', async () => {
  const check = axeCheck;
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(() => localStorage.removeItem('volumora-settings-v2'));
    await page.reload();
    await page.waitForSelector('.next-card');
    await check(`home/${scheme}`);
    await page.click('.next-card [data-start]');
    await page.waitForSelector('.workout-exercise');
    await check(`workout/${scheme}`);
    await page.click('#exitWorkout');
    await page.click('[data-nav="plans"]');
    await page.click('[data-edit-plan]');
    await page.click('[data-add-exercise="0"]');
    await page.waitForSelector('.exercise-library');
    await check(`library/${scheme}`);
    await page.keyboard.press('Escape');
    await page.click('[data-nav="plans"]');
    await page.click('[data-nav="analytics"]');
    await check(`analytics/${scheme}`);
    await page.click('[data-nav="more"]');
    await page.click('[data-nav="settings"]');
    await check(`settings/${scheme}`);
  }
});

// Seeds two finished sessions so analytics, records and history have something to show.
async function seedHistory() {
  await page.evaluate((SCHEMA) => {
    const plans = JSON.parse(localStorage.getItem('volumora-plans-v2'));
    const day = plans.items[0].days[0];
    const ex = day.exercises[0];
    const session = (id, dayKey, weight) => ({
      id,
      planId: plans.items[0].id,
      planName: plans.items[0].name,
      dayId: day.id,
      dayName: day.name,
      startedAt: `${dayKey}T09:00:00.000Z`,
      finishedAt: `${dayKey}T10:00:00.000Z`,
      day: dayKey,
      duration: 3600,
      totalSets: 2,
      volume: weight * 8 * 2,
      markers: { deload: false, ill: false, pain: false },
      entries: [
        {
          exerciseId: ex.id,
          name: ex.name,
          note: '',
          sets: [
            { weight: String(weight), reps: '8', rir: '', done: true, warmup: false },
            { weight: String(weight), reps: '8', rir: '', done: true, warmup: false },
          ],
        },
      ],
    });
    const today = new Date();
    const key = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const recent = new Date(today);
    const old = new Date(today);
    old.setDate(today.getDate() - 200);
    localStorage.setItem(
      'volumora-history-v2',
      JSON.stringify([session('s-recent', key(recent), 50), session('s-old', key(old), 40)])
    );
    // Before the record-flag migration (6), so the seeded sessions get their record flags on reload.
    localStorage.setItem('volumora-schema-version', '5');
  }, SCHEMA);
  await page.reload();
  await page.waitForSelector('.next-card');
}

test('analytics: time range scopes everything, charts show a tooltip, a session opens and can be edited or deleted', async () => {
  await seedHistory();
  await page.click('[data-nav="analytics"]');
  await page.click('[data-analytics-tab="sessions"]');
  assert.equal(await page.locator('.row[data-session]').count(), 1, '3 months hides the 200-day-old session');
  await page.click('[data-range="all"]');
  assert.equal(await page.locator('.row[data-session]').count(), 2);
  await page.click('[data-analytics-tab="overview"]');
  assert.match(await page.textContent('.weekly-sets'), /Brust/);
  await page.click('[data-analytics-tab="sessions"]');
  const canvas = page.locator('#volumeChart');
  const box = await canvas.boundingBox();
  await canvas.hover({ position: { x: box.width - 20, y: 100 } });
  await page.waitForSelector('.chart-tip:not([hidden])');
  assert.match(await page.textContent('.chart-tip strong'), /800 kg/);
  await page.locator('.row[data-session]').first().click();
  await page.waitForSelector('#sessionForm');
  assert.match(await page.textContent('h1'), /Push/);
  await page.fill('[data-edit="weight"][data-e="0"][data-s="0"]', '55');
  await page.click('#sessionForm button[type="submit"]');
  await page.waitForSelector('.toast.show');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-history-v2')));
  assert.equal(stored[0].entries[0].sets[0].weight, '55');
  assert.equal(stored[0].volume, 55 * 8 + 50 * 8, 'volume is recomputed');
  await page.click('#deleteSession');
  await page.waitForSelector('.row[data-session]');
  assert.equal(await page.locator('.row[data-session]').count(), 1);
  await page.click('.toast-action');
  assert.equal(await page.locator('.row[data-session]').count(), 2, 'undo restores the session');
  await page.click('[data-nav="calendar"]');
  await page.click('[data-calendar-shift="-1"]').catch(() => {});
  await page.click('[data-calendar-shift="0"]').catch(() => {});
  if (await page.locator('button.calendar-day[data-session]').count()) {
    await page.locator('button.calendar-day[data-session]').first().click();
    await page.waitForSelector('#sessionForm');
  }
});

test('workout: exercise history sheet and personal record toast', async () => {
  await seedHistory();
  await page.click('[data-start="push"]');
  await page.waitForSelector('.workout-exercise');
  await page.click('[data-exercise-history="0"]');
  await page.waitForSelector('.sheet-backdrop.show');
  // The first 50 kg set carries a record chip since the history migration flags it.
  assert.match(await page.textContent('.sheet-body'), /50×8(PR)? · 50×8/);
  await page.keyboard.press('Escape');
  const first = page.locator('.workout-exercise').first();
  await first.locator('input[data-set-field="weight"][data-index="0"]').fill('60');
  await first.locator('input[data-set-field="reps"][data-index="0"]').fill('8');
  await first.locator('[data-set-done="0"]').click();
  await page.waitForSelector('.toast.show');
  assert.match(await page.textContent('.toast'), /Neuer Bestwert: 60 kg × 8/);
  assert.equal(await first.locator('.set-label span.pr').count(), 1);
  await first.locator('input[data-set-field="weight"][data-index="1"]').fill('40');
  await first.locator('input[data-set-field="reps"][data-index="1"]').fill('8');
  await first.locator('[data-set-done="1"]').click();
  assert.equal(await first.locator('.set-label span.pr').count(), 1, 'a lighter set is not a record');
});

test('the homescreen shortcut opens the next workout', async () => {
  await page.goto(baseURL + '/?action=start');
  await page.waitForSelector('.workout-exercise');
  assert.equal(await page.evaluate(() => location.search), '', 'query is cleaned up');
});

test('units: pounds are shown everywhere and stored as kilograms; the plate calculator works', async () => {
  await seedHistory();
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="settings"]');
  await page.selectOption('select[name="unit"]', 'lbs');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('volumora-settings-v2')).unit === 'lbs');
  await page.click('[data-nav="home"]');
  await page.click('[data-start="push"]');
  await page.waitForSelector('.workout-exercise');
  const first = page.locator('.workout-exercise').first();
  assert.equal(await first.locator('.set-head span').nth(1).textContent(), 'Gewicht');
  assert.equal(await first.locator('.set-row u').first().textContent(), 'lbs');
  assert.equal(
    await first.locator('input[data-set-field="weight"][data-index="0"]').inputValue(),
    '110,2',
    '50 kg shown as pounds'
  );
  await first.locator('input[data-set-field="weight"][data-index="0"]').fill('135');
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('volumora-active-v2')).entries[0].sets[0].weight
  );
  assert.equal(Math.round(Number(saved) * 10) / 10, 61.2, 'stored in kilograms');
  // The plate calculator appears on barbell exercises only.
  await first.locator('[data-exercise-menu="0"]').click();
  await page.waitForSelector('.sheet-backdrop.show');
  assert.equal(
    await page.getByRole('button', { name: 'Scheibenrechner' }).count(),
    0,
    'chest press machine has no plate calculator'
  );
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sheet-backdrop', { state: 'detached' });
  await page.click('#exitWorkout');
  await page.click('[data-start="legs"]');
  await page.click('.sheet-backdrop.show [data-ok]');
  await page.waitForSelector('.workout-exercise');
  const squat = page.locator('.workout-exercise').first();
  await squat.locator('input[data-set-field="weight"][data-index="0"]').fill('135');
  await squat.locator('[data-exercise-menu="0"]').click();
  await page.getByRole('button', { name: 'Scheibenrechner' }).click();
  await page.waitForSelector('#plateResult');
  assert.match(await page.textContent('#plateResult'), /45 lbs pro Seite/);
  assert.match(await page.textContent('#plateResult'), /1 × 45/);
  await page.keyboard.press('Escape');
});

test('home shows the weekly goal and streak', async () => {
  await seedHistory();
  assert.match(await page.textContent('.week-line'), /1 von 3/);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('volumora-settings-v2')) || {};
    s.weeklyGoal = 1;
    localStorage.setItem('volumora-settings-v2', JSON.stringify(s));
  });
  await page.reload();
  await page.waitForSelector('.week-line');
  assert.match(await page.textContent('.week-line'), /1 von 1/);
  assert.match(await page.textContent('.week-line em'), /1 Woche in Folge/);
});

test('touch targets in the workout are at least 44px on a phone', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  const targets = [
    ['#exitWorkout', true],
    ['[data-exercise-menu]', true],
    ['[data-set-done="0"]', true],
    ['[data-add-set]', false],
    ['input[data-set-field="weight"][data-index="0"]', false],
  ];
  for (const [selector, checkWidth] of targets) {
    const box = await page.locator(selector).first().boundingBox();
    // 44px targets; sub-pixel layout on CI reports 43.99998, which is the same thing.
    assert.ok(box && box.height >= 43.5, `${selector} is ${box?.height}px tall`);
    if (checkWidth) assert.ok(box.width >= 43.5, `${selector} is ${box.width}px wide`);
  }
});

test('the interface follows the device language and the language setting', async () => {
  await context.close();
  context = await browser.newContext({ locale: 'en-US' });
  await context.addInitScript(() => {
    localStorage.setItem('volumora-onboarded', '1');
    localStorage.setItem(
      'volumora-sync',
      JSON.stringify({ url: 'http://127.0.0.1:9', username: 'test', token: 'test.t' })
    );
  });
  page = await context.newPage();
  await page.goto(baseURL + '/');
  await page.waitForSelector('.next-card');
  assert.equal(await page.textContent('.home-intro h1'), 'Today');
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  assert.match(await page.textContent('.bottom-nav'), /Progress/);
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="settings"]');
  await page.selectOption('select[name="language"]', 'de');
  await page.waitForFunction(() => document.documentElement.lang === 'de');
  await page.click('[data-nav="home"]');
  assert.equal(await page.textContent('.home-intro h1'), 'Heute');
  await page.reload();
  await page.waitForSelector('.next-card');
  assert.equal(await page.textContent('.home-intro h1'), 'Heute', 'the setting survives a reload');
});

test('the browser back button closes overlays first and then steps back through views', async () => {
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="settings"]');
  await page.waitForSelector('#settingsForm');
  await page.goBack();
  await page.waitForSelector('#installRow');
  assert.equal(await page.locator('#settingsForm').count(), 0, 'back leaves the settings view');
  await page.click('[data-nav="plans"]');
  await page.click('#newPlan');
  await page.waitForSelector('.sheet-backdrop.show');
  await page.goBack();
  await page.waitForSelector('.sheet-backdrop', { state: 'detached' });
  assert.equal(await page.locator('#newPlan').count(), 1, 'back only closed the sheet');
  // Closing a sheet with its own control leaves no dead history entry behind.
  await page.click('#newPlan');
  await page.waitForSelector('.sheet-backdrop.show');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sheet-backdrop', { state: 'detached' });
  await page.waitForTimeout(50);
  await page.goBack();
  await page.waitForSelector('#installRow');
  // The exercise library behaves the same way.
  await page.click('[data-nav="plans"]');
  await page.click('[data-edit-plan]');
  await page.click('[data-add-exercise="0"]');
  await page.waitForSelector('.exercise-library');
  await page.goBack();
  await page.waitForSelector('.exercise-library', { state: 'detached' });
  assert.equal(await page.locator('#savePlan').count(), 1, 'still in the editor');
});

test('charts follow the viewport width', async () => {
  await seedHistory();
  await page.click('[data-nav="analytics"]');
  await page.click('[data-analytics-tab="sessions"]');
  await page.waitForSelector('#volumeChart');
  const before = await page.locator('#volumeChart').evaluate((c) => c.width);
  await page.setViewportSize({ width: 520, height: 800 });
  await page.waitForFunction((w) => document.querySelector('#volumeChart').width !== w, before);
});

test('first run: the onboarding builds a plan from language, unit, goal and days', async () => {
  await context.close();
  context = await browser.newContext({ locale: 'de-DE' });
  await context.addInitScript(() =>
    localStorage.setItem(
      'volumora-sync',
      JSON.stringify({ url: 'http://127.0.0.1:9', username: 'test', token: 'test.t' })
    )
  );
  page = await context.newPage();
  await page.goto(baseURL + '/');
  await page.waitForSelector('#onboardingForm');
  await axeCheck('onboarding');
  await page.check('input[name="language"][value="en"]');
  await page.waitForSelector('input[name="language"][value="en"]:checked');
  assert.match(await page.textContent('.assistant-hero h1'), /Welcome/);
  await page.click('#onboardingForm button[type="submit"]');
  await page.check('input[name="unit"][value="lbs"]');
  await page.click('#onboardingForm button[type="submit"]');
  await page.check('input[name="goal"][value="strength"]');
  await page.check('input[name="level"][value="intermediate"]');
  await page.click('#onboardingForm button[type="submit"]');
  await page.selectOption('select[name="days"]', '4');
  await page.click('#onboardingForm button[type="submit"]');
  assert.match(await page.textContent('.preview-head h1'), /Upper\/lower · 4 days/);
  await page.click('#onboardingUse');
  await page.waitForSelector('.next-card');
  assert.match(await page.textContent('.home-intro p'), /Upper\/lower · 4 days/);
  const stored = await page.evaluate(() => ({
    onboarded: localStorage.getItem('volumora-onboarded'),
    settings: JSON.parse(localStorage.getItem('volumora-settings-v2')),
    plans: JSON.parse(localStorage.getItem('volumora-plans-v2')),
  }));
  assert.equal(stored.onboarded, '1');
  assert.equal(stored.settings.unit, 'lbs');
  assert.equal(stored.settings.language, 'en');
  assert.equal(stored.plans.items.length, 1, 'only the generated plan');
  assert.equal(stored.plans.items[0].days.length, 4);
});

test('first run: skipping the onboarding starts with the default plan', async () => {
  await context.close();
  context = await browser.newContext({ locale: 'de-DE' });
  await context.addInitScript(() =>
    localStorage.setItem(
      'volumora-sync',
      JSON.stringify({ url: 'http://127.0.0.1:9', username: 'test', token: 'test.t' })
    )
  );
  page = await context.newPage();
  await page.goto(baseURL + '/');
  await page.waitForSelector('#onboardingSkip');
  await page.click('#onboardingSkip');
  await page.waitForSelector('.next-card');
  assert.match(await page.textContent('.home-intro p'), /Push · Pull · Legs/);
  await page.reload();
  await page.waitForSelector('.next-card');
  assert.equal(await page.locator('#onboardingForm').count(), 0, 'the flow shows only once');
});

test('exercise picker: folded multi-word search, equipment and group filters, detail sheet', async () => {
  await page.click('[data-nav="plans"]');
  await page.click('[data-edit-plan]');
  await page.click('[data-add-exercise="0"]');
  await page.waitForSelector('.exercise-library');
  await page.fill('#librarySearch', 'ruecken kabel');
  const visible = page.locator('.library-item:not([hidden])');
  assert.ok((await visible.count()) >= 1, 'umlaut-free query finds Rücken exercises');
  assert.match(await visible.first().textContent(), /Rücken · Kabelzug/);
  await page.fill('#librarySearch', '');
  await page.selectOption('#libraryEquipment', 'body weight');
  const equipment = await page
    .locator('.library-item:not([hidden])')
    .evaluateAll((els) => els.map((e) => e.dataset.equipment));
  assert.ok(equipment.length > 0 && equipment.every((e) => e === 'body weight'));
  await page.click('[data-library-category="legs"]');
  const groups = await page
    .locator('.library-item:not([hidden])')
    .evaluateAll((els) => els.map((e) => e.dataset.group));
  assert.ok(groups.length > 0 && groups.every((g) => g === 'legs'));
  await page.locator('.library-item:not([hidden]) [data-library-info]').first().click();
  await page.waitForSelector('.sheet-backdrop.show');
  assert.match(await page.textContent('.sheet-body'), /Beine · Körpergewicht/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sheet-backdrop', { state: 'detached' });
  assert.equal(await page.locator('.exercise-library').count(), 1, 'the picker stays open under the sheet');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.exercise-library').count(), 0);
});

test('bodyweight and timed exercises: reps-only sets count, set types can be changed', async () => {
  await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('volumora-plans-v2'));
    const day = data.items[0].days[0];
    day.exercises.unshift({
      id: 'bw-test',
      libraryId: '0662',
      name: 'Push-up',
      sets: 2,
      range: '8–12',
      gif: '',
      note: '',
    });
    day.exercises.unshift({
      id: 'time-test',
      name: 'Plank',
      sets: 1,
      range: '30–60',
      gif: '',
      note: '',
      custom: true,
      trackType: 'time',
    });
    localStorage.setItem('volumora-plans-v2', JSON.stringify(data));
  });
  await page.reload();
  await page.waitForSelector('.next-card');
  await page.click('[data-start="push"]');
  await page.waitForSelector('.workout-exercise');
  const plank = page.locator('.workout-exercise').nth(0);
  assert.equal(await plank.locator('.set-head span').nth(1).textContent(), 'Zeit');
  await plank.locator('input[data-set-field="time"][data-index="0"]').fill('1:30');
  await plank.locator('[data-set-done="0"]').click();
  const pushup = page.locator('.workout-exercise').nth(1);
  assert.equal(await pushup.locator('.set-head span').nth(1).textContent(), '+kg');
  await pushup.locator('input[data-set-field="reps"][data-index="0"]').fill('12');
  await pushup.locator('[data-set-done="0"]').click();
  assert.equal(await page.locator('.toast').count(), 0, 'the first time has nothing to beat');
  await pushup.locator('[data-set-type="1"]').click();
  await page.getByRole('button', { name: 'Dropsatz' }).click();
  assert.equal(await pushup.locator('[data-set-type="1"] b').textContent(), 'D');
  const active = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-active-v2')));
  assert.equal(active.entries[0].trackType, 'time');
  assert.equal(active.entries[0].sets[0].time, '90');
  assert.equal(active.entries[0].sets[0].done, true);
  assert.equal(active.entries[1].trackType, 'reps');
  assert.equal(active.entries[1].sets[1].type, 'drop');
  await page.click('#finishWorkout');
  await page.click('.sheet-backdrop.show [data-ok]');
  await page.waitForSelector('.summary');
  await page.click('#summaryDone');
  await page.waitForSelector('.next-card');
  await page.click('[data-nav="analytics"]');
  await page.click('[data-analytics-tab="sessions"]');
  await page.waitForSelector('.row[data-session]');
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-history-v2')));
  assert.equal(history[0].entries[0].sets[0].time, '90');
  assert.equal(history[0].volume, 0, 'bodyweight and timed sets add no weight volume');
  await page.locator('.row[data-session]').first().click();
  await page.waitForSelector('#sessionForm');
  assert.equal(await page.inputValue('[data-edit="time"][data-e="0"][data-s="0"]'), '1:30');
});

test('finishing a workout shows the summary with records and sharing; the records screen lists bests', async () => {
  await context.addInitScript(() => {
    window.__shared = [];
    navigator.share = (data) => {
      window.__shared.push(data);
      return Promise.resolve();
    };
  });
  await seedHistory();
  const seeded = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-history-v2')));
  assert.equal(seeded[0].entries[0].sets[0].pr, true, 'migration flags the 50 kg set as a record');
  assert.equal(seeded[0].entries[0].sets[1].pr, false);
  await page.click('[data-start="push"]');
  await page.waitForSelector('.workout-exercise');
  const first = page.locator('.workout-exercise').first();
  await first.locator('input[data-set-field="weight"][data-index="0"]').fill('60');
  await first.locator('input[data-set-field="reps"][data-index="0"]').fill('8');
  await first.locator('[data-set-done="0"]').click();
  await page.click('#finishWorkout');
  await page.click('.sheet-backdrop.show [data-ok]');
  await page.waitForSelector('.summary');
  assert.match(await page.textContent('.summary .list'), /Brustpresse/);
  assert.match(await page.textContent('.summary .list'), /60 kg × 8/);
  assert.match(await page.textContent('.summary .bar-list'), /Brust/);
  await page.click('#summaryShare');
  await page.waitForFunction(() => window.__shared.length === 1);
  const shared = await page.evaluate(() => window.__shared[0].text);
  assert.match(shared, /Volumora · Push/);
  assert.match(shared, /Brustpresse 60 kg × 8/);
  await page.click('#summaryDone');
  await page.waitForSelector('.next-card');
  await page.click('[data-nav="analytics"]');
  await page.click('[data-analytics-tab="strength"]');
  await page.click('[data-nav="records"]');
  await page.waitForSelector('[data-record]');
  assert.match(await page.textContent('[data-record]'), /Brustpresse/);
  assert.match(await page.textContent('[data-record]'), /Max\. Gewicht 60 kg/);
  await page.click('[data-record]');
  await page.waitForSelector('.sheet-backdrop.show');
  assert.match(await page.textContent('.exercise-records'), /1RM ≈/);
});

test('free workout: add, reorder, remove and undo exercises, then save it as a plan day', async () => {
  await page.click('#startFree');
  // The picker opens by itself; closing it leaves the empty workout with its own button.
  await page.waitForSelector('.exercise-library');
  await page.click('#closeLibraryBottom');
  await page.waitForSelector('.exercise-library', { state: 'detached' });
  assert.equal(await page.locator('.workout-exercise').count(), 0);
  await page.click('#addSessionExercise');
  await page.waitForSelector('.exercise-library');
  await page.click('[data-pick-exercise="0025"]');
  await page.click('[data-pick-exercise="0662"]');
  await page.click('#closeLibraryBottom');
  await page.waitForSelector('.exercise-library', { state: 'detached' });
  assert.equal(await page.locator('.workout-exercise').count(), 2);
  await page.click('[data-exercise-menu="1"]');
  await page.getByRole('button', { name: 'Nach oben' }).click();
  const first = page.locator('.workout-exercise').first();
  assert.equal(await first.locator('.set-head span').nth(1).textContent(), '+kg', 'the push-up moved up');
  await page.click('[data-exercise-menu="0"]');
  await page.getByRole('button', { name: 'Aus Training entfernen' }).click();
  assert.equal(await page.locator('.workout-exercise').count(), 1);
  await page.click('.toast-action');
  assert.equal(await page.locator('.workout-exercise').count(), 2, 'undo restores the exercise');
  await first.locator('input[data-set-field="reps"][data-index="0"]').fill('10');
  await first.locator('[data-set-done="0"]').click();
  await page.click('#exitWorkout');
  await page.waitForSelector('.resume-card');
  assert.match(await page.textContent('.resume-card h2'), /Freies Training/);
  await page.click('#startFree');
  await page.waitForSelector('.workout-exercise');
  await page.click('#finishWorkout');
  await page.click('.sheet-backdrop.show [data-ok]');
  await page.waitForSelector('#summarySaveDay');
  await page.click('#summarySaveDay');
  await page.waitForSelector('.toast.show');
  const plans = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-plans-v2')));
  assert.equal(plans.items[0].days.length, 4);
  assert.equal(plans.items[0].days[3].exercises.length, 2);
  assert.equal(plans.items[0].days[3].name, 'Freies Training');
});

test('supersets: linked exercises rest after the round, not in between', async () => {
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('volumora-settings-v2')) || {};
    s.restTimer = true;
    localStorage.setItem('volumora-settings-v2', JSON.stringify(s));
  });
  await page.reload();
  await page.waitForSelector('.next-card');
  await page.click('[data-nav="plans"]');
  await page.click('[data-edit-plan]');
  await page.click('[data-exercise-menu="0:0"]');
  await page.getByRole('button', { name: /Mit nächster Übung verbinden/ }).click();
  assert.equal(await page.locator('.plan-exercise-row .superset-tag').count(), 2);
  await page.click('#savePlan');
  await page.click('[data-nav="home"]');
  await page.click('[data-start="push"]');
  await page.waitForSelector('.workout-exercise.superset-first');
  const first = page.locator('.workout-exercise').nth(0);
  const second = page.locator('.workout-exercise').nth(1);
  await first.locator('input[data-set-field="weight"][data-index="0"]').fill('40');
  await first.locator('input[data-set-field="reps"][data-index="0"]').fill('8');
  await first.locator('[data-set-done="0"]').click();
  assert.equal(await page.locator('#restTimer.show').count(), 0, 'no rest inside the superset');
  await second.locator('input[data-set-field="weight"][data-index="0"]').fill('40');
  await second.locator('input[data-set-field="reps"][data-index="0"]').fill('8');
  await second.locator('[data-set-done="0"]').click();
  await page.waitForSelector('#restTimer.show');
});

test('a plan can be created from a template', async () => {
  await page.click('[data-nav="plans"]');
  await page.click('#newPlan');
  await page.getByRole('button', { name: /Vorlage wählen/ }).click();
  await page.waitForSelector('[data-template="full3"]');
  await page.click('[data-template="full3"]');
  await page.waitForSelector('#useTemplate');
  assert.match(await page.textContent('.preview-head h1'), /Ganzkörper · 3 Tage/);
  assert.equal(await page.locator('.plan-preview article').count(), 3);
  await page.click('#useTemplate');
  await page.waitForSelector('.next-card');
  assert.match(await page.textContent('.home-intro p'), /Ganzkörper · 3 Tage/);
  await page.click('[data-nav="plans"]');
  assert.equal(await page.locator('[data-edit-plan]').count(), 2);
});

test('custom exercises: promoted from old plans, created in the picker, managed in More, kept in backups', async () => {
  await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('volumora-plans-v2'));
    data.items[0].days[0].exercises.push({
      id: 'legacy-custom',
      name: 'Seilspringen',
      sets: 2,
      range: '8–12',
      gif: '',
      note: '',
      custom: true,
      category: 'other',
    });
    localStorage.setItem('volumora-plans-v2', JSON.stringify(data));
    localStorage.setItem('volumora-schema-version', '6');
  });
  await page.reload();
  await page.waitForSelector('.next-card');
  const store = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-custom-exercises-v1')));
  assert.equal(store.length, 1, 'the plan-level custom exercise moved into the store');
  assert.equal(store[0].name, 'Seilspringen');
  const migrated = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('volumora-plans-v2')).items[0].days[0].exercises.at(-1)
  );
  assert.equal(migrated.libraryId, 'legacy-custom');
  assert.equal(migrated.custom, undefined);
  await page.click('[data-nav="plans"]');
  await page.click('[data-edit-plan]');
  assert.match(await page.textContent('.plan-exercise-row:last-child h2'), /Seilspringen/);
  await page.click('[data-add-exercise="0"]');
  await page.waitForSelector('.exercise-library');
  await page.click('#addCustomExercise');
  await page.waitForSelector('#customForm');
  await page.fill('#customForm [name="name"]', 'Farmer Walk');
  await page.selectOption('#customForm [name="category"]', 'legs');
  await page.selectOption('#customForm [name="trackType"]', 'distance_time');
  await page.click('#customForm button[type="submit"]');
  await page.waitForSelector('.sheet-backdrop', { state: 'detached' });
  assert.equal(await page.locator('.library-item[data-custom]').count(), 2);
  await page.click('#closeLibraryBottom');
  await page.click('#savePlan');
  const plans = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-plans-v2')));
  const added = plans.items[0].days[0].exercises.at(-1);
  assert.equal(added.name, 'Farmer Walk');
  assert.ok(added.libraryId, 'linked to the stored custom exercise');
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="backup"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportJson')]);
  const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.equal(backup.customExercises.length, 2);
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="customExercises"]');
  await page.waitForSelector('[data-custom-exercise]');
  assert.equal(await page.locator('[data-custom-exercise]').count(), 2);
  await page.locator('[data-custom-exercise]').first().click();
  await page.getByRole('button', { name: 'Löschen' }).click();
  assert.equal(await page.locator('[data-custom-exercise]').count(), 1);
  await page.click('.toast-action');
  assert.equal(await page.locator('[data-custom-exercise]').count(), 2, 'undo restores it');
});

test('editor: drag to reorder, duplicate a day, move an exercise to another day', async () => {
  await page.click('[data-nav="plans"]');
  await page.click('[data-edit-plan]');
  await page.waitForSelector('.plan-exercise-row');
  const names = () => page.locator('.plan-exercise-row h2').allTextContents();
  const before = await names();
  await page.locator('[data-drag="0"]').dragTo(page.locator('.plan-exercise-row[data-ex-index="2"]'), {
    targetPosition: { x: 10, y: 50 },
  });
  await page.waitForFunction(
    (first) => document.querySelector('.plan-exercise-row h2')?.textContent !== first,
    before[0]
  );
  const after = await names();
  assert.equal(after[0], before[1], 'the first exercise moved down');
  assert.ok(after.includes(before[0]));
  await page.click('[data-day-menu="0"]');
  await page.getByRole('button', { name: 'Tag duplizieren' }).click();
  await page.waitForSelector('[data-editor-day="3"].active');
  assert.match(await page.inputValue('.day-name'), /Push – Kopie/);
  await page.click('[data-exercise-menu="3:0"]');
  await page.getByRole('button', { name: 'In anderen Tag verschieben' }).click();
  await page.waitForSelector('.sheet-backdrop.show');
  await page.locator('.sheet .action-item', { hasText: /^Pull$/ }).click();
  await page.waitForSelector('.toast.show');
  const plans = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-plans-v2')));
  assert.equal(plans.items[0].days.length, 4);
  assert.equal(plans.items[0].days[3].exercises.length, 4);
  assert.equal(plans.items[0].days[1].exercises.length, 6);
});

test('analytics: sets per week with a four-week toggle, weekly charts and the record timeline', async () => {
  await seedHistory();
  await page.click('[data-nav="analytics"]');
  await page.waitForSelector('.weekly-sets');
  assert.match(await page.textContent('.weekly-sets'), /Brust/);
  assert.match(await page.textContent('.weekly-sets .bar-row b'), /^2$/);
  await page.click('[data-week-mode="avg"]');
  await page.waitForSelector('[data-week-mode="avg"].active');
  assert.match(await page.textContent('.weekly-sets .bar-row b'), /0,5/);
  assert.ok(await page.locator('#weeklyVolumeChart').evaluate((c) => c.width > 0));
  assert.ok(await page.locator('#frequencyChart').evaluate((c) => c.width > 0));
  await page.click('[data-analytics-tab="sessions"]');
  await page.click('[data-range="all"]');
  await page.waitForSelector('[data-session-record] .chip-green');
  assert.match(await page.textContent('[data-session-record] .chip-green'), /Bestwert/);
});

test('the 1RM calculator estimates from a set and lists percentages', async () => {
  await page.click('[data-start="push"]');
  await page.waitForSelector('.workout-exercise');
  await page.locator('.workout-exercise').first().locator('[data-exercise-menu="0"]').click();
  await page.getByRole('button', { name: '1RM-Rechner' }).click();
  await page.waitForSelector('#oneRmResult');
  await page.fill('#oneRmWeight', '100');
  await page.fill('#oneRmReps', '5');
  assert.match(await page.textContent('#oneRmResult'), /117 kg/);
  assert.equal(await page.locator('.onerm-table > div').count(), 9);
  assert.match(await page.textContent('.onerm-table > div:nth-child(5)'), /80 %/);
});

test('legal page in both languages, then deleting all data returns to the first-run flow', async () => {
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="legal"]');
  await page.waitForSelector('.legal');
  assert.match(await page.textContent('.legal'), /GitHub Pages/);
  assert.doesNotMatch(await page.textContent('.legal'), /Impressum/);
  await axeCheck('legal');
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('volumora-settings-v2')) || {};
    s.language = 'en';
    localStorage.setItem('volumora-settings-v2', JSON.stringify(s));
  });
  await page.reload();
  await page.waitForSelector('.next-card');
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="legal"]');
  assert.match(await page.textContent('.legal'), /Privacy/);
  // A context without the onboarding seed, so the wipe really lands on the first-run flow.
  await context.close();
  context = await browser.newContext({ locale: 'de-DE' });
  await context.addInitScript(() =>
    localStorage.setItem(
      'volumora-sync',
      JSON.stringify({ url: 'http://127.0.0.1:9', username: 'test', token: 'test.t' })
    )
  );
  page = await context.newPage();
  await page.goto(baseURL + '/');
  await page.waitForSelector('#onboardingForm');
  await page.click('#onboardingSkip');
  await page.waitForSelector('.next-card');
  await seedHistory();
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="settings"]');
  await page.click('#deleteAll');
  await page.click('.sheet [data-ok]');
  await page.waitForSelector('#onboardingForm');
  const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('volumora')));
  assert.deepEqual(
    left.filter((k) => !['volumora-settings-v2', 'volumora-schema-version', 'volumora-sync'].includes(k)),
    [],
    'only the fresh defaults remain'
  );
});

test('a Hevy export merges into the history and unknown exercises become custom ones', async () => {
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="backup"]');
  const file = path.join(__dirname, 'fixtures', 'hevy.csv');
  await page.setInputFiles('#importCsv', file);
  await page.waitForSelector('.sheet-backdrop.show');
  assert.match(await page.textContent('.sheet'), /2 Trainings importieren\?/);
  assert.match(await page.textContent('.sheet'), /Quelle: Hevy/);
  await page.click('.sheet [data-ok]');
  await page.waitForSelector('.sheet-backdrop.show', { state: 'detached' });
  await page.waitForFunction(() =>
    /2 Trainings importiert/.test(document.querySelector('.toast')?.textContent || '')
  );
  // The same file again adds nothing.
  await page.setInputFiles('#importCsv', file);
  await page.waitForSelector('.sheet-backdrop.show');
  await page.click('.sheet [data-ok]');
  await page.waitForFunction(() =>
    /schon vorhanden/.test(document.querySelector('.toast')?.textContent || '')
  );
  await page.click('[data-nav="analytics"]');
  // The fixture is from 2024: widen the range to everything.
  await page.click('[data-analytics-tab="sessions"]');
  await page.click('[data-range="all"]');
  await page.waitForSelector('[data-session]');
  assert.equal(await page.locator('[data-session]').count(), 2);
  assert.match(await page.textContent('main'), /Push Day/);
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="customExercises"]');
  await page.waitForSelector('[data-custom-exercise]');
  assert.match(await page.textContent('[data-custom-exercise]'), /Banded Face Pull Special/);
});

test('a tick takes over the grey values; an empty set cannot be ticked', async () => {
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  const first = page.locator('.workout-exercise').first();
  const weight = (i) => first.locator(`input[data-set-field="weight"][data-index="${i}"]`);
  const reps = (i) => first.locator(`input[data-set-field="reps"][data-index="${i}"]`);
  const tick = (i) => first.locator(`[data-set-done="${i}"]`);
  await tick(0).click();
  assert.equal(await tick(0).getAttribute('aria-pressed'), 'false', 'nothing to log yet');
  assert.match(await page.textContent('.toast'), /Trag zuerst die Werte/);
  await weight(0).fill('60');
  await reps(0).fill('10');
  assert.equal(await reps(1).getAttribute('placeholder'), '10', 'the next set shows the typed value in grey');
  await tick(0).click();
  await tick(1).click();
  assert.equal(await tick(1).getAttribute('aria-pressed'), 'true');
  const active = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-active-v2')));
  assert.deepEqual(
    [active.entries[0].sets[1].weight, active.entries[0].sets[1].reps],
    ['60', '10'],
    'the set before is taken over'
  );
});

test('finishing asks about open sets, saves typed ones and refuses an empty workout', async () => {
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  await page.click('#finishWorkout');
  await page.waitForSelector('.sheet-backdrop.show');
  assert.match(await page.textContent('.sheet'), /ohne Sätze wird nicht gespeichert/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sheet-backdrop', { state: 'detached' });
  const first = page.locator('.workout-exercise').first();
  await first.locator('input[data-set-field="weight"][data-index="0"]').fill('60');
  await first.locator('input[data-set-field="reps"][data-index="0"]').fill('10');
  await page.click('#finishWorkout');
  await page.waitForSelector('.sheet-backdrop.show');
  assert.match(await page.textContent('.sheet'), /1 eingetragener Satz ohne Haken wird mitgespeichert/);
  await page.click('.sheet-backdrop.show [data-ok]');
  await page.waitForSelector('.summary');
  const [saved] = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-history-v2')));
  assert.equal(saved.totalSets, 1);
  assert.equal(saved.entries.length, 1, 'untouched exercises drop out');
  assert.equal(saved.volume, 600);
});

test('a running workout survives a deleted day, a stale history entry and starts on reload', async () => {
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  const first = page.locator('.workout-exercise').first();
  await first.locator('input[data-set-field="weight"][data-index="0"]').fill('60');
  await page.click('#exitWorkout');
  await page.waitForSelector('.resume-card');
  assert.match(await page.textContent('.resume-card p'), /Werte eingetragen/);
  await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('volumora-plans-v2'));
    data.items[0].days.shift();
    localStorage.setItem('volumora-plans-v2', JSON.stringify(data));
  });
  await page.reload();
  await page.waitForSelector('.workout-exercise');
  assert.match(await page.textContent('.workout-top h1'), /Push/, 'a reload lands back in the workout');
  assert.match(await page.textContent('#workoutClock'), /0:0\d/);
  assert.equal(await first.locator('input[data-set-field="weight"][data-index="0"]').inputValue(), '60');
  await page.click('#exitWorkout');
  await page.waitForSelector('.resume-card');
  await page.goBack();
  await page.waitForSelector('.workout-exercise');
  assert.equal(await first.locator('input[data-set-field="weight"][data-index="0"]').inputValue(), '60');
});

test('an action that navigates from a sheet leaves the history in order', async () => {
  await page.click('[data-nav="plans"]');
  await page.click('[data-edit-plan]');
  await page.waitForSelector('#planMenu');
  await page.fill('#planName', 'Getippt');
  await page.click('#planMenu');
  await page.getByRole('button', { name: 'Duplizieren' }).click();
  await page.waitForFunction(() => document.querySelector('#planName')?.value.includes('Kopie'));
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('#planName')?.value === 'Getippt');
  await page.goBack();
  await page.waitForSelector('[data-edit-plan]');
});

test('a decimal typed with a comma stays a decimal and a saved weight can be corrected', async () => {
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  const first = page.locator('.workout-exercise').first();
  const weight = first.locator('input[data-set-field="weight"][data-index="0"]');
  await weight.fill('61,25');
  await first.locator('input[data-set-field="reps"][data-index="0"]').fill('8');
  await first.locator('[data-set-done="0"]').click();
  assert.equal(await weight.inputValue(), '61,25');
  await page.click('#finishWorkout');
  await page.click('.sheet-backdrop.show [data-ok]');
  await page.waitForSelector('.summary');
  const [saved] = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-history-v2')));
  assert.equal(saved.volume, 490);
  await page.click('#summaryView');
  await page.waitForSelector('#sessionForm');
  await page.fill('[data-edit="reps"][data-e="0"][data-s="0"]', '10');
  await page.click('#sessionForm button[type="submit"]');
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('volumora-history-v2'))[0].volume === 612.5
  );
});

test('a rest that ends on another screen still says so', async () => {
  await page.evaluate(() => localStorage.setItem('volumora-rest-until', String(Date.now() + 1500)));
  await page.reload();
  await page.waitForSelector('.next-card');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Pause vorbei'));
  assert.equal(await page.evaluate(() => localStorage.getItem('volumora-rest-until')), null);
});

test('a rest that ended long ago stays silent', async () => {
  await page.evaluate(() => localStorage.setItem('volumora-rest-until', String(Date.now() - 600000)));
  await page.reload();
  await page.waitForFunction(() => localStorage.getItem('volumora-rest-until') === null);
  assert.equal(await page.locator('.toast').count(), 0);
});

test('empty old workouts can be removed in one step and the step undone', async () => {
  await page.evaluate(() => {
    const session = (id, sets) => ({
      id,
      planId: 'x',
      dayName: id,
      day: '2026-01-10',
      finishedAt: '2026-01-10T10:00:00.000Z',
      startedAt: '2026-01-10T09:00:00.000Z',
      duration: 3600,
      totalSets: 0,
      volume: 0,
      entries: [{ exerciseId: 'chest-press', trackType: 'weight_reps', sets }],
    });
    const history = [
      session('empty', [{ weight: '50', reps: '', done: false, type: 'normal' }]),
      session('typed', [{ weight: '50', reps: '8', done: false, type: 'normal' }]),
      session('real', [{ weight: '50', reps: '8', done: true, type: 'normal' }]),
    ];
    localStorage.setItem('volumora-history-v2', JSON.stringify(history));
  });
  const ids = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('volumora-history-v2')).map((h) => h.id));
  await page.reload();
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="settings"]');
  assert.match(await page.textContent('#cleanEmpty'), /1 leeres Training entfernen/);
  await page.click('#cleanEmpty');
  await page.waitForSelector('#cleanEmpty', { state: 'detached' });
  assert.deepEqual(await ids(), ['typed', 'real'], 'a set with typed reps is kept');
  await page.click('.toast-action');
  await page.waitForSelector('#cleanEmpty');
  assert.deepEqual(await ids(), ['empty', 'typed', 'real']);
});

test('the progress line stays in the header while the sets scroll', async () => {
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  assert.equal(await page.locator('.workout-top .progress-line').count(), 1);
});

test('first run: the rest timer can be turned off, and the install tip waits on Heute', async () => {
  await page.evaluate(() => localStorage.clear());
  await context.clearCookies();
  const fresh = await context.newPage();
  await fresh.addInitScript(() => localStorage.removeItem('volumora-onboarded'));
  await fresh.goto(baseURL + '/');
  await fresh.waitForSelector('#onboardingForm');
  for (let step = 0; step < 3; step++) {
    await fresh.click('#onboardingForm button[type="submit"]');
  }
  await fresh.waitForSelector('input[name="restTimer"]');
  await fresh.uncheck('input[name="restTimer"]', { force: true });
  await fresh.click('#onboardingForm button[type="submit"]');
  await fresh.click('#onboardingUse');
  await fresh.waitForSelector('#installNow');
  const settings = await fresh.evaluate(() => JSON.parse(localStorage.getItem('volumora-settings-v2')));
  assert.equal(settings.restTimer, false);
  await fresh.click('#installLater');
  await fresh.waitForSelector('#installNow', { state: 'detached' });
  await fresh.close();
});

// The Claude API as the app sees it; no test ever reaches the real service. `onMessage` returns { text }, { tool, input }
// or { status }.
async function mockClaude({ onMessage, verifyStatus = 200 } = {}) {
  const calls = [];
  await page.route('https://api.anthropic.com/**', async (route) => {
    const request = route.request();
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: cors });
    const body = request.postDataJSON();
    calls.push({ url: request.url(), headers: request.headers(), body });
    if (request.url().endsWith('/count_tokens'))
      return route.fulfill({
        status: verifyStatus,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({ input_tokens: 1, error: { message: 'x' } }),
      });
    const reply = onMessage?.(body) ?? { text: 'Antwort' };
    if (reply.status)
      return route.fulfill({
        status: reply.status,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: reply.message || 'x' } }),
      });
    const thinking = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
    ];
    const events = reply.tool
      ? [
          ...thinking,
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: `tool${calls.length}`, name: reply.tool, input: {} },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input || {}) },
          },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        ]
      : [
          ...thinking,
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: reply.text } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: reply.stop || 'end_turn' } },
        ];
    await route.fulfill({
      status: 200,
      headers: cors,
      contentType: 'text/event-stream',
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
    });
  });
  return calls;
}
const addAiKey = () =>
  page.evaluate(async () => {
    localStorage.setItem('volumora-ai-key', 'sk-ant-api-test-secret');
    (await import('/src/render.js')).render();
  });

test('without a key no AI feature shows and nothing is sent', async () => {
  const calls = await mockClaude();
  await seedHistory();
  await page.click('[data-nav="plans"]');
  await page.click('#newPlan');
  assert.equal(await page.getByText('Mit dem KI-Assistenten').count(), 0);
  await page.keyboard.press('Escape');
  await page.click('[data-nav="analytics"]');
  assert.equal(await page.locator('[data-nav="ai"]').count(), 0, 'no tab without a key');
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="settings"]');
  assert.match(await page.textContent('#openAi'), /Claude-Schlüssel eintragen/);
  assert.equal(calls.length, 0);
});

test('a Claude key is checked before saving and stays out of the backup', async () => {
  const calls = await mockClaude({ verifyStatus: 401 });
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="settings"]');
  await page.click('#openAi');
  await axeCheck('ai setup');
  assert.equal(await page.getAttribute('#aiKey', 'type'), 'password');
  await page.fill('#aiKey', 'sk-ant-oat-subscription');
  await page.click('#aiKeySave');
  await page.waitForSelector('.ai-error');
  assert.match(await page.textContent('.ai-error'), /Claude-Abo/);
  assert.equal(calls.length, 0, 'a subscription token never leaves the device');
  await page.fill('#aiKey', 'sk-ant-api-wrong');
  await page.click('#aiKeySave');
  await page.waitForFunction(() => document.querySelector('.ai-error')?.textContent.includes('lehnt'));
  assert.equal(await page.evaluate(() => localStorage.getItem('volumora-ai-key')), null);

  await page.unroute('https://api.anthropic.com/**');
  const good = await mockClaude();
  await page.fill('#aiKey', ' sk-ant-api-test-secret ');
  await page.click('#aiKeySave');
  await page.waitForSelector('#aiInput');
  assert.equal(good[0].headers['x-api-key'], 'sk-ant-api-test-secret');
  assert.equal(good[0].headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.match(good[0].url, /count_tokens$/);
  await page.click('.toast-close');
  await page.waitForSelector('.toast', { state: 'detached' });
  assert.equal(await page.evaluate(() => localStorage.getItem('volumora-ai-key')), 'sk-ant-api-test-secret');
  await axeCheck('ai home');

  await page.click('#aiBack');
  assert.equal(await page.locator('#openAi').count(), 0, 'settings no longer offer it once it has its tab');
  await page.waitForSelector('[data-nav="ai"]');
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="backup"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportJson')]);
  assert.equal(fs.readFileSync(await download.path(), 'utf8').includes('sk-ant'), false);

  await page.click('[data-nav="ai"]');
  await page.click('#aiMenu');
  await page.getByRole('button', { name: 'Schlüssel entfernen' }).click();
  await page.waitForSelector('#aiKey');
  assert.equal(await page.evaluate(() => localStorage.getItem('volumora-ai-key')), null);
  await page.click('.toast-action');
  await page.waitForSelector('#aiInput');
  assert.equal(await page.evaluate(() => localStorage.getItem('volumora-ai-key')), 'sk-ant-api-test-secret');
});

test('the assistant asks, creates a plan, and the change can be undone from the chat', async () => {
  await addAiKey();
  // A question with answer buttons.
  let answers = [{ text: 'Wie viele Tage pro Woche?\n\n[[2 Tage | 3 Tage | 4 Tage]]' }];
  const calls = await mockClaude({ onMessage: () => answers.shift() });
  await page.click('[data-nav="plans"]');
  await page.click('#newPlan');
  await page.getByText('Mit dem KI-Assistenten').click();
  await page.waitForSelector('.chat-replies button');
  assert.match(calls[0].body.messages[0].content, /neuen Trainingsplan/);
  assert.equal(await page.locator('.chat-replies button').count(), 3);
  assert.equal((await page.textContent('.chat-assistant')).includes('[['), false);
  await axeCheck('ai chat with answer buttons');

  // Tapping an answer sends it; Claude looks things up and creates the plan.
  answers = [
    { tool: 'search_exercises', input: { query: 'bankdrücken' } },
    {
      tool: 'create_plan',
      input: { name: 'Erfunden', days: [{ name: 'A', exercises: [{ exercise_id: 'erfunden' }] }] },
    },
    {
      tool: 'create_plan',
      input: {
        name: 'Kurzhantel 2×',
        description: 'Passt.',
        days: [
          { name: 'Tag A', exercises: [{ exercise_id: '0025', sets: 3, range: '8–12' }] },
          { name: 'Tag B', exercises: [{ exercise_id: '0003', sets: 2, range: '12–15' }] },
        ],
      },
    },
    { text: 'Der Plan ist angelegt.' },
  ];
  await page.locator('.chat-replies button').nth(1).click();
  await page.waitForSelector('[data-ai-undo]');
  await page.waitForFunction(
    () => document.querySelector('#aiSend') && !document.querySelector('#aiSend').hidden
  );
  assert.equal(await page.locator('.chat-user').last().textContent(), '3 Tage');
  assert.equal(await page.locator('.chat-replies').count(), 0, 'old answer buttons are gone');
  assert.match(await page.textContent('.chat-action'), /Plan „Kurzhantel 2×“ angelegt/);
  await axeCheck('ai chat with action');

  const turn = calls.slice(-4).map((c) => c.body);
  assert.ok(
    turn.every((b) => b.system === turn[0].system),
    'one system prompt for the whole turn'
  );
  assert.equal(turn[0].tools.filter((tool) => tool.input_schema).length, 18);
  assert.equal(turn[0].tools.at(-1).name, 'web_search');
  assert.ok(
    turn[0].tools.filter((tool) => tool.input_schema).every((tool) => tool.eager_input_streaming === true)
  );
  assert.equal(turn[0].tools.at(-1).eager_input_streaming, undefined);
  assert.deepEqual(turn[1].messages.at(-2).content[0], { type: 'thinking', thinking: '', signature: 'sig' });
  assert.equal(turn[1].messages.at(-1).content[0].type, 'tool_result');
  const refused = turn[2].messages.at(-1).content[0];
  assert.equal(refused.is_error, true, 'an unknown exercise goes back to Claude');
  assert.match(refused.content, /erfunden/);
  assert.equal(JSON.stringify(turn).includes('sk-ant'), false);

  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('volumora-plans-v2')));
  let plans = await stored();
  assert.equal(plans.items.length, 2);
  assert.equal(plans.items.find((p) => p.id === plans.activePlanId).name, 'Kurzhantel 2×');

  // The next turn sends text only, and says what was done.
  answers = [{ text: 'Gern.' }];
  await page.fill('#aiInput', 'Danke');
  await page.click('#aiSend');
  await page.waitForFunction(() => document.querySelector('#chatScroll').textContent.includes('Gern.'));
  const next = calls.at(-1).body.messages;
  assert.equal(typeof next.at(-2).content, 'string');
  assert.match(
    next.at(-2).content,
    /Der Plan ist angelegt\.[\s\S]*Done in the app: Plan „Kurzhantel 2×“ angelegt/
  );

  await page.click('[data-ai-undo]');
  await page.waitForFunction(() => document.querySelector('.chat-action small'));
  plans = await stored();
  assert.equal(plans.items.length, 1, 'the plan is gone again');
  assert.equal(await page.locator('[data-ai-undo]').count(), 0);
});

test('deleting a plan needs a yes, and settings change right away', async () => {
  await addAiKey();
  const extra = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('volumora-plans-v2'));
    const copy = JSON.parse(JSON.stringify(data.items[0]));
    copy.id = 'second';
    copy.name = 'Zweiter Plan';
    data.items.push(copy);
    localStorage.setItem('volumora-plans-v2', JSON.stringify(data));
    return copy.id;
  });
  let answers = [];
  const calls = await mockClaude({ onMessage: () => answers.shift() });
  await page.click('[data-nav="ai"]');
  const say = async (text) => {
    await page.fill('#aiInput', text);
    await page.click('#aiSend');
  };
  const plans = () => page.evaluate(() => JSON.parse(localStorage.getItem('volumora-plans-v2')).items.length);

  answers = [{ tool: 'delete_plan', input: { plan_id: extra } }, { text: 'Gut, er bleibt.' }];
  await say('Lösche den zweiten Plan');
  await page.waitForSelector('.sheet-backdrop.show');
  assert.match(await page.textContent('.sheet'), /Zweiter Plan/);
  assert.equal(await plans(), 2);
  await page.click('.sheet-actions [data-cancel]');
  await page.waitForFunction(() =>
    document.querySelector('#chatScroll').textContent.includes('Gut, er bleibt.')
  );
  assert.equal(await plans(), 2, 'declined');
  assert.match(calls.at(-1).body.messages.at(-1).content[0].content, /"deleted":false/);

  answers = [{ tool: 'delete_plan', input: { plan_id: extra } }, { text: 'Gelöscht.' }];
  await say('Doch, lösche ihn');
  await page.waitForSelector('.sheet-backdrop.show');
  await page.click('.sheet-actions [data-ok]');
  await page.waitForFunction(() => document.querySelector('#chatScroll').textContent.includes('Gelöscht.'));
  assert.equal(await plans(), 1);

  answers = [
    { tool: 'update_settings', input: { rest_seconds: 120, theme: 'light' } },
    { text: 'Erledigt.' },
  ];
  await say('Pause auf 2 Minuten und helles Design');
  await page.waitForFunction(() => document.querySelector('#chatScroll').textContent.includes('Erledigt.'));
  const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('volumora-settings-v2')));
  assert.deepEqual([settings.rest, settings.theme], [120, 'light']);
  assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  await page.locator('[data-ai-undo]').last().click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('volumora-settings-v2')).rest === 90);
});

test('the chat keeps the conversation, sends the history and survives a reload', async () => {
  await seedHistory();
  await addAiKey();
  let status = 0;
  let count = 0;
  const calls = await mockClaude({
    onMessage: () =>
      status ? { status } : { text: `Antwort ${++count}\n- Mehr **Rücken** <b>trainieren</b>` },
  });
  await page.click('[data-nav="ai"]');
  await page.waitForSelector('.chat-empty');
  assert.equal(calls.length, 0, 'opening the chat sends nothing');
  assert.equal(await page.isDisabled('#aiSend'), true);
  assert.equal(await page.locator('.bottom-nav').count(), 0, 'the chat has the screen to itself');
  await axeCheck('ai chat empty');

  await page.locator('[data-chat-starter]').first().click();
  await page.waitForSelector('.chat-assistant li');
  assert.match(calls[0].body.system, /Sessions in the last 8 weeks/);
  assert.match(calls[0].body.messages[0].content, /Erstelle mir einen neuen Trainingsplan/);
  assert.equal(calls[0].body.messages.length, 1);
  assert.equal(await page.locator('.chat-user').count(), 1);
  const reply = page.locator('.chat-assistant li').first();
  assert.match(await reply.textContent(), /Mehr Rücken <b>trainieren<\/b>/, 'markup in a reply stays text');
  assert.equal(await reply.locator('b').count(), 1, 'bold is the one thing that gets formatted');

  await page.focus('#aiInput');
  await page.fill('#aiInput', 'Warum stagniere ich?');
  await page.click('#aiSend');
  await page.waitForFunction(
    () => document.querySelectorAll('.chat-assistant').length === 2 && !document.querySelector('#chatLive')
  );
  assert.equal(await page.evaluate(() => document.activeElement.id), 'aiInput', 'the keyboard stays up');
  assert.equal(await page.inputValue('#aiInput'), '');
  const second = calls.at(-1).body.messages;
  assert.deepEqual(
    second.map((m) => m.role),
    ['user', 'assistant', 'user']
  );
  assert.match(second[1].content, /Antwort 1/);
  assert.equal(second[2].content, 'Warum stagniere ich?');
  await axeCheck('ai chat');

  status = 401;
  await page.fill('#aiInput', 'Noch eine Frage');
  await page.click('#aiSend');
  await page.waitForSelector('.chat-error');
  assert.match(await page.textContent('.chat-error'), /lehnt diesen Schlüssel ab/);
  assert.equal(
    await page.inputValue('#aiInput'),
    'Noch eine Frage',
    'a failed question comes back to the field'
  );
  assert.equal(await page.locator('.chat-user').count(), 2);

  status = 0;
  await page.reload();
  await page.waitForSelector('.next-card');
  await page.click('[data-nav="ai"]');
  await page.waitForSelector('.chat-user');
  assert.equal(await page.locator('.chat-user').count(), 2, 'the chat is still there');

  await page.click('#aiMenu');
  await page.getByRole('button', { name: 'Neuer Chat' }).click();
  await page.waitForSelector('.chat-empty');
  await page.click('.toast-action');
  await page.waitForSelector('.chat-user');
  assert.equal(await page.locator('.chat-user').count(), 2, 'a new chat can be undone');

  await page.click('.chat-head #aiBack');
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="backup"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportJson')]);
  assert.equal(fs.readFileSync(await download.path(), 'utf8').includes('Warum stagniere'), false);
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="settings"]');
  await page.click('#deleteAll');
  await page.click('.sheet-actions [data-ok]');
  await page.waitForSelector('#onboardingForm, .next-card');
  const left = await page.evaluate(() => [
    localStorage.getItem('volumora-ai-key'),
    localStorage.getItem('volumora-ai-chat'),
  ]);
  assert.deepEqual(left, [null, null], 'delete all includes key and chat');
});

test('replacing an exercise offers matching ones first', async () => {
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  await page.click('[data-exercise-menu="0"]');
  await page.getByRole('button', { name: 'Ersetzen', exact: true }).click();
  await page.waitForSelector('.library-suggested');
  assert.match(await page.textContent('.library-suggested h3'), /Passender Ersatz/);
  const cards = page.locator('.library-suggested .library-item');
  assert.ok((await cards.count()) >= 3);
  await axeCheck('picker with replacements');
  await page.fill('#librarySearch', 'kabel');
  assert.equal(
    await page.locator('.library-suggested').isVisible(),
    false,
    'searching shows the normal list'
  );
  await page.fill('#librarySearch', '');
  const name = await cards.first().locator('h3').textContent();
  await cards.first().locator('[data-pick-exercise]').click();
  await page.waitForSelector('.exercise-library', { state: 'detached' });
  assert.match(await page.locator('.workout-exercise').first().textContent(), new RegExp(name));
});

test('stopping an answer leaves no error and the question returns when nothing arrived', async () => {
  await seedHistory();
  await addAiKey();
  await page.route('https://api.anthropic.com/**', () => {});
  await page.click('[data-nav="ai"]');
  await page.fill('#aiInput', 'Hallo');
  await page.click('#aiSend');
  await page.waitForSelector('#aiStop:not([hidden])');
  assert.equal(await page.isVisible('#aiSend'), false, 'one request at a time');
  assert.equal(await page.locator('.chat-dots').count(), 1);
  await page.click('#aiStop');
  await page.waitForSelector('#aiSend:not([hidden])');
  assert.equal(await page.locator('.chat-error').count(), 0);
  assert.equal(await page.locator('.chat-user').count(), 0);
  assert.equal(await page.inputValue('#aiInput'), 'Hallo');
});

test('one long value stacks the whole chat card, short values stay beside the name', async () => {
  await addAiKey();
  await page.setViewportSize({ width: 390, height: 844 });
  await mockClaude({
    onMessage: () => ({
      text: '## Über dich\n- Erfahrung | 2–3 Jahre\n- Rechte Schulter | Aktivierte Arthrose im AC-Gelenk, kein Drücken über Kopf | Seit März\n- Bankdrücken mit der Langhantel auf der Flachbank | 3×8–12\n\n## Plan\n- Brustpresse | 3×8–12 | 3 Min. Pause\n- Bankdrücken mit der Langhantel auf der Flachbank | 45 kg, 3×11',
    }),
  });
  await page.click('[data-nav="ai"]');
  await page.fill('#aiInput', 'Was weißt du?');
  await page.click('#aiSend');
  await page.waitForFunction(() => document.querySelectorAll('.chat-row').length === 5);
  const rows = await page.$$eval('.chat-row', (items) =>
    items.map((row) => {
      const name = row.querySelector('span').getBoundingClientRect();
      const value = row.querySelector('b').getBoundingClientRect();
      const box = row.getBoundingClientRect();
      return {
        nameWidth: name.width,
        stacked: value.top >= name.bottom - 1,
        fits: value.right <= box.right + 0.5,
      };
    })
  );
  assert.deepEqual(
    rows.map((r) => r.stacked),
    [true, true, true, false, false],
    'a card is all one layout'
  );
  const note = await page.$eval('.chat-card.stacked .chat-row:has(small)', (row) => ({
    value: row.querySelector('b').getBoundingClientRect().bottom,
    note: row.querySelector('small').getBoundingClientRect().top,
  }));
  assert.ok(note.note >= note.value - 1, 'the note comes after the value');
  assert.ok(
    rows.every((r) => r.fits && r.nameWidth > 100),
    JSON.stringify(rows)
  );
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('a plan in the chat reads as cards with one row per exercise', async () => {
  await addAiKey();
  await mockClaude({
    onMessage: () => ({
      text: '## Tag 1 · Oberkörper\n- Brustpresse | 3×8–12\n- Kniebeugen | 3×6–10 | 3 Min. Pause\n\nPasst das?\n\n[[Plan anlegen | Etwas ändern]]',
    }),
  });
  await page.click('[data-nav="ai"]');
  await page.fill('#aiInput', 'Zeig mir einen Plan');
  await page.click('#aiSend');
  await page.waitForSelector('.chat-replies');
  assert.equal(await page.textContent('.chat-card h3'), 'Tag 1 · Oberkörper');
  assert.equal(await page.locator('.chat-row').count(), 2);
  assert.equal(await page.locator('.chat-row b').first().textContent(), '3×8–12');
  assert.equal(await page.locator('.chat-row small').textContent(), '3 Min. Pause');
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(async () => (await import('/src/theme.js')).applyTheme());
    await axeCheck(`chat cards/${scheme}`);
  }
});

test('a workout set can be said, with the field as the way that always works', async () => {
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  // No speech recognition in this browser: the field opens right away.
  await page.evaluate(() => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });
  await page.click('[data-dictate="0"]');
  await page.waitForSelector('#dictateInput');
  assert.match(await page.textContent('.sheet-head h2'), /Brustpresse · Satz 1/);
  assert.equal(await page.isDisabled('#dictateSave'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'dictateInput');
  await page.waitForSelector('.sheet-backdrop.show');
  await axeCheck('dictation');
  await page.fill('#dictateInput', 'keine Ahnung');
  assert.equal(await page.isDisabled('#dictateSave'), true);
  await page.fill('#dictateInput', '60 Kilo, 12 Wiederholungen');
  assert.match(await page.textContent('.dictate-state'), /60 kg · 12 Wdh\./);
  await page.click('#dictateSave');
  await page.waitForSelector('#dictateInput', { state: 'detached' });
  const first = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('volumora-active-v2')).entries[0].sets);
  let sets = await first();
  assert.deepEqual([sets[0].weight, sets[0].reps, sets[0].done], ['60', '12', true]);
  assert.ok(
    await page.locator('.rest-bar, [class*="rest"]').count(),
    'the rest timer starts like after a tap'
  );

  // A blocked microphone is told at once, without starting the recognition.
  await page.evaluate(() => {
    window.starts = 0;
    window.webkitSpeechRecognition = class {
      start() {
        window.starts += 1;
      }
      stop() {
        this.onend?.();
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('no', 'NotAllowedError');
    };
  });
  await page.click('[data-dictate="0"]');
  await page.waitForFunction(() =>
    document.querySelector('.dictate-state')?.textContent.includes('nicht freigegeben')
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('volumora-speech-off')), 'mic-blocked');
  assert.equal(await page.evaluate(() => window.starts), 0);
  await page.click('.sheet-head button');
  await page.waitForSelector('#dictateInput', { state: 'detached' });

  // The next one goes into the next set; a recognizer that hears something finishes on its own.
  await page.evaluate(() => {
    localStorage.removeItem('volumora-speech-off');
    window.micStops = 0;
    navigator.mediaDevices.getUserMedia = async () => ({
      getTracks: () => [{ stop: () => (window.micStops += 1) }],
    });
    window.webkitSpeechRecognition = class {
      start() {
        setTimeout(() => {
          this.onstart?.();
          this.onresult?.({ results: [Object.assign([{ transcript: '62,5 kg zehn' }], { isFinal: true })] });
        }, 10);
      }
      stop() {
        this.onend?.();
      }
    };
  });
  await page.click('[data-dictate="0"]');
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('volumora-active-v2')).entries[0].sets[1].done
  );
  sets = await first();
  assert.deepEqual([sets[1].weight, sets[1].reps], ['62.5', '10']);
  assert.equal(await page.evaluate(() => window.micStops), 1, 'the microphone check does not keep it open');
  await page.waitForSelector('#dictateInput', { state: 'detached' });

  // A phone that refuses says why, and from then on listening waits for a tap on the microphone in the field.
  await page.evaluate(() => {
    window.starts = 0;
    window.webkitSpeechRecognition = class {
      start() {
        window.starts += 1;
        setTimeout(() => this.onerror?.({ error: 'service-not-allowed' }), 10);
      }
      stop() {
        this.onend?.();
      }
    };
  });
  await page.click('[data-dictate="0"]');
  await page.waitForFunction(() => document.querySelector('.dictate-state')?.textContent.includes('Siri'));
  assert.equal(await page.evaluate(() => localStorage.getItem('volumora-speech-off')), 'service-not-allowed');
  await page.waitForSelector('.sheet-backdrop.show');
  await axeCheck('dictation refused');
  await page.click('.sheet-head button');
  await page.waitForSelector('#dictateInput', { state: 'detached' });
  await page.click('[data-dictate="0"]');
  await page.waitForSelector('#dictateMic');
  assert.match(await page.textContent('.dictate-state'), /Siri/);
  assert.equal(await page.evaluate(() => window.starts), 1, 'it does not start by itself again');

  // A tap tries again, and once it works it starts by itself again.
  await page.evaluate(() => {
    window.webkitSpeechRecognition = class {
      start() {
        setTimeout(() => {
          this.onstart?.();
          this.onresult?.({ results: [Object.assign([{ transcript: '65 kg acht' }], { isFinal: true })] });
        }, 10);
      }
      stop() {
        this.onend?.();
      }
    };
  });
  await page.click('#dictateMic');
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('volumora-active-v2')).entries[0].sets[2].done
  );
  sets = await first();
  assert.deepEqual([sets[2].weight, sets[2].reps], ['65', '8']);
  assert.equal(await page.evaluate(() => localStorage.getItem('volumora-speech-off')), null);
  assert.equal(await page.evaluate(() => window.micStops), 3, 'every attempt starts with the microphone');
  await page.waitForSelector('#dictateInput', { state: 'detached' });

  // A phone that listens and never answers does not leave the person waiting.
  await page.evaluate(() => {
    window.webkitSpeechRecognition = class {
      start() {
        setTimeout(() => this.onstart?.(), 10);
      }
      stop() {
        this.onend?.();
      }
    };
  });
  await page.click('[data-add-set="0"]');
  await page.click('[data-dictate="0"]');
  await page.waitForFunction(
    () => document.querySelector('.dictate-state')?.textContent.includes('nicht verstanden'),
    null,
    { timeout: 12000 }
  );
  assert.equal(await page.locator('#dictateMic.listening').count(), 0);
});

test('the assistant knows the running workout, the summary and what it remembers', async () => {
  await seedHistory();
  await addAiKey();
  let answers = [];
  const calls = await mockClaude({ onMessage: () => answers.shift() });
  await page.reload();
  await page.waitForSelector('.next-card');
  await page.click('.next-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  await page.click('[data-exercise-menu="0"]');
  await page.getByRole('button', { name: 'KI fragen' }).click();
  await page.waitForSelector('#aiInput');
  assert.match(await page.inputValue('#aiInput'), /^Zu .+: $/);
  assert.equal(calls.length, 0);
  answers = [
    { tool: 'update_active_workout', input: { action: 'replace', index: 0, exercise_id: '0025' } },
    { tool: 'remember', input: { fact: 'Schulter links empfindlich' } },
    { text: '## Heute\n- Bankdrücken mit Langhantel | 3×8–12\n\nErledigt.' },
  ];
  await page.fill('#aiInput', 'Die Schulter zwickt, ersetze die Übung');
  await page.click('#aiSend');
  await page.waitForSelector('.chat-row[data-exercise]');
  assert.match(calls[0].body.system, /A workout is running right now/);
  assert.equal(await page.locator('.chat-action').count(), 2);
  const active = () => page.evaluate(() => JSON.parse(localStorage.getItem('volumora-active-v2')));
  assert.equal((await active()).entries[0].libraryId, '0025');

  // A row opens the exercise.
  await page.click('.chat-row[data-exercise]');
  await page.waitForSelector('.exercise-sheet');
  await page.keyboard.press('Escape');

  // Menu: memory and the rough cost.
  await page.waitForSelector('.sheet-backdrop', { state: 'detached' });
  await page.click('#aiMenu');
  await page.getByRole('button', { name: /Gedächtnis/ }).click();
  await page.waitForSelector('.memory-row');
  await page.waitForSelector('.sheet-backdrop.show');
  assert.match(await page.textContent('.memory-row'), /Schulter links/);
  await axeCheck('memory');
  await page.click('[data-forget]');
  await page.waitForFunction(() => !document.querySelector('.memory-row'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sheet-backdrop', { state: 'detached' });
  await page.click('#aiMenu');
  assert.match(await page.textContent('.sheet'), /Diesen Monat ca\. /);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sheet-backdrop', { state: 'detached' });

  // Back to the workout, finish it, and let the summary send its question.
  await page.click('#aiBack');
  await page.waitForSelector('.workout-exercise');
  await page.fill('[data-set-field="weight"][data-exercise="0"][data-index="0"]', '50');
  await page.fill('[data-set-field="reps"][data-exercise="0"][data-index="0"]', '10');
  await page.click('[data-set-done="0"][data-exercise="0"]');
  await page.click('#finishWorkout');
  await page.click('.sheet-actions [data-ok]').catch(() => {});
  await page.waitForSelector('#summaryAi');
  answers = [{ text: 'Starkes Training.' }];
  await page.click('#summaryAi');
  await page.waitForFunction(() =>
    document.querySelector('#chatScroll')?.textContent.includes('Starkes Training.')
  );
  assert.match(calls.at(-1).body.messages.at(-1).content, /gerade beendetes Training/);
  await page.click('#aiBack');
  await page.waitForSelector('#summaryAi');
});

test('reading further up is not interrupted while a reply is still being written', async () => {
  await addAiKey();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const encoder = new TextEncoder();
    const realFetch = window.fetch;
    window.fetch = (url, options) => {
      if (!String(url).includes('api.anthropic.com')) return realFetch(url, options);
      const body = new ReadableStream({
        start(controller) {
          window.pushEvent = (event) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          window.endStream = () => controller.close();
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      );
    };
  });
  await page.click('[data-nav="ai"]');
  await page.fill('#aiInput', 'Erzähl mir viel');
  await page.click('#aiSend');
  await page.waitForFunction(() => window.pushEvent);
  const push = async (lines) => {
    await page.evaluate((count) => {
      window.pushEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Eine Zeile Text.\n\n'.repeat(count) },
      });
    }, lines);
    await page.waitForTimeout(150);
  };
  const scroll = () =>
    page.$eval('#chatScroll', (box) => ({
      top: box.scrollTop,
      left: box.scrollHeight - box.scrollTop - box.clientHeight,
    }));
  await page.evaluate(() =>
    window.pushEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  );
  await push(60);
  assert.ok((await scroll()).left < 8, 'new text is followed');
  // A small move up is enough, even inside the zone that counts as near the end.
  await page.$eval('#chatScroll', (box) => {
    box.scrollTop -= 30;
  });
  await page.waitForTimeout(50);
  const held = (await scroll()).top;
  await push(20);
  assert.equal((await scroll()).top, held, 'new text does not pull the reader back');
  await page.$eval('#chatScroll', (box) => {
    box.scrollTop = box.scrollHeight;
  });
  await page.waitForTimeout(50);
  await push(20);
  assert.ok((await scroll()).left < 8, 'back at the end it follows again');
  await page.evaluate(() => {
    window.pushEvent({ type: 'content_block_stop', index: 0 });
    window.pushEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    window.endStream();
  });
  await page.waitForFunction(() => !document.querySelector('#chatLive'));
});

test('progress explains itself: whole counts, labelled marks, a hint instead of an empty chart', async () => {
  await seedHistory();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    const { getHistory, saveHistory, saveBody } = await import('/src/storage.js');
    saveHistory(getHistory().slice(0, 1));
    saveBody([{ id: 'b1', date: new Date().toISOString(), weight: 80 }]);
    const { navigate } = await import('/src/render.js');
    const { state } = await import('/src/state.js');
    state.analyticsRange = 'all';
    navigate('analytics');
  });
  await page.waitForSelector('.bar-scale');
  assert.deepEqual(await page.$$eval('.bar-scale small', (marks) => marks.map((m) => m.textContent)), [
    '10',
    '20',
  ]);
  const alignment = await page.evaluate(() => {
    const track = document.querySelector('.bar-track.target').getBoundingClientRect();
    const mark = document.querySelector('.bar-track.target em').getBoundingClientRect();
    const label = document.querySelector('.bar-scale small').getBoundingClientRect();
    return {
      gap: Math.abs(mark.left + mark.width / 2 - (label.left + label.width / 2)),
      inside: label.left > track.left,
    };
  });
  assert.ok(alignment.gap < 2, `label sits over its mark, off by ${alignment.gap}`);
  assert.ok(alignment.inside);
  const value = await page.$eval('.weekly-sets .bar-row b', (b) => b.getBoundingClientRect().right);
  assert.ok(value <= 390, `the set count stays on screen, ends at ${value}`);
  assert.ok(await page.$eval('.weekly-sets .bar-row b', (b) => b.scrollWidth <= b.clientWidth + 1));
  // Count axes draw no halves: record what is written on the canvas.
  const labels = await page.evaluate(async () => {
    const written = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      if (this.canvas.id === 'frequencyChart') written.push(String(text));
      return original.call(this, text, ...rest);
    };
    const { drawAnalytics } = await import('/src/charts.js');
    const { state } = await import('/src/state.js');
    drawAnalytics(state.analyticsExercise, 'all');
    CanvasRenderingContext2D.prototype.fillText = original;
    return written.filter((text) => /^\d+$/.test(text));
  });
  assert.deepEqual(labels.slice(0, 2), ['1', '0']);
  await page.click('[data-analytics-tab="strength"]');
  // One workout of the chosen exercise: a hint, and no empty canvas.
  await page.waitForSelector('#bodyStrengthEmpty:not([hidden])');
  assert.equal(await page.locator('#bodyStrengthChart').isVisible(), false);
  assert.equal(await page.locator('#bodyStrengthHint').isVisible(), false);
});

test('no field is small enough for an iPhone to zoom into it', async () => {
  await seedHistory();
  await page.setViewportSize({ width: 390, height: 844 });
  const small = () =>
    page.$$eval('input, select, textarea', (fields) =>
      fields
        .filter((f) => f.getClientRects().length && f.type !== 'checkbox' && f.type !== 'file')
        .filter((f) => parseFloat(getComputedStyle(f).fontSize) < 16)
        .map((f) => `${f.tagName} ${f.id || f.className || f.getAttribute('aria-label')}`)
    );
  for (const view of ['analytics', 'plans', 'more', 'settings', 'body']) {
    await page.evaluate(async (name) => (await import('/src/render.js')).navigate(name), view);
    await page.waitForTimeout(50);
    assert.deepEqual(await small(), [], view);
  }
  await page.click('[data-nav="home"]');
  await page.click('[data-start]');
  await page.waitForSelector('[data-exercise-menu]');
  assert.deepEqual(await small(), [], 'workout');
  await page.click('[data-exercise-menu]');
  await page.waitForSelector('.sheet-backdrop.show');
  assert.deepEqual(await small(), [], 'workout menu');
});

test('a reply that dies in the background starts again on return, without repeating a change', async () => {
  await addAiKey();
  await page.evaluate(() => {
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    window.setHidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const encoder = new TextEncoder();
    const events = (list) => list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    const respond = (text) =>
      new Response(encoder.encode(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const realFetch = window.fetch;
    window.requests = [];
    window.fetch = (url, options) => {
      if (!String(url).includes('api.anthropic.com')) return realFetch(url, options);
      const body = JSON.parse(options.body);
      window.requests.push(body);
      const number = window.requests.length;
      if (number === 1)
        return Promise.resolve(
          respond(
            events([
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'tool_use', id: 'tool1', name: 'remember', input: {} },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify({ fact: 'Mag Kabelzug' }) },
              },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
            ])
          )
        );
      // The second request hangs in the background until the app comes back, then the connection is gone.
      if (number === 2) {
        window.setHidden(true);
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('gone', 'AbortError')));
        });
      }
      return Promise.resolve(
        respond(
          events([
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Wieder da.' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          ])
        )
      );
    };
  });
  await page.click('[data-nav="ai"]');
  await page.fill('#aiInput', 'Merk dir das');
  await page.click('#aiSend');
  await page.waitForFunction(() => window.requests.length === 2);
  await page.evaluate(() => window.setHidden(false));
  await page.waitForFunction(
    () => document.querySelector('#chatScroll').textContent.includes('Wieder da.'),
    null,
    {
      timeout: 12000,
    }
  );
  const { sent, memory, actions } = await page.evaluate(async () => {
    const { getAiMemory } = await import('/src/storage.js');
    return {
      sent: window.requests.map((r) => r.messages.length),
      memory: getAiMemory(),
      actions: document.querySelectorAll('.chat-action').length,
    };
  });
  assert.deepEqual(sent, [1, 3, 3], 'the same conversation goes out again');
  assert.equal(memory.length, 1, 'the tool ran once');
  assert.equal(actions, 1);
});

test('a question left open by a closed app goes back into the field', async () => {
  await addAiKey();
  await page.evaluate(async () => {
    const { saveAiChat } = await import('/src/storage.js');
    saveAiChat([{ role: 'user', text: 'Noch offen' }]);
  });
  await page.click('[data-nav="ai"]');
  assert.equal(await page.inputValue('#aiInput'), 'Noch offen');
  assert.match(await page.textContent('.ai-error'), /unterbrochen/);
  assert.equal(await page.evaluate(async () => (await import('/src/storage.js')).getAiChat().length), 0);
});

test('the assistant reads notes, links into the app and draws charts from real data', async () => {
  await seedHistory();
  await addAiKey();
  await page.setViewportSize({ width: 390, height: 844 });
  const { key, id } = await page.evaluate(async () => {
    const { getHistory, saveHistory } = await import('/src/storage.js');
    const { exerciseKey } = await import('/src/util.js');
    const history = getHistory();
    history[0].entries[0].note = 'Schulter zwickt';
    saveHistory(history);
    return { key: exerciseKey(history[0].entries[0]), id: history[0].id };
  });
  const tools = await page.evaluate(async () => {
    const { runTool } = await import('/src/aiTools.js');
    return (await runTool('get_training_history', {}, {})).result;
  });
  assert.equal(tools.sessions[0].exercises[0].note, 'Schulter zwickt');
  assert.equal(tools.sessions[0].id, id);
  await mockClaude({
    onMessage: () => ({
      text: `Hier dein Verlauf.\n>> chart:strength:${key}\n>> chart:sets\n>> chart:body\n>> workout:${id}\n>> records\n>> chart:unknown\n>> nothing`,
    }),
  });
  await page.click('[data-nav="ai"]');
  await page.fill('#aiInput', 'Wie läuft es?');
  await page.click('#aiSend');
  await page.waitForSelector('.chat-link');
  const shown = await page.evaluate(() => ({
    canvases: document.querySelectorAll('.chat-chart canvas').length,
    width: document.querySelector('.chat-chart canvas').width,
    sections: [...document.querySelectorAll('.chat-chart h3')].map((h) => h.textContent),
    thin: document.querySelector('.chat-chart p.muted')?.textContent,
    links: [...document.querySelectorAll('.chat-link')].map((b) => b.textContent),
    leftover: document.querySelector('#chatScroll').textContent.includes('>>'),
  }));
  assert.equal(shown.canvases, 1);
  assert.ok(shown.width > 0, 'the chart is drawn');
  assert.equal(shown.sections.length, 3);
  assert.match(shown.thin, /zu wenig Daten/);
  assert.equal(shown.links.length, 2);
  assert.equal(shown.leftover, false);
  await axeCheck('chat with charts and links');
  await page.click('[data-chat-session]');
  await page.waitForSelector('.coach-note');
  await page.click('.backrow .back');
  await page.waitForSelector('#chatScroll');
  await page.click('[data-chat-nav="records"]');
  await page.waitForFunction(async () => (await import('/src/state.js')).state.view === 'records');
});

test('a new exercise suggests reps in grey, and a tick takes them with a typed weight', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-start]');
  const reps = page.locator('[data-exercise="0"][data-set-field="reps"]').first();
  const range = await page.evaluate(async () => {
    const { allPlans } = await import('/src/storage.js');
    const { rangeMid } = await import('/src/util.js');
    return rangeMid(allPlans().items[0].days[0].exercises[0].range);
  });
  assert.equal(await reps.getAttribute('placeholder'), String(range));
  assert.equal(await reps.inputValue(), '');
  // Without a weight nothing is logged and the field stays empty.
  await page.locator('[data-set-done][data-exercise="0"]').first().click();
  assert.equal(await reps.inputValue(), '');
  await page.locator('[data-exercise="0"][data-set-field="weight"]').first().fill('40');
  await page.locator('[data-set-done][data-exercise="0"]').first().click();
  await page.waitForSelector('.set-card.complete');
  assert.equal(
    await page.locator('[data-exercise="0"][data-set-field="reps"]').first().inputValue(),
    String(range)
  );
});

test('a finished workout can be rated, and shows calories once a body weight exists', async () => {
  await seedHistory();
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await page.evaluate(async () => {
    const { getHistory } = await import('/src/storage.js');
    const { navigate } = await import('/src/render.js');
    const session = getHistory()[0];
    navigate('summary', { sessionId: session.id });
    return session.id;
  });
  await page.waitForSelector('#sessionExtras');
  assert.match(await page.textContent('.session-calories'), /Körpergewicht/);
  await axeCheck('summary with rating');
  await page.click('[data-effort="4"]');
  assert.equal(await page.getAttribute('[data-effort="4"]', 'aria-pressed'), 'true');
  const stored = () =>
    page.evaluate(
      async (sid) => (await import('/src/storage.js')).getHistory().find((h) => h.id === sid).effort,
      id
    );
  assert.equal(await stored(), 4);
  await page.click('[data-effort="4"]');
  assert.equal(await stored(), undefined);
  await page.click('[data-effort="5"]');
  // A weight entered later gives the same workout a value, also in its details.
  await page.evaluate(async (sid) => {
    const { saveBody } = await import('/src/storage.js');
    saveBody([{ id: 'b1', date: new Date().toISOString(), weight: 80 }]);
    (await import('/src/render.js')).navigate('session', { sessionId: sid, sessionFrom: 'analytics' });
  }, id);
  await page.waitForSelector('#sessionExtras');
  assert.match(await page.textContent('.session-calories'), /ca\. 400 kcal/);
  assert.equal(await page.getAttribute('[data-effort="5"]', 'aria-pressed'), 'true');
});

test('a lighter week is suggested once and stays quiet after "not now"', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    const { saveHistory } = await import('/src/storage.js');
    const week = 7 * 86400000;
    const entry = (id) => ({
      exerciseId: id,
      name: id,
      sets: [{ weight: 50, reps: 8, done: true }],
    });
    saveHistory(
      Array.from({ length: 5 }, (_, i) => {
        const at = new Date(Date.now() - i * week).toISOString();
        return {
          id: `s${i}`,
          planId: null,
          dayId: null,
          dayName: 'A',
          startedAt: at,
          finishedAt: at,
          day: at.slice(0, 10),
          duration: 3600,
          totalSets: 1,
          volume: 400,
          effort: 5,
          markers: {},
          entries: [entry('a')],
        };
      })
    );
    (await import('/src/render.js')).navigate('more');
    (await import('/src/render.js')).navigate('home');
  });
  await page.waitForSelector('#deloadCard');
  assert.match(await page.textContent('#deloadCard'), /leichtere Woche/);
  await axeCheck('home with deload card');
  await page.click('#deloadLater');
  await page.waitForFunction(() => !document.querySelector('#deloadCard'));
  await page.click('[data-nav="more"]');
  await page.click('[data-nav="home"]');
  assert.equal(await page.locator('#deloadCard').count(), 0);
});

test('progress lists exercises and muscle groups side by side, and a tap opens the big chart', async () => {
  await seedHistory();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-nav="analytics"]');
  await page.click('[data-analytics-tab="strength"]');
  await page.waitForSelector('.trend-row');
  assert.equal(await page.locator('#analyticsExercise').count(), 0);
  assert.equal(await page.locator('.trend-row[aria-expanded="true"]').count(), 0, 'everything starts closed');
  assert.equal(await page.locator('#strengthChart').count(), 0);
  assert.match(await page.textContent('.analytics-hint:near(.trend-list)'), /geschätztes Maximalgewicht/);
  assert.ok(await page.locator('.trend-row .sparkline').count());
  assert.match(await page.textContent('.trend-row .row-value'), /kg/);
  await page.locator('.trend-row').first().click();
  await page.waitForFunction(() => document.querySelector('#strengthChart')?.width > 0);
  assert.equal(await page.locator('.trend-row[aria-expanded="true"]').count(), 1);
  await page.locator('.trend-row').first().click();
  await page.waitForFunction(() => !document.querySelector('#strengthChart'));
  await page.locator('.trend-row').first().click();
  await page.waitForFunction(() => document.querySelector('#strengthChart')?.width > 0);
  await axeCheck('progress list of exercises');
  await page.click('[data-list-mode="groups"]');
  await page.waitForSelector('[data-trend-group]');
  assert.match(await page.textContent('.trend-list'), /Brust/);
  assert.match(await page.textContent('.trend-row .row-value'), /Sätze/);
  await page.locator('[data-trend-group]').first().click();
  await page.waitForFunction(() => document.querySelector('#groupChart')?.width > 0);
  await axeCheck('progress list of muscle groups');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(wide, false);
});

test('the gate: register with an invitation, lose the phone, sign in and get everything back', async () => {
  const { createSyncServer, store } = await import('../sync-server/server.js');
  const { mkdtemp, rm, readdir, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(path.join(tmpdir(), 'volumora-sync-'));
  const syncServer = createSyncServer({ dataDir: dir, origins: [baseURL] });
  await new Promise((resolve) => syncServer.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${syncServer.address().port}`;
  const invite = await store(dir).createInvite();
  const fresh = async () => {
    await context.close();
    context = await browser.newContext({ locale: 'de-DE' });
    page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseURL + '/');
    await page.waitForSelector('#gateForm');
    await page.click('#syncOther');
    await page.fill('#syncUrl', address);
  };
  try {
    await fresh();
    assert.equal(
      await page.locator('.bottom-nav').count(),
      0,
      'nothing else is reachable without an account'
    );
    await axeCheck('gate');
    await page.fill('#syncUser', 'fouad');
    await page.fill('#syncPassword', 'ein-gutes-passwort');
    await page.fill('#syncInvite', 'xxxx-xxxx-xxxx');
    await page.click('#syncConnect');
    await page.waitForFunction(() =>
      /Einladungscode/.test(document.querySelector('#syncError')?.textContent || '')
    );
    await page.fill('#syncInvite', invite);
    await page.click('#syncConnect');
    // A new account continues with the first-run flow.
    await page.waitForSelector('#onboardingSkip');
    await page.click('#onboardingSkip');
    await page.waitForSelector('.next-card');
    await seedHistory();
    await page.evaluate(async () => {
      localStorage.setItem('volumora-ai-key', 'sk-ant-api-test-secret');
      const { saveAiMemory, saveAiChat, getHistory, saveHistory } = await import('/src/storage.js');
      saveAiMemory([{ id: 'm', fact: 'Trainiert im Studio', at: '2026-11-01' }]);
      saveAiChat([
        { role: 'user', text: 'Hallo' },
        { role: 'assistant', text: 'Hi' },
      ]);
      const history = getHistory();
      history[0].dayName = 'Geändert';
      saveHistory(history);
      await (await import('/src/sync.js')).uploadNow();
      (await import('/src/render.js')).navigate('backup');
    });
    await page.waitForSelector('.sync-on');
    assert.match(await page.textContent('.sync-on'), /fouad/);
    assert.equal(await page.locator('#syncOpen').count(), 0);
    await axeCheck('backup screen with account');
    const files = await readdir(path.join(dir, 'users', 'fouad', 'snapshots'));
    const stored = await readFile(path.join(dir, 'users', 'fouad', 'snapshots', files.at(-1)), 'utf8');
    assert.ok(!stored.includes('sk-ant-api-test-secret'), 'the Claude key never leaves the device');
    assert.ok(!stored.includes('ein-gutes-passwort'));
    assert.match(stored, /Trainiert im Studio/);
    assert.match(stored, /Geändert/);
    // A second device with an old state may not replace what is newer.
    const conflict = await page.evaluate(async () => {
      const { uploadNow } = await import('/src/sync.js');
      const old = JSON.parse(localStorage.getItem('volumora-sync'));
      return uploadNow({ ...old, hash: '', version: 'old' }).catch((err) => err.code);
    });
    assert.equal(conflict, 'newer');

    // The phone is gone: a fresh installation signs in and restores.
    await fresh();
    await page.click('[data-sync-mode="login"]');
    await page.waitForSelector('#syncInviteRow', { state: 'hidden' });
    await page.fill('#syncUser', 'fouad');
    await page.fill('#syncPassword', 'falsches-passwort');
    await page.click('#syncConnect');
    await page.waitForFunction(() =>
      /stimmt nicht/.test(document.querySelector('#syncError')?.textContent || '')
    );
    await page.fill('#syncPassword', 'ein-gutes-passwort');
    await page.click('#syncConnect');
    await page.waitForSelector('.sheet-backdrop.show [data-ok]');
    await page.click('.sheet-backdrop.show [data-ok]');
    // The restore ends with the home screen; only then is everything, chat included, in place.
    await page.waitForSelector('.next-card');
    const back = await page.evaluate(async () => {
      const { getHistory, getAiMemory, getAiChat, isOnboarded } = await import('/src/storage.js');
      return {
        day: getHistory()[0].dayName,
        memory: getAiMemory(),
        chat: getAiChat().length,
        onboarded: isOnboarded(),
        key: localStorage.getItem('volumora-ai-key'),
      };
    });
    assert.equal(back.day, 'Geändert');
    assert.equal(back.chat, 2);
    assert.ok(JSON.stringify(back.memory).includes('Trainiert im Studio'));
    assert.equal(back.onboarded, true);
    assert.equal(back.key, null);
    // Signing out ends the session on the server and shows the gate again; the data stays on the device.
    await page.evaluate(async () => (await import('/src/render.js')).navigate('backup'));
    await page.click('#syncOff');
    await page.waitForSelector('.sheet-backdrop.show [data-ok]');
    await page.click('.sheet-backdrop.show [data-ok]');
    await page.waitForSelector('#gateForm');
    const sessions = JSON.parse(
      await readFile(path.join(dir, 'users', 'fouad', 'account.json'), 'utf8')
    ).sessions;
    assert.equal(sessions.length, 1, 'only the first device stays signed in');
    assert.equal(await page.evaluate(async () => (await import('/src/storage.js')).getHistory().length), 2);
  } finally {
    syncServer.close();
    syncServer.closeAllConnections?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the admin stores the Claude key, sets budgets and invites; everyone else just chats', async () => {
  const { createSyncServer, store } = await import('../sync-server/server.js');
  const { createServer } = await import('node:http');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(path.join(tmpdir(), 'volumora-admin-'));
  // Anthropic as the server sees it: every answer costs 1 $.
  const claudeCalls = [];
  const claude = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      claudeCalls.push({ key: req.headers['x-api-key'], body });
      if (req.headers['x-api-key'] !== 'sk-ant-api-server-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { message: 'bad key' } }));
      }
      if (req.url.endsWith('/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"input_tokens":1}');
      }
      const events = [
        { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Antwort über den Server.' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50000 } },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
    });
  });
  await new Promise((resolve) => claude.listen(0, '127.0.0.1', resolve));
  const syncServer = createSyncServer({
    dataDir: dir,
    origins: [baseURL],
    anthropicUrl: `http://127.0.0.1:${claude.address().port}`,
  });
  await new Promise((resolve) => syncServer.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${syncServer.address().port}`;
  const db = store(dir);
  const signUp = async (name, invite) => {
    await context.close();
    context = await browser.newContext({ locale: 'de-DE' });
    page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseURL + '/');
    await page.waitForSelector('#gateForm');
    await page.click('#syncOther');
    await page.fill('#syncUrl', address);
    await page.fill('#syncUser', name);
    await page.fill('#syncPassword', 'ein-gutes-passwort');
    await page.fill('#syncInvite', invite);
    await page.click('#syncConnect');
    await page.waitForSelector('#onboardingSkip');
    await page.click('#onboardingSkip');
    await page.waitForSelector('.next-card');
  };
  try {
    await signUp('fouad', await db.createInvite());
    // Not an admin yet: no administration row, no assistant without a key.
    await page.click('[data-nav="more"]');
    assert.equal(await page.locator('[data-nav="admin"]').count(), 0);
    assert.equal(await page.locator('[data-nav="ai"]').count(), 0);
    await db.setAdmin('fouad', true);
    await page.evaluate(async () => (await import('/src/sync.js')).refreshMe());
    await page.click('[data-nav="home"]');
    await page.click('[data-nav="more"]');
    await page.click('[data-nav="admin"]');
    await page.waitForSelector('#adminAiForm');
    await axeCheck('administration');
    // A wrong key is refused by Claude and not kept.
    await page.fill('#adminKey', 'sk-ant-api-wrong');
    await page.click('#adminAiForm button[type="submit"]');
    await page.waitForSelector('#adminAiError:not([hidden])');
    assert.match(await page.textContent('#adminAiError'), /lehnt diesen Schlüssel ab/);
    await page.fill('#adminKey', 'sk-ant-api-server-key');
    await page.fill('#adminDefaultBudget', '3');
    await page.click('#adminAiForm button[type="submit"]');
    await page.waitForFunction(() =>
      /hinterlegt/.test(document.querySelector('#adminMount')?.textContent || '')
    );
    assert.equal(
      await page.inputValue('#adminKey'),
      '',
      'the key field empties and the key is never shown again'
    );
    // An invitation for a friend, from the app.
    await page.click('#adminInvite');
    await page.waitForSelector('#inviteCode');
    const invite = await page.textContent('#inviteCode');
    assert.match(invite, /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    await page.click('.sheet-backdrop.show [data-close]');
    await page.waitForSelector(`[data-invite="${invite}"]`);
    // The admin's own budget: 1.5 $ this month.
    await page.fill('[data-admin-user="fouad"] input', '1.5');
    await page.click('[data-admin-user="fouad"] button');
    await page.waitForFunction(() =>
      /1,50 \$ im/.test(document.querySelector('#adminMount')?.textContent || '')
    );
    // Now the assistant is there without any key on the device, and answers through the server.
    await page.click('.backrow .back');
    await page.waitForSelector('[data-nav="ai"]');
    assert.equal(await page.evaluate(() => localStorage.getItem('volumora-ai-key')), null);
    await page.click('[data-nav="ai"]');
    await page.waitForSelector('#aiInput');
    await page.fill('#aiInput', 'Hallo');
    await page.click('#aiSend');
    await page.waitForFunction(() =>
      document.querySelector('#chatScroll')?.textContent.includes('Antwort über den Server.')
    );
    assert.equal(claudeCalls.at(-1).key, 'sk-ant-api-server-key');
    await page.waitForFunction(async () => (await import('/src/sync.js')).syncConfig().ai.used >= 1);
    await page.click('#aiMenu');
    await page.waitForSelector('.sheet-backdrop.show');
    assert.match(await page.textContent('.sheet-backdrop.show'), /1,00 von 1,50 \$/);
    assert.equal(
      await page.locator('.sheet-backdrop.show .action-item.danger').count(),
      0,
      'no key to remove'
    );
    await page.keyboard.press('Escape');
    // The second answer uses the budget up, the third is refused before Claude is asked.
    await page.fill('#aiInput', 'Noch mal');
    await page.click('#aiSend');
    await page.waitForFunction(() => document.querySelectorAll('.chat-assistant').length >= 2);
    const calls = claudeCalls.length;
    await page.fill('#aiInput', 'Und noch mal');
    await page.click('#aiSend');
    await page.waitForSelector('.ai-error');
    assert.match(await page.textContent('.ai-error'), /Budget.*aufgebraucht/);
    assert.equal(claudeCalls.length, calls);
    assert.equal(await page.inputValue('#aiInput'), 'Und noch mal', 'the question goes back into the field');
    // The friend registers with the invitation and chats with the default budget; the admin screen stays closed.
    await signUp('ben', invite);
    await page.waitForSelector('[data-nav="ai"]');
    await page.click('[data-nav="more"]');
    assert.equal(await page.locator('[data-nav="admin"]').count(), 0);
    await page.evaluate(async () => (await import('/src/render.js')).navigate('admin'));
    await page.waitForSelector('[data-nav="backup"]');
    assert.equal(await page.locator('#adminMount').count(), 0, 'the address alone opens nothing');
    await page.click('[data-nav="ai"]');
    await page.fill('#aiInput', 'Hi');
    await page.click('#aiSend');
    await page.waitForFunction(() =>
      document.querySelector('#chatScroll')?.textContent.includes('Antwort über den Server.')
    );
    const ben = await db.account('ben');
    assert.equal(db.budgetOf(ben, await db.ai()), 3);
    assert.ok(db.usedThisMonth(ben) >= 1);
  } finally {
    syncServer.close();
    syncServer.closeAllConnections?.();
    claude.close();
    claude.closeAllConnections?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('review fixes: the KI tab survives a failed upload, short workouts show no calories, applied suggestions lose their button', async () => {
  await seedHistory();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const config = JSON.parse(localStorage.getItem('volumora-sync'));
    localStorage.setItem(
      'volumora-sync',
      JSON.stringify({
        ...config,
        ai: { available: true, budget: 5, used: 0, month: '2026-11' },
        problem: 'network',
      })
    );
    localStorage.setItem(
      'volumora-body-v2',
      JSON.stringify([{ id: 'b1', date: new Date().toISOString(), weight: 80 }])
    );
  });
  await page.click('[data-nav="more"]');
  assert.equal(
    await page.locator('[data-nav="ai"]').count(),
    1,
    'a network problem does not hide the assistant'
  );
  await page.evaluate(() => {
    const config = JSON.parse(localStorage.getItem('volumora-sync'));
    localStorage.setItem('volumora-sync', JSON.stringify({ ...config, problem: 'session' }));
  });
  await page.click('[data-nav="home"]');
  assert.equal(await page.locator('[data-nav="ai"]').count(), 0, 'a lost sign-in does');
  // The exercise with history: its suggestion is already in the fields, so there is nothing to take over.
  await page.evaluate(async () => {
    const { allPlans } = await import('/src/storage.js');
    const plan = allPlans().items[0];
    (await import('/src/render.js')).navigate('workout', { planId: plan.id, dayId: plan.days[0].id });
  });
  await page.waitForSelector('button.suggest-row');
  await page.click('button.suggest-row');
  await page.waitForSelector('p.suggest-row');
  assert.equal(await page.locator('button.suggest-row').count(), 0, 'taken over, so no button is left');
  await page.locator('[data-set-done][data-exercise="0"]').first().click();
  await page.click('#finishWorkout');
  await page.click('.sheet-backdrop.show [data-ok]');
  await page.waitForSelector('#sessionExtras');
  assert.match(await page.textContent('.session-calories'), /Zu kurz/);
  assert.doesNotMatch(await page.textContent('.session-calories'), /0 kcal/);
  // The picker counts what matches, not the whole catalogue.
  await page.click('#summaryDone');
  await page.waitForSelector('.next-card');
  await page.click('[data-start]');
  await page.waitForSelector('#addSessionExercise');
  await page.click('#addSessionExercise');
  await page.waitForSelector('#librarySearch');
  await page.fill('#librarySearch', 'rucken kabel');
  await page.waitForFunction(() =>
    /^\d+ Übungen$/.test(document.querySelector('#libraryCount')?.textContent || '')
  );
  const count = Number((await page.textContent('#libraryCount')).match(/\d+/)[0]);
  assert.ok(count > 0 && count < 50, `matches counted: ${count}`);
});

test('home: last workout, week dots, exercise preview; progress: tabs, last-week fallback, main-muscle sets', async () => {
  await seedHistory();
  await page.setViewportSize({ width: 390, height: 844 });
  // Home
  assert.equal(await page.locator('.week-ring').count(), 0, 'no second week count');
  assert.equal(await page.locator('.week-dots span').count(), 7);
  assert.equal(await page.locator('.week-dots .done').count(), 1);
  assert.match(await page.textContent('.week-line'), /1 von 3 Trainings/);
  assert.match(await page.textContent('[data-last-session]'), /heute/);
  assert.match(await page.textContent('.next-preview'), /·/);
  await page.click('[data-last-session]');
  await page.waitForSelector('#sessionForm');
  await page.click('.backrow .back');
  await page.waitForSelector('.next-card');
  await axeCheck('home');
  // Progress: three tabs, the overview shows this week's sets, where the pull-up counts half for the arms.
  await page.click('[data-nav="analytics"]');
  await page.waitForSelector('.analytics-tabs');
  assert.equal(await page.locator('[data-analytics-tab]').count(), 3);
  assert.equal(await page.locator('.row[data-session]').count(), 0, 'the list lives on its own tab');
  const groups = await page.$$eval('.weekly-sets .bar-row', (rows) =>
    rows.map((r) => r.querySelector('span').textContent + ' ' + r.querySelector('b').textContent)
  );
  assert.ok(
    groups.some((g) => /^Brust 2$/.test(g)),
    groups.join(', ')
  );
  assert.ok(
    !groups.some((g) => /^Arme/.test(g)),
    'sets count for the main muscle only: ' + groups.join(', ')
  );
  assert.match(await page.textContent('.chart-section'), /beim Hauptmuskel/);
  await page.click('[data-analytics-tab="strength"]');
  await page.waitForSelector('.trend-row');
  await page.click('[data-analytics-tab="sessions"]');
  await page.waitForSelector('.row[data-session]');
  await page.click('[data-nav="home"]');
  await page.click('[data-nav="analytics"]');
  assert.equal((await page.locator('.row[data-session]').count()) > 0, true, 'the tab is remembered');
  // An empty week falls back to the last one.
  await page.evaluate(() => {
    const history = JSON.parse(localStorage.getItem('volumora-history-v2'));
    const d = new Date();
    d.setDate(d.getDate() - 7);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    history[0].day = key;
    history[0].finishedAt = `${key}T10:00:00.000Z`;
    localStorage.setItem('volumora-history-v2', JSON.stringify(history));
  });
  await page.click('[data-analytics-tab="overview"]');
  await page.waitForSelector('.weekly-sets');
  assert.match(await page.textContent('.chart-section'), /letzte Woche/);
  assert.match(await page.textContent('.weekly-sets'), /Brust/);
});

test('coming back to a running workout lands on the next open set', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-start]');
  await page.waitForSelector('.workout-exercise');
  assert.equal(await page.evaluate(() => scrollY), 0, 'a fresh workout starts at the top');
  const tick = async (exercise, set) => {
    await page.fill(`[data-set-field="weight"][data-exercise="${exercise}"][data-index="${set}"]`, '50');
    await page.fill(`[data-set-field="reps"][data-exercise="${exercise}"][data-index="${set}"]`, '10');
    await page.click(`[data-set-done="${set}"][data-exercise="${exercise}"]`);
  };
  const sets = await page.locator('#exercise-2 .set-row').count();
  assert.equal(sets > 1, true);
  await tick(2, 0);
  const spot = () =>
    page.evaluate(() => {
      const header = document.querySelector('.workout-top').getBoundingClientRect().bottom;
      const top = document.querySelector('#exercise-2').getBoundingClientRect().top;
      const row = document.querySelector('#exercise-2 [data-set="1"]').getBoundingClientRect();
      const timer = document.querySelector('#restTimer.show')?.getBoundingClientRect().top ?? innerHeight;
      return {
        offset: top - header,
        rowVisible: row.top >= header && row.bottom <= timer,
        timerOnScreen: timer < innerHeight,
        y: scrollY,
      };
    });
  const check = async (label) => {
    await page.waitForFunction(() => scrollY > 0);
    const { offset, rowVisible, timerOnScreen } = await spot();
    assert.equal(timerOnScreen, true, `${label}: the running rest timer stays on the screen`);
    assert.equal(Math.abs(offset) <= 1, true, `${label}: the exercise sits under the header (${offset})`);
    assert.equal(rowVisible, true, `${label}: the open set is in view`);
  };
  await page.evaluate(() => scrollTo(0, 0));
  await page.click('#exitWorkout');
  await page.click('.resume-card [data-start]');
  await page.waitForSelector('.workout-exercise');
  await check('from home');
  // A slow phone: the page finishes loading well after the first frame.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.reload();
  await page.waitForSelector('.workout-exercise');
  await page.waitForTimeout(500);
  await check('after closing the app');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  // Ticking inside the workout leaves the page where it is.
  const before = (await spot()).y;
  await tick(2, 1);
  assert.equal(Math.abs((await spot()).y - before) <= 1, true, 'a tick does not jump');
});

test('the same exercise from the plan and the catalogue is one row with one chart', async () => {
  await page.evaluate(() => {
    const session = (id, day, libraryId, weight) => ({
      id,
      planId: 'p',
      planName: 'P',
      dayId: 'd',
      dayName: 'D',
      startedAt: `${day}T09:00:00.000Z`,
      finishedAt: `${day}T10:00:00.000Z`,
      day,
      entries: [
        {
          exerciseId: `e-${id}`,
          libraryId,
          name: 'Brustpresse',
          trackType: 'weight_reps',
          sets: [{ done: true, weight: String(weight), reps: '10', type: 'normal' }],
        },
      ],
    });
    localStorage.setItem(
      'volumora-history-v2',
      JSON.stringify([session('b', '2026-10-30', '0577', 60), session('a', '2026-10-28', 'chest-press', 55)])
    );
  });
  await page.reload();
  await page.waitForSelector('.next-card');
  await page.click('[data-nav="analytics"]');
  await page.click('[data-analytics-tab="strength"]');
  await page.waitForSelector('.trend-row');
  const names = await page.$$eval('.trend-row b:first-child', (items) => items.map((x) => x.textContent));
  assert.equal(names.filter((n) => n === 'Brustpresse').length, 1, names.join(', '));
  await page.locator('.trend-row').first().click();
  await page.waitForFunction(() => document.querySelector('#strengthChart')?.width > 0);
  const values = await page.$eval('.trend-row .row-value', (x) => x.textContent);
  assert.match(values, /80 kg/, 'the newest session counts, from the catalogue entry');
  assert.ok(await page.locator('.trend-row .sparkline :is(polyline, path)').count(), 'two points, so a line');
});

test('with push on, a rest asks the server for an alarm at its end and a skipped rest takes it back', async () => {
  const alarms = [];
  await page.route('http://127.0.0.1:9/v1/push/alarms', async (route) => {
    alarms.push(JSON.parse(route.request().postData()));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  // Headless Chromium refuses notifications whatever it is granted; the phone's answer is what counts here.
  await context.addInitScript(() =>
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' })
  );
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('volumora-settings-v2')) || {};
    localStorage.setItem(
      'volumora-settings-v2',
      JSON.stringify({ ...s, restTimer: true, restNotify: true, rest: 90 })
    );
    localStorage.setItem('volumora-push', JSON.stringify({ user: 'test', at: new Date().toISOString() }));
  });
  await page.reload();
  await page.click('[data-start="push"]');
  await page.waitForSelector('.workout-exercise');
  const first = page.locator('.workout-exercise').nth(0);
  await first.locator('input[data-set-field="weight"][data-index="0"]').fill('40');
  await first.locator('input[data-set-field="reps"][data-index="0"]').fill('8');
  const ticked = Date.now();
  await first.locator('[data-set-done="0"]').click();
  await page.waitForSelector('#restTimer.show');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const set = alarms.at(-1);
  assert.equal(set.app, 'volumora');
  assert.equal(set.set[0].id, 'rest');
  assert.equal(set.set[0].title, 'Pause vorbei');
  assert.equal(set.set[0].ttl, 120);
  const due = set.set[0].at - ticked;
  assert.ok(due > 85000 && due < 95000, `alarm in about 90 s, not ${due} ms`);
  const before = alarms.length;
  await page.click('[data-rest-skip]');
  await page.waitForFunction(() => !document.querySelector('#restTimer.show'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(alarms.length, before + 1);
  assert.deepEqual(alarms.at(-1), { app: 'volumora', cancel: ['rest'] });
});
