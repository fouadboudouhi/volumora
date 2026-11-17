// More › Custom exercises: create, edit and delete the exercises the catalogue does not have.
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { equipmentLabel, groupLabel } from '../library.js';
import { render } from '../render.js';
import { trackTypeLabel } from '../sets.js';
import {
  getCustomExercises,
  removeCustomExercise,
  saveCustomExercise,
  saveCustomExercises,
} from '../storage.js';
import { actionSheet, toast, undoToast } from '../ui.js';
import { esc } from '../util.js';
import { openCustomForm } from './customForm.js';
import { empty, parentRow } from './shell.js';

export function view() {
  const list = getCustomExercises().sort((a, b) => a.name.localeCompare(b.name));
  const rows = list
    .map(
      (x) =>
        `<button type="button" class="row" data-custom-exercise="${esc(x.id)}"><span class="row-main"><b>${esc(x.name)}</b><small>${esc([groupLabel(x.category || 'other'), equipmentLabel(x.equipment || 'other'), trackTypeLabel(x.trackType || 'weight_reps')].join(' · '))}</small></span>${icon('chevron-right')}</button>`
    )
    .join('');
  return `<main class="shell narrow">${parentRow('more')}<section class="page-head compact"><h1>${t('custom.title')}</h1></section>${
    rows ? `<div class="list">${rows}</div>` : empty(t('custom.empty'), t('custom.emptyText'))
  }<button type="button" class="primary full custom-new" id="newCustomExercise">${t('custom.new')}</button></main>`;
}

const save = (record) => {
  const saved = saveCustomExercise(record);
  render();
  // A refused write has already said so; "saved" on top would replace that message.
  if (saved) toast(t('custom.saved'));
};

export function bind() {
  document
    .querySelector('#newCustomExercise')
    ?.addEventListener('click', () => openCustomForm({ onSave: save }));
  document.querySelectorAll('[data-custom-exercise]').forEach((b) => {
    b.onclick = () => {
      const record = getCustomExercises().find((x) => x.id === b.dataset.customExercise);
      if (!record) return;
      actionSheet(record.name, [
        { label: t('custom.edit'), onClick: () => openCustomForm({ initial: record, onSave: save }) },
        {
          label: t('common.delete'),
          danger: true,
          onClick: () => {
            const result = removeCustomExercise(record.id);
            if (!result) return;
            render();
            undoToast(t('custom.deleted', { name: record.name }), () => {
              const list = getCustomExercises();
              list.splice(Math.min(result.index, list.length), 0, result.removed);
              saveCustomExercises(list);
              render();
            });
          },
        },
      ]);
    };
  });
}
