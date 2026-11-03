// Rest-timer feedback: a short beep (Web Audio, primed by a tap because iOS only unlocks audio in a gesture)
// and vibration, both switchable in Settings.
import { getSettings } from './storage.js';

let context = null;

// Call inside a user gesture (the "set done" tap); creates or resumes the audio context.
export function primeAudio() {
  if (!getSettings().restSound) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    context ||= new Ctx();
    if (context.state === 'suspended') context.resume();
  } catch {
    context = null;
  }
}

export function beep() {
  if (!getSettings().restSound || !context) return;
  try {
    // iOS suspends or interrupts the context after a call or a locked screen; it plays once it runs again.
    if (context.state !== 'running') context.resume().catch(() => {});
    const now = context.currentTime;
    [0, 0.18].forEach((offset) => {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.14);
      osc.connect(gain).connect(context.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.16);
    });
  } catch {
    /* no audio on this device */
  }
}

export function buzz(pattern) {
  if (getSettings().restVibrate === false) return;
  navigator.vibrate?.(pattern);
}
