// Output geometry, text sizing and long-ayah chunking.
//
// libass sizes a font so that its line height equals Fontsize, so all metrics below are
// in "Fontsize units": average advance per base character (marks excluded) measured
// with scripts/c-calibrate.js, line advance = 1.0.

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

// em per base char (calibrated) and a size factor that makes fonts look equally large.
const METRICS = {
  amiriQuran: { charEm: 0.12, factor: 1 },
  scheherazade: { charEm: 0.158, factor: 0.86 },
  naskh: { charEm: 0.19, factor: 1.4 },
  nastaliq: { charEm: 0.118, factor: 1.8 },
  notoSansMedium: { charEm: 0.312, factor: 1 },
  bengali: { charEm: 0.3, factor: 1.05 },
  devanagari: { charEm: 0.3, factor: 1.2 },
  cjkSc: { charEm: 0.72, factor: 0.95 },
  cjkJp: { charEm: 0.72, factor: 0.95 },
  cjkKr: { charEm: 0.62, factor: 0.95 },
};
const metricsFor = (key) => METRICS[key] || { charEm: 0.33, factor: 1.15 };

// Fractions of the frame kept free of text (social-app UI overlays on 9:16).
const SAFE = {
  '9:16': { top: 0.12, bottom: 0.18, side: 0.075, maxWrap: 1, arabic: 0.15, trans: 0.043, arLines: 5, trLines: 7 },
  '16:9': { top: 0.085, bottom: 0.1, side: 0.08, maxWrap: 0.76, arabic: 0.13, trans: 0.045, arLines: 3, trLines: 4 },
  '1:1': { top: 0.08, bottom: 0.1, side: 0.08, maxWrap: 1, arabic: 0.125, trans: 0.04, arLines: 4, trLines: 5 },
};

/**
 * Compute every position/size the subtitle builder needs.
 * `fonts` = { arabic: fontKey, translation: fontKey|null }.
 */
export function buildLayout({ width, height, aspect, style, fonts, showHeader, showFooter }) {
  const s = SAFE[aspect];
  const unit = Math.min(width, height);
  const scale = style.textScale;
  const side = Math.round(width * s.side);
  const wrapWidth = Math.round(Math.min(width - 2 * side, width * s.maxWrap));
  const safeTop = Math.round(height * s.top);
  const safeBottom = Math.round(height * (1 - s.bottom));
  const hasTranslation = Boolean(fonts.translation);

  const header = {
    y: safeTop,
    sizeAr: Math.round(unit * 0.085),
    sizeEn: Math.round(unit * 0.021),
  };
  header.height = showHeader ? Math.round(header.sizeAr + header.sizeEn * 1.1) : 0;
  const footer = {
    y: safeBottom,
    size: Math.round(unit * 0.026),
    creditSize: Math.round(unit * 0.017),
  };
  footer.height = showFooter ? Math.round(footer.size * 1.1 + footer.creditSize * 1.2) : Math.round(footer.creditSize * 1.2);

  const gapAround = Math.round(unit * 0.035);
  const mainTop = safeTop + (showHeader ? header.height + gapAround : 0);
  const mainBottom = safeBottom - footer.height - gapAround;

  const arM = metricsFor(fonts.arabic);
  const arabicSize = Math.round(unit * s.arabic * scale * arM.factor * (hasTranslation ? 1 : 1.18));
  const trM = hasTranslation ? metricsFor(fonts.translation) : null;
  const transSize = hasTranslation ? Math.round(unit * s.trans * scale * trM.factor) : 0;

  return {
    width,
    height,
    side,
    wrapWidth,
    centerX: Math.round(width / 2),
    header,
    footer,
    main: {
      top: mainTop,
      bottom: mainBottom,
      height: mainBottom - mainTop,
      centerY: Math.round((mainTop + mainBottom) / 2),
    },
    gap: Math.round(arabicSize * 0.12),
    arabic: { size: arabicSize, charPx: arabicSize * arM.charEm, maxLines: s.arLines },
    translation: hasTranslation
      ? { size: transSize, charPx: transSize * trM.charEm, maxLines: s.trLines, lineHeight: transSize }
      : null,
  };
}

// ---------------------------------------------------------------------------------
// Chunking

const MARK_RE = /\p{M}/u;
const PAUSE_BONUS = { '\u06D8': 1, '\u06D7': 0.9, '\u06DA': 0.8, '\u06D6': 0.7, '\u06DB': 0.45, '\u06D9': -0.6 };

/** Visible base characters (combining marks excluded) — the unit for width estimates. */
export function baseLength(text) {
  let n = 0;
  for (const ch of text) if (!MARK_RE.test(ch)) n++;
  return n;
}

function estimateLines(len, charPx, wrapWidth) {
  if (!len) return 0;
  // Word wrapping wastes some space at line ends.
  return Math.max(1, Math.ceil((len * charPx * 1.05) / wrapWidth));
}

function measureBlock(layout, arLen, trLen) {
  const ar = layout.arabic;
  const tr = layout.translation;
  const arLines = estimateLines(arLen, ar.charPx, layout.wrapWidth);
  const trLines = tr && trLen ? estimateLines(trLen, tr.charPx, layout.wrapWidth) : 0;
  const height = arLines * ar.size + (trLines ? layout.gap + trLines * tr.lineHeight : 0);
  return { arLines, trLines, height };
}

function blockFits(layout, arLen, trLen) {
  const m = measureBlock(layout, arLen, trLen);
  if (m.arLines > layout.arabic.maxLines) return false;
  if (layout.translation && m.trLines > layout.translation.maxLines) return false;
  return m.height <= layout.main.height;
}

/** Estimated pixel height of a cue's text block (Arabic + translation). */
export function estimateBlockHeight(layout, arabic, translation) {
  return measureBlock(layout, baseLength(arabic) + 3, translation ? baseLength(translation) : 0).height;
}

/**
 * Split `tokens` into shares.length groups whose weight follows `shares`, moving each
 * cut (within `window` of the ideal spot) towards tokens with a high breakBonus.
 */
function splitByShares(tokens, weights, shares, breakBonus, { window = 0.45, bonusWeight = 0.5 } = {}) {
  const n = shares.length;
  const total = weights.reduce((a, b) => a + b, 0);
  const shareSum = shares.reduce((a, b) => a + b, 0);
  const cumAt = [];
  let c = 0;
  for (const w of weights) cumAt.push((c += w));
  const cuts = [];
  let from = 0;
  let shareCum = 0;
  for (let k = 1; k < n; k++) {
    shareCum += shares[k - 1];
    const target = (total * shareCum) / shareSum;
    const span = Math.max((total * shares[k - 1]) / shareSum, 1);
    let best = -1;
    let bestScore = -Infinity;
    // A cut after token i, leaving at least one token for every remaining group.
    for (let i = from; i < tokens.length - (n - k); i++) {
      const dist = Math.abs(cumAt[i] - target) / span;
      if (dist > window) continue;
      const score = breakBonus(tokens[i]) * bonusWeight - dist;
      if (score > bestScore) [best, bestScore] = [i, score];
    }
    if (best < 0) {
      best = from;
      while (best < tokens.length - (n - k) - 1 && cumAt[best] < target) best++;
    }
    cuts.push(best + 1);
    from = best + 1;
  }
  const groups = [];
  let start = 0;
  for (const cut of [...cuts, tokens.length]) {
    groups.push(tokens.slice(start, cut));
    start = cut;
  }
  return groups;
}

const arabicBreakBonus = (word) => PAUSE_BONUS[[...word].pop()] ?? 0;
const transBreakBonus = (tok) => (/[.!?;:؛۔。！？]["'”’)\]]*\s*$/.test(tok) ? 0.8 : /[,،、—–]["'”’)\]]*\s*$/.test(tok) ? 0.5 : 0);

/** Tokenize a translation for splitting; CJK text has no spaces, so split by characters. */
function translationTokens(text) {
  const spaced = text.split(/(?<=\s)/);
  if (spaced.length >= 4 || text.length < 30) return spaced;
  return [...text];
}

const wordsLength = (words) => words.reduce((sum, w) => sum + baseLength(w) + 1, 0);

/**
 * Split one ayah into display chunks that fit the text area. Returns
 * [{ arabic, translation, weight }] where weight (0..1) is the chunk's share of the
 * ayah's recitation time, proportional to its Arabic length. `markerLen` reserves room
 * for the end-of-ayah ornament on the last chunk.
 */
export function chunkAyah(layout, arabic, translation, markerLen = 3) {
  const words = arabic.split(/\s+/).filter(Boolean);
  const arWeights = words.map((w) => baseLength(w) + 1);
  const trText = (translation || '').trim();
  const trLenTotal = trText ? baseLength(trText) : 0;
  const arLenTotal = wordsLength(words);

  const fits = (groups) =>
    groups.every((g, i) => {
      const len = wordsLength(g);
      const extra = i === groups.length - 1 ? markerLen : 0;
      return blockFits(layout, len + extra, Math.ceil((trLenTotal * len) / arLenTotal));
    });
  let groups = [words];
  for (let n = 2; n <= words.length && !fits(groups); n++) {
    groups = splitByShares(words, arWeights, Array(n).fill(1), arabicBreakBonus);
  }
  const lens = groups.map(wordsLength);
  const sum = lens.reduce((a, b) => a + b, 0);

  let trChunks = groups.map(() => null);
  if (trText && groups.length === 1) trChunks = [trText];
  else if (trText) {
    const tokens = translationTokens(trText);
    const weights = tokens.map((t) => Math.max(1, baseLength(t)));
    trChunks = splitByShares(tokens, weights, lens, transBreakBonus, { window: 0.35, bonusWeight: 0.35 })
      .map((g) => g.join('').trim());
  }
  return groups.map((g, i) => ({ arabic: g.join(' '), translation: trChunks[i], weight: lens[i] / sum }));
}
