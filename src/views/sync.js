// Signing in to the optional server copy: a sheet with address, name and password, shared by the backup screen and
// the first start. New accounts need an invitation from whoever runs the server.
import { t } from '../i18n.js';
import { render } from '../render.js';
import {
  DEFAULT_SYNC_URL,
  SyncError,
  cleanSyncUrl,
  dataOwner,
  deviceData,
  fetchSnapshot,
  joinAccount,
  refreshMe,
  register,
  restoreSnapshot,
  signIn,
  signOut,
  syncConfig,
  syncNow,
} from '../sync.js';
import { confirmDialog, sheet, toast } from '../ui.js';
import { esc, fmtLong } from '../util.js';

const errorText = (err) => t(`sync.error.${err instanceof SyncError ? err.code : 'server'}`);

// The data on a device belongs to one account. Before anyone else signs in over it, the person is told whose data
// is here, what becomes of it, and whether all of it had been uploaded. This happens before the server hears
// anything, so leaving changes nothing anywhere. Returns the decision for joinAccount, or null for "leave it".
async function askAboutDeviceData(account) {
  const data = await deviceData(account);
  const next = account.username;
  if (data.whose === 'unknown') {
    // From before the app noted whose data it holds: only the person can say. "No" alone removes nothing.
    const mine = await confirmDialog({
      title: t('sync.unknownTitle'),
      text: t('sync.unknownText', { next }),
      confirmLabel: t('sync.unknownMine'),
      cancelLabel: t('sync.unknownNotMine'),
    });
    if (mine) return { adopt: true };
    const remove = await confirmDialog({
      title: t('sync.removeTitle'),
      text: t('sync.removeText', { next }),
      confirmLabel: t('sync.otherConfirm'),
      danger: true,
    });
    return remove ? { replace: true } : null;
  }
  if (data.whose !== 'other') return {};
  const user = data.url === account.url ? data.username : `${data.username} (${new URL(data.url).host})`;
  const uploaded = data.saved
    ? t(data.running ? 'sync.otherSavedRunning' : 'sync.otherSaved', { user })
    : data.at
      ? t('sync.otherUnsaved', { date: new Date(data.at).toLocaleString() })
      : t('sync.otherUnknown');
  // A running workout is never uploaded: it goes with the rest, whatever else was saved.
  const running = data.running && !data.saved ? ` ${t('sync.otherRunning')}` : '';
  const ok = await confirmDialog({
    title: t('sync.otherTitle', { user }),
    text: `${t('sync.otherText', { user, next })} ${uploaded}${running}`,
    confirmLabel: t('sync.otherConfirm'),
    danger: true,
  });
  return ok ? { replace: true } : null;
}

// Afterwards this device and the account hold the same data. The account's own data on this device is merged with
// what the server holds; neither side is replaced.
async function connect(config, decision, done) {
  const me = await refreshMe(config).catch(() => null);
  if (me) config = { ...config, admin: !!me.admin, ai: me.ai || null };
  const outcome = await joinAccount(config, decision);
  // Another account's data was just removed: the app starts over, so nothing of it lingers on screen or in memory.
  if (decision.replace) return location.reload();
  done();
  const said = { uploaded: 'sync.connected', merged: 'sync.merged', waiting: 'sync.waiting' };
  toast(t(said[outcome] || 'sync.restored'));
}

// The form itself, for the sheet on the backup screen and for the gate at the start. The server is set; only
// someone who runs their own can name another.
export function syncForm({ onDone = () => render(), mode = 'register', close = () => {} } = {}) {
  const box = document.createElement('form');
  box.className = 'settings-form sync-form';
  box.id = 'gateForm';
  box.noValidate = true;
  const modeButton = (name, label) =>
    `<button type="button" class="${name === mode ? 'active' : ''}" data-sync-mode="${name}" aria-pressed="${name === mode}">${label}</button>`;
  // Whoever signs in again does so where the data on this device belongs: the same server, and the same name.
  const owner = dataOwner();
  const ownServer = !!owner && owner.url !== DEFAULT_SYNC_URL;
  box.innerHTML = `<div class="segmented small" role="group" aria-label="${t('sync.title')}">${modeButton('register', t('sync.modeRegister'))}${modeButton('login', t('sync.modeLogin'))}</div><label><span>${t('sync.username')}</span><input id="syncUser" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="32" value="${mode === 'login' ? esc(owner?.username || '') : ''}"></label><label><span>${t('sync.password')}</span><input id="syncPassword" type="password" autocomplete="${mode === 'register' ? 'new-password' : 'current-password'}" minlength="8"></label><label id="syncInviteRow" ${mode === 'register' ? '' : 'hidden'}><span>${t('sync.invite')}</span><input id="syncInvite" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="xxxx-xxxx-xxxx"></label><p class="muted settings-hint" id="syncRegisterHint" ${mode === 'register' ? '' : 'hidden'}>${t('sync.registerHint')}</p><p class="muted settings-hint sync-server" ${ownServer ? 'hidden' : ''}><span>${t('sync.serverIs', { host: esc(new URL(DEFAULT_SYNC_URL).host) })}</span> <button type="button" class="text-btn" id="syncOther">${t('sync.otherServer')}</button></p><label id="syncUrlRow" ${ownServer ? '' : 'hidden'}><span>${t('sync.url')}</span><input id="syncUrl" type="url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" value="${esc(owner?.url || DEFAULT_SYNC_URL)}"></label><p class="ai-error" role="alert" id="syncError" hidden></p><button class="primary full" type="submit" id="syncConnect">${t(mode === 'register' ? 'sync.register' : 'sync.signIn')}</button>`;
  let registering = mode === 'register';
  // What the person decided about another account's data, kept for this form: a mistyped password asks only once.
  let agreed = null;
  box.querySelectorAll('[data-sync-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      registering = button.dataset.syncMode === 'register';
      box.querySelectorAll('[data-sync-mode]').forEach((b) => {
        const on = b === button;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on);
      });
      box.querySelector('#syncInviteRow').hidden = !registering;
      box.querySelector('#syncRegisterHint').hidden = !registering;
      box.querySelector('#syncPassword').autocomplete = registering ? 'new-password' : 'current-password';
      box.querySelector('#syncConnect').textContent = t(registering ? 'sync.register' : 'sync.signIn');
    });
  });
  box.querySelector('#syncOther').addEventListener('click', () => {
    box.querySelector('#syncUrlRow').hidden = false;
    box.querySelector('.sync-server').hidden = true;
    box.querySelector('#syncUrl').focus();
  });
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const line = box.querySelector('#syncError');
    const button = box.querySelector('#syncConnect');
    const fail = (key) => {
      line.textContent = t(`sync.error.${key}`);
      line.hidden = false;
    };
    const url = cleanSyncUrl(box.querySelector('#syncUrl').value);
    const username = box.querySelector('#syncUser').value.trim().toLowerCase();
    const password = box.querySelector('#syncPassword').value;
    const invite = box.querySelector('#syncInvite').value.trim();
    line.hidden = true;
    if (!url) return fail('url');
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) return fail('username');
    if (password.length < 8) return fail('password');
    if (registering && !invite) return fail('invite');
    button.disabled = true;
    try {
      const account = `${url} ${username}`;
      if (agreed?.account !== account) {
        const decision = await askAboutDeviceData({ url, username });
        if (!decision) return;
        agreed = { account, decision };
      }
      const config = registering
        ? await register(url, username, password, invite)
        : await signIn(url, username, password);
      await connect(config, agreed.decision, () => {
        close();
        onDone();
      });
    } catch (err) {
      line.textContent = errorText(err);
      line.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
  return box;
}

export function openSyncForm({ onDone = () => render(), mode = 'login' } = {}) {
  let close = () => {};
  const box = syncForm({ onDone, mode, close: () => close() });
  close = sheet({ title: t('sync.title'), content: box }) || close;
}

export function syncSection() {
  const config = syncConfig();
  if (!config) return '';
  const status = config.problem
    ? `<p class="ai-error" role="alert">${t(`sync.error.${config.problem}`)}</p>`
    : `<p class="muted settings-hint">${config.at ? t('sync.lastDone', { date: new Date(config.at).toLocaleString() }) : ''}</p>`;
  const expired = config.problem === 'session';
  return `<section class="list-section sync-on"><h2>${t('sync.title')}</h2><p class="settings-hint">${t('sync.on', { user: esc(config.username || ''), host: esc(new URL(config.url).host) })}</p>${status}<div class="sync-actions">${
    expired
      ? `<button type="button" class="secondary full" id="syncOpen">${t('sync.signInAgain')}</button>`
      : `<button type="button" class="secondary full" id="syncNow">${t('sync.now')}</button><button type="button" class="secondary full" id="syncLoad">${t('sync.load')}</button>`
  }<button type="button" class="text-btn" id="syncOff">${t('sync.off')}</button></div></section>`;
}

export function bindSync() {
  document.querySelector('#syncOpen')?.addEventListener('click', () => openSyncForm({ mode: 'login' }));
  const guarded = (selector, run) =>
    document.querySelector(selector)?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await run();
      } catch (err) {
        toast(errorText(err));
      }
      render();
    });
  // Brings in what another device saved, then uploads: newer data on the server is merged, never overwritten.
  guarded('#syncNow', async () => {
    await syncNow({ look: true, force: true });
    toast(t('sync.saved'));
  });
  guarded('#syncLoad', async () => {
    const config = syncConfig();
    const found = await fetchSnapshot(config);
    if (!found) return toast(t('sync.nothing'));
    const ok = await confirmDialog({
      title: t('sync.foundTitle'),
      text: t('sync.foundText', { date: fmtLong(found.data?.savedAt || new Date()) }),
      confirmLabel: t('sync.foundLoad'),
    });
    if (!ok) return;
    await restoreSnapshot(config, found);
    toast(t('sync.restored'));
  });
  document.querySelector('#syncOff')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const ok = await confirmDialog({
      title: t('sync.offTitle'),
      text: t('sync.offText'),
      confirmLabel: t('sync.off'),
    });
    if (!ok) return;
    // Signing out uploads what is still waiting first, which can take a moment.
    button.disabled = true;
    await signOut();
    render();
  });
}
