// Output geometry, text sizing, wrapping and long-ayah chunking — a port of
// server/render/layout.js where widths are measured on the canvas instead of estimated.
// Sizes are libass "Fontsize units" (line height); see fonts.js for the conversion.

import { FONTS, cssFont } from './fonts.js';

// Size factor that makes fonts look equally large (from the server's calibration).
const FACTOR = {
  amiriQuran: 1, scheherazade: 0.86, naskh: 1.4, nastaliq: 1.8, notoSansMedium: 1,
  bengali: 1.05, devanagari: 1.2, cjkSc: 0.95, cjkJp: 0.95, cjkKr: 0.95,
};
const factorOf = (key) => FACTOR[key] ?? 1.15;

// Fractions of the frame kept free of text (social-app UI overlays on 9:16).
const SAFE = {
  '9:16': { top: 0.12, bottom: 0.18, side: 0.075, maxWrap: 1, arabic: 0.15, trans: 0.043, arLines: 5, trLines: 7, tafsir: 0.046, tafLines: 10 },
  '16:9': { top: 0.085, bottom: 0.1, side: 0.08, maxWrap: 0.76, arabic: 0.13, trans: 0.045, arLines: 3, trLines: 4, tafsir: 0.046, tafLines: 7 },
  '1:1': { top: 0.08, bottom: 0.1, side: 0.08, maxWrap: 1, arabic: 0.125, trans: 0.04, arLines: 4, trLines: 5, tafsir: 0.042, tafLines: 8 },
};

export const MARK_RE = /\p{M}/u;

/** Visible base characters (combining marks excluded). */
export function baseLength(text) {
  let n = 0;
  for (const ch of text || '') if (!MARK_RE.test(ch)) n++;
  return n;
}

// ---------------------------------------------------------------------------------
// Measuring

/** Width measurer bound to a 2D context; caches per font+text. */
export function createMeasurer(ctx) {
  const cache = new Map();
  let current = '';
  const width = (font, text, direction = 'inherit') => {
    const id = `${font}|${direction}|${text}`;
    let w = cache.get(id);
    if (w === undefined) {
      if (current !== font) {
        ctx.font = font;
        current = font;
      }
      ctx.direction = direction;
      w = ctx.measureText(text).width;
      if (cache.size > 20000) cache.clear();
      cache.set(id, w);
    }
    return w;
  };
  return { width, ctx };
}

// ---------------------------------------------------------------------------------
// Layout

/**
 * Every position/size the text drawer needs (mirrors the server's buildLayout).
 * fonts = { arabic, translation|null, tafsir|null, tafsirLabel|null, tafsirLabelArabic }
 */
export function buildLayout({ width, height, aspect, style, fonts, showHeader, showFooter, creditLines = 1 }) {
  const s = SAFE[aspect] || SAFE['9:16'];
  const unit = Math.min(width, height);
  const scale = Number(style.textScale) || 1;
  const side = Math.round(width * s.side);
  const wrapWidth = Math.round(Math.min(width - 2 * side, width * s.maxWrap));
  const safeTop = Math.round(height * s.top);
  const safeBottom = Math.round(height * (1 - s.bottom));
  const hasTranslation = Boolean(fonts.translation);

  const header = { y: safeTop, sizeAr: Math.round(unit * 0.085), sizeEn: Math.round(unit * 0.021) };
  header.height = showHeader ? Math.round(header.sizeAr + header.sizeEn * 1.1) : 0;
  const footer = { y: safeBottom, size: Math.round(unit * 0.026), creditSize: Math.round(unit * 0.017) };
  footer.height = Math.round((showFooter ? footer.size * 1.1 : 0) + footer.creditSize * 1.2 * creditLines);

  const gapAround = Math.round(unit * 0.035);
  const mainTop = safeTop + (showHeader ? header.height + gapAround : 0);
  const mainBottom = safeBottom - footer.height - gapAround;

  const arabicSize = Math.round(unit * s.arabic * scale * factorOf(fonts.arabic) * (hasTranslation ? 1 : 1.18));
  const transSize = hasTranslation ? Math.round(unit * s.trans * scale * factorOf(fonts.translation)) : 0;

  let tafsir = null;
  if (fonts.tafsir) {
    const size = Math.round(unit * s.tafsir * scale * factorOf(fonts.tafsir));
    const labelSize = Math.round(unit * (fonts.tafsirLabelArabic ? 0.068 : 0.027) * Math.min(scale, 1.2));
    const labelGap = Math.round(unit * 0.022);
    const textHeight = mainBottom - mainTop - labelSize - labelGap;
    tafsir = {
      font: fonts.tafsir,
      labelFont: fonts.tafsirLabel,
      size,
      lineHeight: size,
      maxLines: Math.max(3, Math.min(s.tafLines, Math.floor(textHeight / size))),
      labelSize,
      labelGap,
      labelArabic: Boolean(fonts.tafsirLabelArabic),
      rtl: Boolean(fonts.tafsirRtl),
    };
  }

  return {
    width,
    height,
    aspect,
    side,
    wrapWidth,
    centerX: Math.round(width / 2),
    position: style.position === 'lower' ? 'lower' : 'center',
    header,
    footer,
    main: { top: mainTop, bottom: mainBottom, height: mainBottom - mainTop, centerY: Math.round((mainTop + mainBottom) / 2) },
    gap: Math.round(arabicSize * 0.12),
    arabic: { font: fonts.arabic, size: arabicSize, maxLines: s.arLines },
    translation: hasTranslation
      ? { font: fonts.translation, size: transSize, lineHeight: transSize, maxLines: s.trLines, rtl: Boolean(fonts.translationRtl) }
      : null,
    tafsir,
  };
}

// ---------------------------------------------------------------------------------
// Wrapping

const NO_BREAK_BEFORE = /^[、。，．,.!?！？：；:;）)」』》〉】”’…・ー々〜]/u;
let segmenter;
try {
  segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
} catch {
  segmenter = null;
}

/** Text written with spaces between words? (CJK / Thai are not.) */
export const isSpaced = (text) => (String(text).match(/\s/g) || []).length >= String(text).length / 25;

/**
 * Break text into wrap tokens. Spaced text → words (joined with ' '); unspaced text →
 * words from Intl.Segmenter (or single characters), closing punctuation and combining
 * marks kept with the token before them (joined with '').
 */
export function wrapTokens(text) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text) return { tokens: [], sep: ' ' };
  if (isSpaced(text)) return { tokens: text.split(' '), sep: ' ' };
  let pieces;
  if (segmenter) pieces = [...segmenter.segment(text)].map((s) => s.segment);
  else pieces = [...text];
  const tokens = [];
  for (const p of pieces) {
    if (p === ' ') {
      if (tokens.length) tokens[tokens.length - 1] += ' ';
      continue;
    }
    // Long words from the segmenter (e.g. CJK runs it can't split) → characters.
    const parts = [...p].length > 4 && /[぀-ヿ㐀-鿿가-힯]/u.test(p) ? [...p] : [p];
    for (const part of parts) {
      if (tokens.length && (NO_BREAK_BEFORE.test(part) || MARK_RE.test([...part][0]))) tokens[tokens.length - 1] += part;
      else tokens.push(part);
    }
  }
  return { tokens, sep: '' };
}

/**
 * Wrap tokens into lines no wider than maxWidth, with the fewest lines and the line
 * widths balanced (like libass WrapStyle 0). Returns arrays of token indices [start, end).
 */
export function balancedBreaks(widths, sepWidth, maxWidth) {
  const n = widths.length;
  if (!n) return [];
  const pre = [0];
  for (const w of widths) pre.push(pre[pre.length - 1] + w);
  const lineWidth = (i, j) => pre[j] - pre[i] + sepWidth * (j - i - 1);
  // Greedy line count (minimum).
  let count = 0;
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && lineWidth(i, j + 1) <= maxWidth) j++;
    i = j;
    count++;
  }
  if (count === 1) return [[0, n]];
  // DP: cost[k][j] = best cost of tokens [0, j) in k lines.
  const INF = Infinity;
  const cost = Array.from({ length: count + 1 }, () => new Float64Array(n + 1).fill(INF));
  const from = Array.from({ length: count + 1 }, () => new Int32Array(n + 1).fill(-1));
  cost[0][0] = 0;
  for (let k = 1; k <= count; k++) {
    for (let j = 1; j <= n; j++) {
      for (let i = j - 1; i >= 0; i--) {
        const w = lineWidth(i, j);
        if (w > maxWidth && j - i > 1) break;
        if (cost[k - 1][i] === INF) continue;
        const slack = (maxWidth - w) / maxWidth;
        // Small bias: upper lines a little wider than lower ones (as libass does).
        const c = cost[k - 1][i] + slack * slack + (k < count ? 0 : 0.0001 * slack);
        if (c < cost[k][j]) {
          cost[k][j] = c;
          from[k][j] = i;
        }
      }
    }
  }
  if (cost[count][n] === INF) {
    // Unbreakable token wider than the line: fall back to greedy.
    const out = [];
    for (let i = 0; i < n;) {
      let j = i + 1;
      while (j < n && lineWidth(i, j + 1) <= maxWidth) j++;
      out.push([i, j]);
      i = j;
    }
    return out;
  }
  const lines = [];
  for (let k = count, j = n; k > 0; k--) {
    const i = from[k][j];
    lines.unshift([i, j]);
    j = i;
  }
  return lines;
}

/** Wrap `text` in font `font` (CSS string) to maxWidth → [lineText]. */
export function wrapText(m, font, text, maxWidth, direction = 'ltr') {
  const { tokens, sep } = wrapTokens(text);
  if (!tokens.length) return [];
  const widths = tokens.map((t) => m.width(font, t.trimEnd(), direction));
  const sepWidth = sep ? m.width(font, sep, direction) : 0;
  return balancedBreaks(widths, sepWidth, maxWidth).map(([i, j]) => tokens.slice(i, j).join(sep).trim());
}

// ---------------------------------------------------------------------------------
// Ayah blocks and chunking

const PAUSE_BONUS = { 'ۘ': 1, 'ۗ': 0.9, 'ۚ': 0.8, 'ۖ': 0.7, 'ۛ': 0.45, 'ۙ': -0.6 };
const NBSP = ' ';

/** Arabic words → wrapped lines; `marker` (string|null) is glued to the last word. */
export function wrapArabic(m, layout, words, marker) {
  const font = cssFont(layout.arabic.font, layout.arabic.size, { fallbacks: ['amiriQuran', 'scheherazade', 'naskh'] });
  const tokens = [...words];
  if (marker) tokens[tokens.length - 1] = `${tokens[tokens.length - 1]}${NBSP}${marker}`;
  const widths = tokens.map((t) => m.width(font, t, 'rtl'));
  const sepWidth = m.width(font, ' ', 'rtl');
  return balancedBreaks(widths, sepWidth, layout.wrapWidth).map(([i, j]) => words.slice(i, j));
}

/** Average measured advance per base character of `text` in a font (px). */
function charPx(m, font, text, direction) {
  const len = baseLength(text);
  return len ? m.width(font, text, direction) / len : 0;
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

function translationTokens(text) {
  const spaced = text.split(/(?<=\s)/);
  if (spaced.length >= 4 || text.length < 30) return spaced;
  return [...text];
}

const wordsLength = (words) => words.reduce((sum, w) => sum + baseLength(w) + 1, 0);

export function translationFontCss(layout, scale = 1) {
  const tr = layout.translation;
  return cssFont(tr.font, tr.size * scale);
}

/**
 * Split one ayah into display chunks that fit the text area:
 * → [{ arabic, translation, weight }] (weight = share of the recitation time, by Arabic length).
 * `marker` (string|null) is the end-of-ayah ornament, reserved on the last chunk.
 */
export function chunkAyah(m, layout, arabic, translation, marker) {
  const words = arabic.split(/\s+/).filter(Boolean);
  const arWeights = words.map((w) => baseLength(w) + 1);
  const trText = (translation || '').trim();
  const tr = layout.translation;
  const trFont = tr && trText ? translationFontCss(layout) : null;
  const trChar = trFont ? charPx(m, trFont, trText, tr.rtl ? 'rtl' : 'ltr') : 0;
  const trLenTotal = trText ? baseLength(trText) : 0;
  const arLenTotal = wordsLength(words);

  const fitsGroup = (g, last) => {
    const arLines = wrapArabic(m, layout, g, last ? marker : null).length;
    if (arLines > layout.arabic.maxLines) return false;
    let height = arLines * layout.arabic.size;
    if (trFont) {
      const len = Math.ceil((trLenTotal * wordsLength(g)) / arLenTotal);
      const trLines = Math.max(1, Math.ceil((len * trChar * 1.05) / layout.wrapWidth));
      if (trLines > tr.maxLines) return false;
      height += layout.gap + trLines * tr.lineHeight;
    }
    return height <= layout.main.height;
  };
  const fits = (groups) => groups.every((g, i) => fitsGroup(g, i === groups.length - 1));

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
    trChunks = splitByShares(tokens, weights, lens, transBreakBonus, { window: 0.35, bonusWeight: 0.35 }).map((g) => g.join('').trim());
  }
  return groups.map((g, i) => ({ words: g, arabic: g.join(' '), translation: trChunks[i] || null, weight: lens[i] / sum }));
}

/**
 * Final block geometry for one cue: wrapped Arabic lines, wrapped translation lines
 * (shrunk down to 65 % if the block would overflow the text area) and its height.
 */
export function layoutBlock(m, layout, words, marker, translation) {
  const arLines = wrapArabic(m, layout, words, marker);
  const tr = layout.translation;
  let trLines = [];
  let trScale = 1;
  const arHeight = arLines.length * layout.arabic.size;
  if (tr && translation) {
    const dir = tr.rtl ? 'rtl' : 'ltr';
    trLines = wrapText(m, translationFontCss(layout), translation, layout.wrapWidth, dir);
    let height = arHeight + layout.gap + trLines.length * tr.lineHeight;
    for (let i = 0; i < 6 && height > layout.main.height && trScale > 0.65; i++) {
      trScale = Math.max(0.65, trScale * Math.max(0.85, (layout.main.height - arHeight - layout.gap) / (height - arHeight - layout.gap)));
      trLines = wrapText(m, translationFontCss(layout, trScale), translation, layout.wrapWidth, dir);
      height = arHeight + layout.gap + trLines.length * tr.lineHeight * trScale;
    }
  }
  const height = arHeight + (trLines.length ? layout.gap + trLines.length * tr.lineHeight * trScale : 0);
  return { arLines, trLines, trScale, height };
}

// ---------------------------------------------------------------------------------
// Tafsir cards

const BREAK_PENALTY = { sentence: 0, clause: 0.6, word: 2.5 };
const SENTENCE_BREAK = /(?:[.!?؟۔।…]+["'”’»)\]]*\s+)|(?:[。！？]+["'”’」』)）]*\s*)|(?:\n\s*)/gu;
const CLAUSE_BREAK = /(?:[,،;؛:、，；：]["'”’»)\]]*\s*)|(?:\s[—–-]\s)/gu;

export function tafsirFontCss(layout, scale = 1) {
  const t = layout.tafsir;
  return cssFont(t.font, t.size * scale);
}

/** Wrapped lines of a card's text (shrinks the font up to 75 % if it still overflows). */
export function layoutCard(m, layout, text) {
  const t = layout.tafsir;
  const dir = t.rtl ? 'rtl' : 'ltr';
  let scale = 1;
  let lines = wrapText(m, tafsirFontCss(layout), text, layout.wrapWidth, dir);
  while (lines.length > t.maxLines && scale > 0.75) {
    scale = Math.max(0.75, scale - 0.05);
    lines = wrapText(m, tafsirFontCss(layout, scale), text, layout.wrapWidth, dir);
  }
  return { lines, scale, height: t.labelSize + t.labelGap + lines.length * t.lineHeight * scale };
}

/**
 * Split a tafsir text into cards that each fit the text area (≤ maxLines), cutting at
 * sentence ends, then clauses, then words, with balanced card lengths. → [string]
 */
export function splitTafsir(m, layout, text) {
  text = String(text || '').trim();
  if (!text) return [];
  const t = layout.tafsir;
  const dir = t.rtl ? 'rtl' : 'ltr';
  const font = tafsirFontCss(layout);
  if (wrapText(m, font, text, layout.wrapWidth, dir).length <= t.maxLines) return [text];
  const px = charPx(m, font, text, dir) * 1.08; // wrapping waste in paragraphs
  const fitsLen = (len) => Math.ceil((len * px) / layout.wrapWidth) <= t.maxLines;

  const kinds = new Map();
  const mark = (re, kind) => {
    for (const mt of text.matchAll(re)) {
      const at = mt.index + mt[0].length;
      if (at > 0 && at < text.length && !kinds.has(at)) kinds.set(at, kind);
    }
  };
  mark(SENTENCE_BREAK, 'sentence');
  mark(CLAUSE_BREAK, 'clause');
  mark(/\s+/gu, 'word');
  if (!isSpaced(text)) {
    const chars = [...text];
    let at = 0;
    chars.forEach((ch, i) => {
      at += ch.length;
      const next = chars[i + 1];
      if (next && !kinds.has(at) && !MARK_RE.test(next) && !NO_BREAK_BEFORE.test(next)) kinds.set(at, 'word');
    });
  }
  const cuts = [0, ...[...kinds.keys()].sort((a, b) => a - b), text.length];
  const pre = [0];
  for (let i = 1; i < cuts.length; i++) pre.push(pre[i - 1] + baseLength(text.slice(cuts[i - 1], cuts[i])));
  const total = pre[pre.length - 1];
  const n = cuts.length - 1;

  let minCards = 0;
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && fitsLen(pre[j + 1] - pre[i])) j++;
    i = j;
    minCards++;
  }
  let best = null;
  for (let k = minCards; k <= minCards + 1; k++) {
    const avg = total / k;
    const cost = Array.from({ length: k + 1 }, () => new Float64Array(n + 1).fill(Infinity));
    const from = Array.from({ length: k + 1 }, () => new Int32Array(n + 1).fill(-1));
    cost[0][0] = 0;
    for (let c = 1; c <= k; c++) {
      for (let j = 1; j <= n; j++) {
        for (let i = j - 1; i >= 0; i--) {
          const len = pre[j] - pre[i];
          if (!fitsLen(len) && j - i > 1) break;
          if (cost[c - 1][i] === Infinity) continue;
          const dev = (len - avg) / avg;
          const penalty = j < n ? BREAK_PENALTY[kinds.get(cuts[j])] : 0;
          const value = cost[c - 1][i] + dev * dev + penalty;
          if (value < cost[c][j]) [cost[c][j], from[c][j]] = [value, i];
        }
      }
    }
    const value = cost[k][n] + 0.8 * k;
    if (cost[k][n] < Infinity && (!best || value < best.value)) {
      const ends = [];
      for (let c = k, j = n; c > 0; j = from[c][j], c--) ends.unshift(j);
      best = { value, ends };
    }
  }
  if (!best) return [text];
  const cards = [];
  let start = 0;
  for (const end of best.ends) {
    cards.push(text.slice(cuts[start], cuts[end]).trim());
    start = end;
  }
  return cards.filter(Boolean);
}

export { FONTS };
