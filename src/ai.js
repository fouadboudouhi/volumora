// Claude API client for the AI assistant. No SDK, since the app has no build step: plain fetch, only after the person
// sends something. Usually through the sync server on its operator's key, else straight from this browser to Anthropic
// with the person's own key (see aiAccess.js).
const API = 'https://api.anthropic.com/v1';
const API_VERSION = '2026-10-21';
const TIMEOUT = 180000;
const RETRY_DELAY = 1500;
// How long a request may stay silent after the app is back from the background, and how often it starts over.
const RETURN_GRACE = 6000;
const MAX_RESUMES = 3;
const MAX_STEPS = 12;
export const MODEL = 'claude-opus-5-5';
// Dollars per million tokens and per search, for the rough monthly figure in the chat menu.
const PRICE = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2, search: 0.01 };

// `code` selects the message shown to the person, see `ai.error.*` in the dictionaries.
export class AiError extends Error {
  constructor(code, detail = '') {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const headers = (key) => ({
  'content-type': 'application/json',
  'x-api-key': key,
  'anthropic-version': API_VERSION,
  // Without this header the API refuses calls made from a web page.
  'anthropic-dangerous-direct-browser-access': 'true',
});

export function errorCode(status, message = '') {
  if (/credit balance|billing/i.test(message)) return 'billing';
  return (
    { 400: 'request', 401: 'key', 402: 'billing', 403: 'permission', 404: 'model', 429: 'rate' }[status] ||
    'server'
  );
}
const retryable = (code) => code === 'rate' || code === 'server';

export const costOf = (usage = {}) =>
  ((usage.input_tokens || 0) * PRICE.input +
    (usage.output_tokens || 0) * PRICE.output +
    (usage.cache_creation_input_tokens || 0) * PRICE.cacheWrite +
    (usage.cache_read_input_tokens || 0) * PRICE.cacheRead) /
    1e6 +
  (usage.server_tool_use?.web_search_requests || 0) * PRICE.search;

// `auth` is the person's own key, or { url, token } for the server that holds a key for everyone and forwards
// the request. The server answers with Claude's own errors, plus a few of its own as plain words.
const SERVER_ERRORS = {
  budget: 'budget',
  session: 'session',
  'no ai': 'noai',
  anthropic: 'server',
  // Another request of this account is still running: the same as "too many at once", and worth one more try.
  busy: 'rate',
  model: 'model',
  tool: 'request',
  request: 'request',
};
async function post(path, auth, body, signal) {
  const server = typeof auth === 'object' && auth !== null;
  let response;
  try {
    response = await fetch(server ? `${auth.url}/v1/ai${path}` : `${API}${path}`, {
      method: 'POST',
      headers: server
        ? {
            'content-type': 'application/json',
            authorization: `Bearer ${auth.token}`,
            'anthropic-version': API_VERSION,
          }
        : headers(auth),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new AiError(err?.name === 'AbortError' ? 'aborted' : 'network');
  }
  if (response.ok) return response;
  const detail = await response.json().catch(() => null);
  if (server && typeof detail?.error === 'string') throw new AiError(SERVER_ERRORS[detail.error] || 'server');
  const message = detail?.error?.message || '';
  throw new AiError(errorCode(response.status, message), message);
}

// Stops a request when the caller cancels it or it takes too long; running out of time counts as a lost connection.
async function withTimeout(ms, signal, run) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel);
  try {
    return await run(controller.signal);
  } catch (err) {
    throw timedOut ? new AiError('network') : err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

// Checks key and model with the free token count, so saving a key costs nothing.
export async function verifyKey(key) {
  if (/^sk-ant-oat/.test(key)) throw new AiError('subscription');
  await withTimeout(20000, null, (signal) =>
    post('/messages/count_tokens', key, { model: MODEL, messages: [{ role: 'user', content: 'Hi' }] }, signal)
  );
}

// Rebuilds the reply's content blocks from the server-sent events. Thinking blocks and their signatures stay exactly
// as received, because a turn with tool calls has to be sent back unchanged. Tool input whose JSON cannot be read
// is marked, not guessed at.
export async function readStream(response, onText = () => {}, onData = () => {}) {
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const blocks = [];
  let buffer = '';
  let stopReason = null;
  let usage = {};
  const fields = { text_delta: 'text', thinking_delta: 'thinking', signature_delta: 'signature' };
  const textOf = () =>
    blocks
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('');
  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    let event;
    try {
      event = JSON.parse(line.slice(5));
    } catch {
      return;
    }
    if (event.type === 'message_start') usage = { ...event.message?.usage };
    else if (event.type === 'content_block_start') {
      blocks[event.index] = { ...event.content_block };
      if (/tool_use$/.test(blocks[event.index].type)) blocks[event.index].partial = '';
    } else if (event.type === 'content_block_delta') {
      const block = blocks[event.index];
      if (!block) return;
      const field = fields[event.delta?.type];
      if (field) {
        block[field] = (block[field] || '') + event.delta[field];
        if (field === 'text') onText(textOf());
      } else if (event.delta?.type === 'input_json_delta') block.partial += event.delta.partial_json;
      else if (event.delta?.type === 'citations_delta') (block.citations ||= []).push(event.delta.citation);
    } else if (event.type === 'content_block_stop') {
      const block = blocks[event.index];
      if (block?.partial === undefined) return;
      try {
        block.input = block.partial ? JSON.parse(block.partial) : {};
      } catch {
        block.invalid = block.partial;
        block.input = {};
      }
      delete block.partial;
    } else if (event.type === 'message_delta') {
      stopReason = event.delta?.stop_reason || stopReason;
      usage = { ...usage, ...event.usage };
    } else if (event.type === 'error') throw new AiError('server', event.error?.message);
  };
  for (;;) {
    const { done, value } = await reader.read();
    onData();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : lines.pop();
    lines.forEach(handle);
    if (done) break;
  }
  return { content: blocks.filter(Boolean), text: textOf(), stopReason, usage };
}

// What goes back to the API: the reply as received, without what only this client added.
const asSent = ({ invalid, partial, ...sent }) => sent;

const pageVisible = () =>
  new Promise((resolve) => {
    if (document.visibilityState !== 'hidden') return resolve();
    const seen = () => {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', seen);
      resolve();
    };
    document.addEventListener('visibilitychange', seen);
  });

// iPhones suspend a page in the background and its connection dies with it, sometimes silently. So a request that was
// in the background and fails, or stays silent after the return, is sent again. Tools that already ran are part of the
// transcript and do not run twice.
function backgroundWatch(signal) {
  const stopper = new AbortController();
  const stop = () => stopper.abort();
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop);
  const watch = { signal: stopper.signal, away: false, cut: false, data: () => clearTimeout(timer), end };
  let timer;
  const change = () => {
    clearTimeout(timer);
    if (document.visibilityState === 'hidden') watch.away = true;
    else if (watch.away)
      timer = setTimeout(() => {
        watch.cut = true;
        stop();
      }, RETURN_GRACE);
  };
  function end() {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    globalThis.document?.removeEventListener('visibilitychange', change);
  }
  globalThis.document?.addEventListener('visibilitychange', change);
  return watch;
}

async function requestStep({ key, body, signal, onText, onResume = () => {} }) {
  let started = false;
  const attempt = async () => {
    const watch = backgroundWatch(signal);
    try {
      return await withTimeout(TIMEOUT, watch.signal, async (combined) => {
        try {
          const response = await post('/messages', key, body, combined);
          watch.data();
          return await readStream(
            response,
            (text) => {
              started = true;
              onText(text);
            },
            watch.data
          );
        } catch (err) {
          if (err instanceof AiError) throw err;
          throw new AiError(err?.name === 'AbortError' ? 'aborted' : 'network');
        }
      });
    } catch (err) {
      if (!signal?.aborted && (watch.cut || (watch.away && err.code === 'network'))) err.resume = true;
      throw err;
    } finally {
      watch.end();
    }
  };
  for (let resumes = 0; ; resumes++) {
    try {
      return await attempt();
    } catch (err) {
      if (err.resume && resumes < MAX_RESUMES) {
        await pageVisible();
        if (signal?.aborted) throw new AiError('aborted');
        started = false;
        onText('');
        onResume();
        continue;
      }
      if (err.resume) throw new AiError('network');
      if (started || !retryable(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      return attempt();
    }
  }
}

const sourcesIn = (content) =>
  content.flatMap((block) =>
    (block.citations || [])
      .filter((c) => /^https:\/\//.test(c.url || ''))
      .map((c) => ({ url: c.url, title: c.title || c.url }))
  );

// One turn of the assistant: asks Claude, runs the tools it calls, sends the results back and repeats until it
// answers. `execute(name, input)` returns the tool's result. System prompt and tools stay the same for the whole
// turn and the transcript only grows, as the API requires for thinking blocks to stay valid. Between turns only the
// visible text is kept, so nothing earlier has to match. `serverTools` run at Anthropic; if the first request is refused
// with them, for instance because web search is switched off for the account, the turn goes on without them.
export async function runTurn({
  key,
  system,
  messages,
  tools = [],
  serverTools = [],
  maxTokens = 8000,
  signal,
  onText = () => {},
  onUsage = () => {},
  onResume,
  execute,
}) {
  const transcript = [...messages];
  let shown = '';
  let extra = serverTools;
  const sources = [];
  const join = (text) => [shown, text.trim()].filter(Boolean).join('\n\n');
  const finished = (stopReason) => ({
    text: shown,
    stopReason,
    sources: [...new Map(sources.map((source) => [source.url, source])).values()],
  });
  for (let step = 0; step < MAX_STEPS; step++) {
    const ask = () =>
      requestStep({
        key,
        signal,
        onResume,
        onText: (text) => onText(join(text)),
        body: {
          model: MODEL,
          max_tokens: maxTokens,
          stream: true,
          cache_control: { type: 'ephemeral' },
          system,
          ...(tools.length || extra.length ? { tools: [...tools, ...extra] } : {}),
          messages: transcript,
        },
      });
    let reply;
    try {
      reply = await ask();
    } catch (err) {
      if (step > 0 || err.code !== 'request' || !extra.length) throw err;
      extra = [];
      reply = await ask();
    }
    onUsage(reply.usage);
    shown = join(reply.text);
    sources.push(...sourcesIn(reply.content));
    const calls = reply.content.filter((block) => block.type === 'tool_use');
    if (reply.stopReason === 'refusal') throw new AiError('refusal');
    if (reply.stopReason === 'max_tokens') {
      if (calls.length || !shown) throw new AiError('truncated');
      return finished(reply.stopReason);
    }
    // Anthropic paused its own search; the same conversation sent again lets it go on.
    if (reply.stopReason === 'pause_turn') {
      transcript.push({ role: 'assistant', content: reply.content.map(asSent) });
      shown = '';
      continue;
    }
    if (reply.stopReason !== 'tool_use' || !calls.length) return finished(reply.stopReason);
    transcript.push({ role: 'assistant', content: reply.content.map(asSent) });
    const results = [];
    for (const call of calls) {
      if (signal?.aborted) throw new AiError('aborted');
      if (call.invalid !== undefined) {
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          is_error: true,
          content: JSON.stringify({ INVALID_JSON: call.invalid }),
        });
        continue;
      }
      let outcome;
      try {
        outcome = await execute(call.name, call.input);
      } catch (err) {
        outcome = { error: err?.message || 'Tool failed' };
      }
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        ...(outcome?.error ? { is_error: true } : {}),
        content: JSON.stringify(outcome?.error ? { error: outcome.error } : outcome),
      });
    }
    transcript.push({ role: 'user', content: results });
  }
  throw new AiError('steps');
}
