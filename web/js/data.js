// Web build data layer: static data shipped in /data/*, Quran text / translations / tafsir
// straight from QuranEnc (CORS), recitation URLs on EveryAyah, and the curated clip manifest.
// Responses are cached with the Cache API (when available) so repeat visits work offline-ish.
// Mirrors server/quran.js, server/tafsir.js and server/sources/pick.js (same shapes, same errors).
import { ApiError } from './errors.js';
import {
  QURANENC_API, ARABIC_SOURCE, filterTranslations, translationDefaults, cleanTranslation,
} from '../../shared/translations.js';
import { withLabels, tafsirDefaults, buildEntries, completeTafsirRows } from '../../shared/tafsir.js';
import { CATEGORY_IDS } from '../../shared/render-rules.js';

export const AUDIO_BASE = 'https://everyayah.com/data';
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;
const MAX_AYAHS_PER_REQUEST = 300;
const CACHE_NAME = 'tilawat-data-v1';
const SECONDS_PER_CLIP = 7;
const MAX_CLIPS = 20;

// ---------------------------------------------------------------------------
// Plumbing (overridable for Node tests)

const env = {
  fetch: (...args) => globalThis.fetch(...args),
  /** Static file shipped with the site, e.g. 'surahs.json' → /data/surahs.json (null when absent). */
  loadStatic: async (name) => {
    const res = await env.fetch(`/data/${name}`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  cache: () => (globalThis.caches ? globalThis.caches.open(CACHE_NAME).catch(() => null) : Promise.resolve(null)),
  random: Math.random,
};

/** Tests: replace fetch / loadStatic / cache / random. */
export function configure(overrides) {
  Object.assign(env, overrides);
  memo.clear();
}

const memo = new Map();
function cached(key, load) {
  if (!memo.has(key)) memo.set(key, load().catch((err) => { memo.delete(key); throw err; }));
  return memo.get(key);
}

async function fetchJsonNet(url, timeoutMs = 60000) {
  const res = await env.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * JSON from `url`, cached under `key` for `maxAgeMs`. `validate(data)` → false means "don't
 * cache, fail". A stale cached copy is used when the network fails.
 */
async function cachedJson(url, { key = url, maxAgeMs = Infinity, validate = () => true } = {}) {
  const cache = await env.cache();
  let stale = null;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const at = Number(hit.headers.get('x-tilawat-at')) || 0;
        const data = await hit.json();
        if (Date.now() - at < maxAgeMs && validate(data)) return data;
        if (validate(data)) stale = data;
      }
    } catch { /* corrupt entry: refetch */ }
  }
  try {
    const data = await fetchJsonNet(url);
    if (!validate(data)) throw new Error('incomplete response');
    if (cache) {
      const body = JSON.stringify(data);
      cache.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'x-tilawat-at': String(Date.now()) } })).catch(() => {});
    }
    return data;
  } catch (err) {
    if (stale) return stale;
    throw err;
  }
}

const toInt = (value) => (typeof value === 'number' ? value : /^\s*\d+\s*$/.test(String(value ?? '')) ? Number(value) : NaN);

// ---------------------------------------------------------------------------
// Static data

export const getSurahs = () => cached('surahs', async () => {
  const list = await env.loadStatic('surahs.json');
  if (!Array.isArray(list)) throw new ApiError(500, 'internal_error', 'surahs.json is missing');
  return list;
});

export const getReciters = () => cached('reciters', async () => {
  const list = await env.loadStatic('reciters.json');
  if (!Array.isArray(list)) throw new ApiError(500, 'internal_error', 'reciters.json is missing');
  return list;
});

async function getSurah(number) {
  const surah = (await getSurahs())[Number(number) - 1];
  if (!surah) throw new ApiError(404, 'surah_not_found', `Surah ${number} does not exist`);
  return surah;
}

function validateSurahNumber(surah) {
  if (!Number.isInteger(surah) || surah < 1 || surah > 114) throw new ApiError(400, 'invalid_range', 'Surah must be a number from 1 to 114');
}

function validateRange(surah, from, to, ayahCount) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > to || to > ayahCount) {
    throw new ApiError(400, 'invalid_range', `Ayah range must satisfy 1 ≤ from ≤ to ≤ ${ayahCount} for surah ${surah}`);
  }
  if (to - from + 1 > MAX_AYAHS_PER_REQUEST) throw new ApiError(400, 'invalid_range', `At most ${MAX_AYAHS_PER_REQUEST} ayat per request`);
}

// ---------------------------------------------------------------------------
// Translations

async function loadTranslationList() {
  try {
    const data = await cachedJson(`${QURANENC_API}/translations/list?all=1`, {
      maxAgeMs: DAY_MS,
      validate: (d) => Array.isArray(d?.translations),
    });
    return filterTranslations(data);
  } catch (err) {
    // Offline / QuranEnc down: the snapshot shipped with the build (if any).
    const snapshot = await env.loadStatic('translations.json').catch(() => null);
    const list = filterTranslations(snapshot);
    if (list) return list;
    throw new ApiError(502, 'upstream_unavailable', `Could not load translations from QuranEnc (${err.message})`);
  }
}

const translationList = () => cached('translations', loadTranslationList);

/** → { defaults: { en: 'english_saheeh', ar: null, … }, translations: [...] } (like GET /api/translations). */
export async function getTranslations() {
  const translations = await translationList();
  return { defaults: translationDefaults(translations), translations };
}

export async function findTranslation(key) {
  const t = (await translationList()).find((x) => x.key === key);
  if (!t) throw new ApiError(400, 'unknown_translation', `Unknown translation "${key}"`);
  return t;
}

// ---------------------------------------------------------------------------
// Surah texts

async function loadSurahText(key, surah) {
  return cached(`text:${key}/${surah}`, async () => {
    const { ayahCount } = await getSurah(surah);
    // A new QuranEnc release gets a new cache key (their terms ask to follow the latest version).
    const version = await translationList().then((l) => l.find((t) => t.key === key)?.version).catch(() => null);
    const url = `${QURANENC_API}/translation/sura/${encodeURIComponent(key)}/${surah}`;
    const toRows = (data) => new Map((Array.isArray(data?.result) ? data.result : []).map((row) => [Number(row.aya), row]));
    let data;
    try {
      data = await cachedJson(url, {
        key: `${url}?v=${encodeURIComponent(version || '0')}`,
        validate: (d) => {
          const rows = toRows(d);
          return rows.size === ayahCount && Boolean(rows.get(1)?.arabic_text);
        },
      });
    } catch (err) {
      throw new ApiError(502, 'upstream_unavailable', `Could not load surah ${surah} (${key}) from QuranEnc (${err.message})`);
    }
    return toRows(data);
  });
}

const normalizeKey = (value) => {
  if (value == null) return null;
  const key = String(value).trim();
  return key === '' || key === 'none' || key === 'null' ? null : key;
};

/** Like GET /api/ayahs → { surah, from, to, translation, ayahs: [{ surah, ayah, arabic, translation, translationRaw, footnotes }] }. */
export async function getAyahs({ surah, from, to, translation } = {}) {
  const number = toInt(surah);
  validateSurahNumber(number);
  const s = await getSurah(number);
  const f = from === undefined || from === null ? 1 : toInt(from);
  const t = to === undefined || to === null ? s.ayahCount : toInt(to);
  validateRange(number, f, t, s.ayahCount);
  const key = normalizeKey(translation);
  const tr = key ? await findTranslation(key) : null;

  const [arabicResult, translationResult] = await Promise.allSettled([
    loadSurahText(ARABIC_SOURCE, number),
    key ? loadSurahText(key, number) : null,
  ]);
  if (translationResult.status === 'rejected') throw translationResult.reason;
  // The Arabic is identical in every QuranEnc translation, so the requested one can stand in.
  const arabicRows = arabicResult.status === 'fulfilled' ? arabicResult.value : translationResult.value;
  if (!arabicRows) throw arabicResult.reason;
  const translationRows = translationResult.value;

  const ayahs = [];
  for (let ayah = f; ayah <= t; ayah++) {
    const row = translationRows?.get(ayah);
    const translationRaw = row ? String(row.translation ?? '') : null;
    const footnotes = row?.footnotes ? String(row.footnotes) : null;
    ayahs.push({
      surah: number,
      ayah,
      arabic: arabicRows.get(ayah).arabic_text,
      translation: row ? cleanTranslation(translationRaw, footnotes, ayah, number) : null,
      translationRaw,
      footnotes,
    });
  }
  return {
    surah: s,
    from: f,
    to: t,
    translation: tr && { key: tr.key, languageIso: tr.languageIso, title: tr.title, direction: tr.direction },
    ayahs,
  };
}

export async function getBismillahText() {
  const rows = await loadSurahText(ARABIC_SOURCE, 1);
  return rows.get(1).arabic_text;
}

// ---------------------------------------------------------------------------
// Tafsir

const tafsirList = () => cached('tafsirs', async () => withLabels(await env.loadStatic('tafsirs.json').catch(() => null)));

/** → { defaults, tafsirs } (like GET /api/tafsirs). */
export async function getTafsirs() {
  const tafsirs = await tafsirList();
  return { defaults: tafsirDefaults(tafsirs), tafsirs };
}

export async function getTafsirEdition(key) {
  const edition = (await tafsirList()).find((t) => t.key === key);
  if (!edition) throw new ApiError(400, 'unknown_tafsir', `Unknown tafsir "${key}"`);
  return edition;
}

function loadTafsirSurah(key, surah) {
  return cached(`tafsir:${key}/${surah}`, async () => {
    const { ayahCount } = await getSurah(surah);
    const url = `${QURANENC_API}/translation/sura/${encodeURIComponent(key)}/${surah}`;
    let data;
    try {
      data = await cachedJson(url, { maxAgeMs: MONTH_MS, validate: (d) => Boolean(completeTafsirRows(d, ayahCount)) });
    } catch (err) {
      throw new ApiError(502, 'upstream_unavailable', `Could not load the tafsir of surah ${surah} (${key}) from QuranEnc (${err.message})`);
    }
    return buildEntries(completeTafsirRows(data, ayahCount), ayahCount, surah);
  });
}

/** Like GET /api/tafsir → { edition, surah, from, to, ayahs: [{ ayah, text, groupStart, groupEnd }] }. */
export async function getTafsir({ surah, from, to, edition } = {}) {
  const key = String(edition ?? '').trim();
  if (!key) throw new ApiError(400, 'unknown_tafsir', 'An edition is required');
  const ed = await getTafsirEdition(key);
  const number = toInt(surah);
  validateSurahNumber(number);
  const { ayahCount } = await getSurah(number);
  const f = from === undefined || from === null ? 1 : toInt(from);
  const t = to === undefined || to === null ? Math.min(ayahCount, f + MAX_AYAHS_PER_REQUEST - 1) : toInt(to);
  validateRange(number, f, t, ayahCount);
  const entries = await loadTafsirSurah(key, number);
  return {
    edition: { key: ed.key, languageIso: ed.languageIso, title: ed.title, direction: ed.direction, book: ed.book, label: ed.label },
    surah: number,
    from: f,
    to: t,
    ayahs: entries.slice(f - 1, t).map(({ ayah, text, groupStart, groupEnd }) => ({ ayah, text, groupStart, groupEnd })),
  };
}

// ---------------------------------------------------------------------------
// Recitation

export function audioUrl(reciter, surah, ayah) {
  const name = `${String(surah).padStart(3, '0')}${String(ayah).padStart(3, '0')}`;
  return `${AUDIO_BASE}/${encodeURIComponent(reciter)}/${name}.mp3`;
}

// ---------------------------------------------------------------------------
// Clip manifest (web/clips.json → /data/clips.json, written by scripts/build-web-clips.js)

const EMPTY_MANIFEST = Object.freeze({ version: 1, mode: null, base: null, clips: [] });

export const getManifest = () => cached('clips', async () => {
  const data = await env.loadStatic('clips.json').catch(() => null);
  if (!data || !Array.isArray(data.clips)) return EMPTY_MANIFEST;
  return data;
});

/** Relative manifest URLs resolve against `base` (absolute ones are kept). */
export function resolveClipUrl(url, base) {
  if (!url) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (!base) return url;
  return new URL(url, base.endsWith('/') ? base : `${base}/`).href;
}

const providerOf = (clip) => String(clip.provider || String(clip.id || '').split(':')[0] || 'pixabay').toLowerCase();
const orientationOfClip = (c) => c.orientation || (c.height > c.width ? 'portrait' : c.height === c.width ? 'square' : 'landscape');

const area = (s) => (Number(s.width) || 0) * (Number(s.height) || 0);

/**
 * One segment per part of a clip, at the rendition closest to `quality`. In "pixabay-direct"
 * manifests the segments are renditions of the whole clip (no `part`; res labels name the
 * rendition, the real size can be smaller), in "r2" manifests each `part` (8 s cut) has a
 * 1080 and a 720 rendition. Prefers the matching `res`, else the largest rendition for 1080
 * output and the largest one not above 720 lines for 720 output (the engine scales up/down).
 */
function segmentsFor(clip, quality) {
  const segs = (Array.isArray(clip.segments) ? clip.segments : []).filter((s) => s && s.url);
  const parts = new Map();
  for (const s of segs) {
    const key = s.part ?? '';
    if (!parts.has(key)) parts.set(key, []);
    parts.get(key).push(s);
  }
  const lines = Number(quality) || 1080;
  return [...parts.values()].map((list) => {
    const exact = list.filter((s) => String(s.res) === String(quality)).sort((a, b) => area(b) - area(a))[0];
    if (exact) return exact;
    const bySize = [...list].sort((a, b) => area(b) - area(a));
    if (lines >= 1080) return bySize[0];
    return bySize.find((s) => Math.min(s.width || 0, s.height || 0) <= lines) || bySize[bySize.length - 1];
  });
}

/** Manifest clip → the library clip object the Backgrounds page expects. */
function toLibraryClip(clip, base) {
  const segs = Array.isArray(clip.segments) ? clip.segments.filter((s) => s?.url) : [];
  const big = [...segs].sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0))[0];
  const small = [...segs].sort((a, b) => (a.width * a.height || 0) - (b.width * b.height || 0))[0];
  const provider = providerOf(clip);
  return {
    id: clip.id,
    provider,
    providerId: String(clip.id || '').split(':')[1] || null,
    category: clip.category,
    title: clip.title || '',
    tags: Array.isArray(clip.tags) ? clip.tags : [],
    author: clip.author || null,
    authorUrl: clip.authorUrl || null,
    sourceUrl: clip.sourceUrl || null,
    thumbUrl: resolveClipUrl(clip.thumb, base),
    previewUrl: small ? resolveClipUrl(small.url, base) : null,
    width: big?.width || clip.width || null,
    height: big?.height || clip.height || null,
    duration: big?.duration || clip.duration || null,
    orientation: orientationOfClip(big || clip),
    status: 'approved',
    addedAt: null,
  };
}

/** Curated clips (all categories when `category` is omitted). */
export async function getLibrary(category) {
  const { clips, base } = await getManifest();
  return clips.filter((c) => !category || c.category === category).map((c) => toLibraryClip(c, base));
}

/** { nature: { approved: n }, … } */
export async function libraryCounts() {
  const { clips } = await getManifest();
  return Object.fromEntries(CATEGORY_IDS.map((id) => [id, { approved: clips.filter((c) => c.category === id).length }]));
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(env.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function roundRobin(lists) {
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

/** Shuffled, with clips matching the output orientation first (square output takes any). */
function byOrientation(list, orientation) {
  if (orientation === 'square') return shuffle(list);
  const fits = (c) => orientationOfClip(c) === orientation;
  return [...shuffle(list.filter(fits)), ...shuffle(list.filter((c) => !fits(c)))];
}

export function targetCount(totalDuration) {
  const n = Math.ceil((Number(totalDuration) || 0) / SECONDS_PER_CLIP);
  return Math.min(MAX_CLIPS, Math.max(1, n));
}

/**
 * Background clips for one video, in play order: round-robin across `categories`, matching
 * orientation first, one segment per clip before reusing a clip's other segments, segments
 * at the requested resolution ('1080' | '720', else whatever exists). → job.clips entries.
 */
export async function pickClips({ categories, totalDuration, orientation = 'portrait', quality = '1080' } = {}) {
  const { clips, base } = await getManifest();
  const cats = [...new Set((Array.isArray(categories) ? categories : [categories]).filter((c) => CATEGORY_IDS.includes(c)))];
  if (!cats.length) cats.push(...CATEGORY_IDS);
  const need = targetCount(totalDuration);
  const ordered = roundRobin(cats.map((cat) => byOrientation(clips.filter((c) => c.category === cat), orientation)));
  const perClip = ordered.map((clip) => ({ clip, segs: shuffle(segmentsFor(clip, quality)) })).filter((x) => x.segs.length);
  const chosen = [];
  for (let round = 0; chosen.length < need && perClip.some((x) => round < x.segs.length); round++) {
    for (const { clip, segs } of perClip) {
      if (chosen.length >= need) break;
      if (round < segs.length) chosen.push({ clip, seg: segs[round] });
    }
  }
  return chosen.map(({ clip, seg }) => ({
    id: clip.id,
    url: resolveClipUrl(seg.url, base),
    width: seg.width,
    height: seg.height,
    duration: seg.duration,
    provider: providerOf(clip),
    author: clip.author || null,
    sourceUrl: clip.sourceUrl || null,
  }));
}
