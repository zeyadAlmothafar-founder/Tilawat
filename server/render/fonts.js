import fsp from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR, FONTS_DIR } from '../paths.js';
import { download } from '../lib/http.js';

// All fonts are SIL OFL. `family` is the exact name-table family libass matches against
// (verified with readFontFamilies + test renders). Base fonts are fetched by
// scripts/c-fetch-fonts.js; script-specific Noto fonts are downloaded on first use
// (into cache/fonts).
const GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl';
const NOTO = 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts';
const noto = (name, weight = 'Regular') => `${NOTO}/${name}/hinted/ttf/${name}-${weight}.ttf`;

export const FONTS = {
  amiriQuran: { family: 'Amiri Quran', file: 'AmiriQuran-Regular.ttf', url: `${GF}/amiriquran/AmiriQuran-Regular.ttf`, base: true },
  amiri: { family: 'Amiri', file: 'Amiri-Regular.ttf', url: `${GF}/amiri/Amiri-Regular.ttf`, base: true },
  amiriBold: { family: 'Amiri', bold: true, file: 'Amiri-Bold.ttf', url: `${GF}/amiri/Amiri-Bold.ttf`, base: true },
  scheherazade: { family: 'Scheherazade New', file: 'ScheherazadeNew-Regular.ttf', url: `${GF}/scheherazadenew/ScheherazadeNew-Regular.ttf`, base: true },
  scheherazadeBold: { family: 'Scheherazade New', bold: true, file: 'ScheherazadeNew-Bold.ttf', url: `${GF}/scheherazadenew/ScheherazadeNew-Bold.ttf`, base: true },
  notoSans: { family: 'Noto Sans', file: 'NotoSans-Regular.ttf', url: noto('NotoSans'), base: true },
  notoSansMedium: { family: 'Noto Sans Medium', file: 'NotoSans-Medium.ttf', url: noto('NotoSans', 'Medium'), base: true },
  notoSansSemiBold: { family: 'Noto Sans SemiBold', file: 'NotoSans-SemiBold.ttf', url: noto('NotoSans', 'SemiBold'), base: true },
  naskh: { family: 'Noto Naskh Arabic', file: 'NotoNaskhArabic-Regular.ttf', url: noto('NotoNaskhArabic'), base: true },
  nastaliq: { family: 'Noto Nastaliq Urdu', file: 'NotoNastaliqUrdu-Regular.ttf', url: noto('NotoNastaliqUrdu'), base: true },
  bengali: { family: 'Noto Sans Bengali', file: 'NotoSansBengali-Regular.ttf', url: noto('NotoSansBengali'), base: true },
  devanagari: { family: 'Noto Sans Devanagari', file: 'NotoSansDevanagari-Regular.ttf', url: noto('NotoSansDevanagari') },
  tamil: { family: 'Noto Sans Tamil', file: 'NotoSansTamil-Regular.ttf', url: noto('NotoSansTamil') },
  telugu: { family: 'Noto Sans Telugu', file: 'NotoSansTelugu-Regular.ttf', url: noto('NotoSansTelugu') },
  gujarati: { family: 'Noto Sans Gujarati', file: 'NotoSansGujarati-Regular.ttf', url: noto('NotoSansGujarati') },
  malayalam: { family: 'Noto Sans Malayalam', file: 'NotoSansMalayalam-Regular.ttf', url: noto('NotoSansMalayalam') },
  kannada: { family: 'Noto Sans Kannada', file: 'NotoSansKannada-Regular.ttf', url: noto('NotoSansKannada') },
  gurmukhi: { family: 'Noto Sans Gurmukhi', file: 'NotoSansGurmukhi-Regular.ttf', url: noto('NotoSansGurmukhi') },
  sinhala: { family: 'Noto Sans Sinhala', file: 'NotoSansSinhala-Regular.ttf', url: noto('NotoSansSinhala') },
  thai: { family: 'Noto Sans Thai', file: 'NotoSansThai-Regular.ttf', url: noto('NotoSansThai') },
  khmer: { family: 'Noto Sans Khmer', file: 'NotoSansKhmer-Regular.ttf', url: noto('NotoSansKhmer') },
  lao: { family: 'Noto Sans Lao', file: 'NotoSansLao-Regular.ttf', url: noto('NotoSansLao') },
  myanmar: { family: 'Noto Sans Myanmar', file: 'NotoSansMyanmar-Regular.ttf', url: noto('NotoSansMyanmar') },
  ethiopic: { family: 'Noto Sans Ethiopic', file: 'NotoSansEthiopic-Regular.ttf', url: noto('NotoSansEthiopic') },
  nko: { family: 'Noto Sans NKo', file: 'NotoSansNKo-Regular.ttf', url: noto('NotoSansNKo') },
  hebrew: { family: 'Noto Sans Hebrew', file: 'NotoSansHebrew-Regular.ttf', url: noto('NotoSansHebrew') },
  armenian: { family: 'Noto Sans Armenian', file: 'NotoSansArmenian-Regular.ttf', url: noto('NotoSansArmenian') },
  georgian: { family: 'Noto Sans Georgian', file: 'NotoSansGeorgian-Regular.ttf', url: noto('NotoSansGeorgian') },
  // CJK only exist as large variable fonts upstream (10-18 MB); default instance is Regular.
  cjkSc: { family: 'Noto Sans SC', file: 'NotoSansSC[wght].ttf', url: `${GF}/notosanssc/NotoSansSC%5Bwght%5D.ttf` },
  cjkJp: { family: 'Noto Sans JP', file: 'NotoSansJP[wght].ttf', url: `${GF}/notosansjp/NotoSansJP%5Bwght%5D.ttf` },
  cjkKr: { family: 'Noto Sans KR', file: 'NotoSansKR[wght].ttf', url: `${GF}/notosanskr/NotoSansKR%5Bwght%5D.ttf` },
};

export const ARABIC_FONTS = { amiri: 'amiriQuran', scheherazade: 'scheherazade' };

// Unicode ranges → script id. Latin/Greek/Cyrillic are all covered by Noto Sans.
const SCRIPT_RANGES = [
  ['arabic', [[0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff]]],
  ['hebrew', [[0x0590, 0x05ff]]],
  ['devanagari', [[0x0900, 0x097f]]],
  ['bengali', [[0x0980, 0x09ff]]],
  ['gurmukhi', [[0x0a00, 0x0a7f]]],
  ['gujarati', [[0x0a80, 0x0aff]]],
  ['tamil', [[0x0b80, 0x0bff]]],
  ['telugu', [[0x0c00, 0x0c7f]]],
  ['kannada', [[0x0c80, 0x0cff]]],
  ['malayalam', [[0x0d00, 0x0d7f]]],
  ['sinhala', [[0x0d80, 0x0dff]]],
  ['thai', [[0x0e00, 0x0e7f]]],
  ['lao', [[0x0e80, 0x0eff]]],
  ['myanmar', [[0x1000, 0x109f]]],
  ['georgian', [[0x10a0, 0x10ff]]],
  ['ethiopic', [[0x1200, 0x139f]]],
  ['khmer', [[0x1780, 0x17ff]]],
  ['nko', [[0x07c0, 0x07ff]]],
  ['armenian', [[0x0530, 0x058f]]],
  ['hangul', [[0xac00, 0xd7af], [0x1100, 0x11ff], [0x3130, 0x318f]]],
  ['kana', [[0x3040, 0x30ff]]],
  ['han', [[0x4e00, 0x9fff], [0x3400, 0x4dbf]]],
];

const RTL_SCRIPTS = new Set(['arabic', 'hebrew', 'nko']);

/** Dominant non-Latin script of `text`, or 'latin'. */
export function detectScript(text) {
  const counts = {};
  for (const ch of text || '') {
    const cp = ch.codePointAt(0);
    if (cp < 0x0530) continue;
    for (const [script, ranges] of SCRIPT_RANGES) {
      if (ranges.some(([a, b]) => cp >= a && cp <= b)) {
        counts[script] = (counts[script] || 0) + 1;
        break;
      }
    }
  }
  if (counts.kana) return 'kana'; // Japanese mixes kana with kanji
  let best = 'latin';
  let max = 0;
  for (const [script, n] of Object.entries(counts)) {
    if (n > max) [best, max] = [script, n];
  }
  return best;
}

/**
 * Font for a translation: chosen from the text's actual script, with the language
 * deciding between Arabic-script styles (Nastaliq for Urdu, Naskh otherwise).
 * Returns { key, family, rtl, script }.
 */
export function translationFont(text, languageIso) {
  const script = detectScript(text);
  let key;
  if (script === 'arabic') key = languageIso === 'ur' ? 'nastaliq' : 'naskh';
  else if (script === 'han') key = languageIso === 'ja' ? 'cjkJp' : 'cjkSc';
  else if (script === 'kana') key = 'cjkJp';
  else if (script === 'hangul') key = 'cjkKr';
  else if (FONTS[script]) key = script;
  else key = 'notoSansMedium';
  return { key, family: FONTS[key].family, rtl: RTL_SCRIPTS.has(script), script };
}

// Base fonts ship in assets/fonts; on-demand script fonts go to the (gitignored) cache.
const LAZY_FONTS_DIR = path.join(CACHE_DIR, 'fonts');

export function fontPath(key) {
  return path.join(FONTS[key].base ? FONTS_DIR : LAZY_FONTS_DIR, FONTS[key].file);
}

/** Make sure the font file exists locally (downloads lazily). Resolves to its path. */
export async function ensureFont(key) {
  const font = FONTS[key];
  if (!font) throw new Error(`Unknown font ${key}`);
  return download(font.url, fontPath(key), { timeoutMs: 300000 });
}

export async function ensureBaseFonts() {
  const keys = Object.keys(FONTS).filter((k) => FONTS[k].base);
  for (const key of keys) await ensureFont(key);
  return keys;
}

/**
 * Hard-link (or copy) the given fonts into `dir`, so libass only loads what this job
 * needs via `fontsdir`. Returns the list of files placed.
 */
export async function prepareJobFonts(keys, dir) {
  await fsp.mkdir(dir, { recursive: true });
  const files = [];
  for (const key of new Set(keys)) {
    const src = await ensureFont(key);
    const dest = path.join(dir, FONTS[key].file);
    try {
      await fsp.link(src, dest);
    } catch (err) {
      if (err.code !== 'EEXIST') await fsp.copyFile(src, dest);
    }
    files.push(dest);
  }
  return files;
}

function tableOffset(buf, tag) {
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === tag) return buf.readUInt32BE(rec + 8);
  }
  return -1;
}

/** Set of code points the font maps to a real glyph (cmap formats 4 and 12). */
function readCoverage(buf) {
  const cmap = tableOffset(buf, 'cmap');
  const covered = new Set();
  if (cmap < 0) return covered;
  const count = buf.readUInt16BE(cmap + 2);
  const subtables = [];
  for (let i = 0; i < count; i++) {
    const r = cmap + 4 + i * 8;
    const offset = cmap + buf.readUInt32BE(r + 4);
    subtables.push({ platform: buf.readUInt16BE(r), encoding: buf.readUInt16BE(r + 2), offset, format: buf.readUInt16BE(offset) });
  }
  const f12 = subtables.find((s) => s.format === 12);
  if (f12) {
    const groups = buf.readUInt32BE(f12.offset + 12);
    for (let g = 0; g < groups; g++) {
      const p = f12.offset + 16 + g * 12;
      const end = buf.readUInt32BE(p + 4);
      for (let c = buf.readUInt32BE(p); c <= end; c++) covered.add(c);
    }
    return covered;
  }
  const f4 = subtables.find((s) => s.format === 4 && (s.platform === 3 || s.platform === 0));
  if (!f4) return covered;
  const o = f4.offset;
  const segs = buf.readUInt16BE(o + 6) / 2;
  const ends = o + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;
  for (let i = 0; i < segs; i++) {
    const end = buf.readUInt16BE(ends + i * 2);
    const start = buf.readUInt16BE(starts + i * 2);
    const delta = buf.readInt16BE(deltas + i * 2);
    const rangeOffset = buf.readUInt16BE(ranges + i * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let glyph;
      if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
      else {
        glyph = buf.readUInt16BE(ranges + i * 2 + rangeOffset + (c - start) * 2);
        if (glyph) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph) covered.add(c);
    }
  }
  return covered;
}

const coverageCache = new Map();

/** Code points covered by font `key` (downloads it if needed; cached). */
export async function fontCoverage(key) {
  if (!coverageCache.has(key)) {
    coverageCache.set(key, ensureFont(key).then((file) => fsp.readFile(file)).then(readCoverage));
  }
  return coverageCache.get(key);
}

// Characters that never force a font switch: spaces, marks (stay with their base),
// format controls (ZWJ, RLM, ...).
const NEUTRAL = /[\s\p{M}\p{Cf}]/u;

/**
 * Split `text` into runs so characters missing from the primary font use the first
 * fallback font that has them: → [{ text, key|null }] (null = primary font).
 */
export async function splitByCoverage(text, primaryKey, fallbackKeys) {
  const primary = await fontCoverage(primaryKey);
  const fallbacks = await Promise.all(fallbackKeys.map(async (k) => [k, await fontCoverage(k)]));
  const runs = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    let key = null;
    if (!NEUTRAL.test(ch) && !primary.has(cp)) key = fallbacks.find(([, cov]) => cov.has(cp))?.[0] ?? null;
    const prev = runs[runs.length - 1];
    if (prev && (prev.key === key || NEUTRAL.test(ch))) prev.text += ch;
    else runs.push({ text: ch, key });
  }
  return runs;
}

/** Distinct non-space characters of `text` that font `key` has no glyph for. */
export async function missingChars(key, text) {
  const cov = await fontCoverage(key);
  return [...new Set(text)].filter((c) => !NEUTRAL.test(c) && !cov.has(c.codePointAt(0)));
}

/** Replace Arabic Presentation Forms-B (e.g. U+FEFB lam-alef) with normal letters so they shape in any font. */
export const normalizePresentationForms = (text) => text.replace(/[\uFE70-\uFEFC]/g, (c) => c.normalize('NFKC'));

/** Read family names (name IDs 1 and 16) from a TTF/OTF — used to verify `family` values. */
export async function readFontFamilies(file) {
  const buf = await fsp.readFile(file);
  const nameOffset = tableOffset(buf, 'name');
  if (nameOffset < 0) return [];
  const count = buf.readUInt16BE(nameOffset + 2);
  const strings = nameOffset + buf.readUInt16BE(nameOffset + 4);
  const names = new Set();
  for (let i = 0; i < count; i++) {
    const r = nameOffset + 6 + i * 12;
    const [platform, , , nameId, length, offset] = [0, 2, 4, 6, 8, 10].map((o) => buf.readUInt16BE(r + o));
    if (platform !== 3 || (nameId !== 1 && nameId !== 16)) continue;
    const raw = buf.subarray(strings + offset, strings + offset + length);
    const chars = [];
    for (let j = 0; j + 1 < raw.length; j += 2) chars.push(raw.readUInt16BE(j));
    names.add(`${nameId}:${String.fromCharCode(...chars)}`);
  }
  return [...names];
}
