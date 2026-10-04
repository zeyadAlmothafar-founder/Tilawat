// Output geometry, text sizing and long-ayah chunking.
//
// libass sizes a font so that its line height equals Fontsize, so all metrics below are
// in "Fontsize units": average advance per base character (marks excluded) measured
// with a libass bounding-box calibration, line advance = 1.0.

// Output sizes and orientation are shared with the web build.
export { OUTPUT_SIZES, outputSize, orientationOf } from '../../shared/render-rules.js';

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
// tafsir / tafLines: tafsir card text size and the most lines one card may hold.
const SAFE = {
  '9:16': { top: 0.12, bottom: 0.18, side: 0.075, maxWrap: 1, arabic: 0.15, trans: 0.043, arLines: 5, trLines: 7, tafsir: 0.046, tafLines: 10 },
  '16:9': { top: 0.085, bottom: 0.1, side: 0.08, maxWrap: 0.76, arabic: 0.13, trans: 0.045, arLines: 3, trLines: 4, tafsir: 0.046, tafLines: 7 },
  '1:1': { top: 0.08, bottom: 0.1, side: 0.08, maxWrap: 1, arabic: 0.125, trans: 0.04, arLines: 4, trLines: 5, tafsir: 0.042, tafLines: 8 },
};

/**
 * Compute every position/size the subtitle builder needs.
 * `fonts` = { arabic: fontKey, translation: fontKey|null, tafsir?: fontKey|null,
 * tafsirLabelArabic?: boolean }. `creditLines` = lines of the footer credit.
 */
export function buildLayout({ width, height, aspect, style, fonts, showHeader, showFooter, creditLines = 1 }) {
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
  footer.height = Math.round((showFooter ? footer.size * 1.1 : 0) + footer.creditSize * 1.2 * creditLines);

  const gapAround = Math.round(unit * 0.035);
  const mainTop = safeTop + (showHeader ? header.height + gapAround : 0);
  const mainBottom = safeBottom - footer.height - gapAround;

  const arM = metricsFor(fonts.arabic);
  const arabicSize = Math.round(unit * s.arabic * scale * arM.factor * (hasTranslation ? 1 : 1.18));
  const trM = hasTranslation ? metricsFor(fonts.translation) : null;
  const transSize = hasTranslation ? Math.round(unit * s.trans * scale * trM.factor) : 0;

  let tafsir = null;
  if (fonts.tafsir) {
    const m = metricsFor(fonts.tafsir);
    const size = Math.round(unit * s.tafsir * scale * m.factor);
    // Gold book name above the commentary: Amiri for Arabic-script labels, spaced caps otherwise.
    const labelSize = Math.round(unit * (fonts.tafsirLabelArabic ? 0.068 : 0.027) * Math.min(scale, 1.2));
    const labelGap = Math.round(unit * 0.022);
    const textHeight = mainBottom - mainTop - labelSize - labelGap;
    tafsir = {
      size,
      charPx: size * m.charEm,
      lineHeight: size,
      maxLines: Math.max(3, Math.min(s.tafLines, Math.floor(textHeight / size))),
      labelSize,
      labelGap,
      labelArabic: Boolean(fonts.tafsirLabelArabic),
    };
  }

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
    tafsir,
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

// ---------------------------------------------------------------------------------
// Tafsir cards

// Word wrapping wastes more space in long paragraphs than in short translations.
const PARAGRAPH_WASTE = 1.12;
const BREAK_PENALTY = { sentence: 0, clause: 0.6, word: 2.5 };
const SENTENCE_BREAK = /(?:[.!?؟۔।…]+["'”’»)\]]*\s+)|(?:[。！？]+["'”’」』)）]*\s*)|(?:\n\s*)/gu;
const CLAUSE_BREAK = /(?:[,،;؛:、，；：]["'”’»)\]]*\s*)|(?:\s[—–-]\s)/gu;

/** Lines a paragraph of `len` base characters needs on a tafsir card. */
export function tafsirLines(layout, len) {
  const t = layout.tafsir;
  return len ? Math.max(1, Math.ceil((len * t.charPx * PARAGRAPH_WASTE) / layout.wrapWidth)) : 0;
}

/** Estimated pixel height of a tafsir card (label + text). */
export function tafsirCardHeight(layout, text) {
  const t = layout.tafsir;
  return t.labelSize + t.labelGap + tafsirLines(layout, baseLength(text)) * t.lineHeight;
}

/**
 * Split a tafsir text into cards that each fit the text area (≤ layout.tafsir.maxLines).
 * Cuts prefer sentence ends, then clause punctuation, then plain word gaps, and the cards
 * are balanced in length. Returns [string] (one entry when the whole text fits).
 */
export function splitTafsir(layout, text) {
  text = String(text || '').trim();
  if (!text) return [];
  const maxLines = layout.tafsir.maxLines;
  const fitsLen = (len) => tafsirLines(layout, len) <= maxLines;

  // Candidate cut positions (index where the next card would start) and their kind.
  const kinds = new Map();
  const mark = (re, kind) => {
    for (const m of text.matchAll(re)) {
      const at = m.index + m[0].length;
      if (at > 0 && at < text.length && !kinds.has(at)) kinds.set(at, kind);
    }
  };
  mark(SENTENCE_BREAK, 'sentence');
  mark(CLAUSE_BREAK, 'clause');
  mark(/\s+/gu, 'word');
  const spaced = (text.match(/\s/g) || []).length;
  if (spaced < text.length / 25) {
    // Scripts written without spaces (Chinese, Japanese, Thai): any character boundary.
    const chars = [...text];
    let at = 0;
    chars.forEach((ch, i) => {
      at += ch.length;
      const next = chars[i + 1];
      if (next && !kinds.has(at) && !MARK_RE.test(next)) kinds.set(at, 'word'); // never split a mark from its base
    });
  }
  const cuts = [0, ...[...kinds.keys()].sort((a, b) => a - b), text.length];
  // Prefix base lengths at each cut.
  const pre = [0];
  for (let i = 1; i < cuts.length; i++) pre.push(pre[i - 1] + baseLength(text.slice(cuts[i - 1], cuts[i])));
  const total = pre[pre.length - 1];
  if (fitsLen(total)) return [text];
  const n = cuts.length - 1; // units

  // Fewest cards (greedy is optimal for a monotone fit test).
  let minCards = 0;
  for (let i = 0; i < n; ) {
    let j = i + 1;
    while (j < n && fitsLen(pre[j + 1] - pre[i])) j++;
    i = j;
    minCards++;
  }

  let best = null;
  for (let k = minCards; k <= minCards + 1; k++) {
    const avg = total / k;
    // cost[c][j]: best cost of putting units [0, j) into c cards.
    const cost = Array.from({ length: k + 1 }, () => new Float64Array(n + 1).fill(Infinity));
    const from = Array.from({ length: k + 1 }, () => new Int32Array(n + 1).fill(-1));
    cost[0][0] = 0;
    for (let c = 1; c <= k; c++) {
      for (let j = 1; j <= n; j++) {
        for (let i = j - 1; i >= 0; i--) {
          const len = pre[j] - pre[i];
          if (!fitsLen(len)) break;
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
  if (!best) return [text]; // unreachable: a single unit always fits
  const cards = [];
  let start = 0;
  for (const end of best.ends) {
    cards.push(text.slice(cuts[start], cuts[end]).trim());
    start = end;
  }
  return cards.filter(Boolean);
}

const NO_BREAK_BEFORE = /[、。，．,.!?！？：；:;）)」』》〉】”’…・ー々〜]/u;

/**
 * libass only wraps at spaces, so text in scripts written without them (Chinese,
 * Japanese, Thai...) gets explicit line breaks ("\n") at character boundaries, never
 * before closing punctuation or a combining mark. Spaced text is returned unchanged.
 */
export function wrapTafsirText(layout, text) {
  return wrapUnspaced(text, layout.tafsir.charPx, layout.wrapWidth);
}

/** Same for a translation under the ayah (`scale` = the cue's translation font scale). */
export function wrapTranslationText(layout, text, scale = 1) {
  if (!text || !layout.translation) return text;
  return wrapUnspaced(text, layout.translation.charPx * scale, layout.wrapWidth);
}

function wrapUnspaced(text, charPx, wrapWidth) {
  const spaced = (text.match(/\s/g) || []).length;
  if (spaced >= text.length / 25) return text;
  const capacity = Math.max(4, Math.floor(wrapWidth / charPx) - 1);
  const lines = [];
  let line = '';
  let len = 0;
  for (const ch of text.replace(/\s+/g, ' ').trim()) {
    const base = !MARK_RE.test(ch);
    if (base && len >= capacity && !NO_BREAK_BEFORE.test(ch)) {
      lines.push(line.trim());
      line = '';
      len = 0;
    }
    line += ch;
    if (base) len++;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n');
}
