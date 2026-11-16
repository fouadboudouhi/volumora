// Top bar, bottom navigation and shared snippets.
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { goBack, navigate, render, switchTab } from '../render.js';
import { state } from '../state.js';
import { aiAvailable } from '../aiAccess.js';

const NAV = [
  ['home', 'nav.home', 'home'],
  ['plans', 'nav.plans', 'plan'],
  ['analytics', 'nav.history', 'chart'],
  ['ai', 'nav.ai', 'spark'],
  ['more', 'nav.more', 'more'],
];

export const topbar = () => '';

export const nav = (active) =>
  `<nav class="bottom-nav" aria-label="${t('nav.aria')}"><div class="bottom-nav-inner">${NAV.filter(
    ([view]) => view !== 'ai' || aiAvailable()
  )
    .map(
      ([view, label, ic]) =>
        `<button class="nav-btn ${active === view ? 'active' : ''}" data-nav="${view}" ${active === view ? 'aria-current="page"' : ''}><span>${icon(ic)}</span>${t(label)}</button>`
    )
    .join('')}</div></nav>`;

export const mediaCredit = () =>
  `<footer class="media-credit">${t('credit.media')} <a href="https://github.com/YaKohen/exercises-dataset" target="_blank" rel="noopener">Exercises Dataset</a> · <a href="https://exercisedb.dev" target="_blank" rel="noopener">ExerciseDB</a></footer>`;
export const empty = (title, text, action) =>
  `<div class="empty"><strong>${title}</strong><p>${text}</p>${action ? `<button type="button" class="secondary empty-action" ${action.attrs}>${action.label}</button>` : ''}</div>`;
// The back control names the screen it returns to, the way the platform does; the current screen keeps its title.
const PARENT_LABEL = {
  home: 'nav.home',
  plans: 'nav.plans',
  analytics: 'nav.history',
  more: 'nav.more',
  templates: 'templates.title',
  calendar: 'calendar.title',
  ai: 'nav.ai',
  admin: 'admin.title',
};
export const parentRow = (target) =>
  `<div class="backrow"><button class="back" data-nav="${target}" aria-label="${t('common.back')}">${icon('chevron-left')}</button><span>${t(PARENT_LABEL[target] || 'common.back')}</span></div>`;
export const backRow = (label, target) =>
  `<div class="backrow"><button class="back" data-nav="${target}" aria-label="${t('common.back')}">${icon('chevron-left')}</button><span>${label}</span></div>`;

export function bindShell() {
  document.onkeydown = null;
  document.querySelectorAll('[data-nav]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.nav === 'calendar' && state.view !== 'calendar') state.calendarOffset = 0;
      if (b.dataset.nav === 'ai') state.aiReturn = state.view;
      if (b.classList.contains('back')) goBack(b.dataset.nav);
      else if (b.classList.contains('nav-btn')) switchTab(b.dataset.nav);
      else navigate(b.dataset.nav);
    };
  });
}
