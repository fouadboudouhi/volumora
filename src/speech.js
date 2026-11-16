// Turns what someone said or typed about a set into its values. Works on the text alone, offline and without a service.
const ONES = {
  ein: 1,
  eins: 1,
  eine: 1,
  einer: 1,
  one: 1,
  zwei: 2,
  two: 2,
  drei: 3,
  three: 3,
  vier: 4,
  four: 4,
  fünf: 5,
  fuenf: 5,
  five: 5,
  sechs: 6,
  six: 6,
  sieben: 7,
  seven: 7,
  acht: 8,
  eight: 8,
  neun: 9,
  nine: 9,
  zehn: 10,
  ten: 10,
  elf: 11,
  eleven: 11,
  zwölf: 12,
  zwoelf: 12,
  twelve: 12,
  dreizehn: 13,
  thirteen: 13,
  vierzehn: 14,
  fourteen: 14,
  fünfzehn: 15,
  fifteen: 15,
  sechzehn: 16,
  sixteen: 16,
  siebzehn: 17,
  seventeen: 17,
  achtzehn: 18,
  eighteen: 18,
  neunzehn: 19,
  nineteen: 19,
};
const TENS = {
  zwanzig: 20,
  twenty: 20,
  dreißig: 30,
  dreissig: 30,
  thirty: 30,
  vierzig: 40,
  forty: 40,
  fünfzig: 50,
  fuenfzig: 50,
  fifty: 50,
  sechzig: 60,
  sixty: 60,
  siebzig: 70,
  seventy: 70,
  achtzig: 80,
  eighty: 80,
  neunzig: 90,
  ninety: 90,
};

function wordValue(word) {
  if (ONES[word] !== undefined) return ONES[word];
  if (TENS[word] !== undefined) return TENS[word];
  if (word === 'hundert' || word === 'hundred') return 100;
  const german = word.match(/^(.+?)und(.+)$/);
  if (german && ONES[german[1]] < 10 && TENS[german[2]]) return ONES[german[1]] + TENS[german[2]];
  const hundreds = word.match(/^(?:(.+?))?hundert(.*)$/);
  if (hundreds) {
    const rest = hundreds[2] ? wordValue(hundreds[2].replace(/^und/, '')) : 0;
    const times = hundreds[1] ? ONES[hundreds[1]] : 1;
    if (times && rest !== null) return times * 100 + rest;
  }
  return null;
}

// Number words become digits, "einhalb" and "komma fünf" a decimal.
function normalize(text) {
  const words = String(text)
    .toLowerCase()
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/[,;!?]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const value = wordValue(word);
      return value === null ? word : String(value);
    });
  return words
    .join(' ')
    .replace(/(\d+)\s*(?:komma|point)\s*(\d)\b/g, '$1.$2')
    .replace(/(\d+)\s*(?:einhalb|and a half)\b/g, '$1.5')
    .replace(/\s*[×]\s*/g, ' x ');
}

const WEIGHT = /(\d+(?:\.\d+)?)\s*(?:kg|kilos?|kilogramm|lbs?|pfund|pounds?)\b/;
const REPS = /(\d+)\s*(?:wdh\.?|wiederholungen|wiederholung|reps?|repetitions?)(?![a-z])/;
const SECONDS = /(\d+(?:\.\d+)?)\s*(?:s|sek\.?|sekunden?|seconds?)(?![a-z])/;
const MINUTES = /(\d+(?:\.\d+)?)\s*(?:min\.?|minuten?|minutes?)(?![a-z])/;
const DISTANCE = /(\d+(?:\.\d+)?)\s*(?:km|kilometer|kilometres?)(?![a-z])/;
const CLOCK = /\b(\d+):(\d{2})\b/;

function secondsIn(text) {
  const clock = text.match(CLOCK);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const minutes = text.match(MINUTES);
  const seconds = text.match(SECONDS);
  return minutes || seconds ? Math.round(Number(minutes?.[1] || 0) * 60 + Number(seconds?.[1] || 0)) : null;
}

// How far a reading lies from what is known for the set, relative to it; null when nothing is known to compare with.
function distance(weight, reps, known) {
  const parts = [
    [weight, known?.weight],
    [reps, known?.reps],
  ].filter(([value, ref]) => value !== null && Number(ref) > 0);
  return parts.length ? parts.reduce((sum, [value, ref]) => sum + Math.abs(value - ref) / ref, 0) : null;
}
// Whether the first of two bare numbers is the weight. "10 x 12" can be 10 kg × 12 on a dumbbell or 12 kg × 10, so the
// reading closer to the values known for this set wins; only without them does the larger number count as the weight.
function firstIsWeight(a, b, known) {
  if (Number.isInteger(a) !== Number.isInteger(b)) return !Number.isInteger(a);
  const asSaid = distance(a, b, known);
  const swapped = distance(b, a, known);
  return asSaid !== null && asSaid !== swapped ? asSaid < swapped : a >= b;
}

// Weights stay in the unit the person trains with, and so does `known` ({ weight, reps } this set is expected to
// hold, from the grey values or the last session). Returns null when nothing usable was said.
export function parseSet(text, trackType = 'weight_reps', known = null) {
  let rest = normalize(text);
  const take = (pattern) => {
    const match = rest.match(pattern);
    if (!match) return null;
    rest = rest.replace(match[0], ' ');
    return Number(match[1]);
  };
  if (trackType === 'time') {
    const time = secondsIn(rest);
    const bare = rest.match(/\b(\d+)\b/);
    if (time) return { time };
    return bare ? { time: Number(bare[1]) } : null;
  }
  if (trackType === 'distance_time') {
    const distance = take(DISTANCE);
    const time = secondsIn(rest);
    const result = {
      ...(distance ? { distance } : {}),
      ...(time ? { time } : {}),
    };
    return Object.keys(result).length ? result : null;
  }
  let weight = take(WEIGHT);
  let reps = take(REPS);
  const bare = [...rest.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (trackType === 'reps') {
    reps ??= bare[0] ?? null;
    return reps ? { reps, ...(weight ? { weight } : {}) } : null;
  }
  if (weight === null && reps === null && bare.length >= 2) {
    // "12 mal 60" or "60 x 12": a decimal gives the weight away, otherwise see firstIsWeight.
    const [a, b] = bare;
    const aIsWeight = firstIsWeight(a, b, known);
    weight = aIsWeight ? a : b;
    reps = aIsWeight ? b : a;
  } else if (weight === null && reps === null && bare.length) {
    // One number alone is the reps, unless it lies closer to the known weight than to the known reps.
    const [n] = bare;
    const asWeight = distance(n, null, known);
    const asReps = distance(null, n, known);
    if (asWeight !== null && asReps !== null && asWeight < asReps) weight = n;
    else reps = n;
  } else if (reps === null && bare.length) reps = bare[0];
  else if (weight === null && bare.length) weight = bare[0];
  if (!reps && !weight) return null;
  return { ...(weight ? { weight } : {}), ...(reps ? { reps: Math.round(reps) } : {}) };
}
