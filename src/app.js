// Entry point: storage migrations, language, theme, router, service worker and the first render.
import { setLanguage, t } from './i18n.js';
import { nextSession } from './plans.js';
import { applyRoute, navigate, redrawCharts, render, scrollToStart } from './render.js';
import { initRouter } from './router.js';
import { state } from './state.js';
import {
  activePlan,
  getHistory,
  getRestUntil,
  getSettings,
  migratePhotos,
  needsOnboarding,
  runMigrations,
} from './storage.js';
import { applyTheme } from './theme.js';
import { toast } from './ui.js';
import { initGestures } from './gestures.js';
import { watchInset } from './viewport.js';
import { updateRest } from './views/workout.js';
import { reconcileActive, sessionStarted } from './workout.js';
import { enablePush, pushOn } from './push.js';
import { isSignedIn, startSync } from './sync.js';

// The language comes first: migrations may seed the default plan in it.
setLanguage(getSettings().language);
runMigrations();
// Ask the browser not to clear the data under storage pressure. It decides by itself and never asks the person.
navigator.storage?.persist?.().catch(() => {});
startSync();
// Notifications that were switched on before they came from the server move over on their own.
if (getSettings().restNotify && !pushOn()) enablePush();
applyTheme();
state.restUntil = getRestUntil();
const firstRun = needsOnboarding();
if (!isSignedIn()) state.view = 'gate';
else if (firstRun) state.view = 'onboarding';
initRouter(applyRoute);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
  render();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (getSettings().theme === 'auto') applyTheme();
});
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(redrawCharts, 150);
});

if ('serviceWorker' in navigator) {
  let hadController = !!navigator.serviceWorker.controller;
  // A new worker took over: the next load runs the new code. Offer the reload instead of forcing it, so nothing
  // interrupts a workout. Not on the very first install, where there is nothing to update yet.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    toast(t('update.ready'), {
      action: { label: t('update.reload'), onClick: () => location.reload() },
      duration: 15000,
    });
  });
  window.addEventListener('load', () =>
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => reg.update())
      .catch(() => {})
  );
}

// A GIF that cannot be loaded (offline before first use, dead link) keeps its dark box instead of a broken-image icon.
document.addEventListener(
  'error',
  (e) => {
    if (e.target?.classList?.contains('exercise-gif')) e.target.classList.add('missing');
  },
  true
);

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
window.addEventListener('pageshow', scrollToStart);

render();
setInterval(updateRest, 1000);
watchInset();
initGestures();
// Homescreen shortcut: jump straight into the next session.
if (!firstRun && new URLSearchParams(location.search).get('action') === 'start') {
  history.replaceState(history.state, '', location.pathname);
  const plan = activePlan();
  const running = reconcileActive();
  const { day } = nextSession(plan, getHistory());
  if (running && sessionStarted(running))
    navigate('workout', { planId: running.planId, dayId: running.dayId });
  else if (day?.exercises.length) navigate('workout', { planId: plan.id, dayId: day.id });
} else if (!firstRun) {
  // The app was closed mid-workout: back to it, as long as it was in use during the last twelve hours.
  const running = reconcileActive();
  const lastUse = new Date(running?.lastActivityAt || 0).getTime();
  if (running && sessionStarted(running) && Date.now() - lastUse < 12 * 3600000) {
    navigate('workout', { planId: running.planId, dayId: running.dayId });
    document.querySelector('main')?.classList.remove('view-enter', 'view-modal');
  }
}
migratePhotos().then((migrated) => {
  if (migrated && state.view === 'body') render();
});
