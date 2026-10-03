// Quran text & metadata: surah list (static, server/data/surahs.json), translations and
// verbatim Arabic text from QuranEnc (cached on disk under QURAN_CACHE_DIR).
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { QURAN_CACHE_DIR } from './paths.js';
import { fetchJson } from './lib/http.js';
import { httpError } from './lib/errors.js';

const API = 'https://quranenc.com/api/v1';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_AYAHS_PER_REQUEST = 300;
const MEMO_LIMIT = 60; // parsed surah texts kept in memory

// Arabic always comes from one canonical translation so it never varies with the chosen
// translation (QuranEnc's arabic_text was verified identical across all translation keys).
const ARABIC_SOURCE = 'english_saheeh';

// Default translation per UI language (all verified to exist on QuranEnc).
const DEFAULT_TRANSLATIONS = Object.freeze({
  en: 'english_saheeh', // Saheeh International (Noor International Center)
  ar: null,
  ur: 'urdu_junagarhi', // Muhammad Junagarhi
  fa: 'persian_ih', // Rowwad Translation Center
  fr: 'french_hameedullah', // Muhammad Hamidullah
  tr: 'turkish_shahin', // Ali Özek et al.
  id: 'indonesian_affairs', // Indonesian Ministry of Religious Affairs
  ms: 'malay_basumayyah', // Abdullah Basumayyah
  bn: 'bengali_zakaria', // Abu Bakr Zakaria
  es: 'spanish_garcia', // Isa Garcia
  de: 'german_bubenheim', // Bubenheim & Elyas
  ru: 'russian_rwwad', // Rowwad Translation Center (Kuliev is not on QuranEnc)
});

// Listed by QuranEnc but unsuitable for short videos: tafsir (commentary) editions, editions
// that are unfinished (mostly empty ayat) and one that mixes in commentary and Arabic verses.
const TAFSIR_KEY = /_(saadi|moyassar|mokhtasar)$/;
const UNSUITABLE = new Set(['english_waleed', 'circassian_rwwad', 'kurdish_salahuddin']);

const SURAHS = deepFreeze(JSON.parse(fs.readFileSync(new URL('./data/surahs.json', import.meta.url), 'utf8')));

function deepFreeze(value) {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// Surahs

export async function getSurahs() {
  return SURAHS;
}

export async function getSurah(number) {
  const surah = SURAHS[Number(number) - 1];
  if (!surah) throw httpError(404, 'surah_not_found', `Surah ${number} does not exist`);
  return surah;
}

// ---------------------------------------------------------------------------
// Translations

let translationsMemo = null; // { at, promise }
let translationsLoaded = null; // last successfully loaded list (for sync lookups)

function toTranslation(t) {
  return {
    key: t.key,
    languageIso: t.language_iso_code,
    title: t.title,
    description: typeof t.description === 'string' ? t.description : '',
    version: t.version,
    direction: t.direction === 'rtl' ? 'rtl' : 'ltr',
  };
}

async function loadTranslations() {
  let data;
  try {
    // `all=1` includes translations the default listing omits (e.g. Russian, Malay, Bengali).
    data = await fetchJson(`${API}/translations/list?all=1`, {
      cacheFile: path.join(QURAN_CACHE_DIR, 'translations.json'),
      maxAgeMs: WEEK_MS,
    });
  } catch (err) {
    throw httpError(502, 'upstream_unavailable', `Could not load translations from QuranEnc (${err.message})`);
  }
  if (!Array.isArray(data?.translations)) throw httpError(502, 'upstream_unavailable', 'Unexpected QuranEnc response');
  const list = data.translations
    .filter((t) => typeof t.key === 'string' && typeof t.title === 'string' && t.title.trim())
    .filter((t) => !TAFSIR_KEY.test(t.key) && !UNSUITABLE.has(t.key) && !/in progress/i.test(t.title))
    .map(toTranslation);
  translationsLoaded = list;
  return list;
}

export async function getTranslations() {
  if (!translationsMemo || Date.now() - translationsMemo.at > 60 * 60 * 1000) {
    const promise = loadTranslations();
    translationsMemo = { at: Date.now(), promise };
    promise.catch(() => {
      if (translationsMemo?.promise === promise) translationsMemo = null;
    });
  }
  return translationsMemo.promise;
}

async function findTranslation(key) {
  const translation = (await getTranslations()).find((t) => t.key === key);
  if (!translation) throw httpError(400, 'unknown_translation', `Unknown translation "${key}"`);
  return translation;
}

export function defaultTranslationFor(uiLang) {
  const lang = String(uiLang ?? '').toLowerCase().split(/[-_]/)[0];
  if (!Object.hasOwn(DEFAULT_TRANSLATIONS, lang)) return null;
  const key = DEFAULT_TRANSLATIONS[lang];
  // If QuranEnc ever drops a default, fall back to another translation in that language.
  if (key && translationsLoaded && !translationsLoaded.some((t) => t.key === key)) {
    return translationsLoaded.find((t) => t.languageIso === lang)?.key ?? null;
  }
  return key;
}

function defaultsByLanguage() {
  return Object.fromEntries(Object.keys(DEFAULT_TRANSLATIONS).map((lang) => [lang, defaultTranslationFor(lang)]));
}

// ---------------------------------------------------------------------------
// Surah texts (one QuranEnc request per translation + surah, cached forever)

const surahMemo = new Map(); // `${key}/${surah}` → Promise<Map<ayah, row>>

async function fetchSurahText(key, surah) {
  const cacheFile = path.join(QURAN_CACHE_DIR, key, `${String(surah).padStart(3, '0')}.json`);
  let data;
  try {
    data = await fetchJson(`${API}/translation/sura/${encodeURIComponent(key)}/${surah}`, { cacheFile, timeoutMs: 60000 });
  } catch (err) {
    throw httpError(502, 'upstream_unavailable', `Could not load surah ${surah} (${key}) from QuranEnc (${err.message})`);
  }
  const rows = new Map((Array.isArray(data?.result) ? data.result : []).map((row) => [Number(row.aya), row]));
  const expected = SURAHS[surah - 1].ayahCount;
  if (rows.size !== expected || !rows.get(1)?.arabic_text) {
    await fsp.rm(cacheFile, { force: true }); // never keep a bad response cached
    throw httpError(502, 'upstream_unavailable', `QuranEnc returned incomplete data for surah ${surah} (${key})`);
  }
  return rows;
}

function loadSurahText(key, surah) {
  const id = `${key}/${surah}`;
  if (!surahMemo.has(id)) {
    const promise = fetchSurahText(key, surah);
    promise.catch(() => surahMemo.delete(id));
    surahMemo.set(id, promise);
    if (surahMemo.size > MEMO_LIMIT) surahMemo.delete(surahMemo.keys().next().value);
  }
  return surahMemo.get(id);
}

// ---------------------------------------------------------------------------
// Translation clean-up

// Decimal digits used by QuranEnc translations: ASCII, Arabic-Indic, Persian, Devanagari, Bengali.
const DIGIT = '0-9\u0660-\u0669\u06F0-\u06F9\u0966-\u096F\u09E6-\u09EF';
const DIGIT_ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6];
// "[4]" / "[১]" (always a footnote reference) or "(১)" (only when the footnotes use that label).
const MARKER = new RegExp(String.raw`\s*(?:\[\s*([${DIGIT}]+)\s*\]|\(\s*([${DIGIT}]+)\s*\))\s*`, 'gu');
const FOOTNOTE_LABEL = new RegExp(String.raw`[\[(]\s*([${DIGIT}]+)\s*[\])]|(?:^|\n)\s*([${DIGIT}]+)[\s.)]`, 'gu');
// "3. ", "3-", "(3) ", "3 " or "2-3 " (surah-ayah) at the start of the text.
const LEADING_NUMBER = new RegExp(String.raw`^\s*\(?(?:([${DIGIT}]+)\s*[-:]\s*)?([${DIGIT}]+)\s*[.:)\-–]?\s*`, 'u');
const TRAILING_NUMBER = new RegExp(String.raw`\s*\(\s*([${DIGIT}]+)\s*\)(?=[\s.]*$)`, 'u');
const CLOSING_PUNCT = /[,.;:!?…)\]}»”’،؛؟۔।。、，；：！？」』）]/u;

function digitsValue(text) {
  let value = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9);
    value = value * 10 + (code - zero);
  }
  return value;
}

function footnoteLabels(footnotes) {
  const labels = new Set();
  for (const [, bracketed, bare] of (footnotes || '').matchAll(FOOTNOTE_LABEL)) labels.add(digitsValue(bracketed ?? bare));
  return labels;
}

/**
 * Display text for a translation: footnote reference markers removed ("Lord[4] of" → "Lord of";
 * editorial brackets like "[All] praise" are kept), the ayah number some translations prefix
 * ("3. Who believe…", "2-3 …") or suffix ("…(3)") removed, and whitespace collapsed.
 */
export function cleanTranslation(raw, footnotes, ayah, surah) {
  if (typeof raw !== 'string') return null;
  const labels = footnoteLabels(footnotes);
  let text = raw.replace(MARKER, (match, square, paren, offset, whole) => {
    if (paren !== undefined && !labels.has(digitsValue(paren))) return match;
    const next = whole.charAt(offset + match.length);
    if (!next || CLOSING_PUNCT.test(next)) return '';
    return /\s/.test(match) ? ' ' : ''; // keep word spacing; glued CJK markers vanish
  });
  const lead = text.match(LEADING_NUMBER);
  const leadMatches = lead && digitsValue(lead[2]) === ayah && (lead[1] === undefined || digitsValue(lead[1]) === surah);
  if (leadMatches && lead[0].length < text.length) text = text.slice(lead[0].length);
  const trail = text.match(TRAILING_NUMBER);
  if (trail && digitsValue(trail[1]) === ayah) text = text.slice(0, trail.index) + text.slice(trail.index + trail[0].length);
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Ayahs

function toInt(value) {
  if (typeof value === 'number') return value;
  return /^\s*\d+\s*$/.test(String(value ?? '')) ? Number(value) : NaN;
}

function validateSurahNumber(surah) {
  if (!Number.isInteger(surah) || surah < 1 || surah > 114) {
    throw httpError(400, 'invalid_range', 'Surah must be a number from 1 to 114');
  }
}

function validateRange(surah, from, to) {
  validateSurahNumber(surah);
  const { ayahCount } = SURAHS[surah - 1];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > to || to > ayahCount) {
    throw httpError(400, 'invalid_range', `Ayah range must satisfy 1 ≤ from ≤ to ≤ ${ayahCount} for surah ${surah}`);
  }
  if (to - from + 1 > MAX_AYAHS_PER_REQUEST) {
    throw httpError(400, 'invalid_range', `At most ${MAX_AYAHS_PER_REQUEST} ayat per request`);
  }
}

function normalizeKey(translationKey) {
  if (translationKey == null) return null;
  const key = String(translationKey).trim();
  return key === '' || key === 'none' || key === 'null' ? null : key;
}

export async function getAyahs(surah, from, to, translationKey) {
  [surah, from, to] = [toInt(surah), toInt(from), toInt(to)];
  validateRange(surah, from, to);
  const key = normalizeKey(translationKey);
  if (key) await findTranslation(key);

  const [arabicResult, translationResult] = await Promise.allSettled([
    loadSurahText(ARABIC_SOURCE, surah),
    key ? loadSurahText(key, surah) : null,
  ]);
  if (translationResult.status === 'rejected') throw translationResult.reason;
  // The Arabic is identical in every QuranEnc translation, so the requested one can stand in.
  const arabicRows = arabicResult.status === 'fulfilled' ? arabicResult.value : translationResult.value;
  if (!arabicRows) throw arabicResult.reason;
  const translationRows = translationResult.value;

  const ayahs = [];
  for (let ayah = from; ayah <= to; ayah++) {
    const row = translationRows?.get(ayah);
    const translationRaw = row ? String(row.translation ?? '') : null;
    const footnotes = row?.footnotes ? String(row.footnotes) : null;
    ayahs.push({
      surah,
      ayah,
      arabic: arabicRows.get(ayah).arabic_text,
      translation: row ? cleanTranslation(translationRaw, footnotes, ayah, surah) : null,
      translationRaw,
      footnotes,
    });
  }
  return ayahs;
}

export async function getBismillahText() {
  const rows = await loadSurahText(ARABIC_SOURCE, 1);
  return rows.get(1).arabic_text;
}

// ---------------------------------------------------------------------------
// HTTP

export function init() {
  // Warm the translations list in the background (never blocks startup).
  getTranslations().catch((err) => console.warn(`[quran] translations not loaded yet: ${err.message}`));
}

export const router = express.Router();

router.get('/surahs', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(await getSurahs());
});

router.get('/translations', async (req, res) => {
  const translations = await getTranslations();
  res.json({ defaults: defaultsByLanguage(), translations });
});

router.get('/ayahs', async (req, res) => {
  const surahNumber = toInt(req.query.surah);
  validateSurahNumber(surahNumber);
  const surah = await getSurah(surahNumber);
  const from = req.query.from === undefined ? 1 : toInt(req.query.from);
  const to = req.query.to === undefined ? surah.ayahCount : toInt(req.query.to);
  const key = normalizeKey(req.query.translation);
  const ayahs = await getAyahs(surahNumber, from, to, key);
  const translation = key ? await findTranslation(key) : null;
  res.json({
    surah,
    from,
    to,
    translation: translation && {
      key: translation.key,
      languageIso: translation.languageIso,
      title: translation.title,
      direction: translation.direction,
    },
    ayahs,
  });
});
