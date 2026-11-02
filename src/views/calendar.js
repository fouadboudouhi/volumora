import { plural, t, weekdayShort } from '../i18n.js';
import { icon } from '../icons.js';
import { state } from '../state.js';
import { activePlan, getHistory } from '../storage.js';
import { navigate } from '../render.js';
import { actionSheet } from '../ui.js';
import { dayKey, esc, fmtLong, fmtMonth, number, weekdayIndex } from '../util.js';
import { empty, parentRow } from './shell.js';

export function view() {
  const history = getHistory();
  const plan = activePlan();
  const today = new Date();
  const offsetMonths = number(state.calendarOffset);
  const first = new Date(today.getFullYear(), today.getMonth() + offsetMonths, 1);
  const year = first.getFullYear();
  const month = first.getMonth();
  const offset = weekdayIndex(first);
  const days = new Date(year, month + 1, 0).getDate();
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  const sessions = new Map();
  history.forEach((h) => {
    const key = h.day || dayKey(h.finishedAt);
    if (key.startsWith(prefix)) sessions.set(key, [...(sessions.get(key) || []), h]);
  });
  const todayKey = dayKey(today);
  const cells = Array.from({ length: offset + days }, (_, i) => {
    if (i < offset) return '<div class="calendar-day blank"></div>';
    const d = new Date(year, month, i - offset + 1);
    const key = dayKey(d);
    const done = sessions.get(key) || [];
    if (done.length)
      return `<button type="button" class="calendar-day completed ${key === todayKey ? 'today' : ''}" data-sessions="${esc(done.map((s) => s.id).join(' '))}" aria-label="${esc(t('calendar.open', { day: d.getDate() }))}"><span>${d.getDate()}</span><b>${esc(done[0].dayName || t('session.title'))}</b></button>`;
    return `<div class="calendar-day ${key === todayKey ? 'today' : ''}"><span>${d.getDate()}</span></div>`;
  });
  return `<main class="shell calendar-shell">${parentRow('analytics')}<section class="calendar-head"><h1>${fmtMonth(first)}</h1><div class="calendar-nav"><button class="icon-btn" data-calendar-shift="-1" aria-label="${t('calendar.prev')}">${icon('chevron-left')}</button>${offsetMonths ? `<button class="icon-btn" data-calendar-shift="0">${t('calendar.today')}</button>` : ''}<button class="icon-btn" data-calendar-shift="1" aria-label="${t('calendar.next')}">${icon('chevron-right')}</button></div></section><div class="calendar-weekdays">${[0, 1, 2, 3, 4, 5, 6].map((x) => `<span>${weekdayShort(x)}</span>`).join('')}</div><section class="calendar-grid">${cells.join('')}</section></main>`;
}

export function bind() {
  const open = (sessionId) => navigate('session', { sessionFrom: 'calendar', sessionId });
  document.querySelectorAll('[data-sessions]').forEach((b) => {
    b.onclick = () => {
      const ids = b.dataset.sessions.split(' ');
      if (ids.length === 1) return open(ids[0]);
      const history = getHistory();
      actionSheet(
        fmtLong(history.find((h) => h.id === ids[0])?.day),
        ids.map((id) => ({
          label: history.find((h) => h.id === id)?.dayName || t('session.title'),
          onClick: () => open(id),
        }))
      );
    };
  });
  document.querySelectorAll('[data-calendar-shift]').forEach((b) => {
    b.onclick = () => {
      const shift = number(b.dataset.calendarShift);
      state.calendarOffset = shift ? number(state.calendarOffset) + shift : 0;
      navigate('calendar');
    };
  });
}
