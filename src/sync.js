// Optional automatic copy of everything on a server of someone the person trusts (sync-server/). Off unless they sign
// in to one. The Claude key never leaves this device. Each upload names the version it builds on, so a device with old
// data can not silently replace newer data, and the server keeps older versions.
import { backupData, importBackup, validateBackup } from './backup.js';
import { setLanguage } from './i18n.js';
import {
  LS,
  getActive,
  getAiChat,
  getAiMemory,
  getSettings,
  markOnboarded,
  onDataChange,
  read,
  saveActive,
  saveAiChat,
  saveAiMemory,
} from './storage.js';
import { applyTheme } from './theme.js';

const KEY = 'volumora-sync';
// Where everyone's data goes unless they name another server: the one the person behind Volumora runs.
export const DEFAULT_SYNC_URL = 'https://raspberrypi.tail9d7f95.ts.net';
const DELAY = 20000;
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
export async function signOut() {
  const config = syncConfig();
  revoked = config?.token || '';
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

let uploading = null;
let timer = null;
export async function uploadNow(config = syncConfig(), { force = false } = {}) {
  if (!config) return false;
  if (uploading) await uploading.catch(() => {});
  uploading = (async () => {
    const data = await snapshot();
    const hash = await digest(contentOf(data));
    if (!force && hash === config.hash && config.version) return false;
    const response = await call(config, '/v1/snapshot', {
      method: 'PUT',
      headers: config.version ? { 'if-match': `"${config.version}"` } : {},
      body: JSON.stringify(data),
    });
    const { version } = await response.json();
    const at = new Date().toISOString();
    if (syncConfig()) update({ version, hash, at, problem: '' });
    else if (config.token !== revoked) saveConfig({ ...config, version, hash, at, problem: '' });
    return true;
  })();
  try {
    return await uploading;
  } finally {
    uploading = null;
  }
}

// Replaces what is on this device with what the server holds. The key and the running workout stay as they are.
// No upload runs meanwhile: one in flight is awaited first, and the writes of the restore start none.
let restoring = false;
export async function restoreSnapshot(config, { version, data }) {
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
    const hash = await digest(contentOf(await snapshot()));
    saveConfig({ ...config, version, hash, at: new Date().toISOString(), problem: '' });
  } finally {
    restoring = false;
  }
}

const quietly = async () => {
  timer = null;
  const config = syncConfig();
  // Without a valid sign-in every upload fails; trying on would only count as a failed attempt at the server.
  if (!config || config.problem === 'session') return;
  try {
    await uploadNow(config);
  } catch (err) {
    update({ problem: err.code || 'server', latest: err.latest || '' });
  }
};
const soon = (delay = DELAY) => {
  if (restoring) return;
  clearTimeout(timer);
  timer = setTimeout(quietly, delay);
};

// Runs for the life of the app: uploads shortly after a change, when the connection returns, and when the app reopens.
export function startSync() {
  onDataChange((key) => {
    if (WATCHED.has(key) && syncConfig()) soon();
  });
  addEventListener('online', () => syncConfig() && soon(1000));
  document.addEventListener('visibilitychange', () => {
    if (syncConfig() && document.visibilityState === 'hidden' && timer) {
      clearTimeout(timer);
      quietly();
    }
  });
  if (syncConfig()) {
    soon(3000);
    refreshMe().catch(() => {});
  }
}
