// Canvas line charts with crosshair tooltips, plus the aggregations the analytics screen shows.
import { fmtNumber, t } from './i18n.js';
import { setScore, trackTypeOf } from './sets.js';
import { state } from './state.js';
import { frequency, groupSetsPerWeek, strengthVsBodyweight, weeklyVolume } from './stats.js';
import { getBody, getHistory } from './storage.js';
import { toDisplay, unit } from './units.js';
import { dayKey, exerciseKey, fmtDate, rangeCutoff, volumeOf } from './util.js';

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = (value, suffix) => `${fmtNumber(Math.round(value))}${suffix}`;

// Single-series line chart. Hover, touch and arrow keys move a crosshair; the tooltip shows value and date.
// `secondary` adds a second series on its own right-hand axis: { points: [{ value|null }], color, suffix },
// aligned with `points` by index; null values leave a gap.
export function lineChart(
  canvas,
  points,
  { color = token('--green'), suffix = '', fill = true, secondary = null, whole = false } = {}
) {
  if (!canvas || !points.length) return;
  const card = canvas.parentElement;
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = Number(canvas.getAttribute('height')) || 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const c = canvas.getContext('2d');
  const pad = { l: 58, r: secondary ? 46 : 14, t: 18, b: 28 };
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals);
  const low = Math.max(...vals);
  // A flat series (e.g. one session, or all zeros) spans upwards instead of producing negative ticks.
  const max = low === min ? low + Math.max(1, Math.abs(low) * 0.1) : low;
  const span = max - min;
  const x = (i) => pad.l + (i / Math.max(1, points.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / span) * (h - pad.t - pad.b);
  const surface = token('--surface') || '#fff';
  const second = secondary?.points?.filter((p) => p.value != null).map((p) => p.value) || [];
  const min2 = second.length ? Math.min(...second) : 0;
  const max2 = second.length ? Math.max(...second) : 0;
  const span2 = max2 - min2 || Math.max(1, max2 * 0.1);
  const y2 = (v) => pad.t + (1 - (v - min2) / span2) * (h - pad.t - pad.b);

  const draw = (highlight) => {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.font = '500 11px Satoshi, system-ui, sans-serif';
    c.lineWidth = 1;
    c.strokeStyle = token('--line');
    c.fillStyle = token('--muted');
    for (let i = 0; i < 3; i++) {
      const yy = pad.t + (i * (h - pad.t - pad.b)) / 2;
      c.beginPath();
      c.moveTo(pad.l, yy);
      c.lineTo(w - pad.r, yy);
      c.stroke();
      const tick = max - (i * span) / 2;
      // A count has no halves: its middle line stays unlabelled rather than repeating a rounded number.
      if (!whole || Number.isInteger(tick)) c.fillText(fmt(tick, suffix), 4, yy + 4);
      if (second.length) {
        const text = fmt(max2 - (i * span2) / 2, secondary.suffix || '');
        c.fillStyle = secondary.color || token('--blue');
        c.fillText(text, w - c.measureText(text).width - 4, yy + 4);
        c.fillStyle = token('--muted');
      }
    }
    if (second.length) {
      c.beginPath();
      let pen = false;
      secondary.points.forEach((p, i) => {
        if (p.value == null) {
          pen = false;
          return;
        }
        if (pen) c.lineTo(x(i), y2(p.value));
        else c.moveTo(x(i), y2(p.value));
        pen = true;
      });
      c.lineWidth = 2;
      c.strokeStyle = secondary.color || token('--blue');
      c.setLineDash([4, 4]);
      c.stroke();
      c.setLineDash([]);
      c.lineWidth = 1;
    }
    if (fill) {
      c.beginPath();
      points.forEach((p, i) => (i ? c.lineTo(x(i), y(p.value)) : c.moveTo(x(i), y(p.value))));
      c.lineTo(x(points.length - 1), h - pad.b);
      c.lineTo(x(0), h - pad.b);
      c.closePath();
      c.globalAlpha = 0.08;
      c.fillStyle = color;
      c.fill();
      c.globalAlpha = 1;
    }
    if (highlight >= 0) {
      c.strokeStyle = token('--muted');
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(x(highlight), pad.t);
      c.lineTo(x(highlight), h - pad.b);
      c.stroke();
      c.setLineDash([]);
    }
    c.beginPath();
    points.forEach((p, i) => (i ? c.lineTo(x(i), y(p.value)) : c.moveTo(x(i), y(p.value))));
    c.lineWidth = 2;
    c.strokeStyle = color;
    c.lineJoin = 'round';
    c.stroke();
    points.forEach((p, i) => {
      const r = i === highlight ? 5 : 4;
      c.beginPath();
      c.arc(x(i), y(p.value), r + 2, 0, Math.PI * 2);
      c.fillStyle = surface;
      c.fill();
      c.beginPath();
      c.arc(x(i), y(p.value), r, 0, Math.PI * 2);
      c.fillStyle = color;
      c.fill();
    });
    c.fillStyle = token('--muted');
    const labels =
      points.length > 4
        ? [0, Math.floor((points.length - 1) / 2), points.length - 1]
        : points.map((_, i) => i);
    labels.forEach((i) => {
      const text = points[i].label;
      const width = c.measureText(text).width;
      c.fillText(text, Math.max(pad.l - 4, Math.min(x(i) - width / 2, w - width - 4)), h - 9);
    });
  };
  draw(-1);

  let tip = card.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    card.append(tip);
  }
  let current = -1;
  const show = (i) => {
    current = i;
    draw(i);
    tip.textContent = '';
    const value = document.createElement('strong');
    value.textContent = fmt(points[i].value, suffix);
    const label = document.createElement('span');
    label.textContent = points[i].label;
    tip.append(value, label);
    if (secondary?.points?.[i]?.value != null) {
      const extra = document.createElement('small');
      extra.textContent = fmt(secondary.points[i].value, secondary.suffix || '');
      tip.append(extra);
    }
    tip.hidden = false;
    const left = canvas.offsetLeft + x(i);
    tip.style.left = `${Math.max(canvas.offsetLeft + 40, Math.min(left, canvas.offsetLeft + w - 40))}px`;
    tip.style.top = `${canvas.offsetTop + y(points[i].value) - 12}px`;
  };
  const hide = () => {
    current = -1;
    draw(-1);
    tip.hidden = true;
  };
  const nearest = (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    let best = 0;
    points.forEach((_, i) => {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    });
    return best;
  };
  canvas.onpointermove = (e) => show(nearest(e));
  canvas.onpointerdown = (e) => show(nearest(e));
  canvas.onpointerleave = hide;
  canvas.tabIndex = 0;
  canvas.onfocus = () => show(current < 0 ? points.length - 1 : current);
  canvas.onblur = hide;
  canvas.onkeydown = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      show(
        Math.max(
          0,
          Math.min(
            points.length - 1,
            (current < 0 ? points.length - 1 : current) + (e.key === 'ArrowLeft' ? -1 : 1)
          )
        )
      );
    }
  };
}

const inRange = (cutoff) => (item) => !cutoff || (item.day || dayKey(item.finishedAt || item.date)) >= cutoff;
export const historyInRange = (range) => getHistory().filter(inRange(rangeCutoff(range)));
export const bodyInRange = (range) => getBody().filter(inRange(rangeCutoff(range)));

export const weightPoints = (range) =>
  bodyInRange(range)
    .filter((x) => x.weight)
    .slice()
    .reverse()
    .map((x) => ({ label: fmtDate(x.day || x.date), value: toDisplay(x.weight) }));

// Best score per session, oldest first: estimated 1RM for weighted exercises, otherwise reps, seconds or kilometres.
export function strengthSeries(history, key) {
  let suffix = ` ${unit()}`;
  const points = history
    .map((h) => {
      const e = h.entries?.find((x) => exerciseKey(x) === key);
      if (!e) return null;
      const type = e.trackType || trackTypeOf(e);
      const best = Math.max(0, ...e.sets.map((s) => setScore(s, type)));
      if (!best) return null;
      suffix =
        type === 'weight_reps'
          ? ` ${unit()}`
          : type === 'reps'
            ? ` ${t('workout.reps')}`
            : type === 'time'
              ? ' s'
              : ' km';
      const value = type === 'weight_reps' ? Math.round(toDisplay(best)) : Math.round(best * 100) / 100;
      return { label: fmtDate(h.day || h.finishedAt), value };
    })
    .filter(Boolean);
  return { points, suffix };
}

export function drawAnalytics(selectedKey, range) {
  const history = historyInRange(range).slice().reverse();
  lineChart(
    document.querySelector('#volumeChart'),
    history.slice(-16).map((h) => ({
      label: fmtDate(h.day || h.finishedAt),
      value: Math.round(toDisplay(h.volume || volumeOf(h))),
    })),
    { suffix: ` ${unit()}` }
  );
  const everything = getHistory().slice().reverse();
  const { points: strength, suffix } = strengthSeries(everything, selectedKey);
  lineChart(document.querySelector('#strengthChart'), strength.slice(-16), {
    color: token('--orange'),
    suffix,
  });
  // Body weight next to the strength of the selected exercise, both in the display unit.
  const combo = strengthVsBodyweight(getHistory(), getBody(), selectedKey);
  const comboReady = combo.points.length >= 2;
  document.querySelector('#bodyStrengthChart')?.toggleAttribute('hidden', !comboReady);
  document.querySelector('#bodyStrengthHint')?.toggleAttribute('hidden', !comboReady);
  document.querySelector('#bodyStrengthEmpty')?.toggleAttribute('hidden', comboReady);
  if (comboReady)
    lineChart(
      document.querySelector('#bodyStrengthChart'),
      combo.points.slice(-16).map((p) => ({ label: p.label, value: Math.round(toDisplay(p.value)) })),
      {
        color: token('--orange'),
        suffix,
        fill: false,
        secondary: {
          points: combo.weight
            .slice(-16)
            .map((p) => ({ value: p.value == null ? null : Math.round(toDisplay(p.value) * 10) / 10 })),
          color: token('--blue'),
          suffix: ` ${unit()}`,
        },
      }
    );
  const all = getHistory();
  if (state.analyticsGroup)
    lineChart(document.querySelector('#groupChart'), groupSetsPerWeek(all, state.analyticsGroup), {
      color: token('--blue'),
      whole: true,
    });
  lineChart(
    document.querySelector('#weeklyVolumeChart'),
    weeklyVolume(all, 12).map((p) => ({ label: p.label, value: Math.round(toDisplay(p.value)) })),
    { suffix: ` ${unit()}` }
  );
  lineChart(document.querySelector('#frequencyChart'), frequency(all, 12), {
    color: token('--blue'),
    whole: true,
  });
}
export function drawBodyChart() {
  lineChart(document.querySelector('#bodyChart'), weightPoints('all'), {
    color: token('--blue'),
    suffix: ` ${unit()}`,
  });
}
