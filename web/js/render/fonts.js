// Fonts for the browser renderer: the same SIL OFL files the server renderer uses
// (served from /fonts/), plus script fonts loaded on demand from Google Fonts.
//
// Sizes in the layout are "libass Fontsize units" (as in server/render/layout.js): libass
// scales a font so that its line height (OS/2 winAscent + winDescent, mimicking GDI)
// equals Fontsize. `asc`/`desc` (in em) let us convert those units to canvas pixels and
// place baselines exactly where libass would.

const FONT_BASE = new URL('../../../fonts/', import.meta.url);

// family = the name registered with FontFace (prefixed so system fonts never interfere).
export const FONTS = {
  amiriQuran: { family: 'TW Amiri Quran', weight: 400, file: 'AmiriQuran-Regular.ttf', asc: 1.864, desc: 0.91 },
  scheherazade: { family: 'TW Scheherazade New', weight: 400, file: 'ScheherazadeNew-Regular.ttf', asc: 2884 / 2048, desc: 2100 / 2048 },
  amiri: { family: 'TW Amiri', weight: 400, file: 'Amiri-Regular.ttf', asc: 1.85, desc: 0.91 },
  amiriBold: { family: 'TW Amiri', weight: 700, file: 'Amiri-Bold.ttf', asc: 1.85, desc: 0.91 },
  notoSans: { family: 'TW Noto Sans', weight: 400, file: 'NotoSans-Regular.ttf', asc: 1.124, desc: 0.395 },
  notoSansMedium: { family: 'TW Noto Sans', weight: 500, file: 'NotoSans-Medium.ttf', asc: 1.124, desc: 0.395 },
  notoSansSemiBold: { family: 'TW Noto Sans', weight: 600, file: 'NotoSans-SemiBold.ttf', asc: 1.124, desc: 0.395 },
  naskh: { family: 'TW Noto Naskh Arabic', weight: 400, file: 'NotoNaskhArabic-Regular.ttf', asc: 1.405, desc: 0.634 },
  nastaliq: { family: 'TW Noto Nastaliq Urdu', weight: 400, file: 'NotoNastaliqUrdu-Regular.ttf', asc: 1.904, desc: 1.382 },
  bengali: { family: 'TW Noto Sans Bengali', weight: 400, file: 'NotoSansBengali-Regular.ttf', asc: 0.995, desc: 0.408 },
  // On demand from Google Fonts (css2 API; fonts.gstatic.com sends CORS headers).
  devanagari: { gf: 'Noto Sans Devanagari', asc: 1.1, desc: 0.42 },
  tamil: { gf: 'Noto Sans Tamil', asc: 1.1, desc: 0.42 },
  telugu: { gf: 'Noto Sans Telugu', asc: 1.1, desc: 0.42 },
  gujarati: { gf: 'Noto Sans Gujarati', asc: 1.1, desc: 0.42 },
  malayalam: { gf: 'Noto Sans Malayalam', asc: 1.1, desc: 0.42 },
  kannada: { gf: 'Noto Sans Kannada', asc: 1.1, desc: 0.42 },
  gurmukhi: { gf: 'Noto Sans Gurmukhi', asc: 1.1, desc: 0.42 },
  sinhala: { gf: 'Noto Sans Sinhala', asc: 1.1, desc: 0.42 },
  thai: { gf: 'Noto Sans Thai', asc: 1.1, desc: 0.45 },
  khmer: { gf: 'Noto Sans Khmer', asc: 1.1, desc: 0.45 },
  lao: { gf: 'Noto Sans Lao', asc: 1.1, desc: 0.45 },
  myanmar: { gf: 'Noto Sans Myanmar', asc: 1.3, desc: 0.6 },
  ethiopic: { gf: 'Noto Sans Ethiopic', asc: 1.1, desc: 0.4 },
  nko: { gf: 'Noto Sans NKo', asc: 1.1, desc: 0.4 },
  hebrew: { gf: 'Noto Sans Hebrew', asc: 1.1, desc: 0.4 },
  armenian: { gf: 'Noto Sans Armenian', asc: 1.1, desc: 0.4 },
  georgian: { gf: 'Noto Sans Georgian', asc: 1.1, desc: 0.4 },
  cjkSc: { gf: 'Noto Sans SC', asc: 1.16, desc: 0.288 },
  cjkJp: { gf: 'Noto Sans JP', asc: 1.16, desc: 0.288 },
  cjkKr: { gf: 'Noto Sans KR', asc: 1.16, desc: 0.288 },
};
for (const [key, f] of Object.entries(FONTS)) {
  if (f.gf) Object.assign(f, { family: `TW ${f.gf}`, weight: 400 });
  f.key = key;
  f.lineEm = f.asc + f.desc;
}

export const ARABIC_FONTS = { amiri: 'amiriQuran', scheherazade: 'scheherazade' };

// Fonts tried (in order) for characters the main font lacks — the canvas falls back per
// character through the CSS font-family list.
export const TRANSLATION_FALLBACKS = ['notoSans', 'naskh', 'amiri'];

/** Canvas font-family list: the font itself, then fallbacks (deduplicated). */
export function familyList(key, fallbacks = TRANSLATION_FALLBACKS) {
  const names = [FONTS[key].family, ...fallbacks.map((k) => FONTS[k].family)];
  return [...new Set(names)].map((n) => `"${n}"`).join(', ');
}

/** CSS font shorthand for a font key at a libass Fontsize. */
export function cssFont(key, assSize, { fallbacks = TRANSLATION_FALLBACKS, weight } = {}) {
  const f = FONTS[key];
  return `${weight ?? f.weight} ${(assSize / f.lineEm).toFixed(2)}px ${familyList(key, fallbacks)}`;
}

/** Canvas px for a libass Fontsize, and the font's ascent/descent at that size. */
export function fontMetrics(key, assSize) {
  const f = FONTS[key];
  const px = assSize / f.lineEm;
  return { px, asc: f.asc * px, desc: f.desc * px, line: assSize };
}

// ---------------------------------------------------------------------------------
// Script detection (mirrors server/render/fonts.js)

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
  if (counts.kana) return 'kana';
  let best = 'latin';
  let max = 0;
  for (const [script, n] of Object.entries(counts)) if (n > max) [best, max] = [script, n];
  return best;
}

/** Font for a translation/tafsir text → { key, rtl, script } (Nastaliq for Urdu, Naskh for other Arabic-script languages). */
export function translationFont(text, languageIso) {
  const script = detectScript(text);
  let key;
  if (script === 'arabic') key = languageIso === 'ur' ? 'nastaliq' : 'naskh';
  else if (script === 'han') key = languageIso === 'ja' ? 'cjkJp' : 'cjkSc';
  else if (script === 'kana') key = 'cjkJp';
  else if (script === 'hangul') key = 'cjkKr';
  else if (FONTS[script]) key = script;
  else key = 'notoSansMedium';
  return { key, rtl: RTL_SCRIPTS.has(script), script };
}

/** Replace Arabic Presentation Forms-B (e.g. U+FEFB lam-alef) with normal letters. */
export const normalizePresentationForms = (text) => String(text ?? '').replace(/[ﹰ-ﻼ]/g, (c) => c.normalize('NFKC'));

// ---------------------------------------------------------------------------------
// Loading (works in a Worker via self.fonts, or on the main thread via document.fonts)

export function fontSet() {
  if (typeof document !== 'undefined' && document.fonts) return document.fonts;
  if (typeof self !== 'undefined' && self.fonts) return self.fonts;
  return null;
}

const loaded = new Map(); // key → Promise

async function loadLocal(key, set, signal) {
  const f = FONTS[key];
  const res = await fetch(new URL(f.file, FONT_BASE), { signal });
  if (!res.ok) throw new Error(`Font ${f.file}: HTTP ${res.status}`);
  const face = new FontFace(f.family, await res.arrayBuffer(), { weight: String(f.weight), style: 'normal' });
  await face.load();
  set.add(face);
}

const gfCss = new Map();
/** Google Fonts: register every unicode-range slice, then load only the slices `text` needs. */
async function loadGoogle(key, set, text, signal) {
  const f = FONTS[key];
  if (!gfCss.has(key)) {
    gfCss.set(key, (async () => {
      const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.gf).replace(/%20/g, '+')}:wght@400&display=swap`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`Google Fonts ${f.gf}: HTTP ${res.status}`);
      const css = await res.text();
      for (const block of css.match(/@font-face\s*{[^}]*}/g) || []) {
        const src = block.match(/src:\s*url\(([^)]+)\)/)?.[1];
        if (!src) continue;
        const range = block.match(/unicode-range:\s*([^;]+);/)?.[1];
        const face = new FontFace(f.family, `url(${src.replace(/['"]/g, '')})`, { weight: '400', style: 'normal', ...(range ? { unicodeRange: range.trim() } : {}) });
        set.add(face);
      }
    })());
  }
  await gfCss.get(key);
  // FontFaceSet.load() fetches only the faces whose unicode-range intersects `text`.
  await set.load(`400 40px "${f.family}"`, text || 'a');
}

/**
 * Load fonts by key. `texts[key]` (optional) = the text a Google font must cover.
 * Fonts that fail to load are reported in the returned list (rendering falls back).
 */
export async function loadFonts(keys, { texts = {}, signal } = {}) {
  const set = fontSet();
  if (!set) throw new Error('FontFaceSet unavailable');
  const failed = [];
  await Promise.all([...new Set(keys)].filter(Boolean).map(async (key) => {
    const f = FONTS[key];
    if (!f) return;
    try {
      if (f.gf) await loadGoogle(key, set, texts[key], signal);
      else {
        if (!loaded.has(key)) {
          const p = loadLocal(key, set, signal);
          loaded.set(key, p);
          p.catch(() => loaded.delete(key));
        }
        await loaded.get(key);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      failed.push(key);
      console.warn(`[render] font ${key} failed: ${err.message}`);
    }
  }));
  return failed;
}
