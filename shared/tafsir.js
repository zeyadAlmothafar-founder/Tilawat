// Tafsir (commentary) helpers shared by server/tafsir.js and the web build: short book labels,
// per-language defaults, and turning QuranEnc rows into per-ayah entries with groups merged.
// Pure, dependency-free ESM (Node + browser).
import { DIGIT, digitsValue } from './digits.js';
import { cleanTranslation } from './translations.js';

export const BOOK_ORDER = ['mokhtasar', 'moyassar', 'saadi'];
export const UI_LANGS = ['ar', 'en', 'ur', 'fa', 'fr', 'tr', 'id', 'ms', 'bn', 'es', 'de', 'ru'];

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

/** server/data/tafsirs.json entries → frozen editions with their short `label`. */
export function withLabels(list) {
  return Object.freeze(
    (Array.isArray(list) ? list : []).filter((t) => t?.key && t.title).map((t) => Object.freeze({ ...t, label: shortLabel(t) })),
  );
}

/** Best tafsir for a UI language (Al-Mukhtasar first, then Al-Muyassar, then As-Sa'di), or null. */
export function defaultTafsirFor(list, uiLang) {
  const lang = String(uiLang ?? '').toLowerCase().split(/[-_]/)[0];
  const options = list.filter((t) => t.languageIso === lang);
  options.sort((a, b) => BOOK_ORDER.indexOf(a.book) - BOOK_ORDER.indexOf(b.book));
  return options[0]?.key ?? null;
}

/** { ar: 'arabic_mokhtasar', en: …, de: null, … } for every UI language. */
export function tafsirDefaults(list) {
  return Object.fromEntries(UI_LANGS.map((lang) => [lang, defaultTafsirFor(list, lang)]));
}

// "255. ", "3 - 4 - ", "(5) ", "3-4: ", "1、" at the start of the commentary.
const LEADING_RANGE = new RegExp(
  String.raw`^\s*\(?([${DIGIT}]+)\)?\s*(?:[-–]\s*\(?([${DIGIT}]+)\)?\s*)?(?:[.:\-–)、，．]\s*|\s+)`,
  'u',
);

/** Display text: the ayah number(s) prefixed by some editions and footnote markers removed. */
export function cleanTafsir(raw, footnotes, start, end, surah) {
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

/**
 * QuranEnc rows (Map ayah → row) → per-ayah entries [{ ayah, text, textRaw, groupStart, groupEnd }].
 * Some editions explain several ayat at once: QuranEnc then repeats the same text for each of
 * them (or leaves the later entries empty). Such runs are merged into one group.
 */
export function buildEntries(rows, ayahCount, surah) {
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

/** QuranEnc sura response → Map ayah → row, or null when incomplete (never cache those). */
export function completeTafsirRows(data, ayahCount) {
  const rows = new Map((Array.isArray(data?.result) ? data.result : []).map((row) => [Number(row.aya), row]));
  let complete = rows.size === ayahCount;
  for (let a = 1; complete && a <= ayahCount; a++) if (!rows.has(a)) complete = false;
  const filled = [...rows.values()].filter((r) => String(r.translation ?? '').trim()).length;
  return complete && filled ? rows : null;
}

/**
 * Which ayat of a video carry tafsir cards: a group's commentary is shown once, after its last
 * ayah (or after the last ayah of the video when the group runs past it). Empty texts never
 * become a card. `rows` are entries for ayat from–to → Map ayah → { text, groupStart, groupEnd }
 * (group clipped to from–to).
 */
export function tafsirCardsFor(rows, from, to) {
  const cards = new Map();
  for (const row of rows) {
    if (row.text && (row.ayah === row.groupEnd || row.ayah === to)) {
      cards.set(row.ayah, { text: row.text, groupStart: Math.max(row.groupStart, from), groupEnd: Math.min(row.groupEnd, to) });
    }
  }
  return cards;
}
