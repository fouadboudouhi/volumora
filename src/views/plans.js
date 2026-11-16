import { plural, t } from '../i18n.js';
import { icon } from '../icons.js';
import { createEmptyPlan } from '../plans.js';
import { navigate, render } from '../render.js';
import { aiAvailable } from '../aiAccess.js';
import { allPlans, savePlans } from '../storage.js';
import { actionSheet, toast } from '../ui.js';
import { esc } from '../util.js';
import { openAi } from './ai.js';

const planRow = (p, activeId) => {
  const count = p.days.reduce((n, d) => n + d.exercises.length, 0);
  return `<div class="row-wrap"><button type="button" class="row" data-edit-plan="${esc(p.id)}"><span class="row-main"><b>${esc(p.name)}${p.id === activeId ? `<span class="chip chip-green">${t('plans.active')}</span>` : ''}</b><small>${plural(p.days.length, 'days')} · ${plural(count, 'exercises')}</small></span>${icon('chevron-right')}</button>${p.id === activeId ? '' : `<button type="button" class="compact-btn secondary" data-activate-plan="${esc(p.id)}">${t('plans.activate')}</button>`}</div>`;
};

export function view() {
  const data = allPlans();
  return `<main class="shell"><section class="page-head"><h1>${t('plans.title')}</h1><button class="icon-btn" id="newPlan" aria-label="${t('plans.new')}">${icon('plus')}</button></section>
  <div class="list">${data.items.map((p) => planRow(p, data.activePlanId)).join('')}</div></main>`;
}

export function bind() {
  document.querySelector('#newPlan')?.addEventListener('click', () =>
    actionSheet(t('plans.newTitle'), [
      {
        label: t('plans.fromTemplate'),
        hint: t('plans.fromTemplateHint'),
        onClick: () => navigate('templates', { templateId: null, templatePreview: null }),
      },
      {
        label: t('plans.withAssistant'),
        hint: t('plans.withAssistantHint'),
        onClick: () =>
          navigate('assistant', { assistantStep: 1, assistantDraft: null, assistantPreview: null }),
      },
      aiAvailable() && {
        label: t('plans.withAi'),
        hint: t('plans.withAiHint'),
        onClick: () => openAi('plans', { aiInput: t('ai.planQuestion'), aiAutoSend: true }),
      },
      {
        label: t('plans.empty'),
        hint: t('plans.emptyHint'),
        onClick: () => {
          const data = allPlans();
          const plan = createEmptyPlan();
          data.items.push(plan);
          savePlans(data);
          navigate('planEditor', { editPlanId: plan.id, editorDayIndex: 0, editorReturn: 'plans' });
        },
      },
    ])
  );
  document.querySelectorAll('[data-activate-plan]').forEach((b) => {
    b.onclick = () => {
      const data = allPlans();
      data.activePlanId = b.dataset.activatePlan;
      savePlans(data);
      render();
      toast(t('editor.nowActive'));
    };
  });
  document.querySelectorAll('[data-edit-plan]').forEach((b) => {
    b.onclick = () =>
      navigate('planEditor', { editPlanId: b.dataset.editPlan, editorDayIndex: 0, editorReturn: 'plans' });
  });
}
