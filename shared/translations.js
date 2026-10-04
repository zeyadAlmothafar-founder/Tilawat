// Translations (QuranEnc): list filtering, per-language defaults and the display clean-up of
// translation texts. Shared by server/quran.js and the web build (web/js/data.js).
// Pure, dependency-free ESM (Node + browser).
import { DIGIT, digitsValue } from './digits.js';

export const QURANENC_API = 'https://quranenc.com/api/v1';

// Arabic always comes from one canonical translation so it never varies with the chosen
// translation (QuranEnc's arabic_text was verified identical across all translation keys).
export const ARABIC_SOURCE = 'english_saheeh';

// Default translation per UI language (all verified to exist on QuranEnc).
export const DEFAULT_TRANSLATIONS = Object.freeze({
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
export const TAFSIR_KEY = /_(saadi|moyassar|mokhtasar)$/;
export const UNSUITABLE = new Set(['english_waleed', 'circassian_rwwad', 'kurdish_salahuddin']);

/** One QuranEnc list entry → { key, languageIso, title, description, version, direction }. */
export function toTranslation(t) {
  return {
    key: t.key,
    languageIso: t.language_iso_code,
    title: t.title,
    description: typeof t.description === 'string' ? t.description : '',
    version: t.version,
    direction: t.direction === 'rtl' ? 'rtl' : 'ltr',
  };
}

/** QuranEnc `/translations/list` response → the translations offered in the app (or null). */
export function filterTranslations(data) {
  if (!Array.isArray(data?.translations)) return null;
  return data.translations
    .filter((t) => typeof t.key === 'string' && typeof t.title === 'string' && t.title.trim())
    .filter((t) => !TAFSIR_KEY.test(t.key) && !UNSUITABLE.has(t.key) && !/in progress/i.test(t.title))
    .map(toTranslation);
}

/**
 * Default translation key for a UI language (null = Arabic only / unknown language). With
 * `loaded` (the current list), a default QuranEnc dropped falls back to another translation
 * in that language.
 */
export function defaultTranslationFor(uiLang, loaded = null) {
  const lang = String(uiLang ?? '').toLowerCase().split(/[-_]/)[0];
  if (!Object.hasOwn(DEFAULT_TRANSLATIONS, lang)) return null;
  const key = DEFAULT_TRANSLATIONS[lang];
  if (key && loaded && !loaded.some((t) => t.key === key)) {
    return loaded.find((t) => t.languageIso === lang)?.key ?? null;
  }
  return key;
}

/** { en: 'english_saheeh', ar: null, … } for every UI language. */
export function translationDefaults(loaded = null) {
  return Object.fromEntries(Object.keys(DEFAULT_TRANSLATIONS).map((lang) => [lang, defaultTranslationFor(lang, loaded)]));
}

// ---------------------------------------------------------------------------
// Translation clean-up

// "[4]" / "[১]" (always a footnote reference) or "(১)" (only when the footnotes use that label).
const MARKER = new RegExp(String.raw`\s*(?:\[\s*([${DIGIT}]+)\s*\]|\(\s*([${DIGIT}]+)\s*\))\s*`, 'gu');
const FOOTNOTE_LABEL = new RegExp(String.raw`[\[(]\s*([${DIGIT}]+)\s*[\])]|(?:^|\n)\s*([${DIGIT}]+)[\s.)]`, 'gu');
// "3. ", "3-", "(3) ", "3 " or "2-3 " (surah-ayah) at the start of the text.
const LEADING_NUMBER = new RegExp(String.raw`^\s*\(?(?:([${DIGIT}]+)\s*[-:]\s*)?([${DIGIT}]+)\s*[.:)\-–]?\s*`, 'u');
const TRAILING_NUMBER = new RegExp(String.raw`\s*\(\s*([${DIGIT}]+)\s*\)(?=[\s.]*$)`, 'u');
const CLOSING_PUNCT = /[,.;:!?…)\]}»”’،؛؟۔।。、，；：！？」』）]/u;

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
