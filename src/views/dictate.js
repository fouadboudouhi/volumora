// Saying what a set was. The phone's own speech recognition starts by itself; after a refusal it waits for a tap on the
// microphone in the field, which also shows why it was refused. The keyboard's microphone works in the field either way.
import { intlLocale, localDecimal, t } from '../i18n.js';
import { fmtDistance, fmtDuration } from '../sets.js';
import { parseSet } from '../speech.js';
import { icon } from '../icons.js';
import { sheet } from '../ui.js';
import { unit } from '../units.js';
import { esc } from '../util.js';

// Holds why the recognition last refused; while it is set, listening only starts from a tap.
const OFF = 'volumora-speech-off';
const REFUSALS = ['not-allowed', 'service-not-allowed', 'audio-capture'];
const REASONS = [...REFUSALS, 'mic-blocked', 'silent'];
// Long enough for someone to answer the microphone question, which pauses everything without telling the page.
const START_TIMEOUT = 20000;
// How long the phone may stay silent once it listens, before the person gets a way forward.
const RESULT_TIMEOUT = 8000;
// A new attempt waits for the last one to end, but not forever.
const END_TIMEOUT = 1500;
let ending = Promise.resolve();

const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition;
// Safari decides speech recognition by the microphone permission, and a refusal holds until the page is reloaded. Asking
// for the microphone first shows the phone's real question, or tells at once that it is blocked. Null means it is free.
// On iPhones only the first listening of a page worked without this, so every attempt starts the same way.
async function askForMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return null;
  } catch (error) {
    if (error.name === 'NotAllowedError') return 'mic-blocked';
    return ['NotFoundError', 'NotReadableError'].includes(error.name) ? 'audio-capture' : null;
  }
}

const refusal = () => {
  try {
    return localStorage.getItem(OFF);
  } catch {
    return null;
  }
};
const rememberRefusal = (reason) => {
  try {
    if (reason) localStorage.setItem(OFF, reason);
    else localStorage.removeItem(OFF);
  } catch {
    // Then it is simply tried again next time.
  }
};

const preview = (values) =>
  [
    values.weight ? `${localDecimal(values.weight)} ${unit()}` : '',
    values.reps ? t('dictate.reps', { n: values.reps }) : '',
    values.distance ? fmtDistance(values.distance) : '',
    values.time ? fmtDuration(values.time) : '',
  ]
    .filter(Boolean)
    .join(' · ');

// `onValues` gets the parsed values, in the person's unit, once they are clear. `known` holds what this set is expected
// to be ({ weight, reps } in the person's unit), which tells "10 x 12" on a dumbbell from 12 kg × 10.
export function openDictation({ title, trackType, known = null, onValues }) {
  const box = document.createElement('form');
  box.className = 'dictate';
  box.noValidate = true;
  const canListen = !!Recognition();
  box.innerHTML = `<div class="dictate-field"><input id="dictateInput" autocomplete="off" enterkeyhint="done" placeholder="${esc(t(`dictate.placeholder.${trackType}`, null, t('dictate.placeholder.weight_reps')))}" aria-label="${esc(t('dictate.label'))}">${canListen ? `<button type="button" class="icon-btn quiet" id="dictateMic" aria-label="${esc(t('dictate.listen'))}" aria-pressed="false">${icon('mic')}</button>` : ''}</div><p class="dictate-state" role="status"></p><button class="primary full" id="dictateSave" disabled>${t('dictate.save')}</button>`;
  const close = sheet({ title, content: box, autoFocus: false });
  const input = box.querySelector('#dictateInput');
  const state = box.querySelector('.dictate-state');
  const save = box.querySelector('#dictateSave');
  const mic = box.querySelector('#dictateMic');
  let recognition = null;
  let waiting = null;
  let attempt = 0;
  let done = false;

  const parsed = () => parseSet(input.value, trackType, known);
  const showParsed = () => {
    const values = parsed();
    save.disabled = !values;
    if (values) state.textContent = preview(values);
    return values;
  };
  const showListening = (on) => {
    mic?.classList.toggle('listening', on);
    mic?.setAttribute('aria-pressed', String(on));
  };
  const isListening = () => !!mic?.classList.contains('listening');
  const stop = () => {
    attempt += 1;
    clearTimeout(waiting);
    showListening(false);
    if (!recognition) return;
    const running = recognition;
    recognition = null;
    running.onresult = running.onerror = running.onstart = null;
    ending = new Promise((resolve) => {
      running.onend = resolve;
      setTimeout(resolve, END_TIMEOUT);
    });
    try {
      running.stop();
    } catch {
      // It had already ended.
    }
  };
  const finish = (values) => {
    if (done) return;
    done = true;
    stop();
    close();
    onValues(values);
  };
  // Listening ends by itself only with a whole set: a half sentence like "60 Kilo" would otherwise take the reps
  // silently from the last session. A tap on the button still logs what is there, as a tick would.
  const finishHeard = () => {
    const values = parsed();
    if (values && (trackType !== 'weight_reps' || (values.weight && values.reps))) {
      finish(values);
      return true;
    }
    state.textContent = values ? `${preview(values)} · ${t('dictate.incomplete')}` : t('dictate.unclear');
    return false;
  };
  const refused = (reason, detail) => {
    rememberRefusal(reason);
    stop();
    state.textContent = `${t(`dictate.why.${reason}`)}${detail ? ` (${detail})` : ''} ${t('dictate.retry')}`;
  };

  // Tapping the field means typing or the keyboard's microphone, whatever the recognition was doing.
  input.addEventListener('focus', () => {
    if (!isListening()) return;
    stop();
    state.textContent = t('dictate.keyboard');
  });
  input.addEventListener('input', () => {
    stop();
    if (!showParsed()) state.textContent = t('dictate.keyboard');
  });
  box.addEventListener('submit', (e) => {
    e.preventDefault();
    const values = parsed();
    if (values) finish(values);
  });
  // Closing the sheet any other way must not leave the microphone on.
  new MutationObserver((_, observer) => {
    if (!box.isConnected) {
      stop();
      observer.disconnect();
    }
  }).observe(document.body, { childList: true });

  async function listen() {
    stop();
    const current = attempt;
    input.blur();
    state.textContent = t('dictate.listening');
    showListening(true);
    await ending;
    if (current !== attempt) return;
    const blocked = await askForMicrophone();
    if (current !== attempt || !box.isConnected) return;
    if (blocked) return refused(blocked);
    recognition = new (Recognition())();
    recognition.lang = intlLocale();
    recognition.interimResults = true;
    recognition.continuous = false;
    // Some phones offer the API and then simply do nothing.
    waiting = setTimeout(() => refused('silent'), START_TIMEOUT);
    // A phone can also listen and never answer. What was understood by then still counts.
    const waitForResult = () => {
      clearTimeout(waiting);
      waiting = setTimeout(() => {
        if (!finishHeard()) stop();
      }, RESULT_TIMEOUT);
    };
    recognition.onstart = waitForResult;
    recognition.onresult = (e) => {
      waitForResult();
      rememberRefusal(null);
      const result = e.results[e.results.length - 1];
      input.value = result[0].transcript;
      showParsed();
      if (result.isFinal) finishHeard();
    };
    recognition.onerror = (e) => {
      if (REFUSALS.includes(e.error)) return refused(e.error, e.message);
      stop();
      state.textContent = ['no-speech', 'aborted'].includes(e.error)
        ? t('dictate.unclear')
        : t('dictate.why.other', { code: e.error });
    };
    recognition.onend = () => {
      clearTimeout(waiting);
      recognition = null;
      showListening(false);
      if (!done) finishHeard();
    };
    try {
      recognition.start();
    } catch {
      refused('silent');
    }
  }
  mic?.addEventListener('click', () => {
    if (!isListening()) return listen();
    stop();
    state.textContent = t('dictate.retry');
  });

  const reason = canListen && refusal();
  if (!canListen) {
    state.textContent = t('dictate.keyboard');
    input.focus();
  } else if (reason) {
    state.textContent = `${REASONS.includes(reason) ? `${t(`dictate.why.${reason}`)} ` : ''}${t('dictate.retry')}`;
  } else listen();
  return close;
}
