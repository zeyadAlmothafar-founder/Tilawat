// "Create" page: passages, recitation, backgrounds, format, style, live preview, submit.
import * as api from './api.js';
import { t, getLang, getLocale, isRtl, fmtNumber, fmtPercent, fmtApproxDuration, languageName, dirForLang, onLanguageChange, storageGet, storageSet } from './i18n.js';
import { h, debounce, clamp, toast, showError, errorBlock, loadingBlock, nextId } from './ui.js';
import { icon } from './icons.js';
import { createSurahPicker } from './surah-picker.js';
import { renderDevicePreview, renderAyahList } from './preview.js';

const MAX_VIDEOS = 50;
const MAX_AYAT_PER_VIDEO = 50;
const SECONDS_PER_AYAH = 6;
const MAX_LISTED_AYAT = 300;
const CATEGORIES = ['nature', 'space', 'mosque', 'islamic'];
const NO_BISMILLAH = new Set([1, 9]);
const STORE_KEY = 'qvs.create.v1';

const PRESETS = [
  { id: 'fatiha', items: [{ surah: 1, from: 1, to: 7 }] },
  { id: 'kursi', items: [{ surah: 2, from: 255, to: 255 }] },
  { id: 'baqarahEnd', items: [{ surah: 2, from: 285, to: 286 }] },
  { id: 'ikhlas', items: [{ surah: 112, from: 1, to: 4 }] },
  { id: 'falaq', items: [{ surah: 113, from: 1, to: 5 }] },
  { id: 'nas', items: [{ surah: 114, from: 1, to: 6 }] },
  { id: 'quls', items: [{ surah: 112, from: 1, to: 4 }, { surah: 113, from: 1, to: 5 }, { surah: 114, from: 1, to: 6 }] },
];

const DEFAULT_STATE = {
  items: [{ surah: 1, from: 1, to: 7 }],
  mode: 'combined',
  reciter: 'Alafasy_128kbps',
  translation: null,
  translationTouched: false,
  categories: ['nature'],
  approvedOnly: false,
  aspect: '9:16',
  quality: '1080',
  bismillah: true,
  style: { arabicFont: 'amiri', textScale: 1, position: 'center', overlay: 0.45, showSurahTitle: true, showReciter: true },
};

const ENUMS = {
  mode: ['combined', 'perAyah'],
  aspect: ['9:16', '16:9', '1:1'],
  quality: ['1080', '720'],
  arabicFont: ['amiri', 'scheherazade'],
  position: ['center', 'lower'],
};

let els = {};
let state;
let submitting = false;
let rows = []; // [{ item, li, from, to, msg, meta }]
let ayahGroups = [];
let textToken = 0;
let audio = null;
const bgCache = new Map(); // category -> thumb URL | null
const data = {
  surahs: null, surahMap: new Map(), surahsError: null,
  reciters: null, recitersError: null,
  translations: null, translationsError: null,
  status: null, bismillah: null,
};

// ---------- state ----------

const isInt = (n) => Number.isInteger(n) && n > 0;
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const withUid = (item) => ({ ...item, uid: nextId('sel') });

function loadState() {
  let saved = {};
  try { saved = JSON.parse(storageGet(STORE_KEY) || '{}') || {}; } catch { saved = {}; }
  const s = structuredClone(DEFAULT_STATE);
  const items = Array.isArray(saved.items) ? saved.items.filter((i) => i && isInt(i.surah) && isInt(i.from) && isInt(i.to) && i.surah <= 114) : [];
  if (items.length) s.items = items.slice(0, MAX_VIDEOS).map(({ surah, from, to }) => ({ surah, from, to }));
  s.mode = pick(saved.mode, ENUMS.mode, s.mode);
  s.aspect = pick(saved.aspect, ENUMS.aspect, s.aspect);
  s.quality = pick(saved.quality, ENUMS.quality, s.quality);
  if (typeof saved.reciter === 'string' && saved.reciter) s.reciter = saved.reciter;
  if (saved.translationTouched) {
    s.translationTouched = true;
    s.translation = typeof saved.translation === 'string' ? saved.translation : null;
  }
  const cats = Array.isArray(saved.categories) ? saved.categories.filter((c) => CATEGORIES.includes(c)) : [];
  if (cats.length) s.categories = cats;
  if (typeof saved.approvedOnly === 'boolean') s.approvedOnly = saved.approvedOnly;
  if (typeof saved.bismillah === 'boolean') s.bismillah = saved.bismillah;
  const st = saved.style || {};
  s.style.arabicFont = pick(st.arabicFont, ENUMS.arabicFont, s.style.arabicFont);
  s.style.position = pick(st.position, ENUMS.position, s.style.position);
  if (Number.isFinite(st.textScale)) s.style.textScale = clamp(st.textScale, 0.7, 1.5);
  if (Number.isFinite(st.overlay)) s.style.overlay = clamp(st.overlay, 0, 0.8);
  for (const k of ['showSurahTitle', 'showReciter']) if (typeof st[k] === 'boolean') s.style[k] = st[k];
  s.items = s.items.map(withUid);
  return s;
}

const saveStateSoon = debounce(() => {
  const { items, ...rest } = state;
  storageSet(STORE_KEY, JSON.stringify({ ...rest, items: items.map(({ surah, from, to }) => ({ surah, from, to })) }));
}, 300);

/** Aspect currently chosen on the Create page (used by the library's orientation filter). */
export const currentAspect = () => (state || loadState()).aspect;

function counts() {
  const ayat = state.items.reduce((n, i) => n + Math.max(0, i.to - i.from + 1), 0);
  const videos = state.mode === 'perAyah' ? ayat : state.items.length;
  return { ayat, videos, seconds: ayat * SECONDS_PER_AYAH };
}

const currentTranslation = () =>
  state.translation ? data.translations?.translations?.find((tr) => tr.key === state.translation) || null : null;

/** Language and text direction of the selected translation (null iso = Arabic only). */
function translationInfo() {
  const tr = currentTranslation();
  if (!tr) return { iso: null, dir: 'auto' };
  return { iso: tr.languageIso || 'und', dir: tr.direction || dirForLang(tr.languageIso) };
}

// ---------- init / lifecycle ----------

export function init(section) {
  const $ = (sel) => section.querySelector(sel);
  els = {
    section,
    form: $('#create-form'),
    presets: $('#preset-chips'),
    list: $('#selection-list'),
    add: $('#add-selection'),
    reciter: $('#reciter-select'),
    reciterPreview: $('#reciter-preview'),
    translation: $('#translation-select'),
    categories: $('#category-chips'),
    approvedOnly: $('#approved-only'),
    approvedNote: $('#approved-note'),
    textScale: $('#text-scale'),
    textScaleValue: $('#text-scale-value'),
    overlay: $('#overlay'),
    overlayValue: $('#overlay-value'),
    showTitle: $('#show-title'),
    showReciter: $('#show-reciter'),
    bismillah: $('#bismillah'),
    frame: $('#preview-frame'),
    summary: $('#create-summary'),
    errors: $('#create-errors'),
    submit: $('#create-submit'),
    ayahList: $('#ayah-list'),
  };
  state = loadState();

  buildPresets();
  buildCategories();
  syncControls();
  setAudioUi('idle');
  bindEvents();
  renderSelections();
  renderReciters();
  renderTranslations();
  onChange();
  loadData();

  onLanguageChange(() => {
    const before = state.translation;
    buildPresets();
    syncCategories();
    renderSelections();
    renderReciters();
    renderTranslations();
    syncOutputs();
    onChange({ texts: before !== state.translation });
    if (before === state.translation) renderAyahList(els.ayahList, ayahGroups, { maxAyat: MAX_LISTED_AYAT });
    setAudioUi(audio ? 'playing' : 'idle');
  });
}

export function show() {
  loadData();
  bgCache.clear();
  refreshStatus();
  loadBackground();
}

export function hide() {
  stopAudio();
}

function loadData() {
  if (!data.surahs) loadSurahs();
  if (!data.reciters) {
    api.getReciters()
      .then((list) => { data.reciters = Array.isArray(list) ? list : []; data.recitersError = null; })
      .catch((err) => { data.recitersError = err; })
      .finally(() => { renderReciters(); onChange(); });
  }
  if (!data.translations) {
    api.getTranslations()
      .then((res) => { data.translations = { defaults: res?.defaults || {}, translations: res?.translations || [] }; data.translationsError = null; })
      .catch((err) => { data.translationsError = err; })
      .finally(() => { renderTranslations(); onChange({ texts: true }); });
  }
  if (!data.bismillah) {
    api.getAyahs({ surah: 1, from: 1, to: 1, translation: null })
      .then((res) => { data.bismillah = res?.ayahs?.[0]?.arabic || null; updatePreview(); })
      .catch(() => {});
  }
}

function loadSurahs() {
  data.surahsError = null;
  renderSelections();
  api.getSurahs()
    .then((list) => {
      data.surahs = Array.isArray(list) ? list : [];
      data.surahMap = new Map(data.surahs.map((s) => [s.number, s]));
      for (const item of state.items) clampItem(item);
    })
    .catch((err) => { data.surahsError = err; })
    .finally(() => { renderSelections(); onChange({ texts: true }); });
}

function refreshStatus() {
  api.getSourcesStatus()
    .then((status) => { data.status = status; syncCategories(); })
    .catch(() => {});
}

// ---------- events ----------

function bindEvents() {
  els.add.addEventListener('click', addItem);
  els.form.addEventListener('submit', submit);
  els.form.addEventListener('change', onFormChange);
  els.textScale.addEventListener('input', () => { state.style.textScale = Number(els.textScale.value); syncOutputs(); onChange(); });
  els.overlay.addEventListener('input', () => { state.style.overlay = Number(els.overlay.value); syncOutputs(); onChange(); });
  els.reciter.addEventListener('change', () => { state.reciter = els.reciter.value; stopAudio(); onChange(); });
  els.translation.addEventListener('change', () => {
    state.translation = els.translation.value === 'none' ? null : els.translation.value;
    state.translationTouched = true;
    onChange({ texts: true });
  });
  els.reciterPreview.addEventListener('click', toggleAudio);
}

function onFormChange(e) {
  const { name, value, checked } = e.target;
  switch (name) {
    case 'mode': state.mode = value; break;
    case 'aspect': state.aspect = value; break;
    case 'quality': state.quality = value; break;
    case 'font': state.style.arabicFont = value; break;
    case 'position': state.style.position = value; break;
    case 'approvedOnly': state.approvedOnly = checked; syncApprovedNote(); break;
    case 'showSurahTitle': state.style.showSurahTitle = checked; break;
    case 'showReciter': state.style.showReciter = checked; break;
    case 'bismillah': state.bismillah = checked; break;
    default: return;
  }
  onChange();
}

/** Push state into the static form controls. */
function syncControls() {
  const setRadio = (name, value) => {
    const input = els.form.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
    if (input) input.checked = true;
  };
  setRadio('mode', state.mode);
  setRadio('aspect', state.aspect);
  setRadio('quality', state.quality);
  setRadio('font', state.style.arabicFont);
  setRadio('position', state.style.position);
  els.approvedOnly.checked = state.approvedOnly;
  els.showTitle.checked = state.style.showSurahTitle;
  els.showReciter.checked = state.style.showReciter;
  els.bismillah.checked = state.bismillah;
  els.textScale.value = String(state.style.textScale);
  els.overlay.value = String(state.style.overlay);
  syncOutputs();
}

function syncOutputs() {
  els.textScaleValue.textContent = fmtPercent(state.style.textScale);
  els.overlayValue.textContent = fmtPercent(state.style.overlay);
}

function onChange({ texts = false } = {}) {
  saveStateSoon();
  updateSummary();
  validateAndShow();
  updatePreview();
  if (texts) loadTextsSoon();
}

// ---------- presets ----------

function buildPresets() {
  els.presets.replaceChildren(
    ...PRESETS.map((p) =>
      h('button', { type: 'button', class: 'chip chip-preset', onclick: () => applyPreset(p) }, icon('sparkle'), h('span', { text: t(`create.presets.${p.id}`) })),
    ),
  );
}

const sameItem = (a, b) => a.surah === b.surah && a.from === b.from && a.to === b.to;

function applyPreset(preset) {
  const onlyDefault = state.items.length === 1 && sameItem(state.items[0], DEFAULT_STATE.items[0]);
  const base = onlyDefault && !preset.items.some((p) => sameItem(p, DEFAULT_STATE.items[0])) ? [] : state.items;
  const additions = preset.items.filter((p) => !base.some((i) => sameItem(i, p)));
  state.items = [...base, ...additions.map(withUid)].slice(0, MAX_VIDEOS);
  renderSelections();
  onChange({ texts: true });
}

// ---------- selections ----------

function clampItem(item) {
  const s = data.surahMap.get(item.surah);
  if (!s) return;
  item.from = clamp(item.from, 1, s.ayahCount);
  item.to = clamp(item.to, item.from, s.ayahCount);
}

function defaultRangeFor(surah) {
  return { from: 1, to: surah.ayahCount <= MAX_AYAT_PER_VIDEO ? surah.ayahCount : Math.min(surah.ayahCount, 10) };
}

function addItem() {
  if (state.items.length >= MAX_VIDEOS) return;
  const last = state.items[state.items.length - 1];
  const number = last ? (last.surah % 114) + 1 : 1;
  const surah = data.surahMap.get(number);
  const range = surah ? defaultRangeFor(surah) : { from: 1, to: 1 };
  state.items.push(withUid({ surah: number, ...range }));
  renderSelections();
  rows[rows.length - 1]?.pickerButton.focus();
  onChange({ texts: true });
}

function removeItem(item) {
  const index = state.items.indexOf(item);
  state.items = state.items.filter((i) => i !== item);
  renderSelections();
  const target = rows[Math.min(index, rows.length - 1)];
  (target?.removeBtn.disabled ? els.add : target?.removeBtn || els.add).focus();
  onChange({ texts: true });
}

function renderSelections() {
  if (!data.surahs) {
    rows = [];
    els.list.replaceChildren(
      h('li', { class: 'sel-state' }, data.surahsError ? errorBlock(data.surahsError, loadSurahs, t('create.passages.loadError')) : loadingBlock()),
    );
    els.add.disabled = true;
    return;
  }
  rows = state.items.map(createRow);
  els.list.replaceChildren(...rows.map((r) => r.li));
  els.add.disabled = state.items.length >= MAX_VIDEOS;
}

function createRow(item, index) {
  const ids = { label: nextId('sel-label'), from: nextId('sel-from'), to: nextId('sel-to'), msg: nextId('sel-msg') };
  const row = { item };
  const ayahCount = () => data.surahMap.get(item.surah)?.ayahCount || 1;

  const picker = createSurahPicker({
    surahs: data.surahs,
    value: item.surah,
    labelId: ids.label,
    onChange: (number) => {
      item.surah = number;
      Object.assign(item, defaultRangeFor(data.surahMap.get(number)));
      syncRowInputs(row);
      onChange({ texts: true });
    },
  });

  const numberInput = (id) => h('input', { id, class: 'input input-num', type: 'number', inputmode: 'numeric', min: '1', step: '1', 'aria-describedby': ids.msg });
  row.from = numberInput(ids.from);
  row.to = numberInput(ids.to);
  row.meta = h('p', { class: 'sel-meta' });
  row.msg = h('p', { class: 'sel-msg', id: ids.msg, hidden: true });
  row.pickerButton = picker.button;
  row.removeBtn = h(
    'button',
    {
      type: 'button',
      class: 'icon-btn btn-danger sel-remove',
      'aria-label': t('create.passages.remove', { n: index + 1 }),
      title: t('create.passages.remove', { n: index + 1 }),
      disabled: state.items.length === 1,
      onclick: () => removeItem(item),
    },
    icon('trash'),
  );

  // While typing, accept in-range values; on commit, clamp and keep from ≤ to.
  const onInput = (which) => () => {
    const v = parseInt(row[which].value, 10);
    if (v >= 1 && v <= ayahCount()) { item[which] = v; onChange({ texts: true }); }
  };
  const onCommit = (which) => () => {
    const max = ayahCount();
    const v = clamp(parseInt(row[which].value, 10) || (which === 'from' ? 1 : max), 1, max);
    item[which] = v;
    if (item.from > item.to) {
      if (which === 'from') item.to = item.from;
      else item.from = item.to;
    }
    syncRowInputs(row);
    onChange({ texts: true });
  };
  for (const which of ['from', 'to']) {
    row[which].addEventListener('input', onInput(which));
    row[which].addEventListener('change', onCommit(which));
  }

  row.li = h(
    'li',
    { class: 'selection-row', role: 'group', 'aria-label': t('create.passages.selection', { n: index + 1 }) },
    h('span', { class: 'sel-index', 'aria-hidden': 'true', text: fmtNumber(index + 1) }),
    h('div', { class: 'field sel-surah' }, h('span', { class: 'field-label', id: ids.label, text: t('create.passages.surah') }), picker.el, row.meta),
    h('div', { class: 'field sel-from' }, h('label', { class: 'field-label', for: ids.from, text: t('create.passages.from') }), row.from),
    h('div', { class: 'field sel-to' }, h('label', { class: 'field-label', for: ids.to, text: t('create.passages.to') }), row.to),
    h('div', { class: 'sel-actions' }, row.removeBtn),
    row.msg,
  );
  syncRowInputs(row);
  return row;
}

function syncRowInputs(row) {
  const s = data.surahMap.get(row.item.surah);
  const max = String(s?.ayahCount || 1);
  row.from.max = max;
  row.to.max = max;
  row.from.value = String(row.item.from);
  row.to.value = String(row.item.to);
  if (s) {
    row.meta.textContent = t('create.passages.meta', {
      ayat: t('create.summary.ayat', { count: s.ayahCount }),
      revelation: s.revelation === 'medinan' ? t('create.picker.medinan') : t('create.picker.meccan'),
    });
  }
}

// ---------- recitation & translation ----------

function reciterLabel(r) {
  const name = isRtl() ? r.nameAr || r.nameEn : r.nameEn || r.nameAr;
  return r.style ? `${name} · ${t(`create.reciter.style.${r.style}`)}` : name;
}

function renderReciters() {
  const sel = els.reciter;
  if (!data.reciters?.length) {
    sel.replaceChildren(new Option(t(data.recitersError || data.reciters ? 'create.reciter.unavailable' : 'create.reciter.loading'), ''));
    sel.disabled = true;
    els.reciterPreview.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.replaceChildren(...data.reciters.map((r) => new Option(reciterLabel(r), r.id)));
  if (!data.reciters.some((r) => r.id === state.reciter)) state.reciter = data.reciters[0].id;
  sel.value = state.reciter;
  els.reciterPreview.disabled = false;
}

function defaultTranslation() {
  const defaults = data.translations?.defaults || {};
  const lang = getLang();
  return lang in defaults ? defaults[lang] : defaults.en ?? null;
}

function renderTranslations() {
  const sel = els.translation;
  if (!data.translations) {
    sel.replaceChildren(new Option(t(data.translationsError ? 'create.translation.unavailable' : 'create.translation.loading'), 'none'));
    sel.disabled = !data.translationsError;
    if (data.translationsError) {
      sel.replaceChildren(new Option(t('create.translation.none'), 'none'));
      state.translation = null;
    }
    return;
  }
  const { translations } = data.translations;
  const byLang = new Map();
  for (const tr of translations) {
    const iso = tr.languageIso || 'und';
    if (!byLang.has(iso)) byLang.set(iso, []);
    byLang.get(iso).push(tr);
  }
  const lang = getLang();
  const collator = new Intl.Collator(getLocale());
  const order = [...byLang.keys()].sort(
    (a, b) => (b === lang) - (a === lang) || (b === 'en') - (a === 'en') || collator.compare(languageName(a), languageName(b)),
  );
  sel.replaceChildren(
    new Option(t('create.translation.none'), 'none'),
    ...order.map((iso) => {
      const group = document.createElement('optgroup');
      group.label = languageName(iso);
      group.append(...byLang.get(iso).map((tr) => new Option(tr.title || tr.key, tr.key)));
      return group;
    }),
  );
  if (!state.translationTouched) state.translation = defaultTranslation();
  if (state.translation && !translations.some((tr) => tr.key === state.translation)) state.translation = defaultTranslation();
  sel.value = state.translation || 'none';
  sel.disabled = false;
}

function setAudioUi(mode) {
  const btn = els.reciterPreview;
  btn.classList.toggle('is-busy', mode === 'loading');
  btn.setAttribute('aria-pressed', String(mode !== 'idle'));
  const label = t(mode === 'idle' ? 'create.reciter.preview' : 'create.reciter.stop');
  btn.replaceChildren(icon(mode === 'idle' ? 'play' : 'stop'));
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function toggleAudio() {
  if (audio) { stopAudio(); return; }
  const first = state.items[0];
  if (!first || !state.reciter) return;
  const a = new Audio(api.audioUrl(state.reciter, first.surah, first.from));
  audio = a;
  setAudioUi('loading');
  a.addEventListener('playing', () => { if (audio === a) setAudioUi('playing'); });
  a.addEventListener('ended', () => { if (audio === a) stopAudio(); });
  a.addEventListener('error', () => {
    if (audio !== a) return;
    stopAudio();
    toast(t('errors.audio_failed'), { type: 'error' });
  });
  a.play().catch((err) => {
    if (audio !== a || err.name === 'AbortError') return;
    stopAudio();
    toast(t('errors.audio_failed'), { type: 'error' });
  });
}

function stopAudio() {
  const a = audio;
  audio = null;
  if (a) a.pause();
  if (els.reciterPreview) setAudioUi('idle');
}

// ---------- backgrounds ----------

function buildCategories() {
  els.categories.replaceChildren(
    ...CATEGORIES.map((id) =>
      h(
        'button',
        { type: 'button', class: 'chip chip-cat', 'aria-pressed': 'false', dataset: { cat: id }, onclick: () => toggleCategory(id) },
        h('span', { class: 'chip-swatch', dataset: { cat: id }, 'aria-hidden': 'true' }),
        h('span', { class: 'chip-label' }),
        h('span', { class: 'chip-count', hidden: true }),
        icon('check', 'chip-check'),
      ),
    ),
  );
  syncCategories();
}

function approvedCount(id) {
  const n = data.status?.library?.[id]?.approved;
  return typeof n === 'number' ? n : null;
}

function syncCategories() {
  for (const btn of els.categories.children) {
    const id = btn.dataset.cat;
    btn.setAttribute('aria-pressed', String(state.categories.includes(id)));
    btn.querySelector('.chip-label').textContent = t(`categories.${id}`);
    const count = approvedCount(id);
    const badge = btn.querySelector('.chip-count');
    badge.hidden = !count;
    if (count) {
      badge.textContent = fmtNumber(count);
      badge.title = t('create.backgrounds.approvedCount', { count });
    }
  }
  syncApprovedNote();
}

function syncApprovedNote() {
  const known = state.categories.map(approvedCount);
  const none = known.every((n) => n === 0);
  els.approvedNote.hidden = !(state.approvedOnly && none);
}

function toggleCategory(id) {
  const on = state.categories.includes(id);
  if (on && state.categories.length === 1) {
    toast(t('create.backgrounds.atLeastOne'));
    return;
  }
  state.categories = on ? state.categories.filter((c) => c !== id) : CATEGORIES.filter((c) => c === id || state.categories.includes(c));
  syncCategories();
  loadBackground();
  onChange();
}

/** Use an approved clip's thumbnail (if any) as the preview background. */
async function loadBackground() {
  const cat = state.categories[0];
  if (!bgCache.has(cat)) {
    bgCache.set(cat, null);
    try {
      const clips = await api.getLibrary(cat);
      bgCache.set(cat, (Array.isArray(clips) ? clips : []).find((c) => c.thumbUrl)?.thumbUrl || null);
    } catch { /* gradient fallback */ }
  }
  updatePreview();
}

// ---------- summary & validation ----------

function updateSummary() {
  const { videos, ayat, seconds } = counts();
  els.summary.textContent = t('create.summary.text', {
    videos: t('create.summary.videos', { count: videos }),
    ayat: t('create.summary.ayat', { count: ayat }),
    duration: fmtApproxDuration(seconds),
  });
  els.submit.querySelector('.btn-label').textContent = submitting ? t('create.submitting') : t('create.submit', { count: videos });
}

function validate() {
  if (!data.surahs) return [{ message: t(data.surahsError ? 'create.passages.loadError' : 'create.validation.loading') }];
  const errors = [];
  if (!state.items.length) errors.push({ message: t('create.validation.noItems') });
  state.items.forEach((item, row) => {
    const s = data.surahMap.get(item.surah);
    const n = row + 1;
    const len = item.to - item.from + 1;
    if (!s || !(item.from >= 1 && item.to >= item.from && item.to <= s.ayahCount)) {
      errors.push({ row, message: t('create.validation.range', { n }) });
    } else if (state.mode === 'combined' && len > MAX_AYAT_PER_VIDEO) {
      errors.push({ row, message: t('create.validation.tooManyAyat', { n, count: len, max: MAX_AYAT_PER_VIDEO }) });
    }
  });
  const { videos } = counts();
  if (videos > MAX_VIDEOS) errors.push({ message: t('create.validation.tooManyVideos', { count: videos, max: MAX_VIDEOS }) });
  if (!state.reciter || !data.reciters?.length) errors.push({ message: t('create.validation.noReciter') });
  if (!state.categories.length) errors.push({ message: t('create.validation.noCategory') });
  return errors;
}

function validateAndShow() {
  const errors = validate();
  rows.forEach((row, i) => {
    const err = errors.find((e) => e.row === i);
    row.msg.hidden = !err;
    row.msg.textContent = err?.message || '';
    row.li.classList.toggle('is-invalid', Boolean(err));
    for (const input of [row.from, row.to]) input.setAttribute('aria-invalid', String(Boolean(err)));
  });
  els.errors.replaceChildren(...errors.map((e) => h('li', {}, icon('alert'), h('span', { text: e.message }))));
  els.errors.hidden = errors.length === 0;
  els.submit.disabled = submitting || errors.length > 0;
  return errors;
}

// ---------- texts & preview ----------

const groupKey = (g) => `${g.surahNumber}:${g.from}:${g.to}:${g.translation || 'none'}`;
const loadTextsSoon = debounce(loadTexts, 350);

async function loadTexts() {
  if (!data.surahs) return;
  const token = ++textToken;
  const translation = state.translation;
  const { iso: translationIso, dir: translationDir } = translationInfo();
  const previous = new Map(ayahGroups.map((g) => [groupKey(g), g]));
  ayahGroups = state.items.map((item) => {
    const g = { surahNumber: item.surah, surah: data.surahMap.get(item.surah), from: item.from, to: item.to, translation, translationIso, translationDir, status: 'loading', ayahs: [] };
    const prev = previous.get(groupKey(g));
    return prev && prev.status === 'ready' ? { ...prev, surah: g.surah, translationIso, translationDir } : g;
  });
  const redraw = () => {
    if (token !== textToken) return;
    renderAyahList(els.ayahList, ayahGroups, { maxAyat: MAX_LISTED_AYAT });
    updatePreview();
  };
  redraw();
  await Promise.all(
    ayahGroups.map(async (g) => {
      if (g.status === 'ready') return;
      try {
        const res = await api.getAyahs({ surah: g.surahNumber, from: g.from, to: Math.min(g.to, g.from + MAX_LISTED_AYAT - 1), translation });
        g.ayahs = Array.isArray(res?.ayahs) ? res.ayahs : [];
        g.status = 'ready';
      } catch {
        g.status = 'error';
      }
      redraw();
    }),
  );
}

function updatePreview() {
  if (!els.frame) return;
  const first = state.items[0];
  const group = ayahGroups[0];
  const matches = group && first && group.surahNumber === first.surah && group.from === first.from;
  const reciter = data.reciters?.find((r) => r.id === state.reciter) || null;
  renderDevicePreview(els.frame, {
    aspect: state.aspect,
    style: state.style,
    category: state.categories[0],
    backgroundUrl: bgCache.get(state.categories[0]) || null,
    surah: first ? data.surahMap.get(first.surah) : null,
    ayah: matches && group.status === 'ready' ? group.ayahs[0] || null : null,
    loading: !matches || group.status === 'loading',
    error: matches && group.status === 'error',
    translationIso: translationInfo().iso,
    translationDir: translationInfo().dir,
    reciter,
    showBismillah: Boolean(state.bismillah && first && first.from === 1 && !NO_BISMILLAH.has(first.surah)),
    bismillahText: data.bismillah,
  });
}

// ---------- submit ----------

function buildRequest() {
  return {
    items: state.items.map(({ surah, from, to }) => ({ surah, from, to })),
    mode: state.mode,
    reciter: state.reciter,
    translation: state.translation || null,
    categories: [...state.categories],
    aspect: state.aspect,
    quality: state.quality,
    bismillah: state.bismillah,
    approvedOnly: state.approvedOnly,
    style: { ...state.style },
  };
}

async function submit(e) {
  e.preventDefault();
  if (submitting) return;
  const errors = validateAndShow();
  if (errors.length) {
    const firstRow = errors.find((er) => er.row !== undefined);
    if (firstRow) rows[firstRow.row]?.from.focus();
    return;
  }
  submitting = true;
  els.submit.classList.add('is-busy');
  updateSummary();
  validateAndShow();
  try {
    const res = await api.startRender(buildRequest());
    const count = Array.isArray(res?.videos) ? res.videos.length : counts().videos;
    toast(t('create.queued', { count }), { type: 'success' });
    stopAudio();
    document.dispatchEvent(new CustomEvent('videos:changed'));
    location.hash = '#videos';
  } catch (err) {
    showError(err);
  } finally {
    submitting = false;
    els.submit.classList.remove('is-busy');
    updateSummary();
    validateAndShow();
  }
}
