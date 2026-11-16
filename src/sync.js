// Optional automatic copy of everything on a server of someone the person trusts (sync-server/). Off unless they sign
// in to one. The Claude key never leaves this device. Each upload names the version it builds on, so a device with old
// data can not silently replace newer data, and the server keeps older versions. What the server holds that this
// device has not seen is merged in, not chosen against. The data on a device belongs to one account.
import { backupData, importBackup, mergeBackup, validateBackup } from './backup.js';
import { setLanguage } from './i18n.js';
import {
  LS,
  allPlans,
  clearOwnStorage,
  getActive,
  getAiChat,
  getAiMemory,
  getPrefs,
  getSettings,
  hasPersonalData,
  markOnboarded,
  onDataChange,
  photos,
  read,
  saveActive,
  saveAiChat,
  saveAiMemory,
} from './storage.js';
import { applyTheme } from './theme.js';

const KEY = 'volumora-sync';
// Whose data stays on this device once nobody is signed in: the account that signed out, and how far its data had
// been uploaded. While someone is signed in, the sign-in itself says whose the data is.
const LEFT = 'volumora-owner';
// Where everyone's data goes unless they name another server: the one the person behind Volumora runs.
export const DEFAULT_SYNC_URL = 'https://raspberrypi.tail9d7f95.ts.net';
const DELAY = 20000;
// A return to the app asks the server for news at most this often.
const LOOK_EVERY = 3 * 60000;
// Signing out uploads what is still waiting, but does not wait for a silent server longer than this.
const SIGN_OUT_WAIT = 10000;
const WATCHED = new Set([
  LS.plans,
  LS.history,
  LS.body,
  LS.settings,
  LS.exercisePrefs,
  LS.customExercises,
  LS.aiChat,
  LS.aiMemory,
]);

export class SyncError extends Error {
  constructor(code, latest = '') {
    super(code);
    this.code = code;
    this.latest = latest;
  }
}

export const syncConfig = () => read(KEY, null);
export const isSignedIn = () => !!syncConfig()?.token;
const saveConfig = (config) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
    // A full storage shows up elsewhere; the next upload tries again.
  }
};
export const disconnectSync = () => localStorage.removeItem(KEY);
const update = (changes) => {
  const config = syncConfig();
  if (config) saveConfig({ ...config, ...changes });
};
// The account the data on this device belongs to: the one signed in, even with a sign-in the server no longer
// knows, or else the one that signed out last. Null on a new device, and on one that was signed out before owners
// were remembered.
export const dataOwner = () =>
  [syncConfig(), read(LEFT, null)].find((owner) => owner?.username && owner.url) || null;
const sameAccount = (a, b) => a.username === b.username && a.url === b.url;

export function cleanSyncUrl(text) {
  const raw = String(text).trim().replace(/\/+$/, '');
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    return url.protocol === 'https:' || local ? url.href.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

const ERRORS = { 401: 'session', 403: 'invite', 429: 'blocked', 413: 'size' };
export async function call(config, path, options = {}) {
  let response;
  try {
    response = await fetch(`${config.url}${path}`, {
      ...options,
      headers: {
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new SyncError('network');
  }
  if (response.status === 412) throw new SyncError('newer', (await response.json().catch(() => ({}))).latest);
  if (response.ok || response.status === 404) return response;
  const detail = (await response.json().catch(() => ({}))).error;
  if (response.status === 400 || response.status === 401 || response.status === 403)
    throw new SyncError(
      ['user', 'invite', 'taken', 'username', 'password', 'session'].includes(detail)
        ? detail
        : ERRORS[response.status] || 'server'
    );
  throw new SyncError(ERRORS[response.status] || 'server');
}

// Both give a signed-in config for the account; nothing is stored until the first exchange of data worked.
// A server that answers something else than a token, for instance a 404 page behind a wrong address, is no sign-in.
const tokenOf = async (response) => {
  const token = (await response.json().catch(() => ({}))).token;
  if (typeof token !== 'string' || !token.includes('.')) throw new SyncError('server');
  return token;
};
export async function signIn(url, username, password) {
  const response = await call({ url }, '/v1/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  return { url, username: username.trim().toLowerCase(), token: await tokenOf(response) };
}
export async function register(url, username, password, invite) {
  const response = await call({ url }, '/v1/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, invite }),
  });
  return { url, username: username.trim().toLowerCase(), token: await tokenOf(response) };
}
// Who the server says we are: admin or not, and whether and how much Claude it offers this month.
export async function refreshMe(config = syncConfig()) {
  if (!config?.token) return null;
  const response = await call(config, '/v1/me');
  const me = await response.json();
  if (syncConfig()?.token === config.token) update({ admin: !!me.admin, ai: me.ai || null });
  return me;
}
export const isAdmin = () => !!syncConfig()?.admin;
// Admin calls answer with a plain word on refusal; it becomes the error code.
export async function adminCall(path, options = {}) {
  const config = syncConfig();
  let response;
  try {
    response = await fetch(`${config.url}/v1/admin${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new SyncError('network');
  }
  if (response.ok) return response.json();
  const detail = await response.json().catch(() => ({}));
  throw new SyncError(
    typeof detail.error === 'string' ? detail.error.replace(' ', '') : ERRORS[response.status] || 'server'
  );
}
// The token a sign-out revoked: an upload that was still running must not bring it back.
let revoked = '';
// Stores the outcome of an exchange with the server. A sign-in that is not stored yet is stored with it, unless it
// was signed out in the meantime.
const settle = (config, changes) => {
  if (syncConfig()) update(changes);
  else if (config.token !== revoked) saveConfig({ ...config, ...changes });
};
const atMost = (ms, job) => {
  let clock;
  const limit = new Promise((resolve) => {
    clock = setTimeout(resolve, ms);
  });
  return Promise.race([job, limit]).finally(() => clearTimeout(clock));
};
// The data stays on this device and stays this account's: what was still waiting is uploaded first, and the device
// remembers whose data it holds, so the next sign-in can tell its own from someone else's.
export async function signOut() {
  clearTimeout(timer);
  timer = null;
  if (isSignedIn() && syncConfig().problem !== 'session')
    await atMost(
      SIGN_OUT_WAIT,
      syncNow().catch(() => {})
    );
  const config = syncConfig();
  revoked = config?.token || '';
  if (config?.username) {
    const { url, username, version, hash, marks, at } = config;
    try {
      localStorage.setItem(LEFT, JSON.stringify({ url, username, version, hash, marks, at }));
    } catch {
      // Without the note the next sign-in asks whose data this is.
    }
  }
  disconnectSync();
  if (config?.token) await call(config, '/v1/logout', { method: 'POST' }).catch(() => {});
}

const snapshot = async () => ({
  app: 'Volumora',
  savedAt: new Date().toISOString(),
  backup: await backupData(),
  aiChat: getAiChat(),
  aiMemory: getAiMemory(),
});

const digest = async (text) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
};
// What counts as a change: the data, not the moment it was packed.
const contentOf = ({ savedAt, backup: { exportedAt, ...backup }, ...rest }) =>
  JSON.stringify({ backup, ...rest });
// The parts of a snapshot that are one piece each: a merge takes such a piece from one side as a whole. A mark per
// piece, kept from the last exchange with the server, tells later whether this device changed it since.
const PIECES = {
  plans: (data) => data.backup.plans,
  settings: (data) => data.backup.settings,
  exercisePrefs: (data) => data.backup.exercisePrefs,
  aiChat: (data) => data.aiChat,
  aiMemory: (data) => data.aiMemory,
};
const marksOf = async (data) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(PIECES).map(async ([name, piece]) => [name, await digest(JSON.stringify(piece(data)))])
    )
  );
// The pieces as they are stored at this very moment, read in one go: no change can slip in between them.
const piecesNow = () => ({
  backup: { plans: allPlans(), settings: getSettings(), exercisePrefs: getPrefs() },
  aiChat: getAiChat(),
  aiMemory: getAiMemory(),
});

// What the server holds: { version, data } or null when it holds nothing yet.
export async function fetchSnapshot(config = syncConfig()) {
  const response = await call(config, '/v1/snapshot');
  if (response.status === 404) return null;
  try {
    return { version: (response.headers.get('etag') || '').replaceAll('"', ''), data: await response.json() };
  } catch {
    throw new SyncError('server');
  }
}
// The newest version the server holds, without its data: enough to know whether there is anything to fetch. Empty
// when it holds nothing, null when the server does not know the question.
async function latestVersion(config) {
  const response = await call(config, '/v1/snapshots');
  if (response.status === 404) return null;
  const list = (await response.json().catch(() => ({}))).snapshots;
  return (Array.isArray(list) && list[0]?.version) || '';
}

let uploading = null;
let timer = null;
export async function uploadNow(config = syncConfig(), { force = false } = {}) {
  if (!config) return false;
  if (uploading) await uploading.catch(() => {});
  uploading = (async () => {
    const data = await snapshot();
    const hash = await digest(contentOf(data));
    if (!force && hash === config.hash && config.version) {
      // A sign-in from before the pieces had marks: nothing changed since its last upload, so they are as uploaded.
      if (!config.marks && syncConfig()?.token === config.token) update({ marks: await marksOf(data) });
      return false;
    }
    const response = await call(config, '/v1/snapshot', {
      method: 'PUT',
      headers: config.version ? { 'if-match': `"${config.version}"` } : {},
      body: JSON.stringify(data),
    });
    const { version } = await response.json();
    const at = new Date().toISOString();
    settle(config, { version, hash, marks: await marksOf(data), at, problem: '', latest: '' });
    return true;
  })();
  try {
    return await uploading;
  } finally {
    uploading = null;
  }
}

// Exchanges with the server run one after the other, each seeing what the one before left behind.
let round = Promise.resolve();
const inTurn = (job) => (round = round.catch(() => {}).then(job));

// Replaces what is on this device with what the server holds. The key and the running workout stay as they are.
// No upload runs meanwhile: one in flight is awaited first, and the writes of the restore start none.
let restoring = false;
export const restoreSnapshot = (config, found) => inTurn(() => replaceDevice(config, found));
async function replaceDevice(config, { version, data }) {
  const backup = validateBackup(data?.backup);
  if (uploading) await uploading.catch(() => {});
  restoring = true;
  clearTimeout(timer);
  timer = null;
  try {
    const running = getActive();
    await importBackup(backup);
    if (running) saveActive(running);
    if (Array.isArray(data.aiChat)) saveAiChat(data.aiChat);
    if (data.aiMemory) saveAiMemory(data.aiMemory);
    markOnboarded();
    setLanguage(getSettings().language);
    applyTheme();
    const now = await snapshot();
    const hash = await digest(contentOf(now));
    const at = new Date().toISOString();
    saveConfig({ ...config, version, hash, marks: await marksOf(now), at, problem: '', latest: '' });
  } finally {
    restoring = false;
  }
}

// Brings a newer state from the server together with what is on this device, so that neither side loses anything.
// Workouts, body entries and own exercises are kept from both. Plans, settings, exercise preferences, the chat and
// what the assistant remembers are taken from the server, except those this device changed since its last exchange:
// they stay and go up with the next upload. A running workout always stays. Like a restore, it starts no upload
// of its own.
// The person may be using the app while this runs. `changes` counts what they store, so the merge can tell that the
// data moved while it was being read, and then decides again or leaves the pieces alone.
let changes = 0;
let applying = false;
async function mergeSnapshot(config, { version, data }) {
  let theirs = null;
  try {
    theirs = validateBackup(data?.backup);
  } catch {
    // What the server holds is no backup this app can read: there is nothing to bring in, and this device's
    // state goes up as the next version.
  }
  if (uploading) await uploading.catch(() => {});
  restoring = true;
  clearTimeout(timer);
  timer = null;
  let moved = false;
  try {
    let hash, marks;
    let steady = false;
    for (let tries = 0; tries < 3 && !steady; tries++) {
      const start = changes;
      const mine = await snapshot();
      hash = await digest(contentOf(mine));
      marks = await marksOf(mine);
      steady = changes === start;
    }
    // Something to add from here: a change since the last exchange, or data that would not hold still.
    const pending = !theirs || !steady || hash !== config.hash;
    // A sign-in from before the pieces had marks cannot tell which one changed: then all of them count as changed.
    const keep = Object.fromEntries(
      Object.keys(PIECES).map((name) => [name, !steady || (pending && config.marks?.[name] !== marks[name])])
    );
    // Stored in one go, right after the decision: nothing the person does can come in between.
    applying = true;
    let photosStored;
    try {
      if (theirs) photosStored = mergeBackup(theirs, keep);
      if (theirs && !keep.aiChat && Array.isArray(data.aiChat)) saveAiChat(data.aiChat);
      if (theirs && !keep.aiMemory && Array.isArray(data.aiMemory)) saveAiMemory(data.aiMemory);
    } finally {
      applying = false;
    }
    const taken = marksOf(piecesNow());
    const applied = changes;
    await photosStored;
    if (theirs && !keep.settings) {
      setLanguage(getSettings().language);
      applyTheme();
    }
    const now = await digest(contentOf(await snapshot()));
    moved = changes !== applied;
    const takenMarks = await taken;
    settle(config, {
      version,
      // Without anything of its own to add, this device now holds what the server holds and has nothing to upload.
      ...(pending || moved ? { hash: '' } : { hash: now, at: new Date().toISOString() }),
      // A piece that stayed keeps its old mark, so it still counts as changed until it has been uploaded.
      marks: Object.fromEntries(
        Object.keys(PIECES).map((name) => [name, keep[name] ? config.marks?.[name] || '' : takenMarks[name]])
      ),
      problem: '',
      latest: '',
    });
  } finally {
    restoring = false;
  }
  // What the person stored meanwhile started no upload of its own while the merge was running.
  if (moved && syncConfig()) soon();
}

// One exchange with the server. With `look` it first asks whether the server holds a version this device has not
// seen, and merges it in. Then what changed here is uploaded. An upload the server refuses because another device
// was faster is answered the same way: merge, then upload again. Nobody has to choose which side to lose.
async function exchange(config, { look = false, force = false } = {}) {
  const done = { merged: false, uploaded: false };
  if (!config || restoring) return done;
  const bringIn = async () => {
    const found = await fetchSnapshot(config);
    if (found) await mergeSnapshot(config, found);
    done.merged ||= !!found;
    config = syncConfig() || config;
  };
  if (look) {
    const latest = await latestVersion(config);
    // A server that holds nothing gets what is here, whatever this device believes it uploaded before.
    if (latest === '') force = true;
    else if (latest && latest !== config.version) await bringIn();
  }
  for (let attempt = 1; ; attempt++) {
    try {
      done.uploaded = await uploadNow(config, { force });
      return done;
    } catch (err) {
      if (err.code !== 'newer' || attempt === 3) throw err;
      await bringIn();
    }
  }
}
// The exchange the app runs by itself and behind "save now": { merged, uploaded } say what it did.
export const syncNow = (options) => inTurn(() => exchange(syncConfig(), options));

// What a sign-in as `account` ({ url, username }) meets on this device: nothing ('none'), this account's own data
// ('own'), another account's ('other'), or data whose account was never noted ('unknown': an installation that was
// signed out before owners were remembered). For another account's data it also says whether all of it had been
// uploaded there, or since when part of it exists only here.
export async function deviceData(account) {
  const owner = dataOwner();
  if (!owner) return { whose: hasPersonalData() ? 'unknown' : 'none' };
  if (sameAccount(owner, account)) return { whose: 'own' };
  const saved = !!owner.hash && owner.hash === (await digest(contentOf(await snapshot())));
  return { whose: 'other', username: owner.username, url: owner.url, saved, at: owner.at || '' };
}
// Takes an account's data off this device: storage, photos, its Claude key and its sign-in.
async function clearDevice() {
  clearTimeout(timer);
  timer = null;
  clearOwnStorage();
  await photos.clear().catch(() => {});
}
// The same account comes back to its own data, after a sign-out or with a sign-in the server no longer knew. It
// goes on from its last exchange, so what was made since then is merged with the account instead of replaced.
async function rejoin(config) {
  const { version, hash, marks, at } = dataOwner() || {};
  // The data is here already, so the sign-in counts at once. An exchange that fails now is tried again like any
  // other, and nothing is lost in the meantime.
  saveConfig({ ...syncConfig(), ...config, version, hash, marks, at, problem: '', latest: '' });
  localStorage.removeItem(LEFT);
  await inTurn(() => exchange(syncConfig(), { look: true })).catch((err) =>
    update({ problem: err.code || 'server', latest: err.latest || '' })
  );
  return 'merged';
}
// Signs this device in to an account: afterwards the device and the account hold the same data, and the data here
// is this account's. Data of another account is never uploaded: `replace` says the person agreed to have it removed
// from this device first, and without that the sign-in stops. Data nobody is noted for needs the person's word too,
// `replace` or `adopt` (it is theirs and joins the account). Returns 'restored', 'uploaded' or 'merged'.
export async function joinAccount(config, { replace = false, adopt = false } = {}) {
  const { whose } = await deviceData(config);
  const foreign = whose === 'other' || whose === 'unknown';
  if (foreign && !replace && !(adopt && whose === 'unknown')) throw new SyncError('other');
  if (whose === 'own' || (foreign && !replace)) return rejoin(config);
  // Read before anything is removed: a sign-in that cannot get at the account's data changes nothing here.
  const found = await fetchSnapshot(config);
  if (found) validateBackup(found.data?.backup);
  if (foreign) await clearDevice();
  if (found) await restoreSnapshot(config, found);
  else await inTurn(() => uploadNow(config, { force: true }));
  return found ? 'restored' : 'uploaded';
}

// Set when it is time to ask the server for news: at the start, and on a return to the app after a while.
let lookDue = false;
let looked = 0;
let news = () => {};
const quietly = async () => {
  timer = null;
  const config = syncConfig();
  // Without a valid sign-in every call fails; trying on would only count as a failed attempt at the server.
  if (!config || config.problem === 'session') return;
  const look = lookDue;
  lookDue = false;
  if (look) looked = Date.now();
  let merged = false;
  try {
    ({ merged } = await syncNow({ look }));
    if (syncConfig()?.problem) update({ problem: '', latest: '' });
  } catch (err) {
    // A question that got no answer is asked again with the next exchange.
    lookDue ||= look;
    update({ problem: err.code || 'server', latest: err.latest || '' });
  }
  if (merged) news();
};
const soon = (delay = DELAY) => {
  if (restoring) return;
  clearTimeout(timer);
  timer = setTimeout(quietly, delay);
};

// Runs for the life of the app: uploads shortly after a change, when the connection returns and when the app goes to
// the background. At the start and on a return to the app it asks the server for what another device saved and
// merges it in; `onNews` is called when something arrived.
export function startSync({ onNews = () => {} } = {}) {
  news = onNews;
  onDataChange((key) => {
    if (!WATCHED.has(key) || applying) return;
    changes++;
    if (syncConfig()) soon();
  });
  addEventListener('online', () => syncConfig() && soon(1000));
  document.addEventListener('visibilitychange', () => {
    if (!syncConfig()) return;
    const hidden = document.visibilityState === 'hidden';
    if (!hidden && Date.now() - looked >= LOOK_EVERY) lookDue = true;
    // Going to the background uploads what is waiting; coming back asks for news when it is time to.
    if (hidden ? !timer : !lookDue) return;
    clearTimeout(timer);
    quietly();
  });
  if (syncConfig()) {
    lookDue = true;
    soon(3000);
    refreshMe().catch(() => {});
  }
}
