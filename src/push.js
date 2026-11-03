// The end of a rest as a push message from the sync server. An iPhone stops a web app that is not on screen, so only a
// message from outside reaches a locked phone; it rings and vibrates like any other notification. Without an account
// or permission the in-app signal and the timer in views/workout.js stay the only ones.
import { t } from './i18n.js';
import { read } from './storage.js';
import { call, isSignedIn, syncConfig } from './sync.js';

const KEY = 'volumora-push';
const APP = 'volumora';
const REST = 'rest';
// A rest signal that arrives minutes late, after a dead spot in the gym, only confuses.
const REST_TTL = 120;

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// Bound to the account it was set up for: another sign-in on this device needs its own subscription.
export const pushOn = () =>
  pushSupported() &&
  Notification.permission === 'granted' &&
  isSignedIn() &&
  read(KEY, null)?.user === syncConfig()?.username;

const bytes = (text) => {
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const sameKey = (a, b) =>
  !!a && a.byteLength === b.byteLength && new Uint8Array(a).every((x, i) => x === b[i]);

// Needs the permission first (asked in Settings). No support or no answer is fine, the app works without.
export async function enablePush() {
  if (!pushSupported() || Notification.permission !== 'granted' || !isSignedIn()) return false;
  try {
    const config = syncConfig();
    const key = bytes((await (await call(config, '/v1/push/key')).json()).key);
    const worker = await navigator.serviceWorker.ready;
    let subscription = await worker.pushManager.getSubscription();
    // One made for another server would never receive anything from this one.
    if (subscription && !sameKey(subscription.options?.applicationServerKey, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ||= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await call(config, '/v1/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: subscription.toJSON(), app: APP }),
    });
    localStorage.setItem(KEY, JSON.stringify({ user: config.username, at: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function disablePush() {
  scheduleRest(0);
  localStorage.removeItem(KEY);
}

// One alarm per app: the next rest replaces it, 0 takes it back. Returns false when push is not set up.
export function scheduleRest(until) {
  if (!pushOn()) return false;
  const body =
    until > Date.now()
      ? {
          app: APP,
          set: [
            { id: REST, at: until, title: t('rest.notifyTitle'), body: t('rest.notifyBody'), ttl: REST_TTL },
          ],
        }
      : { app: APP, cancel: [REST] };
  call(syncConfig(), '/v1/push/alarms', { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
  return true;
}
