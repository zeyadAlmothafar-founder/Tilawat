// "Backgrounds" page: provider status, approved clips per category, candidate search
// (approve / hide), and uploads of the user's own clips.
import * as api from './api.js';
import { t, tNodes, fmtNumber, fmtDuration, fmtPercent, isRtl, onLanguageChange } from './i18n.js';
import { h, fill, toast, showError, confirmDialog, stateBlock, loadingBlock, errorBlock, externalLink } from './ui.js';
import { icon } from './icons.js';
import { currentAspect } from './create.js';

const CATEGORIES = ['nature', 'space', 'mosque', 'islamic'];
const PROVIDERS = ['pexels', 'pixabay', 'nasa', 'upload'];
const KEY_LINKS = { pexels: 'https://www.pexels.com/api/', pixabay: 'https://pixabay.com/api/docs/' };
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const TYPE_BY_EXT = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const ORIENTATION_FOR_ASPECT = { '9:16': 'portrait', '16:9': 'landscape', '1:1': 'square' };

let els = {};
let status = null;
let statusError = null;
let category = 'nature';
let view = 'approved';
let orientation = null;
const approved = new Map(); // category -> { clips, loading, error }
const candidates = new Map(); // `${category}|${orientation}` -> { clips, page, hasMore, loading, error }
let upload = null; // { name, category, progress, abort }

export function init(section) {
  const $ = (sel) => section.querySelector(sel);
  els = {
    status: $('#library-status'),
    tabs: $('#library-cats'),
    views: $('#library-views'),
    findTools: $('#find-tools'),
    orientation: $('#orientation-select'),
    panel: $('#library-panel'),
    uploadBtn: $('#upload-btn'),
    file: $('#upload-input'),
    upload: $('#upload-progress'),
  };
  els.uploadBtn.addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', onFileChosen);
  els.views.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) setView(btn.dataset.view);
  });
  els.orientation.addEventListener('change', () => {
    orientation = els.orientation.value;
    renderPanel();
  });
  els.tabs.addEventListener('keydown', onTabKeydown);
  onLanguageChange(renderAll);
}

export function show() {
  if (orientation === null) orientation = ORIENTATION_FOR_ASPECT[currentAspect()] || '';
  els.orientation.value = orientation;
  loadStatus();
  loadApproved(category);
  renderAll();
}

function renderAll() {
  if (!els.panel) return;
  renderStatus();
  renderTabs();
  renderViews();
  renderPanel();
  renderUpload();
}

// ---------- data ----------

function loadStatus() {
  api.getSourcesStatus()
    .then((s) => { status = s; statusError = null; })
    .catch((err) => { statusError = err; })
    .finally(() => { renderStatus(); renderTabs(); });
}

function loadApproved(cat) {
  const entry = approved.get(cat) || { clips: [] };
  entry.loading = true;
  approved.set(cat, entry);
  api.getLibrary(cat)
    .then((clips) => { entry.clips = Array.isArray(clips) ? clips : []; entry.error = null; })
    .catch((err) => { entry.error = err; })
    .finally(() => {
      entry.loading = false;
      entry.loaded = true;
      if (cat === category && view === 'approved') renderPanel();
      renderTabs();
    });
}

const candidateKey = () => `${category}|${orientation || ''}`;

function loadCandidates({ more = false } = {}) {
  const key = candidateKey();
  const cat = category;
  const entry = candidates.get(key) || { clips: [], page: 0, hasMore: true };
  if (entry.loading) return;
  entry.loading = true;
  entry.error = null;
  candidates.set(key, entry);
  const page = more ? entry.page + 1 : 1;
  if (!more) entry.clips = [];
  renderPanel();
  api.getCandidates({ category: cat, page, orientation: orientation || undefined })
    .then((res) => {
      const seen = new Set(entry.clips.map((c) => c.id));
      entry.clips.push(...(res?.clips || []).filter((c) => !seen.has(c.id)));
      entry.page = res?.page || page;
      entry.hasMore = Boolean(res?.hasMore);
      entry.warnings = Array.isArray(res?.warnings) ? res.warnings : [];
    })
    .catch((err) => { entry.error = err; })
    .finally(() => {
      entry.loading = false;
      if (candidateKey() === key && view === 'find') renderPanel();
    });
}

function approvedCount(cat) {
  const entry = approved.get(cat);
  if (entry?.loaded && !entry.error) return entry.clips.length;
  const n = status?.library?.[cat]?.approved;
  return typeof n === 'number' ? n : null;
}

// ---------- status ----------

function renderStatus() {
  if (!status) {
    els.status.replaceChildren(statusError ? errorBlock(statusError, loadStatus, t('library.statusError')) : loadingBlock());
    return;
  }
  const providers = status.providers || {};
  const pills = PROVIDERS.map((id) => {
    const enabled = Boolean(providers[id]?.enabled);
    const always = id === 'nasa' || id === 'upload';
    return h(
      'li',
      { class: `provider-pill ${enabled ? 'is-on' : 'is-off'}` },
      icon(enabled ? 'check' : 'x'),
      h('span', { class: 'provider-name', text: t(`providers.${id}`) }),
      h('span', { class: 'provider-state', text: enabled ? t(always ? 'library.providers.alwaysOn' : 'library.providers.enabled') : t('library.providers.disabled') }),
    );
  });
  const missing = ['pexels', 'pixabay'].filter((id) => !providers[id]?.enabled);
  fill(
    els.status,
    h('div', { class: 'provider-row' }, h('h2', { class: 'subhead', text: t('library.providers.title') }), h('ul', { class: 'provider-pills' }, pills)),
    missing.length ? keysHelp(missing) : null,
  );
}

function keysHelp(missing) {
  const code = (text) => h('code', { dir: 'ltr', text });
  const env = missing.map((id) => `${id.toUpperCase()}_API_KEY=…`).join('\n');
  return h(
    'details',
    { class: 'callout callout-gold keys-help', open: missing.length === 2 },
    h('summary', {}, icon('key'), h('span', { text: t('library.keys.title') })),
    h(
      'ol',
      { class: 'keys-steps' },
      h('li', {}, tNodes('library.keys.step1', { pexels: externalLink(KEY_LINKS.pexels, 'Pexels'), pixabay: externalLink(KEY_LINKS.pixabay, 'Pixabay') })),
      h('li', {}, tNodes('library.keys.step2', { example: code('.env.example'), file: code('.env') }), h('pre', { class: 'code-block', dir: 'ltr', text: env })),
      h('li', {}, t('library.keys.step3')),
    ),
    h('p', { class: 'muted small', text: t('library.keys.nasaNote') }),
  );
}

// ---------- tabs & views ----------

function renderTabs() {
  els.tabs.replaceChildren(
    ...CATEGORIES.map((id) => {
      const selected = id === category;
      const count = approvedCount(id);
      return h(
        'button',
        {
          type: 'button',
          role: 'tab',
          id: `lib-tab-${id}`,
          class: 'cat-tab',
          'aria-selected': String(selected),
          'aria-controls': 'library-panel',
          tabindex: selected ? '0' : '-1',
          dataset: { cat: id },
          onclick: () => setCategory(id),
        },
        h('span', { class: 'chip-swatch', dataset: { cat: id }, 'aria-hidden': 'true' }),
        h('span', { text: t(`categories.${id}`) }),
        count != null && h('span', { class: 'tab-count', text: fmtNumber(count) }),
      );
    }),
  );
  els.panel.setAttribute('aria-labelledby', `lib-tab-${category}`);
}

function onTabKeydown(e) {
  const keys = { ArrowRight: isRtl() ? -1 : 1, ArrowLeft: isRtl() ? 1 : -1 };
  let index = CATEGORIES.indexOf(category);
  if (e.key in keys) index = (index + keys[e.key] + CATEGORIES.length) % CATEGORIES.length;
  else if (e.key === 'Home') index = 0;
  else if (e.key === 'End') index = CATEGORIES.length - 1;
  else return;
  e.preventDefault();
  setCategory(CATEGORIES[index]);
  els.tabs.querySelector(`[data-cat="${CATEGORIES[index]}"]`)?.focus();
}

function setCategory(id) {
  if (id === category) return;
  category = id;
  if (!approved.get(id)?.loaded) loadApproved(id);
  renderTabs();
  renderPanel();
}

function setView(next) {
  view = next;
  renderViews();
  renderPanel();
}

function renderViews() {
  for (const btn of els.views.querySelectorAll('[data-view]')) btn.setAttribute('aria-pressed', String(btn.dataset.view === view));
  els.findTools.hidden = view !== 'find';
}

// ---------- panel ----------

function renderPanel() {
  if (view === 'approved') renderApproved();
  else renderCandidates();
}

function renderApproved() {
  const entry = approved.get(category);
  if (!entry || (entry.loading && !entry.loaded)) return els.panel.replaceChildren(loadingBlock());
  if (entry.error) return els.panel.replaceChildren(errorBlock(entry.error, () => loadApproved(category), t('library.loadError')));
  if (!entry.clips.length) {
    return els.panel.replaceChildren(
      stateBlock({
        iconName: 'image',
        title: t('library.approvedEmpty.title'),
        text: t('library.approvedEmpty.text'),
        action: h(
          'div',
          { class: 'state-actions' },
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => setView('find') }, icon('search'), t('library.findTab')),
          h('button', { type: 'button', class: 'btn', onclick: () => els.file.click() }, icon('upload'), t('library.upload.button')),
        ),
      }),
    );
  }
  els.panel.replaceChildren(h('div', { class: 'clip-grid' }, entry.clips.map((clip) => clipCard(clip, 'approved'))));
}

function renderCandidates() {
  const entry = candidates.get(candidateKey());
  if (!entry) {
    loadCandidates();
    return;
  }
  if (entry.loading && !entry.clips.length) return els.panel.replaceChildren(loadingBlock());
  if (entry.error && !entry.clips.length) return els.panel.replaceChildren(errorBlock(entry.error, () => loadCandidates(), t('library.loadError')));
  const warnings = warningsBlock(entry.warnings);
  if (!entry.clips.length) {
    const noKeys = status && !status.providers?.pexels?.enabled && !status.providers?.pixabay?.enabled;
    return fill(
      els.panel,
      warnings,
      stateBlock({
        iconName: noKeys ? 'key' : 'search',
        title: noKeys ? t('library.candidatesNoKeys') : null,
        text: noKeys ? t('library.candidatesNoKeysText') : t('library.candidatesEmpty'),
        action: h(
          'div',
          { class: 'state-actions' },
          noKeys && h('button', { type: 'button', class: 'btn btn-primary', onclick: showKeysHelp }, icon('key'), t('library.keys.show')),
          h('button', { type: 'button', class: 'btn', onclick: () => loadCandidates() }, icon('refresh'), t('common.retry')),
        ),
      }),
    );
  }
  const more = entry.hasMore
    ? h('div', { class: 'load-more' }, h('button', { type: 'button', class: 'btn', disabled: entry.loading, onclick: () => loadCandidates({ more: true }) }, entry.loading ? h('span', { class: 'spinner spinner-sm' }) : icon('chevronDown'), t('common.loadMore')))
    : null;
  fill(els.panel, warnings, h('div', { class: 'clip-grid' }, entry.clips.map((clip) => clipCard(clip, 'candidate'))), more);
}

/** Provider hiccups reported by the server (e.g. one source timed out) — shown quietly. */
function warningsBlock(warnings = []) {
  const lines = warnings
    .map((w) => (typeof w === 'string' ? w : [w?.provider && t(`providers.${w.provider}`), w?.message].filter(Boolean).join(': ')))
    .filter(Boolean);
  if (!lines.length) return null;
  return h('div', { class: 'library-warnings', role: 'note' }, icon('alert'), h('div', {}, h('p', { text: t('library.warnings') }), h('ul', {}, lines.map((l) => h('li', { dir: 'auto', text: l })))));
}

function showKeysHelp() {
  const details = els.status.querySelector('.keys-help');
  if (!details) return;
  details.open = true;
  details.scrollIntoView({ behavior: 'smooth', block: 'center' });
  details.querySelector('summary')?.focus({ preventScroll: true });
}

// ---------- clip card ----------

function clipCard(clip, kind) {
  const title = clip.title || t(`providers.${clip.provider}`);
  const media = h(
    'button',
    { type: 'button', class: 'clip-media', 'aria-pressed': 'false', 'aria-label': `${t('library.preview')}: ${title}` },
    icon('film', 'clip-placeholder'),
    clip.thumbUrl && h('img', { src: clip.thumbUrl, alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.currentTarget.remove() }),
    h('span', { class: 'clip-play' }, icon('play')),
    clip.duration ? h('span', { class: 'clip-badge clip-duration', text: fmtDuration(clip.duration) }) : null,
    h('span', { class: 'clip-badge clip-provider', text: t(`providers.${clip.provider}`) }),
  );
  wirePreview(media, clip);

  const credit = clip.author
    ? h('p', { class: 'clip-credit' }, tNodes('library.credit', {
        author: clip.authorUrl ? externalLink(clip.authorUrl, clip.author) : clip.author,
        provider: clip.sourceUrl ? externalLink(clip.sourceUrl, t(`providers.${clip.provider}`)) : t(`providers.${clip.provider}`),
      }))
    : null;

  const card = h('article', { class: 'clip-card' }, media, h('div', { class: 'clip-body' }, h('p', { class: 'clip-title', dir: 'auto', text: title }), credit));
  const actions =
    kind === 'approved'
      ? [h('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: () => removeApproved(clip) }, icon('trash'), t('common.remove'))]
      : [
          h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => approve(clip, card) }, icon('check'), t('library.approve')),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => reject(clip, card) }, icon('x'), t('library.reject')),
        ];
  card.append(h('div', { class: 'clip-actions' }, actions));
  return card;
}

/** Hover (mouse) or press (touch/keyboard) plays the muted preview. */
function wirePreview(media, clip) {
  const src = clip.previewUrl;
  if (!src) return;
  let video = null;
  const start = () => {
    if (video) return;
    video = h('video', { class: 'clip-video', src, muted: true, loop: true, playsInline: true, autoplay: true, preload: 'auto' });
    media.append(video);
    media.setAttribute('aria-pressed', 'true');
    video.play().catch(() => {});
  };
  const stop = () => {
    if (!video) return;
    video.pause();
    video.remove();
    video = null;
    media.setAttribute('aria-pressed', 'false');
  };
  media.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') start(); });
  media.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') stop(); });
  media.addEventListener('click', () => (video ? stop() : start()));
  media.addEventListener('blur', stop);
}

function bumpCount(cat, delta) {
  const lib = status?.library?.[cat];
  if (lib && typeof lib.approved === 'number') lib.approved = Math.max(0, lib.approved + delta);
}

function removeCandidate(clip) {
  const entry = candidates.get(candidateKey());
  if (!entry) return;
  entry.clips = entry.clips.filter((c) => c.id !== clip.id);
  if (!entry.clips.length && entry.hasMore) loadCandidates({ more: true });
}

function setCardBusy(card, busy) {
  for (const b of card.querySelectorAll('.clip-actions button')) b.disabled = busy;
  card.classList.toggle('is-busy', busy);
}

/** After removing a card, keep keyboard focus in the grid. */
function focusNear(card) {
  const next = card.nextElementSibling || card.previousElementSibling;
  const target = next?.querySelector('.clip-actions button') || els.panel.querySelector('button');
  card.remove();
  target?.focus();
}

async function approve(clip, card) {
  setCardBusy(card, true);
  try {
    const saved = await api.approveClip({ ...clip, category: clip.category || category });
    const entry = approved.get(category);
    if (entry) entry.clips.unshift(saved && typeof saved === 'object' && saved.id ? saved : { ...clip, status: 'approved' });
    else bumpCount(category, 1);
    removeCandidate(clip);
    focusNear(card);
    renderTabs();
    toast(t('library.approved'), { type: 'success' });
    if (!els.panel.querySelector('.clip-card')) renderPanel();
  } catch (err) {
    setCardBusy(card, false);
    showError(err);
  }
}

async function reject(clip, card) {
  setCardBusy(card, true);
  try {
    await api.rejectClip({ id: clip.id, category: clip.category || category });
    removeCandidate(clip);
    focusNear(card);
    toast(t('library.rejected'));
    if (!els.panel.querySelector('.clip-card')) renderPanel();
  } catch (err) {
    setCardBusy(card, false);
    showError(err);
  }
}

async function removeApproved(clip) {
  const ok = await confirmDialog({ title: t('common.remove'), message: t('library.removeConfirm'), confirmText: t('common.remove'), danger: true });
  if (!ok) return;
  try {
    await api.removeClip(clip.id);
    const cat = clip.category || category;
    const entry = approved.get(cat);
    if (entry) entry.clips = entry.clips.filter((c) => c.id !== clip.id);
    else bumpCount(cat, -1);
    renderTabs();
    renderPanel();
    toast(t('library.removed'), { type: 'success' });
  } catch (err) {
    showError(err);
  }
}

// ---------- upload ----------

function onFileChosen() {
  const file = els.file.files?.[0];
  els.file.value = '';
  if (!file) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const type = Object.values(TYPE_BY_EXT).includes(file.type) ? file.type : TYPE_BY_EXT[ext];
  if (!type) return toast(t('library.upload.badType'), { type: 'error' });
  if (file.size > MAX_UPLOAD_BYTES) return toast(t('library.upload.tooLarge'), { type: 'error' });
  if (upload) return;

  const cat = category;
  const { promise, abort } = api.uploadClip(file, {
    category: cat,
    type,
    onProgress: (p) => { if (upload) { upload.progress = p; renderUploadProgress(); } },
  });
  upload = { name: file.name, category: cat, progress: 0, abort };
  renderUpload();
  promise
    .then((clip) => {
      const entry = approved.get(cat);
      if (entry && clip?.id) entry.clips.unshift(clip);
      else if (!entry) bumpCount(cat, 1);
      toast(t('library.upload.done'), { type: 'success' });
      renderTabs();
      if (cat === category && view === 'approved') renderPanel();
    })
    .catch((err) => {
      if (err.name === 'AbortError') toast(t('library.upload.canceled'));
      else showError(err);
    })
    .finally(() => {
      upload = null;
      renderUpload();
    });
}

function renderUpload() {
  els.uploadBtn.disabled = Boolean(upload);
  if (!upload) {
    els.upload.replaceChildren();
    els.upload.hidden = true;
    return;
  }
  els.upload.hidden = false;
  els.upload.replaceChildren(
    h(
      'div',
      { class: 'upload-card' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'upload-info' },
        h('p', { class: 'upload-name', text: t('library.upload.uploading', { name: upload.name, category: t(`categories.${upload.category}`) }) }),
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': t('library.upload.button') }, h('span', { class: 'progress-fill' })),
      ),
      h('span', { class: 'upload-percent' }),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => upload?.abort() }, icon('x'), t('common.cancel')),
    ),
  );
  renderUploadProgress();
}

function renderUploadProgress() {
  if (!upload) return;
  const p = upload.progress || 0;
  const fill = els.upload.querySelector('.progress-fill');
  if (fill) fill.style.width = `${(p * 100).toFixed(1)}%`;
  els.upload.querySelector('.progress')?.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  const percent = els.upload.querySelector('.upload-percent');
  if (percent) percent.textContent = fmtPercent(p);
}
