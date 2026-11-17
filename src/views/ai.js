// AI assistant with the person's own Claude key: one chat that answers, analyses and changes plans and settings.
// Without a key this is only the screen to add one; nothing is sent before the person sends something.
import { AiError, costOf, runTurn, verifyKey } from '../ai.js';
import { aiAuth, aiAvailable, aiMode, serverAi } from '../aiAccess.js';
import { drawChatCharts } from '../chatCharts.js';
import { isSignedIn, refreshMe } from '../sync.js';
import { assistantSystem, chatMessages, replyHtml, splitReplies, trainingSummary } from '../aiPrompts.js';
import { aiTools, runTool, webSearchTool } from '../aiTools.js';
import { fmtNumber, plural, t } from '../i18n.js';
import { icon } from '../icons.js';
import { libraryOf } from '../library.js';
import { goBack, navigate, render } from '../render.js';
import { state } from '../state.js';
import {
  addAiCost,
  clearAiKey,
  getAiChat,
  getAiCost,
  getAiKey,
  getAiMemory,
  saveAiChat,
  saveAiKey,
  saveAiMemory,
} from '../storage.js';
import { actionSheet, confirmDialog, sheet, toast, undoToast } from '../ui.js';
import { esc, uid } from '../util.js';
import { openExerciseSheet } from './exercise.js';

const LABELS = {
  plans: 'nav.plans',
  analytics: 'nav.history',
  more: 'nav.more',
  settings: 'settings.title',
  home: 'nav.home',
};
const CLEAN = { aiInput: '', aiError: '', aiErrorDetail: '', aiAutoSend: false };
const NEAR_BOTTOM = 80;
const AT_END = 8;
const MAX_SOURCES = 5;

// One turn at a time. It keeps running while the person looks elsewhere; the answer waits in the chat.
let running = null;
let live = { text: '', status: '', actions: [] };
// Undo steps live as long as the app is open; after a restart the chat only shows what happened.
const undos = new Map();
const discard = () => {
  running?.abort();
  running = null;
};

export function openAi(from, patch = {}) {
  navigate('ai', { ...CLEAN, aiReturn: from, ...patch });
}

const backTarget = () => state.aiReturn || 'home';
const backButton = () =>
  `<button class="back" id="aiBack" aria-label="${t('common.back')}">${icon('chevron-left')}</button>`;
const errorText = () =>
  state.aiError
    ? `${t(`ai.error.${state.aiError}`)}${state.aiError === 'request' && state.aiErrorDetail ? ` (${state.aiErrorDetail})` : ''}`
    : '';
const errorLine = (extra = '') =>
  state.aiError ? `<p class="ai-error ${extra}" role="alert">${esc(errorText())}</p>` : '';

const setupView = () =>
  `<main class="shell narrow"><div class="backrow">${backButton()}<span>${t(LABELS[backTarget()] || 'common.back')}</span></div><section class="page-head compact"><h1>${t('ai.setupTitle')}</h1></section>${isSignedIn() ? `<p class="muted ai-intro">${t('ai.setupNoServerAi')}</p>` : ''}<p class="muted ai-intro">${t('ai.setupIntro')}</p>
  <form class="settings-form" id="aiKeyForm" novalidate><label><span>${t('ai.keyLabel')}</span><input id="aiKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-api…"></label>${errorLine()}<button class="primary full" id="aiKeySave">${state.aiChecking ? t('ai.checking') : t('ai.keySave')}</button></form>
  <ul class="ai-notes"><li>${t('ai.setupStays')}</li><li>${t('ai.setupLimit')}</li><li>${t('ai.setupSent')}</li></ul>
  <p class="settings-hint"><a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">${t('ai.keyLink')}</a></p></main>`;

const actionHtml = (action) =>
  `<div class="chat-action">${icon('check')}<span>${esc(action.label)}</span>${
    action.undone
      ? `<small>${t('ai.undone')}</small>`
      : undos.has(action.id)
        ? `<button type="button" class="text-btn" data-ai-undo="${esc(action.id)}">${t('common.undo')}</button>`
        : ''
  }</div>`;

const messageHtml = (message, last) => {
  if (message.role === 'user') return `<div class="chat-msg chat-user">${esc(message.text)}</div>`;
  const { body, options } = splitReplies(message.text);
  const replies =
    last && options.length
      ? `<div class="chat-replies">${options.map((option) => `<button type="button" data-chat-reply>${esc(option)}</button>`).join('')}</div>`
      : '';
  const sources = (message.sources || []).length
    ? `<p class="chat-sources">${message.sources.map((source) => `<a href="${esc(source.url)}" target="_blank" rel="noopener">${esc(source.title)}</a>`).join('')}</p>`
    : '';
  return `<div class="chat-msg chat-assistant">${replyHtml(body)}${sources}${(message.actions || []).map(actionHtml).join('')}${message.cut ? `<p class="muted">${t('ai.cut')}</p>` : ''}${replies}</div>`;
};

const dots = () => `<span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>`;
const liveHtml = () =>
  `${replyHtml(splitReplies(live.text).body, { live: true })}${live.actions.map(actionHtml).join('')}<div class="chat-status" role="status" aria-label="${t('ai.thinking')}">${dots()}${live.status ? `<span>${esc(live.status)}</span>` : ''}</div>`;

const emptyChat = () =>
  `<div class="chat-empty"><h2>${t('ai.chatTitle')}</h2><p class="muted">${t('ai.chatNote')}</p><div class="chat-starters">${t(
    'ai.chatExamples'
  )
    .split('|')
    .map((text) => `<button type="button" data-chat-starter>${esc(text)}</button>`)
    .join('')}</div></div>`;

const messagesHtml = () => {
  const messages = getAiChat();
  if (!messages.length && !running) return emptyChat();
  const list = messages.map((m, i) => messageHtml(m, !running && i === messages.length - 1)).join('');
  return `${list}${running ? `<div class="chat-msg chat-assistant" id="chatLive">${liveHtml()}</div>` : ''}`;
};

const chatView = () =>
  `<main class="ai-chat"><header class="chat-head">${backButton()}<h1>${t('ai.title')}</h1><button type="button" class="icon-btn quiet" id="aiMenu" aria-label="${t('ai.menu')}">${icon('more')}</button></header>
  <div class="chat-scroll" id="chatScroll" role="log">${messagesHtml()}</div>
  <div class="chat-foot">${errorLine('chat-error')}<form class="chat-composer" id="chatForm"><textarea id="aiInput" rows="1" maxlength="2000" enterkeyhint="send" aria-label="${t('ai.chatPlaceholder')}" placeholder="${t('ai.chatPlaceholder')}">${esc(state.aiInput)}</textarea><button type="submit" class="chat-send" id="aiSend" aria-label="${t('ai.chatSend')}" ${running ? 'hidden' : ''} ${state.aiInput.trim() ? '' : 'disabled'}>${icon('up')}</button><button type="button" class="chat-send chat-stop" id="aiStop" aria-label="${t('ai.chatStop')}" ${running ? '' : 'hidden'}>${icon('stop')}</button></form></div></main>`;

// The app was closed while a reply was on its way: nothing can pick that up again, so the question goes back into the
// field. Sending it by itself could repeat a change that had already been made.
function recoverInterrupted() {
  const messages = getAiChat();
  if (running || messages.at(-1)?.role !== 'user') return;
  saveAiChat(messages.slice(0, -1));
  if (!state.aiInput.trim()) state.aiInput = messages.at(-1).text;
  Object.assign(state, { aiError: 'interrupted', aiErrorDetail: '' });
}

export function view() {
  if (!aiAvailable()) return setupView();
  recoverInterrupted();
  return chatView();
}

const scroller = () => document.querySelector('#chatScroll');
const fromBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight;
const nearBottom = (box) => fromBottom(box) < NEAR_BOTTOM;
// Whether the chat stays on the latest text while it arrives. Any move upwards ends that, however small, and only
// scrolling back down to the very end brings it back.
let following = true;
const toBottom = () => {
  const box = scroller();
  if (box) box.scrollTop = box.scrollHeight;
};

// The chat updates its parts instead of rendering the screen, so the field keeps its focus and the keyboard stays.
function paintChat() {
  const box = scroller();
  if (!box) return;
  box.innerHTML = messagesHtml();
  drawChatCharts(box);
  const send = document.querySelector('#aiSend');
  const stop = document.querySelector('#aiStop');
  const input = document.querySelector('#aiInput');
  send.hidden = !!running;
  stop.hidden = !running;
  send.disabled = !input.value.trim();
  const foot = document.querySelector('.chat-foot');
  foot.querySelector('.ai-error')?.remove();
  foot.insertAdjacentHTML('afterbegin', errorLine('chat-error'));
}

function paintLive() {
  const box = scroller();
  const element = document.querySelector('#chatLive');
  if (!box || !element) return;
  element.innerHTML = liveHtml();
  if (following) toBottom();
}

const sizeInput = (input) => {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
};
function setDraft(text) {
  state.aiInput = text;
  const input = document.querySelector('#aiInput');
  if (!input) return;
  input.value = text;
  sizeInput(input);
}

async function sendChat(text) {
  const question = text.trim();
  if (running || !question) return;
  const messages = [...getAiChat(), { role: 'user', text: question }];
  saveAiChat(messages);
  Object.assign(state, { aiError: '', aiErrorDetail: '' });
  setDraft('');
  const job = new AbortController();
  running = job;
  live = { text: '', status: '', actions: [] };
  let renderAfter = false;
  following = true;
  paintChat();
  toBottom();
  const execute = async (name, input) => {
    if (running === job) {
      live.status = t(`ai.tool.${name}`, null, '');
      paintLive();
    }
    const outcome = await runTool(name, input, { confirm: confirmDialog });
    if (outcome.action) {
      const id = uid();
      undos.set(id, outcome.action.undo);
      live.actions.push({ id, label: outcome.action.label });
      renderAfter ||= outcome.action.rerender;
    }
    if (running === job) {
      live.status = '';
      paintLive();
    }
    return outcome.error ? { error: outcome.error } : outcome.result;
  };
  const finish = (reply, extra = {}) =>
    saveAiChat([
      ...messages,
      {
        role: 'assistant',
        text: reply,
        ...(live.actions.length ? { actions: live.actions } : {}),
        ...extra,
      },
    ]);
  try {
    const reply = await runTurn({
      key: aiAuth(),
      system: assistantSystem(trainingSummary()),
      messages: chatMessages(messages),
      tools: aiTools(),
      serverTools: [webSearchTool],
      signal: job.signal,
      onUsage: (usage) => aiMode() === 'key' && addAiCost(costOf(usage)),
      onResume: () => {
        if (running !== job) return;
        live.status = t('ai.resuming');
        paintLive();
      },
      execute,
      onText: (current) => {
        if (running !== job) return;
        live.text = current;
        if (current) live.status = '';
        paintLive();
      },
    });
    if (running !== job) return;
    if (aiMode() === 'server') refreshMe().catch(() => {});
    if (!reply.text.trim() && !live.actions.length) throw new AiError('server');
    finish(reply.text.trim(), {
      ...(reply.stopReason === 'max_tokens' ? { cut: true } : {}),
      ...(reply.sources.length ? { sources: reply.sources.slice(0, MAX_SOURCES) } : {}),
    });
  } catch (err) {
    if (running !== job) return;
    // What already happened stays in the chat. A question without any result goes back into the field, so the
    // conversation keeps taking turns.
    if (live.text.trim() || live.actions.length) finish(live.text.trim());
    else {
      saveAiChat(messages.slice(0, -1));
      setDraft(question);
    }
    if (err.code !== 'aborted')
      Object.assign(state, { aiError: err.code || 'server', aiErrorDetail: err.detail || '' });
  } finally {
    if (running === job) {
      running = null;
      live = { text: '', status: '', actions: [] };
      if (renderAfter && state.view === 'ai') render();
      else paintChat();
      if (following) toBottom();
    }
  }
}

function undoAction(id) {
  const undo = undos.get(id);
  if (!undo) return;
  if (!undo()) {
    toast(t('ai.undoStale'));
    return;
  }
  undos.delete(id);
  const messages = getAiChat();
  messages.forEach((m) =>
    m.actions?.forEach((a) => {
      if (a.id === id) a.undone = true;
    })
  );
  saveAiChat(messages);
  render();
}

function newChat() {
  discard();
  const before = getAiChat();
  saveAiChat([]);
  Object.assign(state, CLEAN);
  render();
  undoToast(t('ai.chatCleared'), () => {
    saveAiChat(before);
    render();
    toBottom();
  });
}

function removeKey() {
  discard();
  const key = getAiKey();
  clearAiKey();
  render();
  undoToast(t('ai.keyRemoved'), () => {
    saveAiKey(key);
    render();
  });
}

function openMemory() {
  const box = document.createElement('div');
  const draw = () => {
    const memory = getAiMemory();
    box.innerHTML = memory.length
      ? `<div class="memory-list">${memory.map((m) => `<div class="memory-row"><span>${esc(m.text)}</span><button type="button" class="icon-btn quiet" data-forget="${esc(m.id)}" aria-label="${t('ai.memoryRemove')}">${icon('close')}</button></div>`).join('')}</div>`
      : `<p class="muted">${t('ai.memoryEmpty')}</p>`;
    box.querySelectorAll('[data-forget]').forEach((b) => {
      b.onclick = () => {
        saveAiMemory(getAiMemory().filter((m) => m.id !== b.dataset.forget));
        draw();
      };
    });
  };
  draw();
  sheet({ title: t('ai.memory'), content: box });
}

const money = (value) => fmtNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const costText = () => {
  const server = serverAi();
  return server
    ? t('ai.budgetUsed', { used: money(server.ai.used || 0), budget: money(server.ai.budget || 0) })
    : t('ai.cost', { amount: money(getAiCost()) });
};

function openMenu() {
  const memory = getAiMemory().length;
  actionSheet(t('ai.title'), [
    getAiChat().length > 0 && { label: t('ai.chatNew'), onClick: newChat },
    {
      label: t('ai.memory'),
      hint: memory ? plural(memory, 'ai.memoryCount') : t('ai.memoryHint'),
      onClick: openMemory,
    },
    {
      label: t('ai.dataAndCost'),
      hint: costText(),
      onClick: () => {
        const box = document.createElement('div');
        box.innerHTML = `<p class="ai-cost"><b>${costText()}</b><br><span class="muted">${t(serverAi() ? 'ai.budgetHint' : 'ai.costHint')}</span></p><p class="muted">${t('ai.sentHint')}</p><pre class="ai-sent">${esc(trainingSummary())}</pre>`;
        sheet({ title: t('ai.dataAndCost'), content: box });
      },
    },
    aiMode() === 'key' && { label: t('ai.removeKey'), danger: true, onClick: removeKey },
  ]);
}

const redraw = () => state.view === 'ai' && render();

function bindSetup() {
  document.querySelector('#aiKeyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const field = document.querySelector('#aiKey');
    const key = field.value.trim();
    if (!key || state.aiChecking) {
      field.focus();
      return;
    }
    Object.assign(state, { aiChecking: true, aiError: '' });
    const button = document.querySelector('#aiKeySave');
    button.disabled = true;
    button.textContent = t('ai.checking');
    try {
      await verifyKey(key);
      saveAiKey(key);
      state.aiChecking = false;
      toast(t('ai.keySaved'));
    } catch (err) {
      Object.assign(state, { aiChecking: false, aiError: err.code || 'network' });
    }
    redraw();
  });
}

// Whoever reads the latest message keeps seeing it when the keyboard or a growing field takes space away.
let chatResize = null;
function keepLatestVisible() {
  const box = scroller();
  following = !running || nearBottom(box);
  let lastTop = box.scrollTop;
  box.addEventListener(
    'scroll',
    () => {
      const top = box.scrollTop;
      const left = fromBottom(box);
      if (top < lastTop && left > AT_END) following = false;
      else if (top > lastTop && left <= AT_END) following = true;
      lastTop = top;
    },
    { passive: true }
  );
  // A finger on the chat must not be pulled along by new text before its first scroll event.
  let touchTop = null;
  let followedAtTouch = false;
  box.addEventListener(
    'touchstart',
    () => {
      touchTop = box.scrollTop;
      followedAtTouch = following;
      following = false;
    },
    { passive: true }
  );
  const release = () => {
    if (followedAtTouch && touchTop !== null && box.scrollTop >= touchTop) following = true;
    touchTop = null;
  };
  box.addEventListener('touchend', release, { passive: true });
  box.addEventListener('touchcancel', release, { passive: true });
  chatResize?.disconnect();
  chatResize = new ResizeObserver(() => {
    if (following) toBottom();
  });
  chatResize.observe(box);
}

function bindChat() {
  const input = document.querySelector('#aiInput');
  const send = document.querySelector('#aiSend');
  if (!input) return;
  sizeInput(input);
  drawChatCharts(scroller());
  toBottom();
  keepLatestVisible();
  // The messages are redrawn while the chat runs, so one listener on their parent serves every button in them.
  scroller().addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.aiUndo) undoAction(button.dataset.aiUndo);
    else if (button.dataset.exercise) openExerciseSheet(libraryOf({ id: button.dataset.exercise }));
    else if (button.dataset.chatNav) navigate(button.dataset.chatNav);
    else if (button.dataset.chatSession)
      navigate('session', { sessionFrom: 'ai', sessionId: button.dataset.chatSession });
    else if (button.matches('[data-chat-starter], [data-chat-reply]')) sendChat(button.textContent);
  });
  input.addEventListener('input', () => {
    state.aiInput = input.value;
    send.disabled = !input.value.trim();
    sizeInput(input);
  });
  // With a real keyboard Enter sends; on a phone it starts a new line and the button sends.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      sendChat(input.value);
    }
  });
  document.querySelector('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat(input.value);
  });
  // Tapping the buttons must not take the focus from the field, or the keyboard would drop after every message.
  document.querySelectorAll('.chat-send').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
  });
  document.querySelector('#aiStop').addEventListener('click', () => running?.abort());
  document.querySelector('#aiMenu').addEventListener('click', openMenu);
  // Entries such as "analyse this workout" already are the tap that sends.
  if (state.aiAutoSend) {
    state.aiAutoSend = false;
    sendChat(input.value);
  }
}

export function bind() {
  document.querySelector('#aiBack')?.addEventListener('click', () => goBack(backTarget()));
  if (aiAvailable()) bindChat();
  else bindSetup();
}
