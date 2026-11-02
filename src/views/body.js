import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { render } from '../render.js';
import { getBody, photos, saveBody } from '../storage.js';
import { toast, undoToast } from '../ui.js';
import { fieldValue, fmtWeight, fromDisplay, unit } from '../units.js';
import { dayKey, esc, fmtDate, number, uid } from '../util.js';
import { parentRow } from './shell.js';

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 900 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.72));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

const photoMarkup = (e) => {
  const alt = esc(t('body.photoAlt', { date: fmtDate(e.day || e.date) }));
  if (e.hasPhoto) return `<img data-photo="${esc(e.id)}" alt="${alt}">`;
  if (typeof e.photo === 'string' && e.photo.startsWith('data:image/'))
    return `<img src="${esc(e.photo)}" alt="${alt}">`;
  return '';
};
const measures = (e) =>
  [
    [t('body.waist'), e.waist],
    [t('body.chest'), e.chest],
    [t('body.arm'), e.arm],
    [t('body.thigh'), e.thigh],
  ]
    .filter((x) => x[1])
    .map((x) => `${x[0]} ${esc(x[1])} cm`)
    .join(' · ') || t('body.noMeasures');
const numberField = (name, label) =>
  `<label><span>${esc(t('body.cm', { label }))}</span><input type="number" step="any" min="0" name="${name}"></label>`;

export function view() {
  const entries = getBody();
  return `<main class="shell">${parentRow('more')}<section class="page-head compact"><h1>${t('body.title')}</h1></section>
    <form class="body-form" id="bodyForm" novalidate><label><span>${t('body.date')}</span><input type="date" name="date" value="${dayKey()}" required></label><label><span>${t('body.weight', { unit: unit() })}</span><input type="number" step="any" min="0" name="weight"></label><details class="more-fields"><summary>${t('body.moreFields')}</summary><div class="more-fields-grid">${numberField('waist', t('body.waist'))}${numberField('chest', t('body.chest'))}${numberField('arm', t('body.arm'))}${numberField('thigh', t('body.thighLong'))}<label class="photo-field"><span>${t('body.photo')}</span><input type="file" name="photo" accept="image/*"></label></div></details><button class="primary" type="submit">${t('common.save')}</button></form>
    ${entries.some((x) => x.weight) ? `<section class="chart-card"><h2>${t('body.chart')}</h2><canvas id="bodyChart" height="210" role="img" aria-label="${t('body.chart')}"></canvas></section>` : ''}
    <section class="body-grid">${entries.map((e) => `<article class="body-entry ${photoMarkup(e) ? '' : 'compact'}">${photoMarkup(e)}<div><span class="entry-date">${fmtDate(e.day || e.date)}</span><h3>${e.weight ? fmtWeight(e.weight) : t('body.entry')}</h3><p>${measures(e)}</p></div><button class="icon-btn danger" data-delete-body="${e.id}" aria-label="${t('body.deleteEntry')}">${icon('close')}</button></article>`).join('')}</section></main>`;
}

function loadPhotos() {
  document.querySelectorAll('img[data-photo]').forEach(async (img) => {
    const src = await photos.get(img.dataset.photo);
    if (src && img.isConnected) img.src = src;
  });
}

export function bind() {
  loadPhotos();
  document.querySelector('#bodyForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const file = f.get('photo');
    const day = dayKey(f.get('date')) || dayKey();
    const positive = (name) => Math.max(0, number(f.get(name)));
    if (!file?.size && !['weight', 'waist', 'chest', 'arm', 'thigh'].some(positive)) {
      toast(t('body.emptyEntry'));
      return;
    }
    const entry = {
      id: uid(),
      date: new Date(`${day}T12:00:00`).toISOString(),
      day,
      weight: Math.max(0, number(fromDisplay(f.get('weight')))) || '',
      waist: positive('waist') || '',
      chest: positive('chest') || '',
      arm: positive('arm') || '',
      thigh: positive('thigh') || '',
      hasPhoto: false,
    };
    if (file?.size) {
      try {
        await photos.set(entry.id, await compressImage(file));
        entry.hasPhoto = true;
      } catch {
        toast(t('body.photoFailed'));
      }
    }
    const all = getBody();
    all.unshift(entry);
    saveBody(all);
    render();
  });
  document.querySelectorAll('[data-delete-body]').forEach((b) => {
    b.onclick = () => {
      const all = getBody();
      const index = all.findIndex((x) => x.id === b.dataset.deleteBody);
      if (index < 0) return;
      const [removed] = all.splice(index, 1);
      saveBody(all);
      render();
      // The photo stays in IndexedDB until the undo window has passed.
      undoToast(
        t('body.deleted'),
        () => {
          const current = getBody();
          current.splice(Math.min(index, current.length), 0, removed);
          saveBody(current);
          render();
        },
        () => photos.remove(removed.id)
      );
    };
  });
}
