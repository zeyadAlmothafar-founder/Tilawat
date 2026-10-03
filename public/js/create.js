// "Create" page: passages, recitation, backgrounds, format, style, live preview, submit.
import * as api from './api.js';
import { t, getLang, getLocale, isRtl, fmtNumber, fmtPercent, fmtApproxDuration, languageName, dirForLang, onLanguageChange, storageGet, storageSet } from './i18n.js';
import { h, debounce, clamp, toast, showError, errorBlock, loadingBlock, nextId } from './ui.js';
import { icon } from './icons.js';
import { createSurahPicker } from './surah-picker.js';
import { renderDevicePreview, renderAyahList, indexTafsir } from './preview.js';

const MAX_VIDEOS = 50;
const MAX_AYAT_PER_VIDEO = 50;
const SECONDS_PER_AYAH = 6;
const MAX_LISTED_AYAT = 300;
const CATEGORIES = ['nature', 'space', 'mosque', 'islamic'];
const NO_BISMILLAH = new Set([1, 9]);
const STORE_KEY = 'qvs.create.v1';
// Tafsir cards add reading time to the video (mirrors the renderer): words / 2.8 + 1.5 s, min 4 s.
const TAFSIR_WORDS_PER_SECOND = 2.8;
const TAFSIR_CARD_PADDING = 1.5;
const TAFSIR_CARD_MIN = 4;
const TAFSIR_FALLBACK_SECONDS = 20; // per ayah, until the tafsir text is loaded

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
  tafsir: null,
  tafsirCards: false,
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
let previewView = 'ayah'; // 'ayah' | 'tafsir'
const bgCache = new Map(); // category -> thumb URL | null
const tafsirCache = new Map(); // "surah:from:to:edition" -> { status, entries }
const data = {
  surahs: null, surahMap: new Map(), surahsError: null,
  reciters: null, recitersError: null,
  translations: null, translationsError: null,
  tafsirs: null, tafsirsError: null,
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
  if (typeof saved.tafsir === 'string' && saved.tafsir) s.tafsir = saved.tafsir;
  s.tafsirCards = Boolean(s.tafsir && saved.tafsirCards === true);
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
  return { ayat, videos, seconds: ayat * SECONDS_PER_AYAH + (tafsirCardsOn() ? tafsirSeconds() : 0) };
}

const currentTranslation = () =>
  state.translation ? data.translations?.translations?.find((tr) => tr.key === state.translation) || null : null;

/** The chosen tafsir edition (null when none, or when the server has no tafsir support). */
const currentTafsir = () =>
  state.tafsir ? data.tafsirs?.tafsirs?.find((tf) => tf.key === state.tafsir) || null : null;
const tafsirCardsOn = () => Boolean(state.tafsirCards && currentTafsir());

function tafsirInfo() {
  const tf = currentTafsir();
  if (!tf) return null;
  return { key: tf.key, title: tafsirName(tf), label: tf.label || tf.title || tf.key, iso: tf.languageIso || null, dir: tf.direction || dirForLang(tf.languageIso) };
}

/** Last ayah fetched for a selection (lists and tafsir requests are capped). */
const listedTo = (item) => Math.min(item.to, item.from + MAX_LISTED_AYAT - 1);
const tafsirKey = (item, edition) => `${item.surah}:${item.from}:${listedTo(item)}:${edition}`;
const tafsirStateFor = (item) => (state.tafsir ? tafsirCache.get(tafsirKey(item, state.tafsir)) || null : null);

const cardSeconds = (text) => {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(TAFSIR_CARD_MIN, words / TAFSIR_WORDS_PER_SECOND + TAFSIR_CARD_PADDING);
};

/** Extra reading time for tafsir cards: from the loaded texts, else ~20 s per ayah. */
function tafsirSeconds() {
  let total = 0;
  for (const item of state.items) {
    const count = Math.max(0, item.to - item.from + 1);
    const ts = tafsirStateFor(item);
    if (ts?.status !== 'ready') { total += count * TAFSIR_FALLBACK_SECONDS; continue; }
    const index = indexTafsir(ts.entries);
    const end = listedTo(item);
    const seen = new Set();
    for (let a = item.from; a <= end; a++) {
      const entry = index.get(a);
      if (!entry) continue;
      // One card per explanation in a combined video; every per-ayah video gets its own card.
      if (state.mode !== 'perAyah') {
        if (seen.has(entry)) continue;
        seen.add(entry);
      }
      total += cardSeconds(entry.text);
    }
    total += Math.max(0, item.to - end) * TAFSIR_FALLBACK_SECONDS;
  }
  return total;
}

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
    tafsirField: $('#tafsir-field'),
    tafsir: $('#tafsir-select'),
    tafsirCards: $('#tafsir-cards'),
    previewView: $('#preview-view'),
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
  renderTafsirs();
  onChange();
  loadData();

  onLanguageChange(() => {
    const before = state.translation;
    buildPresets();
    syncCategories();
    renderSelections();
    renderReciters();
    renderTranslations();
    renderTafsirs();
    syncOutputs();
    onChange({ texts: before !== state.translation });
    if (before === state.translation) renderTextList();
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
  if (!data.tafsirs && !data.tafsirsLoading) {
    // Optional feature: if the server has no tafsir support (404) the controls stay hidden.
    data.tafsirsLoading = true;
    api.getTafsirs()
      .then((res) => {
        const list = Array.isArray(res?.tafsirs) ? res.tafsirs.filter((tf) => tf && typeof tf.key === 'string') : [];
        data.tafsirs = { defaults: res?.defaults || {}, tafsirs: list };
        data.tafsirsError = null;
      })
      .catch((err) => { data.tafsirsError = err; })
      .finally(() => { data.tafsirsLoading = false; renderTafsirs(); onChange({ texts: true }); });
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
  els.tafsir.addEventListener('change', () => {
    state.tafsir = els.tafsir.value === 'none' ? null : els.tafsir.value;
    if (!state.tafsir) state.tafsirCards = false;
    syncTafsirControls();
    onChange({ texts: true });
  });
  els.previewView.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    previewView = btn.dataset.view === 'tafsir' ? 'tafsir' : 'ayah';
    updatePreview();
  });
  els.reciterPreview.addEventListener('click', toggleAudio);
}

/** Turning tafsir cards on without an edition picks the default for the UI language. */
function setTafsirCards(on) {
  state.tafsirCards = on;
  let texts = false;
  if (on && !currentTafsir()) {
    state.tafsir = defaultTafsir();
    state.tafsirCards = Boolean(state.tafsir);
    texts = true;
  }
  syncTafsirControls();
  onChange({ texts });
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
    case 'tafsirCards': setTafsirCards(checked); return;
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
  fillGroupedSelect(sel, translations, t('create.translation.none'));
  if (!state.translationTouched) state.translation = defaultTranslation();
  if (state.translation && !translations.some((tr) => tr.key === state.translation)) state.translation = defaultTranslation();
  sel.value = state.translation || 'none';
  sel.disabled = false;
}

/** "None" + editions grouped by language (UI language first, then English, then A–Z). */
function fillGroupedSelect(sel, list, noneLabel, nameOf = (item) => item.title || item.key) {
  const byLang = new Map();
  for (const item of list) {
    const iso = item.languageIso || 'und';
    if (!byLang.has(iso)) byLang.set(iso, []);
    byLang.get(iso).push(item);
  }
  const lang = getLang();
  const collator = new Intl.Collator(getLocale());
  const order = [...byLang.keys()].sort(
    (a, b) => (b === lang) - (a === lang) || (b === 'en') - (a === 'en') || collator.compare(languageName(a), languageName(b)),
  );
  sel.replaceChildren(
    new Option(noneLabel, 'none'),
    ...order.map((iso) => {
      const group = document.createElement('optgroup');
      group.label = languageName(iso);
      group.append(...byLang.get(iso).map((item) => new Option(nameOf(item), item.key)));
      return group;
    }),
  );
}

// ---------- tafsir ----------

/** Native-language name (e.g. 'التفسير الميسر') for editions in the UI language, else the full title. */
const tafsirName = (tf) => (tf.languageIso === getLang() && tf.label) || tf.title || tf.key;

const tafsirAvailable = () => Boolean(data.tafsirs?.tafsirs?.length);

/** defaults[uiLang], else the first edition offered in the list. */
function defaultTafsir() {
  if (!tafsirAvailable()) return null;
  const { defaults, tafsirs } = data.tafsirs;
  const preferred = defaults?.[getLang()];
  if (preferred && tafsirs.some((tf) => tf.key === preferred)) return preferred;
  return [...els.tafsir.options].find((o) => o.value !== 'none')?.value || tafsirs[0].key;
}

function renderTafsirs() {
  const available = tafsirAvailable();
  els.tafsirField.hidden = !available;
  if (!available) return; // still loading, or no tafsir support on this server
  fillGroupedSelect(els.tafsir, data.tafsirs.tafsirs, t('create.tafsir.none'), tafsirName);
  if (state.tafsir && !currentTafsir()) {
    state.tafsir = null;
    state.tafsirCards = false;
  }
  syncTafsirControls();
}

function syncTafsirControls() {
  els.tafsir.value = state.tafsir || 'none';
  els.tafsirCards.checked = tafsirCardsOn();
}

function tafsirListOptions() {
  const info = tafsirInfo();
  if (!info) return null;
  return {
    ...info,
    stateFor: (g) => tafsirCache.get(tafsirKey({ surah: g.surahNumber, from: g.from, to: g.to }, info.key)) || null,
    onRetry: (g) => {
      tafsirCache.delete(tafsirKey({ surah: g.surahNumber, from: g.from, to: g.to }, info.key));
      loadTafsirs();
    },
  };
}

/** Lazily fetch the chosen edition's tafsir for every selection (responses are cached). */
function loadTafsirs() {
  const edition = currentTafsir()?.key;
  if (!edition || !data.surahs) return;
  let started = false;
  for (const item of state.items) {
    const key = tafsirKey(item, edition);
    if (tafsirCache.has(key)) continue;
    const entry = { status: 'loading', entries: [] };
    tafsirCache.set(key, entry);
    started = true;
    api.getTafsir({ surah: item.surah, from: item.from, to: listedTo(item), edition })
      .then((res) => {
        entry.entries = Array.isArray(res?.ayahs) ? res.ayahs : [];
        entry.status = 'ready';
      })
      .catch(() => { entry.status = 'error'; }) // shown with a retry button
      .finally(() => {
        if (tafsirCache.get(key) !== entry || state.tafsir !== edition) return;
        renderTextList();
        updateSummary();
        updatePreview();
      });
  }
  if (started) {
    renderTextList();
    updatePreview();
  }
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
  els.summary.textContent = t(tafsirCardsOn() ? 'create.summary.textTafsir' : 'create.summary.text', {
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
    renderTextList();
    updatePreview();
  };
  redraw();
  loadTafsirs();
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

function renderTextList() {
  if (!els.ayahList) return;
  renderAyahList(els.ayahList, ayahGroups, { maxAyat: MAX_LISTED_AYAT, tafsir: tafsirListOptions() });
}

/** The "Ayah | Tafsir card" switch above the preview (only when an edition is chosen). */
function syncPreviewView(info) {
  if (!info) previewView = 'ayah';
  els.previewView.hidden = !info;
  for (const btn of els.previewView.querySelectorAll('button[data-view]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === previewView));
  }
}

/** Tafsir card model for the first selected ayah. */
function previewTafsir(info, first) {
  if (!info || !first) return null;
  const ts = tafsirStateFor(first);
  const entry = ts?.status === 'ready' ? indexTafsir(ts.entries).get(first.from) : null;
  return {
    status: ts?.status || 'loading',
    title: info.label, // the short label the video card shows
    iso: info.iso,
    dir: info.dir,
    text: entry ? entry.text.trim() : '',
    ref: `${fmtNumber(first.surah)}:${fmtNumber(first.from)}`,
  };
}

function updatePreview() {
  if (!els.frame) return;
  const first = state.items[0];
  const group = ayahGroups[0];
  const matches = group && first && group.surahNumber === first.surah && group.from === first.from;
  const reciter = data.reciters?.find((r) => r.id === state.reciter) || null;
  const tafsir = tafsirInfo();
  syncPreviewView(tafsir);
  renderDevicePreview(els.frame, {
    view: previewView,
    tafsir: previewTafsir(tafsir, first),
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
    tafsir: tafsirCardsOn() ? state.tafsir : null,
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
