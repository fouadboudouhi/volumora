const VERSION = 'v74';
const CACHE = `volumora-${VERSION}`;
// Cross-origin exercise GIFs get their own bounded cache so the app shell cache stays small and predictable.
// Its name stays the same across versions: an update must not throw the downloaded animations away.
const MEDIA_CACHE = 'volumora-media-v1';
const MEDIA_LIMIT = 120;
// Only exercise animations are kept offline. Anything else from another origin, such as the person's own server,
// must always be fresh.
const MEDIA_HOSTS = /(^|\.)(githubusercontent\.com|exercisedb\.dev)$/;
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './assets/data/exercises.js',
  './assets/data/steps.de.js',
  './assets/data/steps.en.js',
  './assets/fonts/satoshi-500.woff2',
  './assets/fonts/satoshi-700.woff2',
  './src/ai.js',
  './src/aiPrompts.js',
  './src/aiTools.js',
  './src/app.js',
  './src/audio.js',
  './src/backup.js',
  './src/calories.js',
  './src/aiAccess.js',
  './src/charts.js',
  './src/sync.js',
  './src/views/admin.js',
  './src/views/sync.js',
  './src/chatCharts.js',
  './src/deload.js',
  './src/gestures.js',
  './src/i18n.js',
  './src/importers.js',
  './src/icons.js',
  './src/library.js',
  './src/locales/de.js',
  './src/locales/en.js',
  './src/locales/index.js',
  './src/plans.js',
  './src/plates.js',
  './src/records.js',
  './src/render.js',
  './src/router.js',
  './src/sets.js',
  './src/speech.js',
  './src/share.js',
  './src/stats.js',
  './src/templates.js',
  './src/state.js',
  './src/storage.js',
  './src/theme.js',
  './src/ui.js',
  './src/units.js',
  './src/util.js',
  './src/viewport.js',
  './src/workout.js',
  './src/views/effort.js',
  './src/views/ai.js',
  './src/views/analytics.js',
  './src/views/assistant.js',
  './src/views/body.js',
  './src/views/calendar.js',
  './src/views/customExercises.js',
  './src/views/customForm.js',
  './src/views/dictate.js',
  './src/views/editor.js',
  './src/views/exercise.js',
  './src/views/home.js',
  './src/views/legal.js',
  './src/views/more.js',
  './src/views/gate.js',
  './src/views/onboarding.js',
  './src/views/picker.js',
  './src/views/plans.js',
  './src/views/records.js',
  './src/views/session.js',
  './src/views/setRow.js',
  './src/views/shell.js',
  './src/views/summary.js',
  './src/views/templates.js',
  './src/views/workout.js',
  './assets/brand/volumora-mark.png',
  './assets/icons/favicon-32.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (e) =>
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  )
);
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE && k !== MEDIA_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  )
);

const store = (e, cacheName, request, response) =>
  e.waitUntil(caches.open(cacheName).then((c) => c.put(request, response)));
async function trimMedia() {
  const c = await caches.open(MEDIA_CACHE),
    keys = await c.keys();
  if (keys.length <= MEDIA_LIMIT) return;
  await Promise.all(keys.slice(0, keys.length - MEDIA_LIMIT).map((k) => c.delete(k)));
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;
  if (e.request.mode === 'navigate') {
    // Only a successful document may replace the offline start page; a 404 or error page must never be cached as index.html.
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) store(e, CACHE, './index.html', res.clone());
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  if (!sameOrigin && !MEDIA_HOSTS.test(new URL(e.request.url).hostname)) return;
  if (sameOrigin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) store(e, CACHE, e.request, res.clone());
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(
      (cached) =>
        cached ||
        fetch(e.request).then((res) => {
          if (res.ok || res.type === 'opaque') {
            // Cloned right here: once the page starts reading the response, it can no longer be cloned.
            const copy = res.clone();
            e.waitUntil(
              caches
                .open(MEDIA_CACHE)
                .then((c) => c.put(e.request, copy))
                .then(trimMedia)
            );
          }
          return res;
        })
    )
  );
});
