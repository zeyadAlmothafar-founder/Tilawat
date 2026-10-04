// Render request rules shared by the server (server/render/*) and the web build
// (web/js/jobs.js): limits, enums, style normalization, output sizes, the Bismillah rule.
// Pure, dependency-free ESM (Node + browser).

/** Per-request limits. The web build renders on the visitor's device, so it allows less. */
export const LIMITS = Object.freeze({
  server: Object.freeze({ maxVideos: 50, maxAyahs: 50 }),
  web: Object.freeze({ maxVideos: 5, maxAyahs: 20 }),
});

export const ASPECTS = ['9:16', '16:9', '1:1'];
export const QUALITIES = ['1080', '720'];
export const FILE_SIZES = ['small', 'balanced', 'high'];
export const CATEGORY_IDS = ['nature', 'space', 'mosque', 'islamic'];
export const DEFAULT_CATEGORIES = ['nature', 'space'];
export const DEFAULTS = Object.freeze({
  reciter: 'Alafasy_128kbps',
  translation: 'english_saheeh',
});

export const OUTPUT_SIZES = {
  '9:16': { 1080: [1080, 1920], 720: [720, 1280] },
  '16:9': { 1080: [1920, 1080], 720: [1280, 720] },
  '1:1': { 1080: [1080, 1080], 720: [720, 720] },
};

export function outputSize(aspect, quality) {
  const [width, height] = OUTPUT_SIZES[aspect][quality];
  return { width, height };
}

export function orientationOf(aspect) {
  return aspect === '9:16' ? 'portrait' : aspect === '16:9' ? 'landscape' : 'square';
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = (v, def, min, max) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? clamp(Number(v), min, max) : def);

export function normalizeStyle(style = {}) {
  const s = style && typeof style === 'object' ? style : {};
  return {
    arabicFont: s.arabicFont === 'scheherazade' ? 'scheherazade' : 'amiri',
    textScale: Math.round(num(s.textScale, 1, 0.7, 1.5) * 100) / 100,
    position: s.position === 'lower' ? 'lower' : 'center',
    overlay: Math.round(num(s.overlay, 0.45, 0, 0.8) * 100) / 100,
    showSurahTitle: s.showSurahTitle !== false,
    showReciter: s.showReciter !== false,
    // Source credits in the footer: one short QuranEnc line (its terms require the source
    // and translation version), every source, or none (credits then go in the share text).
    credits: ['full', 'none'].includes(s.credits) ? s.credits : 'minimal',
  };
}

/** Bismillah is recited before ayah 1 of every surah except Al-Fatihah (where it is ayah 1) and At-Tawbah. */
export const wantsBismillah = (req) => Boolean(req.bismillah) && req.from === 1 && req.surah !== 1 && req.surah !== 9;
