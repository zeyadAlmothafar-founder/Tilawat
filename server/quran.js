// Quran text & metadata: surah list (static, server/data/surahs.json), translations and
// verbatim Arabic text from QuranEnc (cached on disk under QURAN_CACHE_DIR).
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { QURAN_CACHE_DIR } from './paths.js';
import { fetchJson } from './lib/http.js';
import { httpError } from './lib/errors.js';
import {
  QURANENC_API, ARABIC_SOURCE, DEFAULT_TRANSLATIONS, filterTranslations, cleanTranslation,
  defaultTranslationFor as sharedDefaultTranslationFor,
} from '../shared/translations.js';

export { cleanTranslation };

const API = QURANENC_API;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_AYAHS_PER_REQUEST = 300;
const MEMO_LIMIT = 60; // parsed surah texts kept in memory

// ARABIC_SOURCE, the default translation per UI language and the list filtering live in
// shared/translations.js (also used by the web build).

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
  const list = filterTranslations(data);
  if (!list) throw httpError(502, 'upstream_unavailable', 'Unexpected QuranEnc response');
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
  // If QuranEnc ever drops a default, fall back to another translation in that language.
  return sharedDefaultTranslationFor(uiLang, translationsLoaded);
}

function defaultsByLanguage() {
  return Object.fromEntries(Object.keys(DEFAULT_TRANSLATIONS).map((lang) => [lang, defaultTranslationFor(lang)]));
}

// ---------------------------------------------------------------------------
// Surah texts (one QuranEnc request per translation + surah, cached forever)

const surahMemo = new Map(); // `${key}/${surah}` → Promise<Map<ayah, row>>

// Cached texts live in a folder per translation version, so a new QuranEnc release is
// fetched fresh (their terms ask re-publishers to follow the latest version).
async function cacheDirFor(key) {
  const version = await getTranslations()
    .then((list) => list.find((t) => t.key === key)?.version)
    .catch(() => null);
  return path.join(QURAN_CACHE_DIR, version ? `${key}@${version}` : key);
}

async function fetchSurahText(key, surah) {
  const cacheFile = path.join(await cacheDirFor(key), `${String(surah).padStart(3, '0')}.json`);
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

// Translation clean-up: cleanTranslation() lives in shared/translations.js (re-exported above).

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
