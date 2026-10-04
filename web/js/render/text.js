// Text drawing: libass-like styles (fill, blurred outline, drop shadow) rendered once per
// cue / card / header / footer into an offscreen "sprite", then composited per frame with
// a fade (globalAlpha). Styles mirror server/render/subtitles.js.

import { FONTS, cssFont, fontMetrics } from './fonts.js';
import { wrapText } from './layout.js';

export const COLORS = { text: '#FFFFFF', translation: '#F3EFE6', gold: '#E2C27A', goldSoft: '#D9BE86' };

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export const toArabicDigits = (n) => String(n).replace(/\d/g, (d) => ARABIC_DIGITS[d]);
/** End-of-ayah ornament: U+06DD followed by Arabic-Indic digits (Amiri Quran / Scheherazade enclose them). */
export const ayahMarker = (n) => `۝${toArabicDigits(n)}`;
const NBSP = ' ';

const OPEN_TANWEEN = { 'ٗ': 'ࣰ', 'ٞ': 'ࣱ', 'ٖ': 'ࣲ' };
/** Display mapping for QuranEnc's KFGQPC open tanween (idempotent; letters untouched). */
export const quranDisplayText = (text) => String(text ?? '').replace(/[ٖٗٞ]/g, (c) => OPEN_TANWEEN[c]);

const ARABIC_FALLBACKS = ['amiriQuran', 'scheherazade', 'naskh'];
const OFF = 10000; // shadow trick: draw far off-canvas, shadow lands back in place

// Canvas backing: 'gpu' (default, accelerated) or 'cpu' (willReadFrequently → software
// raster). When reading GPU canvases back for the encoder is slow on a machine, frames are
// composed on CPU canvases instead (see engine.js).
let cpuMode = false;
export function setCanvasMode(mode) {
  cpuMode = mode === 'cpu';
}
export const canvasMode = () => (cpuMode ? 'cpu' : 'gpu');
export function ctx2d(canvas, opts = {}) {
  return canvas.getContext('2d', cpuMode ? { ...opts, willReadFrequently: true } : opts);
}

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

/**
 * A "line" = { height, runs: [{ text, key, size, font, dir, color, alpha, spacing }], align }
 * A "group" = lines sharing one outline/shadow style:
 *   { lines, outline, outlineAlpha, shadow, shadowAlpha, blur }
 * renderSprite(groups, width) → { canvas, height, pad } with the text block drawn centered.
 */
export function renderSprite(m, groups, width) {
  const totalHeight = groups.reduce((s, g) => s + g.lines.reduce((a, l) => a + l.height, 0), 0);
  const maxSize = Math.max(...groups.flatMap((g) => g.lines.flatMap((l) => l.runs.map((r) => r.size))), 10);
  const pad = Math.ceil(maxSize * 0.5 + 12);
  const canvas = makeCanvas(width, totalHeight + 2 * pad);
  const ctx = ctx2d(canvas);
  const mask = makeCanvas(width, totalHeight + 2 * pad);
  const mctx = ctx2d(mask);

  // Positions of every run.
  let y = pad;
  const placed = groups.map((g) => {
    const lines = g.lines.map((line) => {
      const top = y;
      y += line.height;
      if (!line.runs.length) return { runs: [] };
      // Baseline: libass puts it at the line top + the tallest ascender of the line.
      const asc = Math.max(...line.runs.map((r) => fontMetrics(r.key, r.size).asc));
      const desc = Math.max(...line.runs.map((r) => fontMetrics(r.key, r.size).desc));
      const baseline = top + asc * (line.height / Math.max(1, asc + desc));
      const widths = line.runs.map((r) => runWidth(m, r));
      const total = widths.reduce((a, b) => a + b, 0);
      // Runs are listed in visual order left → right.
      let x = width / 2 - total / 2;
      const runs = line.runs.map((r, i) => {
        const placedRun = { ...r, x, width: widths[i], baseline };
        x += widths[i];
        return placedRun;
      });
      return { runs };
    });
    return { ...g, lines };
  });

  for (const g of placed) {
    // 1. Mask of glyph + outline (opaque black) for the shadow and the outline.
    mctx.clearRect(0, 0, mask.width, mask.height);
    for (const line of g.lines) for (const r of line.runs) drawRun(mctx, r, { stroke: g.outline, color: '#000', alpha: 1 });
    // 2. Drop shadow (offset copy of glyph + outline).
    if (g.shadow > 0 && g.shadowAlpha > 0) {
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${g.shadowAlpha})`;
      ctx.shadowBlur = g.blur * 1.2;
      ctx.shadowOffsetX = OFF + g.shadow;
      ctx.shadowOffsetY = g.shadow;
      ctx.drawImage(mask, -OFF, 0);
      ctx.restore();
    }
    // 3. Outline (blurred).
    if (g.outline > 0 && g.outlineAlpha > 0) {
      ctx.save();
      if (g.blur > 0) {
        ctx.shadowColor = `rgba(0,0,0,${g.outlineAlpha})`;
        ctx.shadowBlur = g.blur * 1.2;
        ctx.shadowOffsetX = OFF;
        ctx.drawImage(mask, -OFF, 0);
      } else {
        ctx.globalAlpha = g.outlineAlpha;
        ctx.drawImage(mask, 0, 0);
      }
      ctx.restore();
    }
    // 4. Fill.
    for (const line of g.lines) for (const r of line.runs) drawRun(ctx, r, {});
  }
  return { canvas, height: totalHeight, pad };
}

function runWidth(m, r) {
  if (!r.spacing) return m.width(r.font, r.text, r.dir);
  const chars = [...r.text];
  return chars.reduce((s, ch) => s + m.width(r.font, ch, r.dir), 0) + r.spacing * Math.max(0, chars.length - 1);
}

function drawRun(ctx, r, { stroke = 0, color, alpha }) {
  ctx.font = r.font;
  ctx.direction = r.dir || 'ltr';
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = alpha ?? r.alpha ?? 1;
  ctx.fillStyle = color || r.color;
  ctx.strokeStyle = color || r.color;
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke * 2;
  const draw = (text, x) => {
    if (stroke > 0) ctx.strokeText(text, x, r.baseline);
    ctx.fillText(text, x, r.baseline);
  };
  if (r.spacing) {
    ctx.textAlign = 'left';
    let x = r.x;
    for (const ch of r.text) {
      draw(ch, x);
      x += ctx.measureText(ch).width + r.spacing;
    }
  } else if (r.dir === 'rtl') {
    ctx.textAlign = 'right';
    draw(r.text, r.x + r.width);
  } else {
    ctx.textAlign = 'left';
    draw(r.text, r.x);
  }
  ctx.globalAlpha = 1;
}

const run = (key, size, text, extra = {}) => ({
  key, size, text, font: cssFont(key, size, extra.fallbacks ? { fallbacks: extra.fallbacks } : {}), dir: 'ltr', color: COLORS.text, alpha: 1, ...extra,
});

// ---------------------------------------------------------------------------------
// Sprites

/** Cue block: Arabic lines (+ gold ayah ornament on the last one), gap, translation lines. */
export function cueSprite(m, layout, cue) {
  const ar = layout.arabic;
  const tr = layout.translation;
  const arLines = cue.block.arLines.map((words, i) => {
    const last = i === cue.block.arLines.length - 1;
    const text = quranDisplayText(words.join(' '));
    const runs = [run(ar.font, ar.size, text, { dir: 'rtl', fallbacks: ARABIC_FALLBACKS })];
    if (last && cue.marker != null) {
      // RTL: the ornament sits to the left of the text.
      runs.unshift(run(ar.font, ar.size, `${NBSP}${ayahMarker(cue.marker)}`, { dir: 'rtl', color: COLORS.gold, fallbacks: ARABIC_FALLBACKS }));
    }
    return { height: ar.size, runs };
  });
  const groups = [{
    lines: arLines,
    outline: Math.max(1, Math.round(ar.size * 0.026)),
    outlineAlpha: 0.6,
    shadow: Math.max(1, Math.round(ar.size * 0.018)),
    shadowAlpha: 0.45,
    blur: Math.max(1, Math.round(ar.size * 0.025)),
  }];
  if (tr && cue.block.trLines.length) {
    const size = tr.size * cue.block.trScale;
    const dir = tr.rtl ? 'rtl' : 'ltr';
    groups.push({
      lines: [
        { height: layout.gap, runs: [] },
        ...cue.block.trLines.map((text) => ({ height: tr.lineHeight * cue.block.trScale, runs: [run(tr.font, size, text, { dir, color: COLORS.translation, alpha: 0.96 })] })),
      ],
      outline: Math.max(2, Math.round(size * 0.06)),
      outlineAlpha: 0.58,
      shadow: 1,
      shadowAlpha: 0.45,
      blur: 2,
    });
  }
  return renderSprite(m, groups, layout.width);
}

/** Tafsir card: gold label + commentary. */
export function cardSprite(m, layout, card) {
  const t = layout.tafsir;
  const size = t.size * card.block.scale;
  const dir = t.rtl ? 'rtl' : 'ltr';
  const labelRun = t.labelArabic
    ? run(t.labelFont, t.labelSize, card.label, { dir: 'rtl', color: COLORS.gold, fallbacks: ['naskh', 'amiri'] })
    : run(t.labelFont, t.labelSize, card.label, { color: COLORS.gold, spacing: Math.round(t.labelSize * 0.1) });
  return renderSprite(m, [
    { lines: [{ height: t.labelSize, runs: [labelRun] }], outline: 2, outlineAlpha: 0.45, shadow: 1, shadowAlpha: 0.45, blur: 1 },
    {
      lines: [
        { height: t.labelGap, runs: [] },
        ...card.block.lines.map((text) => ({ height: t.lineHeight * card.block.scale, runs: [run(t.font, size, text, { dir, color: COLORS.translation, alpha: 0.98 })] })),
      ],
      outline: Math.max(2, Math.round(size * 0.055)),
      outlineAlpha: 0.6,
      shadow: 1,
      shadowAlpha: 0.45,
      blur: Math.max(1, Math.round(size * 0.03)),
    },
  ], layout.width);
}

/** Header: gold "سورة …" + spaced Latin name. */
export function headerSprite(m, layout, header) {
  const L = layout.header;
  const lines = [{ height: L.sizeAr, runs: [run('amiriBold', L.sizeAr, header.nameAr, { dir: 'rtl', color: COLORS.gold, fallbacks: ['amiri', 'naskh'] })] }];
  const groups = [{ lines, outline: 2, outlineAlpha: 0.4, shadow: 1, shadowAlpha: 0.45, blur: 0 }];
  if (header.nameEn) {
    groups.push({
      lines: [{ height: L.sizeEn * 1.1, runs: [run('notoSansMedium', L.sizeEn, header.nameEn.toUpperCase(), { color: COLORS.goldSoft, alpha: 0.9, spacing: Math.round(L.sizeEn * 0.12) })] }],
      outline: 1, outlineAlpha: 0.4, shadow: 1, shadowAlpha: 0.45, blur: 0,
    });
  }
  return renderSprite(m, groups, layout.width);
}

/** Wrapped credit lines (credit may contain '\n'). */
export function creditLines(m, layout, credit) {
  if (!credit) return [];
  const font = cssFont('notoSans', layout.footer.creditSize);
  return String(credit).split(/\n/).flatMap((p) => wrapText(m, font, p.trim(), layout.width - 2 * layout.side, 'ltr'));
}

/** Footer: reciter (English · Arabic) + credit lines. */
export function footerSprite(m, layout, { reciter, credit }) {
  const F = layout.footer;
  const groups = [];
  if (reciter && (reciter.nameEn || reciter.nameAr)) {
    const runs = [];
    if (reciter.nameEn) runs.push(run('notoSansMedium', F.size, reciter.nameEn, { alpha: 0.88 }));
    if (reciter.nameEn && reciter.nameAr) runs.push(run('notoSansMedium', F.size, '  ·  ', { alpha: 0.88 }));
    if (reciter.nameAr) runs.push(run('amiri', Math.round(F.size * 1.7), reciter.nameAr, { dir: 'rtl', alpha: 0.88, fallbacks: ['naskh'] }));
    groups.push({ lines: [{ height: Math.round(F.size * 1.7), runs }], outline: 1, outlineAlpha: 0.45, shadow: 1, shadowAlpha: 0.45, blur: 0 });
  }
  const credits = creditLines(m, layout, credit);
  if (credits.length) {
    groups.push({
      lines: credits.map((text) => ({ height: F.creditSize, runs: [run('notoSans', F.creditSize, text, { alpha: 0.65 })] })),
      outline: 1, outlineAlpha: 0.4, shadow: 0, shadowAlpha: 0, blur: 0,
    });
  }
  return groups.length ? renderSprite(m, groups, layout.width) : null;
}

export { FONTS };
