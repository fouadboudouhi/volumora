// Keeps the snapshots of several Volumora installations, one account each. No database, no dependencies: every
// account is a folder. Registration needs an invitation code from whoever runs the server, so a public address does
// not fill the disk. Older versions of each account stay, so a mistake can be undone.
// The server can also hold one Claude key for everyone: the app then talks to Claude through here, and each account
// gets a monthly budget in dollars that the admin sets.
import {
  createCipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scryptSync,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

const KEEP_LATEST = 20;
const KEEP_DAILY_DAYS = 60;
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 10 * 60 * 1000;
const DAY = 86400000;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MIN_PASSWORD = 8;
const VERSION = /^\d{13}-[0-9a-f]{8}$/;
const ANTHROPIC = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2026-10-21';
// A whole week of recipes takes a while, and the answer streams all the way.
const AI_TIMEOUT = 360000;
// Dollars per million tokens and per search, the same table as in the app.
const PRICE = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2, search: 0.01 };
const DEFAULT_BUDGET = 5;
// Other apps of the same person get their own place, so they can never overwrite each other's data.
const APP_NAME = /^[a-z][a-z0-9-]{1,30}$/;
const MAX_SUBSCRIPTIONS = 10;
const MAX_ALARMS = 200;
const MAX_ALARM_DAYS = 60;
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
const isPushService = (url) => url.protocol === 'https:' && PUSH_HOSTS.test(url.hostname);
// Each app's alarms only go to that app's own subscriptions. Untagged ones belong together, as before apps said who
// they are, so an app that sends no name keeps working unchanged.
const appOf = (value) => (value === undefined ? '' : APP_NAME.test(value) ? value : null);
const sameApp = (a, b) => (a.app || '') === (b.app || '');
const base64url = (data) => Buffer.from(data).toString('base64url');
export const costOf = (usage = {}) =>
  ((usage.input_tokens || 0) * PRICE.input +
    (usage.output_tokens || 0) * PRICE.output +
    (usage.cache_creation_input_tokens || 0) * PRICE.cacheWrite +
    (usage.cache_read_input_tokens || 0) * PRICE.cacheRead) /
    1e6 +
  (usage.server_tool_use?.web_search_requests || 0) * PRICE.search;
const monthKey = (at) => new Date(at).toISOString().slice(0, 7);
const asBudget = (value) => {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hashPassword = (password, salt = randomBytes(16).toString('hex')) =>
  `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const passwordMatches = (password, stored) => {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64));
};
const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};
// Written whole and renamed into place, so a crash never leaves a half file.
async function writeJson(file, value) {
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

// What the admin script and the server share: accounts and invitations on disk.
export function store(dataDir) {
  const usersDir = join(dataDir, 'users');
  const invitesFile = join(dataDir, 'invites.json');
  const aiFile = join(dataDir, 'ai.json');
  const accountFile = (name) => join(usersDir, name, 'account.json');
  const account = (name) => readJson(accountFile(name), null);
  const saveAccount = async (name, data) => {
    await mkdir(join(usersDir, name, 'snapshots'), { recursive: true });
    await writeJson(accountFile(name), data);
  };
  return {
    dataDir,
    usersDir,
    account,
    saveAccount,
    snapshotsDir: (name) => join(usersDir, name, 'snapshots'),
    appDir: (name, app) => join(usersDir, name, 'apps', app),
    pushOf: async (name) => ({ subscriptions: [], alarms: [], ...(await readJson(join(usersDir, name, 'push.json'), {})) }),
    savePush: (name, data) => writeJson(join(usersDir, name, 'push.json'), data),
    // The server's own key pair for Web Push, made once. Push services only need the public half.
    async pushKeys() {
      const file = join(dataDir, 'push.json');
      const found = await readJson(file, null);
      if (found) return found;
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = privateKey.export({ format: 'jwk' });
      const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
      const keys = { privateJwk: jwk, publicKey: base64url(raw) };
      await mkdir(dataDir, { recursive: true });
      await writeJson(file, keys);
      return keys;
    },
    users: async () => (await readdir(usersDir).catch(() => [])).filter((name) => USERNAME.test(name)).sort(),
    invites: () => readJson(invitesFile, []),
    // The Claude key and the budget a new account starts with. The key is never handed out again.
    ai: () => readJson(aiFile, {}),
    saveAi: async (data) => {
      await mkdir(dataDir, { recursive: true });
      await writeJson(aiFile, data);
    },
    budgetOf: (data, ai) => asBudget(data?.budget) ?? asBudget(ai?.defaultBudget) ?? DEFAULT_BUDGET,
    usedThisMonth: (data, at = Date.now()) => Number(data?.usage?.[monthKey(at)]) || 0,
    async addUsage(name, dollars, at = Date.now()) {
      const data = await account(name);
      if (!data) return;
      const month = monthKey(at);
      const usage = { ...(data.usage || {}), [month]: (Number(data.usage?.[month]) || 0) + dollars };
      await saveAccount(name, { ...data, usage });
    },
    async setAdmin(name, admin) {
      const data = await account(name);
      if (!data) return false;
      await saveAccount(name, { ...data, admin: !!admin });
      return true;
    },
    async setBudget(name, budget) {
      const data = await account(name);
      if (!data) return false;
      const value = asBudget(budget);
      const { budget: old, ...rest } = data;
      await saveAccount(name, value === null ? rest : { ...rest, budget: value });
      return true;
    },
    saveInvites: async (list) => {
      await mkdir(dataDir, { recursive: true });
      await writeJson(invitesFile, list);
    },
    async createInvite() {
      const code = randomBytes(6).toString('hex').match(/.{4}/g).join('-');
      await this.saveInvites([...(await this.invites()), { code, createdAt: new Date().toISOString() }]);
      return code;
    },
    async register(name, password, invite) {
      if (!USERNAME.test(name)) return { error: 'username' };
      if (String(password).length < MIN_PASSWORD) return { error: 'password' };
      const invites = await this.invites();
      const found = invites.find((i) => i.code === String(invite).trim().toLowerCase() && !i.usedBy);
      if (!found) return { error: 'invite' };
      if (await account(name)) return { error: 'taken' };
      found.usedBy = name;
      found.usedAt = new Date().toISOString();
      await saveAccount(name, { password: hashPassword(password), createdAt: found.usedAt, sessions: [] });
      await this.saveInvites(invites);
      return { ok: true };
    },
    async setPassword(name, password) {
      const data = await account(name);
      if (!data) return false;
      // Every device has to sign in again with the new password.
      await saveAccount(name, { ...data, password: hashPassword(password), sessions: [] });
      return true;
    },
  };
}

// Web Push: the message is encrypted for that one browser (RFC 8291), the server signs who it is (RFC 8292).
export function encryptPush(subscription, text) {
  const browser = Buffer.from(subscription.keys.p256dh, 'base64url');
  const secret = Buffer.from(subscription.keys.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  const own = ecdh.generateKeys();
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), browser, own]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(browser), secret, info, 32));
  const salt = randomBytes(16);
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.from(text)), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(4096);
  return Buffer.concat([salt, size, Buffer.from([own.length]), own, body]);
}
function vapidHeader(keys, endpoint, at) {
  const part = (value) => base64url(JSON.stringify(value));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(at / 1000) + 12 * 3600,
    sub: 'https://fouad-boudouhi.de/prepora/',
  })}`;
  const key = createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${base64url(signature)}, k=${keys.publicKey}`;
}

export function createSyncServer({
  dataDir,
  origins,
  maxBytes = 64 * 1024 * 1024,
  now = Date.now,
  anthropicUrl = ANTHROPIC,
  pushAllowed = isPushService,
}) {
  const db = store(dataDir);

  // A key is only kept once Claude accepted it, checked with the free token count.
  async function checkKey(key) {
    try {
      const response = await fetch(`${anthropicUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'Hi' }] }),
        signal: AbortSignal.timeout(20000),
      });
      return response.ok ? null : response.status === 401 ? 'key' : 'anthropic';
    } catch {
      return 'anthropic';
    }
  }

  const aiState = async (data) => {
    const ai = await db.ai();
    return {
      available: !!ai.key,
      budget: db.budgetOf(data, ai),
      used: Math.round(db.usedThisMonth(data, now()) * 10000) / 10000,
      month: monthKey(now()),
    };
  };
  const failures = new Map();

  const versions = async (name, dir = db.snapshotsDir(name)) =>
    (await readdir(dir).catch(() => []))
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -5))
      .filter((version) => VERSION.test(version))
      .sort();

  // Newest ones, plus the last one of each recent day.
  async function prune(name, dir = db.snapshotsDir(name)) {
    const all = await versions(name, dir);
    const keep = new Set(all.slice(-KEEP_LATEST));
    const days = new Map();
    all.forEach((version) => {
      const at = Number(version.split('-')[0]);
      if (now() - at <= KEEP_DAILY_DAYS * DAY) days.set(new Date(at).toISOString().slice(0, 10), version);
    });
    days.forEach((version) => keep.add(version));
    await Promise.all(
      all.filter((v) => !keep.has(v)).map((v) => rm(join(dir, `${v}.json`), { force: true }))
    );
  }

  // Too much data is read to its end and thrown away, so the client still gets a proper answer.
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size <= maxBytes) chunks.push(chunk);
      });
      req.on('end', () =>
        size > maxBytes
          ? reject(Object.assign(new Error('too large'), { status: 413 }))
          : resolve(Buffer.concat(chunks))
      );
      req.on('error', reject);
    });

  const session = async (token) => {
    if (!token || !token.includes('.')) return null;
    const [name, secret] = token.split('.');
    if (!USERNAME.test(name)) return null;
    const data = await db.account(name);
    const hashed = sha256(secret);
    return data?.sessions?.some((s) => s.hash === hashed) ? { name, data } : null;
  };
  const openSession = async (name, data) => {
    const secret = randomBytes(32).toString('hex');
    const sessions = [...(data.sessions || []), { hash: sha256(secret), at: new Date(now()).toISOString() }].slice(-20);
    await db.saveAccount(name, { ...data, sessions });
    return `${name}.${secret}`;
  };

  // Hands out every alarm that is due. Taken off the list first, so a crash can lose a reminder but never repeat it.
  async function sendDueAlarms() {
    const keys = await db.pushKeys();
    for (const name of await db.users()) {
      const push = await db.pushOf(name);
      const due = push.alarms.filter((alarm) => alarm.at <= now());
      if (!due.length) continue;
      push.alarms = push.alarms.filter((alarm) => alarm.at > now());
      const gone = new Set();
      for (const alarm of due) {
        for (const subscription of push.subscriptions.filter((s) => sameApp(s, alarm))) {
          const response = await fetch(subscription.endpoint, {
            method: 'POST',
            headers: {
              authorization: vapidHeader(keys, subscription.endpoint, now()),
              'content-encoding': 'aes128gcm',
              'content-type': 'application/octet-stream',
              ttl: String(alarm.ttl ?? 3600),
              urgency: 'high',
            },
            body: encryptPush(subscription, JSON.stringify({ title: alarm.title, body: alarm.body, id: alarm.id })),
            signal: AbortSignal.timeout(15000),
          }).catch(() => null);
          if (response?.status === 404 || response?.status === 410) gone.add(subscription.endpoint);
        }
      }
      // Read again: the app may have changed the list while the messages went out.
      const latest = await db.pushOf(name);
      await db.savePush(name, {
        alarms: latest.alarms.filter((alarm) => alarm.at > now()),
        subscriptions: latest.subscriptions.filter((s) => !gone.has(s.endpoint)),
      });
    }
  }

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = origins.includes(origin)
      ? {
          'access-control-allow-origin': origin,
          'access-control-allow-headers': 'authorization, content-type, if-match, anthropic-version, anthropic-beta',
          'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
          'access-control-expose-headers': 'etag',
          'access-control-max-age': '600',
          vary: 'origin',
        }
      : {};
    const send = (status, body = null, headers = {}) => {
      res.writeHead(status, { ...cors, 'cache-control': 'no-store', ...headers });
      res.end(body);
    };
    const json = (status, value, headers) =>
      send(status, JSON.stringify(value), { 'content-type': 'application/json', ...headers });
    try {
      if (req.method === 'OPTIONS') return send(204);
      const { pathname } = new URL(req.url, 'http://local');
      if (pathname === '/v1/health') return json(200, { ok: true });

      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
      const failed = failures.get(ip);
      if (failed && now() - failed.at > FAILURE_WINDOW) failures.delete(ip);
      if (failures.get(ip)?.count >= MAX_FAILURES) return json(429, { error: 'too many attempts' });
      const failure = (status, error) => {
        failures.set(ip, { count: (failures.get(ip)?.count || 0) + 1, at: now() });
        return json(status, { error });
      };
      const bodyJson = async () => JSON.parse((await readBody(req)).toString('utf8') || '{}');

      if (req.method === 'POST' && pathname === '/v1/register') {
        const { username, password, invite } = await bodyJson();
        const name = String(username ?? '').trim().toLowerCase();
        const result = await db.register(name, String(password ?? ''), invite ?? '');
        if (result.error) return failure(result.error === 'invite' ? 403 : 400, result.error);
        failures.delete(ip);
        return json(200, { token: await openSession(name, await db.account(name)) });
      }
      if (req.method === 'POST' && pathname === '/v1/login') {
        const { username, password } = await bodyJson();
        const name = String(username ?? '').trim().toLowerCase();
        const data = USERNAME.test(name) ? await db.account(name) : null;
        if (!data || !passwordMatches(String(password ?? ''), data.password)) return failure(401, 'user');
        failures.delete(ip);
        return json(200, { token: await openSession(name, data) });
      }

      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const who = await session(token);
      if (!who) return failure(401, 'session');
      failures.delete(ip);
      const { name } = who;
      if (req.method === 'GET' && pathname === '/v1/me')
        return json(200, { username: name, admin: !!who.data.admin, ai: await aiState(who.data) });
      if (req.method === 'POST' && pathname === '/v1/ai/messages') {
        const ai = await db.ai();
        if (!ai.key) return json(503, { error: 'no ai' });
        const budget = db.budgetOf(who.data, ai);
        const used = db.usedThisMonth(who.data, now());
        if (used >= budget) return json(402, { error: 'budget', used, budget });
        const body = await readBody(req);
        JSON.parse(body.toString('utf8'));
        // The caller going away ends the request at Claude as well, so nobody pays for an answer no one reads.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), AI_TIMEOUT);
        res.on('close', () => {
          if (!res.writableFinished) controller.abort();
        });
        let upstream;
        try {
          upstream = await fetch(`${anthropicUrl}/v1/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': ai.key,
              'anthropic-version': req.headers['anthropic-version'] || ANTHROPIC_VERSION,
              ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}),
            },
            body,
            signal: controller.signal,
          });
        } catch {
          clearTimeout(timer);
          return json(502, { error: 'anthropic' });
        }
        res.writeHead(upstream.status, {
          ...cors,
          'cache-control': 'no-store',
          'content-type': upstream.headers.get('content-type') || 'application/json',
        });
        // Streamed through unchanged; the usage figures in the events say what this answer cost.
        const decoder = new TextDecoder();
        let text = '';
        try {
          for await (const chunk of upstream.body) {
            res.write(chunk);
            text += decoder.decode(chunk, { stream: true });
          }
        } catch {
          // The client or Claude went away; what came through was still paid for.
        } finally {
          clearTimeout(timer);
        }
        // Counted before the answer ends, so whoever asks for the budget right after sees this answer in it.
        if (upstream.ok) {
          let usage = {};
          if (/^(event|data):/m.test(text))
            text.split(/\r?\n/).forEach((line) => {
              if (!line.startsWith('data:')) return;
              try {
                const event = JSON.parse(line.slice(5));
                if (event.type === 'message_start') usage = { ...event.message?.usage };
                else if (event.type === 'message_delta') usage = { ...usage, ...event.usage };
              } catch {
                // A broken line carries no usage.
              }
            });
          else
            try {
              usage = JSON.parse(text).usage || {};
            } catch {
              // No usage to count.
            }
          await db.addUsage(name, costOf(usage), now());
        }
        res.end();
        return;
      }

      if (pathname.startsWith('/v1/admin/')) {
        if (!who.data.admin) return json(403, { error: 'admin' });
        if (req.method === 'GET' && pathname === '/v1/admin/overview') {
          const ai = await db.ai();
          const users = [];
          for (const user of await db.users()) {
            const data = await db.account(user);
            users.push({
              username: user,
              admin: !!data?.admin,
              createdAt: data?.createdAt || '',
              budget: db.budgetOf(data, ai),
              ownBudget: asBudget(data?.budget),
              used: Math.round(db.usedThisMonth(data, now()) * 10000) / 10000,
            });
          }
          const invites = (await db.invites())
            .filter((i) => !i.usedBy)
            .map(({ code, createdAt }) => ({ code, createdAt }));
          return json(200, {
            ai: { configured: !!ai.key, defaultBudget: asBudget(ai.defaultBudget) ?? DEFAULT_BUDGET },
            month: monthKey(now()),
            users,
            invites,
          });
        }
        if (req.method === 'PUT' && pathname === '/v1/admin/ai') {
          const { key, defaultBudget } = await bodyJson();
          const ai = await db.ai();
          if (key !== undefined) {
            const value = String(key).trim();
            if (value) {
              const problem = await checkKey(value);
              if (problem) return json(400, { error: problem });
              ai.key = value;
            } else delete ai.key;
          }
          if (defaultBudget !== undefined) {
            const value = asBudget(defaultBudget);
            if (value === null) return json(400, { error: 'budget' });
            ai.defaultBudget = value;
          }
          await db.saveAi(ai);
          return json(200, { configured: !!ai.key, defaultBudget: asBudget(ai.defaultBudget) ?? DEFAULT_BUDGET });
        }
        if (req.method === 'POST' && pathname === '/v1/admin/invites')
          return json(200, { code: await db.createInvite() });
        const user = pathname.match(/^\/v1\/admin\/users\/([a-z0-9._-]+)$/);
        if (user && req.method === 'PUT') {
          if (!USERNAME.test(user[1])) return json(404, { error: 'not found' });
          const { budget } = await bodyJson();
          if (budget !== null && asBudget(budget) === null) return json(400, { error: 'budget' });
          if (!(await db.setBudget(user[1], budget))) return json(404, { error: 'not found' });
          return json(200, { ok: true });
        }
        return json(404, { error: 'not found' });
      }
      if (req.method === 'POST' && pathname === '/v1/logout') {
        const hashed = sha256(token.split('.')[1]);
        await db.saveAccount(name, { ...who.data, sessions: who.data.sessions.filter((s) => s.hash !== hashed) });
        return json(200, { ok: true });
      }

      if (req.method === 'GET' && pathname === '/v1/push/key')
        return json(200, { key: (await db.pushKeys()).publicKey });
      if (req.method === 'POST' && pathname === '/v1/push/subscribe') {
        const request = await bodyJson();
        const { endpoint, keys } = request.subscription ?? {};
        const app = appOf(request.app);
        let url = null;
        try {
          url = new URL(endpoint);
        } catch {
          // Stays null and is refused below.
        }
        if (!url || !pushAllowed(url) || !keys?.p256dh || !keys?.auth || app === null)
          return json(400, { error: 'subscription' });
        const push = await db.pushOf(name);
        push.subscriptions = [
          ...push.subscriptions.filter((s) => s.endpoint !== endpoint),
          { endpoint, keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) }, ...(app ? { app } : {}) },
        ].slice(-MAX_SUBSCRIPTIONS);
        await db.savePush(name, push);
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && pathname === '/v1/push/alarms') {
        // `set` adds or replaces by id, `cancel` removes by id, both within the app. The app decides what is due when;
        // `ttl` says how long a late message is still worth delivering, in seconds.
        const request = await bodyJson();
        const { set = [], cancel = [] } = request;
        const app = appOf(request.app);
        if (!Array.isArray(set) || !Array.isArray(cancel) || app === null) return json(400, { error: 'alarms' });
        const clean = set.map(({ id, at, title, body, ttl }) => ({
          id: String(id).slice(0, 100),
          at: Number(at),
          title: String(title ?? '').slice(0, 100),
          body: String(body ?? '').slice(0, 300),
          ...(ttl != null && Number.isFinite(Number(ttl)) ? { ttl: Math.min(86400, Math.max(0, Math.round(ttl))) } : {}),
          ...(app ? { app } : {}),
        }));
        if (clean.some((alarm) => !alarm.id || !Number.isFinite(alarm.at) || alarm.at > now() + MAX_ALARM_DAYS * DAY))
          return json(400, { error: 'alarms' });
        const remove = new Set([...cancel.map(String), ...clean.map((alarm) => alarm.id)]);
        const push = await db.pushOf(name);
        push.alarms = [...push.alarms.filter((alarm) => (alarm.app || '') !== app || !remove.has(alarm.id)), ...clean];
        if (push.alarms.length > MAX_ALARMS) return json(400, { error: 'alarms' });
        await db.savePush(name, push);
        return json(200, { ok: true });
      }

      // Without an app name this is the Volumora data, as it always was.
      const place = pathname.match(/^\/v1\/apps\/([^/]+)\/snapshot$/);
      if (place && !APP_NAME.test(place[1])) return json(404, { error: 'not found' });
      const dir = place ? db.appDir(name, place[1]) : db.snapshotsDir(name);
      const all = await versions(name, dir);
      const latest = all.at(-1);
      const file = (version) => join(dir, `${version}.json`);
      if (place && req.method === 'GET') {
        if (!latest) return json(404, { error: 'nothing stored yet' });
        return send(200, await readFile(file(latest)), { 'content-type': 'application/json', etag: `"${latest}"` });
      }
      if (place && req.method === 'PUT') {
        const claimed = (req.headers['if-match'] || '').replaceAll('"', '');
        if (latest && claimed !== latest) return json(412, { error: 'newer data', latest }, { etag: `"${latest}"` });
        const body = await readBody(req);
        JSON.parse(body.toString('utf8'));
        const version = `${String(now()).padStart(13, '0')}-${sha256(body).slice(0, 8)}`;
        await mkdir(dir, { recursive: true });
        const temporary = join(db.dataDir, `${name}-${version}.tmp`);
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, file(version));
        await prune(name, dir);
        return json(200, { version }, { etag: `"${version}"` });
      }
      if (pathname === '/v1/snapshot' && req.method === 'GET') {
        if (!latest) return json(404, { error: 'nothing stored yet' });
        return send(200, await readFile(file(latest)), { 'content-type': 'application/json', etag: `"${latest}"` });
      }
      if (pathname === '/v1/snapshot' && req.method === 'PUT') {
        const claimed = (req.headers['if-match'] || '').replaceAll('"', '');
        if (latest && claimed !== latest) return json(412, { error: 'newer data', latest }, { etag: `"${latest}"` });
        const body = await readBody(req);
        JSON.parse(body.toString('utf8'));
        const version = `${String(now()).padStart(13, '0')}-${sha256(body).slice(0, 8)}`;
        const temporary = join(db.dataDir, `${name}-${version}.tmp`);
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, file(version));
        await prune(name);
        return json(200, { version }, { etag: `"${version}"` });
      }
      if (pathname === '/v1/snapshots' && req.method === 'GET') {
        const list = await Promise.all(
          all.map(async (version) => ({
            version,
            savedAt: new Date(Number(version.split('-')[0])).toISOString(),
            bytes: (await stat(file(version))).size,
          }))
        );
        return json(200, { snapshots: list.reverse() });
      }
      const old = pathname.match(/^\/v1\/snapshots\/([^/]+)$/);
      if (old && req.method === 'GET' && all.includes(old[1]))
        return send(200, await readFile(file(old[1])), { 'content-type': 'application/json' });
      return json(404, { error: 'not found' });
    } catch (err) {
      if (err instanceof SyntaxError) return json(400, { error: 'not json' });
      if (err.status === 413) return json(413, { error: 'too large' });
      console.error(err);
      return json(500, { error: 'server error' });
    }
  });
  server.sendDueAlarms = sendDueAlarms;
  return server;
}

if (process.argv[1]?.endsWith('server.js')) {
  const dataDir = process.env.DATA_DIR || '/data';
  await mkdir(dataDir, { recursive: true });
  const origins = (process.env.ALLOWED_ORIGINS || 'https://fouad-boudouhi.de').split(',');
  const server = createSyncServer({ dataDir, origins, anthropicUrl: process.env.ANTHROPIC_URL || ANTHROPIC });
  server.listen(Number(process.env.PORT) || 8787, () => console.log('Volumora sync is listening'));
  let sending = false;
  setInterval(async () => {
    if (sending) return;
    sending = true;
    await server.sendDueAlarms().catch((err) => console.error(err));
    sending = false;
  }, 5000);
}
