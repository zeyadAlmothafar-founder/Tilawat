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
import { getSurah, cleanTranslation } from './quran.js';

const API = 'https://quranenc.com/api/v1';
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_AYAHS_PER_REQUEST = 300;
const MEMO_LIMIT = 40;
const BOOK_ORDER = ['mokhtasar', 'moyassar', 'saadi'];
const UI_LANGS = ['ar', 'en', 'ur', 'fa', 'fr', 'tr', 'id', 'ms', 'bn', 'es', 'de', 'ru'];

function loadList() {
  try {
    const list = JSON.parse(fs.readFileSync(new URL('./data/tafsirs.json', import.meta.url), 'utf8'));
    return Object.freeze(list.filter((t) => t?.key && t.title).map((t) => Object.freeze({ ...t, label: shortLabel(t) })));
  } catch (err) {
    console.warn(`[tafsir] no tafsir list (run scripts/check-tafsirs.js): ${err.message}`);
    return Object.freeze([]);
  }
}

// Short book name shown above the commentary in videos, in the edition's script.
const LABELS = {
  ar: { mokhtasar: 'المختصر في التفسير', moyassar: 'التفسير الميسر', saadi: 'تفسير السعدي' },
  // Persian / Urdu / Pashto / Kurdish ... (Arabic script, Persian spelling)
  arabicScript: { mokhtasar: 'تفسیر المختصر', moyassar: 'تفسیر میسر', saadi: 'تفسیر سعدی' },
  latin: { mokhtasar: 'Al-Mukhtasar', moyassar: 'At-Tafsir al-Muyassar', saadi: "Tafsir As-Sa'di" },
};
const ARABIC_SCRIPT_LANGS = new Set(['fa', 'ur', 'ps', 'ku', 'prs', 'ug', 'kmr']);

export function shortLabel(edition) {
  const set = edition.languageIso === 'ar' ? LABELS.ar : ARABIC_SCRIPT_LANGS.has(edition.languageIso) ? LABELS.arabicScript : LABELS.latin;
  return set[edition.book] || edition.title;
}

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
  const lang = String(uiLang ?? '').toLowerCase().split(/[-_]/)[0];
  const options = TAFSIRS.filter((t) => t.languageIso === lang);
  options.sort((a, b) => BOOK_ORDER.indexOf(a.book) - BOOK_ORDER.indexOf(b.book));
  return options[0]?.key ?? null;
}

function defaultsByLanguage() {
  return Object.fromEntries(UI_LANGS.map((lang) => [lang, defaultTafsirFor(lang)]));
}

// ---------------------------------------------------------------------------
// Surah texts

const memo = new Map(); // `${key}/${surah}` → Promise<entries[]> (index = ayah - 1)

const DIGIT = '0-9٠-٩۰-۹०-९০-৯';
const DIGIT_ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6];
// "255. ", "3 - 4 - ", "(5) ", "3-4: ", "1、" at the start of the commentary.
const LEADING_RANGE = new RegExp(
  String.raw`^\s*\(?([${DIGIT}]+)\)?\s*(?:[-–]\s*\(?([${DIGIT}]+)\)?\s*)?(?:[.:\-–)、，．]\s*|\s+)`,
  'u',
);

function digitsValue(text) {
  let value = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    value = value * 10 + (code - DIGIT_ZEROS.find((z) => code >= z && code <= z + 9));
  }
  return value;
}

/** Display text: the ayah number(s) prefixed by some editions and footnote markers removed. */
function cleanTafsir(raw, footnotes, start, end, surah) {
  let text = String(raw ?? '');
  const m = text.match(LEADING_RANGE);
  if (m) {
    const a = digitsValue(m[1]);
    const b = m[2] === undefined ? a : digitsValue(m[2]);
    if (a >= start - 1 && a <= end && b >= a && b <= end + 1 && m[0].length < text.length) text = text.slice(m[0].length);
  }
  return cleanTranslation(text, footnotes, end, surah) || '';
}

const sameText = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** QuranEnc rows → per-ayah entries with groups merged. */
function buildEntries(rows, ayahCount, surah) {
  const groups = [];
  let pendingStart = null; // empty entries before the first text join the next group
  for (let ayah = 1; ayah <= ayahCount; ayah++) {
    const row = rows.get(ayah);
    const raw = String(row.translation ?? '');
    const last = groups[groups.length - 1];
    if (!raw.trim()) {
      if (last) last.end = ayah;
      else pendingStart ??= ayah;
    } else if (last && sameText(last.raw, raw)) {
      last.end = ayah;
    } else {
      groups.push({ start: pendingStart ?? ayah, end: ayah, raw, footnotes: row.footnotes ? String(row.footnotes) : null });
      pendingStart = null;
    }
  }
  const entries = [];
  for (const g of groups) {
    const text = cleanTafsir(g.raw, g.footnotes, g.start, g.end, surah);
    for (let ayah = g.start; ayah <= g.end; ayah++) {
      entries.push({ ayah, text, textRaw: g.raw, groupStart: g.start, groupEnd: g.end });
    }
  }
  return entries;
}

async function fetchSurah(key, surah) {
  const { ayahCount } = await getSurah(surah);
  const cacheFile = path.join(QURAN_CACHE_DIR, `tafsir-${key}`, `${String(surah).padStart(3, '0')}.json`);
  let data;
  try {
    data = await fetchJson(`${API}/translation/sura/${encodeURIComponent(key)}/${surah}`, { cacheFile, maxAgeMs: MONTH_MS, timeoutMs: 60000 });
  } catch (err) {
    throw httpError(502, 'upstream_unavailable', `Could not load the tafsir of surah ${surah} (${key}) from QuranEnc (${err.message})`);
  }
  const rows = new Map((Array.isArray(data?.result) ? data.result : []).map((row) => [Number(row.aya), row]));
  let complete = rows.size === ayahCount;
  for (let a = 1; complete && a <= ayahCount; a++) if (!rows.has(a)) complete = false;
  const filled = [...rows.values()].filter((r) => String(r.translation ?? '').trim()).length;
  if (!complete || !filled) {
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
