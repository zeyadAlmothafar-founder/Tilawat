// Validation and normalization of POST /api/render bodies.
import { httpError } from '../lib/errors.js';
import { quranModule, recitersModule, sourcesModule, tafsirModule } from './inputs.js';
import { clamp } from './util.js';

export const MAX_VIDEOS = 50;
export const MAX_AYAHS = 50;
const ASPECTS = ['9:16', '16:9', '1:1'];
const DEFAULT_CATEGORIES = ['nature', 'space'];
const FALLBACK_CATEGORY_IDS = ['nature', 'space', 'mosque', 'islamic'];
export const DEFAULTS = {
  reciter: 'Alafasy_128kbps',
  translation: 'english_saheeh',
};

const toInt = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const num = (v, def, min, max) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? clamp(Number(v), min, max) : def);

function normalizeStyle(style = {}) {
  const s = style && typeof style === 'object' ? style : {};
  return {
    arabicFont: s.arabicFont === 'scheherazade' ? 'scheherazade' : 'amiri',
    textScale: Math.round(num(s.textScale, 1, 0.7, 1.5) * 100) / 100,
    position: s.position === 'lower' ? 'lower' : 'center',
    overlay: Math.round(num(s.overlay, 0.45, 0, 0.8) * 100) / 100,
    showSurahTitle: s.showSurahTitle !== false,
    showReciter: s.showReciter !== false,
  };
}

async function categoryIds() {
  try {
    return (await sourcesModule()).CATEGORY_IDS || FALLBACK_CATEGORY_IDS;
  } catch {
    return FALLBACK_CATEGORY_IDS;
  }
}

async function resolveTranslation(value) {
  if (value === undefined) value = DEFAULTS.translation;
  if (value === null || value === false || value === '' || value === 'none' || value === 'null') return null;
  const key = String(value);
  const list = await (await quranModule()).getTranslations();
  const t = list.find((x) => x.key === key);
  if (!t) throw httpError(400, 'invalid_translation', `Unknown translation "${key}"`);
  return { key: t.key, languageIso: t.languageIso, title: t.title, version: t.version || null, direction: t.direction || null };
}

async function resolveTafsir(value) {
  if (value === undefined || value === null || value === false || value === '' || value === 'none' || value === 'null') return null;
  const key = String(value);
  const list = await (await tafsirModule()).getTafsirs();
  const t = list.find((x) => x.key === key);
  if (!t) throw httpError(400, 'invalid_tafsir', `Unknown tafsir "${key}"`);
  return { key: t.key, title: t.title, languageIso: t.languageIso, direction: t.direction };
}

async function resolveReciter(value) {
  const id = value ? String(value) : DEFAULTS.reciter;
  try {
    const r = await (await recitersModule()).getReciter(id);
    return { id: r.id, nameEn: r.nameEn, nameAr: r.nameAr };
  } catch (err) {
    if (err.code === 'reciter_not_found') throw httpError(400, 'invalid_reciter', err.message);
    throw err;
  }
}

async function resolveItem(item, index) {
  if (!item || typeof item !== 'object') throw httpError(400, 'invalid_items', `items[${index}] must be an object`);
  const number = toInt(item.surah);
  if (!Number.isInteger(number) || number < 1 || number > 114) {
    throw httpError(400, 'invalid_surah', `items[${index}].surah must be 1–114`);
  }
  const s = await (await quranModule()).getSurah(number);
  const from = Number.isInteger(toInt(item.from)) ? toInt(item.from) : 1;
  const to = Number.isInteger(toInt(item.to)) ? toInt(item.to) : from;
  if (from < 1 || to < from || to > s.ayahCount) {
    throw httpError(400, 'invalid_range', `items[${index}]: ayat ${from}–${to} are not in surah ${number} (1–${s.ayahCount})`);
  }
  return { surah: { number: s.number, nameAr: s.nameAr, nameEn: s.nameEn }, from, to };
}

/**
 * Body → { common, videos: [{ surah: {number,nameAr,nameEn}, from, to }] }. Throws httpError(400)
 * with a clear code for anything that cannot be defaulted.
 */
export async function normalizeRequest(body) {
  if (!body || typeof body !== 'object') throw httpError(400, 'invalid_request', 'Expected a JSON object');
  const items = Array.isArray(body.items) ? body.items : body.surah ? [body] : [];
  if (!items.length) throw httpError(400, 'invalid_items', 'items must be a non-empty array');
  if (items.length > MAX_VIDEOS) throw httpError(400, 'too_many_videos', `At most ${MAX_VIDEOS} videos per request`);

  const mode = body.mode === 'perAyah' ? 'perAyah' : 'combined';
  const resolved = [];
  for (const [i, item] of items.entries()) resolved.push(await resolveItem(item, i));

  const videos = [];
  for (const item of resolved) {
    if (mode === 'perAyah') {
      for (let a = item.from; a <= item.to; a++) videos.push({ surah: item.surah, from: a, to: a });
    } else {
      if (item.to - item.from + 1 > MAX_AYAHS) {
        throw httpError(400, 'too_many_ayahs', `At most ${MAX_AYAHS} ayat per video (surah ${item.surah.number}: ${item.from}–${item.to})`);
      }
      videos.push(item);
    }
    if (videos.length > MAX_VIDEOS) throw httpError(400, 'too_many_videos', `At most ${MAX_VIDEOS} videos per request`);
  }

  const allowed = await categoryIds();
  const categories = [...new Set((Array.isArray(body.categories) ? body.categories : []).filter((c) => allowed.includes(c)))];
  const quality = String(body.quality) === '720' ? '720' : '1080';
  const common = {
    mode,
    reciter: await resolveReciter(body.reciter),
    translation: await resolveTranslation(body.translation),
    tafsir: await resolveTafsir(body.tafsir),
    categories: categories.length ? categories : DEFAULT_CATEGORIES,
    aspect: ASPECTS.includes(body.aspect) ? body.aspect : '9:16',
    quality,
    bismillah: body.bismillah !== false,
    approvedOnly: body.approvedOnly === true,
    style: normalizeStyle(body.style),
  };
  return { common, videos };
}
