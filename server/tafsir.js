// Tafsir (Quran commentary) from QuranEnc. Tafsir editions are served through the same
// endpoints as translations (`translation` = the commentary text) but most are not in
// /translations/list, so the verified list lives in server/data/tafsirs.json (written by
// scripts/check-tafsirs.js). Surah texts are cached on disk under QURAN_CACHE_DIR/tafsir-<key>.
//
// Some editions explain several ayat at once: QuranEnc then repeats the same text for each
// of them (or leaves the later entries empty). Such runs are merged into one group
// (groupStart–groupEnd) so the commentary is shown once.
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { QURAN_CACHE_DIR } from './paths.js';
import { fetchJson } from './lib/http.js';
import { httpError } from './lib/errors.js';
import { getSurah } from './quran.js';
import { QURANENC_API } from '../shared/translations.js';
import { withLabels, shortLabel, defaultTafsirFor as sharedDefaultTafsirFor, tafsirDefaults, buildEntries, completeTafsirRows } from '../shared/tafsir.js';

export { shortLabel };

const API = QURANENC_API;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_AYAHS_PER_REQUEST = 300;
const MEMO_LIMIT = 40;

function loadList() {
  try {
    const list = JSON.parse(fs.readFileSync(new URL('./data/tafsirs.json', import.meta.url), 'utf8'));
    return withLabels(list);
  } catch (err) {
    console.warn(`[tafsir] no tafsir list (run scripts/check-tafsirs.js): ${err.message}`);
    return Object.freeze([]);
  }
}

// Short book labels (shortLabel), defaults and grouping live in shared/tafsir.js (also used
// by the web build).

const TAFSIRS = loadList();

export async function getTafsirs() {
  return TAFSIRS;
}

/** The edition with this key, or throws httpError(400, 'unknown_tafsir'). */
export function getTafsirEdition(key) {
  const edition = TAFSIRS.find((t) => t.key === key);
  if (!edition) throw httpError(400, 'unknown_tafsir', `Unknown tafsir "${key}"`);
  return edition;
}

/** Best tafsir for a UI language (Al-Mukhtasar first, then Al-Muyassar, then As-Sa'di), or null. */
export function defaultTafsirFor(uiLang) {
  return sharedDefaultTafsirFor(TAFSIRS, uiLang);
}

function defaultsByLanguage() {
  return tafsirDefaults(TAFSIRS);
}

// ---------------------------------------------------------------------------
// Surah texts

const memo = new Map(); // `${key}/${surah}` → Promise<entries[]> (index = ayah - 1)

async function fetchSurah(key, surah) {
  const { ayahCount } = await getSurah(surah);
  const cacheFile = path.join(QURAN_CACHE_DIR, `tafsir-${key}`, `${String(surah).padStart(3, '0')}.json`);
  let data;
  try {
    data = await fetchJson(`${API}/translation/sura/${encodeURIComponent(key)}/${surah}`, { cacheFile, maxAgeMs: MONTH_MS, timeoutMs: 60000 });
  } catch (err) {
    throw httpError(502, 'upstream_unavailable', `Could not load the tafsir of surah ${surah} (${key}) from QuranEnc (${err.message})`);
  }
  const rows = completeTafsirRows(data, ayahCount);
  if (!rows) {
    await fsp.rm(cacheFile, { force: true }); // never keep a bad response cached
    throw httpError(502, 'upstream_unavailable', `QuranEnc returned incomplete tafsir data for surah ${surah} (${key})`);
  }
  return buildEntries(rows, ayahCount, surah);
}

function loadSurah(key, surah) {
  const id = `${key}/${surah}`;
  if (!memo.has(id)) {
    const promise = fetchSurah(key, surah);
    promise.catch(() => memo.delete(id));
    memo.set(id, promise);
    if (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value);
  }
  return memo.get(id);
}

const toInt = (value) => (typeof value === 'number' ? value : /^\s*\d+\s*$/.test(String(value ?? '')) ? Number(value) : NaN);

async function validateRange(surah, from, to) {
  if (!Number.isInteger(surah) || surah < 1 || surah > 114) throw httpError(400, 'invalid_range', 'Surah must be a number from 1 to 114');
  const { ayahCount } = await getSurah(surah);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > to || to > ayahCount) {
    throw httpError(400, 'invalid_range', `Ayah range must satisfy 1 ≤ from ≤ to ≤ ${ayahCount} for surah ${surah}`);
  }
  if (to - from + 1 > MAX_AYAHS_PER_REQUEST) throw httpError(400, 'invalid_range', `At most ${MAX_AYAHS_PER_REQUEST} ayat per request`);
}

/**
 * Commentary for ayat from–to: [{ ayah, text, textRaw, groupStart, groupEnd }]. Ayat of one
 * group share the same text (the group may extend beyond from–to).
 */
export async function getTafsir(surah, from, to, key) {
  [surah, from, to] = [toInt(surah), toInt(from), toInt(to)];
  getTafsirEdition(String(key ?? ''));
  await validateRange(surah, from, to);
  const entries = await loadSurah(String(key), surah);
  return entries.slice(from - 1, to).map((e) => ({ ...e }));
}

// ---------------------------------------------------------------------------
// HTTP

export const router = express.Router();

router.get('/tafsirs', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ defaults: defaultsByLanguage(), tafsirs: await getTafsirs() });
});

router.get('/tafsir', async (req, res) => {
  const key = String(req.query.edition ?? req.query.tafsir ?? '').trim();
  if (!key) throw httpError(400, 'unknown_tafsir', 'Query parameter "edition" is required');
  const edition = getTafsirEdition(key);
  const surah = toInt(req.query.surah);
  if (!Number.isInteger(surah) || surah < 1 || surah > 114) throw httpError(400, 'invalid_range', 'Surah must be a number from 1 to 114');
  const { ayahCount } = await getSurah(surah);
  const from = req.query.from === undefined ? 1 : toInt(req.query.from);
  const to = req.query.to === undefined ? Math.min(ayahCount, from + MAX_AYAHS_PER_REQUEST - 1) : toInt(req.query.to);
  const ayahs = await getTafsir(surah, from, to, key);
  res.json({
    edition: { key: edition.key, languageIso: edition.languageIso, title: edition.title, direction: edition.direction, book: edition.book, label: edition.label },
    surah,
    from,
    to,
    ayahs: ayahs.map(({ ayah, text, groupStart, groupEnd }) => ({ ayah, text, groupStart, groupEnd })),
  });
});
