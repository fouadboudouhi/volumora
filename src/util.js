// Pure helpers without DOM or storage access.
import { intlLocale } from './i18n.js';

export const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
export const clone = (value) => JSON.parse(JSON.stringify(value));
export const esc = (value) =>
  String(value ?? '').replace(
    /[&<>'"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]
  );
export const number = (value) => Number(String(value ?? '').replace(',', '.')) || 0;
// A plan exercise has 1 to 12 sets; anything else that got stored falls back to a usable count.
export const setsCount = (value) => {
  const n = Math.round(number(value));
  return n > 0 ? Math.min(12, n) : 3;
};
// "8-12", "8 – 12" and "12–8" read as "8–12"; text such as "30 s" stays as typed; empty keeps the fallback.
export function normalizeRange(value, fallback = '8–12') {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (/[^\d\s\-–—]/.test(text)) return text.slice(0, 20);
  const nums = (text.match(/\d+/g) || []).map(Number).filter((n) => n > 0);
  if (!nums.length) return fallback;
  const [a, b = a] = nums;
  return a === b ? String(a) : `${Math.min(a, b)}–${Math.max(a, b)}`;
}
export const rangeMax = (range) => Math.max(...(String(range).match(/\d+/g)?.map(Number) || [12]));
// Bottom of a real range; a single target such as "10" or "30 s" has none.
export const rangeMin = (range) => {
  const nums = String(range).match(/\d+/g)?.map(Number) || [];
  return nums.length > 1 ? Math.min(...nums) : 0;
};
// The middle of a range such as 8–12, as a starting point for an exercise without any history.
export const rangeMid = (range) => {
  const nums = String(range).match(/\d+/g)?.map(Number) || [];
  return nums.length ? Math.round((Math.min(...nums) + Math.max(...nums)) / 2) : null;
};
export const titleCase = (value) =>
  String(value)
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bEz\b/g, 'EZ');

// Search normalisation: lower case, accents stripped, ß -> ss and ae/oe/ue -> a/o/u, so "rucken" and "ruecken"
// both find "Rücken". Applied to the index and the query alike.
export const fold = (value) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/ae|oe|ue/g, (m) => m[0]);

// Exercises are matched across plans and sessions by their library id; custom exercises fall back to their own id.
export const exerciseSourceId = (item) => item?.libraryId || item?.exerciseId || item?.id || '';
// The default plan has its own entries for these catalogue exercises. Same exercise, so one history and one record.
const SAME_EXERCISE = { '0577': 'chest-press', '0313': 'hammer-curl' };
export const exerciseKey = (item) => {
  const id = exerciseSourceId(item);
  return SAME_EXERCISE[id] || id;
};

export const weekdayIndex = (date) => (date.getDay() + 6) % 7;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');
// Accepts a Date, an ISO timestamp or a local day key (YYYY-MM-DD). A day key is read as local noon so it never
// shifts to the previous or next day in another time zone.
export const parseDate = (value) => {
  if (value instanceof Date) return isNaN(value) ? null : value;
  const m = DAY_KEY.exec(String(value ?? ''));
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12);
  const d = new Date(value);
  return isNaN(d) ? null : d;
};
export const dayKey = (value = new Date()) => {
  const d = parseDate(value);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '';
};
const format = (options) => (value) => {
  const d = parseDate(value);
  return d ? new Intl.DateTimeFormat(intlLocale(), options).format(d) : '–';
};
export const fmtDate = format({ day: '2-digit', month: '2-digit', year: '2-digit' });
export const fmtLong = format({ weekday: 'short', day: '2-digit', month: 'short' });
export const fmtMonth = format({ month: 'long', year: 'numeric' });

// Working sets are everything but warm-ups; `type` wins over the older `warmup` flag.
export const isWorkSet = (set) => (set?.type ? set.type !== 'warmup' : !set?.warmup);
// Volume is weight × reps of completed working sets; timed and distance sets have none.
export const setVolume = (set, trackType = 'weight_reps') =>
  !set?.done || !isWorkSet(set) || trackType === 'time' || trackType === 'distance_time'
    ? 0
    : number(set.weight) * number(set.reps);
export const volumeOf = (session) =>
  session.entries?.reduce(
    (sum, entry) => sum + entry.sets.reduce((s, set) => s + setVolume(set, entry.trackType), 0),
    0
  ) || 0;
// Completed working sets; warm-ups stay out, like in every other count of the app.
export const doneSets = (session) =>
  session?.entries?.reduce((n, e) => n + e.sets.filter((x) => x.done && isWorkSet(x)).length, 0) || 0;
// Epley estimate of the one-repetition maximum.
export const e1rm = (weight, reps) => number(weight) * (1 + number(reps) / 30);
export const RANGES = { '4w': 28, '3m': 91, '1y': 365, all: Infinity };
export const rangeCutoff = (range, today = new Date()) => {
  const days = RANGES[range] ?? Infinity;
  if (!Number.isFinite(days)) return '';
  const d = new Date(today);
  d.setDate(d.getDate() - days);
  return dayKey(d);
};
