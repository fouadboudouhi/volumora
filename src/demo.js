// The demo: the real app without an account. Everything stays in this tab, nothing reaches the server, and the
// assistant answers with a prepared text, so a visitor can look around without an invitation and without costs.
import { DEFAULT_SYNC_URL } from './sync.js';

// The tab's own storage stands in for the device storage, and photos get databases of their own: the demo never
// mixes with a real Volumora or Prepora on this domain, and closing the tab forgets it.
Object.defineProperty(window, 'localStorage', { value: window.sessionStorage, configurable: true });
const realIdb = window.indexedDB;
if (realIdb)
  Object.defineProperty(window, 'indexedDB', {
    value: {
      open: (name, version) => realIdb.open(`demo-${name}`, version),
      deleteDatabase: (name) => realIdb.deleteDatabase(`demo-${name}`),
      cmp: (a, b) => realIdb.cmp(a, b),
    },
    configurable: true,
  });

const SEEDED = 'volumora-demo-seeded';
if (!localStorage.getItem('volumora-sync')) {
  localStorage.setItem(
    'volumora-sync',
    JSON.stringify({ url: DEFAULT_SYNC_URL, username: 'demo', token: 'demo.local', ai: { available: true } })
  );
  localStorage.setItem('volumora-onboarded', '1');
}

const DEMO_TEXT =
  'Das ist die Demo: Hier antworte ich mit einem vorbereiteten Text. In der App schaue ich in deinen Verlauf, ' +
  'baue und ändere Pläne, passe das laufende Training an und erkläre, wo du stagnierst.';
const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}`).join('\n') + '\n';
const textStream = (text) =>
  sse([
    { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
    { type: 'message_stop' },
  ]);
const json = (status, value, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

async function answer(path, method) {
  if (path === '/v1/login' || path === '/v1/register') return json(200, { token: 'demo.local' });
  if (path === '/v1/logout') return json(200, { ok: true });
  if (path === '/v1/me') return json(200, { username: 'demo', admin: false, ai: { available: true } });
  if (path === '/v1/snapshot' && method === 'PUT') return json(200, { version: 'demo' }, { etag: '"demo"' });
  if (path.startsWith('/v1/ai/')) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return new Response(textStream(DEMO_TEXT), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  // No stored copy and no push in the demo.
  return json(404, { error: 'demo' });
}

// Every call to the server is answered here; none ever leaves the browser.
const realFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith(DEFAULT_SYNC_URL)) return realFetch(input, init);
  return answer(new URL(url).pathname, init.method ?? 'GET');
};

await import('./app.js');

// The first visit gets ten weeks of training, built from the app's own default plan, then starts again with them.
if (!localStorage.getItem(SEEDED)) {
  const { allPlans, saveHistory, saveBody } = await import('./storage.js');
  const { annotateAll } = await import('./records.js');
  const { trackTypeOf, newSetFor } = await import('./sets.js');
  const { dayKey, doneSets, volumeOf, uid } = await import('./util.js');
  const plan = allPlans().items[0];
  const BASE = [40, 32.5, 22.5, 10, 7.5, 5];
  const at = (daysAgo, hour) => {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    date.setHours(hour, 0, 0, 0);
    return date;
  };
  const sessions = [];
  // Three trainings a week for ten weeks: Monday, Wednesday, Friday, the plan's days in turn.
  for (let week = 9, turn = 0; week >= 0; week -= 1)
    for (const weekday of [0, 2, 4]) {
      const daysAgo = week * 7 + (4 - weekday) + 2;
      const day = plan.days[turn % plan.days.length];
      turn += 1;
      const progress = Math.floor((9 - week) / 2);
      const start = at(daysAgo, 18);
      const entries = day.exercises.map((ex, index) => {
        const trackType = trackTypeOf(ex);
        const weight = (BASE[index] ?? 5) + progress * (index < 2 ? 2.5 : 1.25);
        const reps = 8 + ((9 - week) % 2) * 2;
        const count = Number(ex.sets) || 3;
        return {
          exerciseId: ex.id,
          libraryId: ex.libraryId || undefined,
          name: ex.name,
          trackType,
          note: '',
          sets: Array.from({ length: count }, (_, i) =>
            newSetFor(trackType, {
              done: true,
              rpe: '',
              ...(trackType.includes('weight') ? { weight: String(weight) } : {}),
              ...(trackType.includes('reps') ? { reps: String(Math.max(6, reps - i)) } : {}),
              ...(trackType.includes('time') ? { time: String(40 + progress * 5) } : {}),
            })
          ),
        };
      });
      const session = {
        id: uid(),
        planId: plan.id,
        planName: plan.name,
        dayId: day.id,
        dayName: day.name,
        startedAt: start.toISOString(),
        finishedAt: new Date(start.getTime() + 62 * 60000).toISOString(),
        day: dayKey(start),
        duration: 62 * 60,
        markers: { deload: false, ill: false, pain: false },
        entries,
      };
      session.totalSets = doneSets(session);
      session.volume = volumeOf(session);
      sessions.unshift(session);
    }
  annotateAll(sessions);
  saveHistory(sessions);
  // A slow, honest weight curve: about a kilo less over ten weeks.
  saveBody(
    Array.from({ length: 10 }, (_, week) => {
      const date = at((9 - week) * 7 + 1, 8);
      return {
        id: uid(),
        date: date.toISOString(),
        day: dayKey(date),
        weight: Math.round((82.4 - week * 0.12 + (week % 3) * 0.15) * 10) / 10,
        waist: '',
        chest: '',
        arm: '',
        thigh: '',
        hasPhoto: false,
      };
    }).reverse()
  );
  localStorage.setItem(SEEDED, '1');
  location.reload();
}
