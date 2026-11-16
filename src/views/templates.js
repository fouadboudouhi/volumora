// Template library: pick a programme, preview it, use it as is or adjust it in the editor.
import { plural, t } from '../i18n.js';
import { icon } from '../icons.js';
import { exerciseName } from '../library.js';
import { navigate } from '../render.js';
import { state } from '../state.js';
import { allPlans, savePlans } from '../storage.js';
import {
  TEMPLATES,
  planFromTemplate,
  templateById,
  templateDescription,
  templateName,
} from '../templates.js';
import { esc } from '../util.js';
import { parentRow } from './shell.js';

const equipmentLabel = (key) => t(`equipmentChoice.${key}`);

function preview(template) {
  const plan = (state.templatePreview ||= planFromTemplate(template.id));
  return `<main class="shell narrow"><div class="backrow"><button class="back" id="templatesBack" aria-label="${t('common.back')}">${icon('chevron-left')}</button><span>${t('templates.title')}</span></div><section class="assistant-hero preview-head"><h1>${esc(plan.name)}</h1><p>${esc(templateDescription(template))}</p></section><div class="plan-preview">${plan.days
    .map(
      (d, i) =>
        `<article><span>${i + 1}</span><div><h2>${esc(d.name)}</h2><p>${d.exercises.map((x) => esc(exerciseName(x))).join(' · ')}</p></div><b>${d.exercises.length}</b></article>`
    )
    .join(
      ''
    )}</div><div class="preview-actions"><button class="primary" id="useTemplate">${t('wizard.use')}</button><button class="secondary" id="customizeTemplate">${t('wizard.customize')}</button></div></main>`;
}

export function view() {
  const template = templateById(state.templateId);
  if (template) return preview(template);
  state.templatePreview = null;
  const rows = TEMPLATES.map(
    (x) =>
      `<button type="button" class="row" data-template="${esc(x.id)}"><span class="row-main"><b>${esc(templateName(x))}</b><small>${esc(templateDescription(x))} · ${plural(x.days, 'trainingDays')} · ${esc(equipmentLabel(x.equipment))}</small></span>${icon('chevron-right')}</button>`
  ).join('');
  return `<main class="shell">${parentRow('plans')}<section class="page-head compact"><h1>${t('templates.title')}</h1></section><p class="muted templates-intro">${t('templates.intro')}</p><div class="list">${rows}</div></main>`;
}

export function bind() {
  document.querySelectorAll('[data-template]').forEach((b) => {
    b.onclick = () => navigate('templates', { templateId: b.dataset.template, templatePreview: null });
  });
  const accept = (customize) => {
    const plan = state.templatePreview || planFromTemplate(state.templateId);
    if (!plan) return;
    const data = allPlans();
    data.items.push(plan);
    data.activePlanId = plan.id;
    savePlans(data);
    Object.assign(state, { templateId: null, templatePreview: null });
    if (customize) navigate('planEditor', { editorReturn: 'home', editPlanId: plan.id, editorDayIndex: 0 });
    else navigate('home');
  };
  document.querySelector('#useTemplate')?.addEventListener('click', () => accept(false));
  document.querySelector('#customizeTemplate')?.addEventListener('click', () => accept(true));
  // Back from a preview returns to the list, not to the plans screen.
  document
    .querySelector('#templatesBack')
    ?.addEventListener('click', () => navigate('templates', { templateId: null, templatePreview: null }));
}
