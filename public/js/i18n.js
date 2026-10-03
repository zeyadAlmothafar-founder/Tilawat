// Tiny i18n runtime: JSON dictionaries in /i18n/<lang>.json (nested keys, looked up
// with dot paths), English fallback, CLDR plurals via Intl.PluralRules and
// Intl-based number/date/duration formatting for the active UI language.
import { LANGUAGES, DEFAULT_LANG } from '/i18n/languages.js';

const STORAGE_KEY = 'qvs.lang';
const RTL_LANGS = new Set(['ar', 'fa', 'ur', 'he', 'ps', 'sd', 'ug', 'ckb', 'dv', 'yi', 'ks']);

const dictionaries = new Map(); // code -> Promise<object>
const loadedFonts = new Set();

let current = LANGUAGES.find((l) => l.code === DEFAULT_LANG);
let dict = {};
let fallback = {};
let plural = new Intl.PluralRules('en');
let numberFmt = new Intl.NumberFormat('en');

export const getLang = () => current.code;
export const getLocale = () => current.locale || current.code;
export const isRtl = () => current.dir === 'rtl';
export const findLanguage = (code) => LANGUAGES.find((l) => l.code === code);

export function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode etc. */ }
}

/** ?lang= → saved choice → browser languages → English. */
export function detectLanguage() {
  const candidates = [
    new URLSearchParams(location.search).get('lang'),
    storageGet(STORAGE_KEY),
    ...(navigator.languages || [navigator.language]),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const base = String(candidate).toLowerCase().split(/[-_]/)[0];
    if (findLanguage(base)) return base;
  }
  return DEFAULT_LANG;
}

function loadDictionary(code) {
  if (!dictionaries.has(code)) {
    const promise = fetch(`/i18n/${code}.json`)
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
    dictionaries.set(code, promise);
  }
  return dictionaries.get(code);
}

function loadFont(spec) {
  if (!spec || loadedFonts.has(spec)) return;
  loadedFonts.add(spec);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${spec.replace(/ /g, '+')}&display=swap`;
  document.head.append(link);
}

export async function initI18n() {
  await setLanguage(detectLanguage());
}

export async function setLanguage(code, { persist = false } = {}) {
  const lang = findLanguage(code) || findLanguage(DEFAULT_LANG);
  const [d, f] = await Promise.all([loadDictionary(lang.code), loadDictionary(DEFAULT_LANG)]);
  current = lang;
  dict = d;
  fallback = f;
  plural = new Intl.PluralRules(getLocale());
  numberFmt = new Intl.NumberFormat(getLocale());
  if (persist) storageSet(STORAGE_KEY, lang.code);

  const html = document.documentElement;
  html.lang = lang.code;
  html.dir = lang.dir;
  loadFont(lang.font);
  applyI18n(document);
  document.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: lang.code } }));
}

/** Call fn now-ish on every language change; returns an unsubscribe function. */
export function onLanguageChange(fn) {
  const handler = () => fn(getLang());
  document.addEventListener('i18n:change', handler);
  return () => document.removeEventListener('i18n:change', handler);
}

function lookup(obj, key) {
  let node = obj;
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

function pickPlural(entry, count, rules) {
  if (!entry || typeof entry !== 'object') return entry;
  if (typeof count !== 'number') return entry.other;
  return entry[rules.select(count)] ?? entry.other;
}

function resolve(key, vars) {
  let value = pickPlural(lookup(dict, key), vars.count, plural);
  if (typeof value !== 'string') {
    value = pickPlural(lookup(fallback, key), vars.count, new Intl.PluralRules('en'));
  }
  return typeof value === 'string' ? value : null;
}

function formatVar(value) {
  return typeof value === 'number' ? numberFmt.format(value) : String(value);
}

/** Translate `key`, interpolating {placeholders}. Numbers are localized. */
export function t(key, vars = {}) {
  const template = resolve(key, vars);
  if (template == null) return key;
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in vars && vars[name] != null ? formatVar(vars[name]) : m));
}

export const has = (key) => resolve(key, {}) != null;

/** Like t(), but placeholders may be DOM nodes (links, <code>…). Returns a fragment. */
export function tNodes(key, vars = {}) {
  const template = resolve(key, vars) ?? key;
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    frag.append(template.slice(last, match.index));
    const value = vars[match[1]];
    if (value instanceof Node) frag.append(value);
    else frag.append(value == null ? match[0] : formatVar(value));
    last = match.index + match[0].length;
  }
  frag.append(template.slice(last));
  return frag;
}

/** Fill [data-i18n] text and [data-i18n-attr="attr:key; attr2:key2"] attributes. */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
}

/** Populate a <select> with the UI languages (native names) and wire it up. */
export function mountLanguageSelect(select) {
  select.replaceChildren(
    ...LANGUAGES.map((l) => {
      const option = new Option(l.name, l.code);
      option.lang = l.code;
      option.dir = l.dir;
      return option;
    }),
  );
  select.value = getLang();
  select.addEventListener('change', () => {
    const url = new URL(location.href);
    if (url.searchParams.has('lang')) {
      url.searchParams.delete('lang');
      history.replaceState(null, '', url);
    }
    setLanguage(select.value, { persist: true });
  });
  onLanguageChange((code) => { select.value = code; });
}

// ---------- formatting ----------

export const fmtNumber = (n) => numberFmt.format(n);

export function fmtPercent(fraction) {
  return new Intl.NumberFormat(getLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(fraction);
}

/** 41.2 → "0:41", 3725 → "1:02:05" (localized digits). */
export function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const pad = new Intl.NumberFormat(getLocale(), { minimumIntegerDigits: 2, useGrouping: false });
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${fmtNumber(h)}:${pad.format(m)}:${pad.format(s)}` : `${fmtNumber(m)}:${pad.format(s)}`;
}

/** Rough duration for estimates: "45 sec", "3 min", "1 hr" in the UI language. */
export function fmtApproxDuration(seconds) {
  const unitFmt = (unit, value) =>
    new Intl.NumberFormat(getLocale(), { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 0 }).format(value);
  if (seconds < 90) return unitFmt('second', Math.max(1, Math.round(seconds)));
  if (seconds < 90 * 60) return unitFmt('minute', Math.round(seconds / 60));
  return new Intl.NumberFormat(getLocale(), { style: 'unit', unit: 'hour', unitDisplay: 'short', maximumFractionDigits: 1 }).format(seconds / 3600);
}

export function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  const [unit, value] = n >= 1e9 ? ['gigabyte', n / 1e9] : n >= 1e6 ? ['megabyte', n / 1e6] : ['kilobyte', Math.max(1, n / 1e3)];
  return new Intl.NumberFormat(getLocale(), { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
}

export function fmtDate(iso, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(getLocale(), options).format(date);
}

/** Localized name of a language code, e.g. 'ur' → "Urdu" / "الأردية". */
export function languageName(iso) {
  try {
    const name = new Intl.DisplayNames([getLocale()], { type: 'language' }).of(iso);
    return name ? name.charAt(0).toLocaleUpperCase(getLocale()) + name.slice(1) : iso;
  } catch {
    return iso;
  }
}

/** Text direction for content in language `iso` ('auto' when not known RTL). */
export const dirForLang = (iso) => (iso && RTL_LANGS.has(String(iso).toLowerCase().split(/[-_]/)[0]) ? 'rtl' : 'auto');
