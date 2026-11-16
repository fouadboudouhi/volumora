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
// Wrong passwords for one account, from anywhere: enough for typos, too few to guess.
const MAX_ACCOUNT_FAILURES = 20;
const ACCOUNT_WINDOW = 60 * 60 * 1000;
const DAY = 86400000;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MIN_PASSWORD = 8;
const VERSION = /^\d{13}-[0-9a-f]{8}$/;
const ANTHROPIC = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2026-10-21';
// A whole week of recipes takes a while, and the answer streams all the way.
const AI_TIMEOUT = 360000;
// Dollars per million tokens and per search, the same table as in the app. A cache entry kept for an hour costs
// twice the input price to write, the usual five minutes a quarter more.
const PRICE = { input: 4, output: 20, cacheWrite: 5, cacheWriteHour: 8, cacheRead: 0.2, search: 0.01 };
// Claude is paid with the owner's key, so the server decides what may be asked for, not the apps: only models this
// table has a price for, answers no longer than the longest an app needs (Prepora's plan), and of Claude's paid
// extras only the two the apps use.
const MODELS = { 'claude-opus-5-5': PRICE };
const MAX_OUTPUT_TOKENS = 32000;
const AI_BETAS = ['server-side-fallback-2026-07-01', 'server-side-fallback-2026-06-01'];
const SERVER_TOOL = /^web_(search|fetch)_\d{8}$/;
const MAX_TOOL_USES = 5;
const REFUSED_FIELDS = ['mcp_servers', 'container', 'speed', 'service_tier', 'inference_geo'];
// Requests of one account that may be on their way to Claude at the same time.
const MAX_AI_PARALLEL = 4;
// Sign-in, push and admin calls are a few hundred bytes. Only snapshots and Claude requests carry weight, and those
// are read only once it is known who sends them.
const SMALL_BODY = 16 * 1024;
const ALARM_BODY = 256 * 1024;
const AI_BODY = 16 * 1024 * 1024;
// How much of a refused upload is still read (and dropped) before the connection is cut.
const UNREAD_BYTES = 1024 * 1024;
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
export const costOf = (usage = {}, price = PRICE) => {
  const written = usage.cache_creation_input_tokens || 0;
  const forAnHour = Math.min(written, usage.cache_creation?.ephemeral_1h_input_tokens || 0);
  return (
    ((usage.input_tokens || 0) * price.input +
      (usage.output_tokens || 0) * price.output +
      (written - forAnHour) * price.cacheWrite +
      forAnHour * price.cacheWriteHour +
      (usage.cache_read_input_tokens || 0) * price.cacheRead) /
      1e6 +
    (usage.server_tool_use?.web_search_requests || 0) * price.search
  );
};

// The request as it goes on to Claude, or what is wrong with it.
export function aiRequest(asked) {
  if (!asked || typeof asked !== 'object' || Array.isArray(asked)) return { error: 'request' };
  const price = Object.hasOwn(MODELS, asked.model) ? MODELS[asked.model] : null;
  if (!price) return { error: 'model' };
  const length = Number(asked.max_tokens);
  if (!Number.isInteger(length) || length < 1) return { error: 'request' };
  if (REFUSED_FIELDS.some((field) => field in asked)) return { error: 'request' };
  if (asked.tools !== undefined && !Array.isArray(asked.tools)) return { error: 'request' };
  const tools = [];
  for (const tool of asked.tools || []) {
    if (!tool || typeof tool !== 'object') return { error: 'request' };
    // The apps' own tools run on the phone and cost nothing extra; Claude's own tools are billed per use.
    if (tool.type === undefined || tool.type === 'custom') tools.push(tool);
    else if (!SERVER_TOOL.test(tool.type)) return { error: 'tool' };
    else {
      const uses = Number(tool.max_uses);
      tools.push({ ...tool, max_uses: uses >= 1 ? Math.min(Math.floor(uses), MAX_TOOL_USES) : MAX_TOOL_USES });
    }
  }
  return {
    price,
    request: {
      ...asked,
      max_tokens: Math.min(length, MAX_OUTPUT_TOKENS),
      ...(asked.tools ? { tools } : {}),
    },
  };
}

// Reads what an answer costs while it passes through. An answer that breaks off never says how long it got, so its
// length is then estimated from the text that came (hidden thinking is not in it, so this is the lower end).
function usageMeter(streamed) {
  let rest = '';
  let usage = {};
  let written = 0;
  let ended = false;
  const read = (line) => {
    if (!line.startsWith('data:')) return;
    try {
      const event = JSON.parse(line.slice(5));
      if (event.type === 'message_start') usage = { ...event.message?.usage };
      else if (event.type === 'message_delta') {
        usage = { ...usage, ...event.usage };
        ended = true;
      } else if (event.type === 'content_block_delta') {
        const { text, thinking, partial_json: input } = event.delta || {};
        written += String(text ?? thinking ?? input ?? '').length;
      }
    } catch {
      // A broken line carries no usage.
    }
  };
  return {
    feed(text) {
      rest += text;
      if (!streamed) return;
      const lines = rest.split(/\r?\n/);
      rest = lines.pop();
      lines.forEach(read);
    },
    usage() {
      if (!streamed) {
        try {
          return JSON.parse(rest).usage || {};
        } catch {
          return {};
        }
      }
      read(rest);
      if (ended) return usage;
      return { ...usage, output_tokens: Math.max(usage.output_tokens || 0, Math.ceil(written / 3)) };
    },
  };
}
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
  // One change at a time per file: read, change and write back as a whole. Without this, two requests that end in
  // the same moment overwrite each other, and a counted cost, a new sign-in or a used invitation is gone again.
  const queues = new Map();
  const exclusive = (key, work) => {
    const run = (queues.get(key) || Promise.resolve()).then(() => work());
    const tail = run.catch(() => {});
    queues.set(key, tail);
    tail.then(() => queues.get(key) === tail && queues.delete(key));
    return run;
  };
  // The name of no account, so the list of invitations has a queue of its own.
  const INVITES = '/invites';
  const update = (name, change) =>
    exclusive(name, async () => {
      const data = await account(name);
      if (!data) return null;
      const next = change(data);
      await saveAccount(name, next);
      return next;
    });
  const invites = () => readJson(invitesFile, []);
  const saveInvites = async (list) => {
    await mkdir(dataDir, { recursive: true });
    await writeJson(invitesFile, list);
  };
  return {
    dataDir,
    usersDir,
    account,
    saveAccount,
    exclusive,
    update,
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
    invites,
    // The Claude key and the budget a new account starts with. The key is never handed out again.
    ai: () => readJson(aiFile, {}),
    saveAi: async (data) => {
      await mkdir(dataDir, { recursive: true });
      await writeJson(aiFile, data);
    },
    budgetOf: (data, ai) => asBudget(data?.budget) ?? asBudget(ai?.defaultBudget) ?? DEFAULT_BUDGET,
    usedThisMonth: (data, at = Date.now()) => Number(data?.usage?.[monthKey(at)]) || 0,
    addUsage: (name, dollars, at = Date.now()) =>
      update(name, (data) => {
        const month = monthKey(at);
        return { ...data, usage: { ...(data.usage || {}), [month]: (Number(data.usage?.[month]) || 0) + dollars } };
      }),
    setAdmin: async (name, admin) => !!(await update(name, (data) => ({ ...data, admin: !!admin }))),
    setBudget: async (name, budget) =>
      !!(await update(name, ({ budget: old, ...rest }) => {
        const value = asBudget(budget);
        return value === null ? rest : { ...rest, budget: value };
      })),
    saveInvites,
    createInvite: () =>
      exclusive(INVITES, async () => {
        const code = randomBytes(6).toString('hex').match(/.{4}/g).join('-');
        await saveInvites([...(await invites()), { code, createdAt: new Date().toISOString() }]);
        return code;
      }),
    register(name, password, invite) {
      if (!USERNAME.test(name)) return { error: 'username' };
      if (String(password).length < MIN_PASSWORD) return { error: 'password' };
      // One registration at a time, and the invitation is marked as used before the account exists: otherwise
      // several people signing up in the same moment would all get in on one code.
      return exclusive(INVITES, async () => {
        const list = await invites();
        const found = list.find((i) => i.code === String(invite).trim().toLowerCase() && !i.usedBy);
        if (!found) return { error: 'invite' };
        if (await account(name)) return { error: 'taken' };
        found.usedBy = name;
        found.usedAt = new Date().toISOString();
        await saveInvites(list);
        await saveAccount(name, { password: hashPassword(password), createdAt: found.usedAt, sessions: [] });
        return { ok: true };
      });
    },
    // Every device has to sign in again with the new password.
    setPassword: async (name, password) =>
      !!(await update(name, (data) => ({ ...data, password: hashPassword(password), sessions: [] }))),
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
  const accountFailures = new Map();
  // Wrong passwords per account are also kept on disk: a restart must not hand out a fresh set of guesses.
  // Addresses stay in memory only.
  const failuresFile = join(dataDir, 'failures.json');
  const ready = readJson(failuresFile, {}).then((saved) => {
    for (const [name, entry] of Object.entries(saved && typeof saved === 'object' ? saved : {}))
      if (USERNAME.test(name) && Number.isFinite(entry?.count) && Number.isFinite(entry?.at))
        accountFailures.set(name, { count: entry.count, at: entry.at });
  });
  const rememberFailures = () =>
    db.exclusive('/failures', () => writeJson(failuresFile, Object.fromEntries(accountFailures))).catch(() => {});
  // What each account has on its way to Claude right now: how many requests, and what they may cost at most.
  const aiRunning = new Map();
  // Counts in a window; the map forgets old entries so it cannot grow without end.
  const count = (map, key, window, limit) => {
    const entry = map.get(key);
    if (entry && now() - entry.at > window) map.delete(key);
    if (map.size > 10000) for (const [k, v] of map) if (now() - v.at > window) map.delete(k);
    return (map.get(key)?.count || 0) >= limit;
  };
  const note = (map, key) => {
    const entry = map.get(key);
    map.set(key, { count: (entry?.count || 0) + 1, at: entry?.at ?? now() });
  };

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

  // A body over its limit is never kept in memory. A small one is refused as soon as that is clear. A large upload
  // from someone signed in (`patient`) is read on to its end and thrown away, up to twice the limit, so the app gets
  // a proper answer instead of a broken connection.
  const readBody = (req, limit = maxBytes, patient = false) =>
    new Promise((resolve, reject) => {
      const tooLarge = () => reject(Object.assign(new Error('too large'), { status: 413 }));
      if (!patient && Number(req.headers['content-length']) > limit) return tooLarge();
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size <= limit) {
          chunks.push(chunk);
          return;
        }
        chunks.length = 0;
        if (!patient || size > limit * 2) {
          req.removeAllListeners('data');
          tooLarge();
        }
      });
      req.on('end', () => (size > limit ? tooLarge() : resolve(Buffer.concat(chunks))));
      req.on('error', reject);
    });

  // `name.secret`: the name may hold dots itself, the secret never does, so the last dot is the one that divides.
  const session = async (token) => {
    const cut = token ? token.lastIndexOf('.') : -1;
    if (cut < 1) return null;
    const name = token.slice(0, cut);
    if (!USERNAME.test(name)) return null;
    const data = await db.account(name);
    const hash = sha256(token.slice(cut + 1));
    return data?.sessions?.some((s) => s.hash === hash) ? { name, data, hash } : null;
  };
  const openSession = async (name) => {
    const secret = randomBytes(32).toString('hex');
    const entry = { hash: sha256(secret), at: new Date(now()).toISOString() };
    await db.update(name, (data) => ({ ...data, sessions: [...(data.sessions || []), entry].slice(-20) }));
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

      // The proxy in front (Tailscale Funnel) adds the real address last; anything before it the client could
      // have written itself.
      const ip =
        String(req.headers['x-forwarded-for'] || '')
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .pop() || String(req.socket.remoteAddress);
      if (count(failures, ip, FAILURE_WINDOW, MAX_FAILURES)) return json(429, { error: 'too many attempts' });
      const failure = (status, error) => {
        note(failures, ip);
        return json(status, { error });
      };
      const bodyJson = async (limit = SMALL_BODY) => {
        const value = JSON.parse((await readBody(req, Math.min(limit, maxBytes))).toString('utf8') || '{}');
        return value && typeof value === 'object' ? value : {};
      };
      await ready;

      if (req.method === 'POST' && pathname === '/v1/register') {
        const { username, password, invite } = await bodyJson();
        const name = String(username ?? '').trim().toLowerCase();
        const result = await db.register(name, String(password ?? ''), invite ?? '');
        if (result.error) return failure(result.error === 'invite' ? 403 : 400, result.error);
        failures.delete(ip);
        return json(200, { token: await openSession(name) });
      }
      if (req.method === 'POST' && pathname === '/v1/login') {
        const { username, password } = await bodyJson();
        const name = String(username ?? '').trim().toLowerCase();
        const data = USERNAME.test(name) ? await db.account(name) : null;
        if (data && count(accountFailures, name, ACCOUNT_WINDOW, MAX_ACCOUNT_FAILURES))
          return json(429, { error: 'too many attempts' });
        if (!data || !passwordMatches(String(password ?? ''), data.password)) {
          if (data) {
            note(accountFailures, name);
            await rememberFailures();
          }
          return failure(401, 'user');
        }
        failures.delete(ip);
        if (accountFailures.delete(name)) await rememberFailures();
        return json(200, { token: await openSession(name) });
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
        const { price, request, error } = aiRequest(JSON.parse((await readBody(req, AI_BODY, true)).toString('utf8')));
        if (error) return json(400, { error });
        const body = JSON.stringify(request);
        // The most this request can cost: the longest answer it may get, and its own size read as text (a picture
        // counts for far fewer tokens than its bytes, hence the cap).
        const atMost = (request.max_tokens * price.output + Math.min(body.length / 3, 150000) * price.input) / 1e6;
        // Looked at one request at a time, with the account read fresh. What is still on its way to Claude counts as
        // spent already, or many requests sent in the same moment would all pass on the same old figure.
        const refused = await db.exclusive(name, async () => {
          const data = (await db.account(name)) || who.data;
          const budget = db.budgetOf(data, ai);
          const used = db.usedThisMonth(data, now());
          const running = aiRunning.get(name) || { count: 0, dollars: 0 };
          if (used >= budget) return [402, { error: 'budget', used, budget }];
          if (running.count >= MAX_AI_PARALLEL || used + running.dollars >= budget) return [429, { error: 'busy' }];
          aiRunning.set(name, { count: running.count + 1, dollars: running.dollars + atMost });
          return null;
        });
        if (refused) return json(...refused);
        const done = () => {
          const running = aiRunning.get(name);
          if (!running || running.count <= 1) aiRunning.delete(name);
          else aiRunning.set(name, { count: running.count - 1, dollars: Math.max(0, running.dollars - atMost) });
        };
        // The caller going away ends the request at Claude as well, so nobody pays for an answer no one reads.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), AI_TIMEOUT);
        res.on('close', () => {
          if (!res.writableFinished) controller.abort();
        });
        const version = String(req.headers['anthropic-version'] || '');
        const betas = String(req.headers['anthropic-beta'] || '')
          .split(',')
          .map((beta) => beta.trim())
          .filter((beta) => AI_BETAS.includes(beta));
        let upstream;
        try {
          upstream = await fetch(`${anthropicUrl}/v1/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': ai.key,
              'anthropic-version': /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : ANTHROPIC_VERSION,
              ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {}),
            },
            body,
            signal: controller.signal,
          });
        } catch {
          clearTimeout(timer);
          done();
          return json(502, { error: 'anthropic' });
        }
        const kind = upstream.headers.get('content-type') || 'application/json';
        res.writeHead(upstream.status, { ...cors, 'cache-control': 'no-store', 'content-type': kind });
        // Streamed through unchanged; the usage figures in the events say what this answer cost.
        const decoder = new TextDecoder();
        const meter = usageMeter(kind.includes('text/event-stream'));
        try {
          for await (const chunk of upstream.body) {
            if (!res.destroyed) res.write(chunk);
            meter.feed(decoder.decode(chunk, { stream: true }));
          }
        } catch {
          // The client or Claude went away; what came through was still paid for.
        } finally {
          clearTimeout(timer);
        }
        // Counted before the answer ends, so whoever asks for the budget right after sees this answer in it. A cost
        // that cannot be written down must not take the answer, or the server, with it.
        try {
          if (upstream.ok) await db.addUsage(name, costOf(meter.usage(), price), now());
        } catch (err) {
          console.error(err);
        } finally {
          done();
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
        await db.update(name, (data) => ({
          ...data,
          sessions: (data.sessions || []).filter((s) => s.hash !== who.hash),
        }));
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
        const request = await bodyJson(ALARM_BODY);
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
        const body = await readBody(req, maxBytes, true);
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
        const body = await readBody(req, maxBytes, true);
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
      // An answer that is already on its way cannot be replaced by an error; trying would bring the server down.
      if (res.headersSent) {
        console.error(err);
        return res.destroy();
      }
      if (err instanceof SyntaxError) return json(400, { error: 'not json' });
      if (err.status === 413) {
        // The rest of the upload is let through unkept, so an honest mistake still gets its answer instead of a
        // broken connection. Only so much of it, though: after that the line is cut.
        let unread = 0;
        req.on('error', () => {});
        req.on('data', (chunk) => {
          unread += chunk.length;
          if (unread > UNREAD_BYTES) req.destroy();
        });
        return json(413, { error: 'too large' });
      }
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
