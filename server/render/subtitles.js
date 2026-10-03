// ASS (Advanced SubStation Alpha) builder. Rendered with ffmpeg's `ass` filter using
// `shaping=complex` (HarfBuzz) — the `subtitles` filter defaults to simple shaping,
// which breaks Arabic joining. `Kerning: yes` is required for the end-of-ayah ornament
// (U+06DD) to enclose its digits.

import { CARD_FADE_MS } from './cards.js';

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const END_OF_AYAH = '\u06DD';
const NBSP = '\u00A0';

export const toArabicDigits = (n) => String(n).replace(/\d/g, (d) => ARABIC_DIGITS[d]);

// QuranEnc's Uthmani text follows the KFGQPC Hafs encoding, which writes the open
// (staggered) tanween with U+0657 / U+065E / U+0656 — code points its own font draws as
// open fathatan / dammatan / kasratan. OFL fonts draw those code points as other marks
// (inverted damma, subscript alef) or not at all, so for display only we map them to the
// standard Unicode open-tanween characters. The words and letters are untouched.
const OPEN_TANWEEN = { '\u0657': '\u08F0', '\u065E': '\u08F1', '\u0656': '\u08F2' };
export const quranDisplayText = (text) => text.replace(/[\u0656\u0657\u065E]/g, (c) => OPEN_TANWEEN[c]);

/** Ornamental ayah number (Amiri / Scheherazade draw the digits inside U+06DD). */
export const ayahMarker = (n) => `${END_OF_AYAH}${toArabicDigits(n)}`;

/** Make arbitrary text safe for an ASS Dialogue line. */
export function escapeAss(text, { trim = true } = {}) {
  const out = String(text ?? '')
    .replace(/\\/g, '\\\u2060') // a word joiner stops "\N", "\h"... from forming
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/[ \t\u00A0]*\r?\n[ \t\u00A0]*/g, '\\N')
    .replace(/[ \t]+/g, ' ');
  return trim ? out.trim() : out;
}

/** Text or [{ text, family|null }] runs (family = fallback font for that run) → ASS. */
function renderRuns(value, baseFamily) {
  if (typeof value === 'string') return escapeAss(value);
  const esc = (t) => escapeAss(t, { trim: false });
  return value
    .map((r) => (r.family ? `{\\fn${r.family}}${esc(r.text)}{\\fn${baseFamily}}` : esc(r.text)))
    .join('')
    .trim();
}

/** '#RRGGBB' + alpha (0 opaque .. 1 transparent) → ASS '&HAABBGGRR'. */
export function assColor(hex, transparency = 0) {
  const h = hex.replace('#', '');
  const a = Math.round(transparency * 255).toString(16).padStart(2, '0');
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/** Seconds → H:MM:SS.cc */
export function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

const COLORS = {
  text: '#FFFFFF',
  translation: '#F3EFE6',
  gold: '#E2C27A',
  goldSoft: '#D9BE86',
  shadow: '#000000',
};

const STYLE_FORMAT =
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding';

function styleLine(name, o) {
  const primary = assColor(o.color || COLORS.text, o.alpha || 0);
  const outline = assColor(COLORS.shadow, o.outlineAlpha ?? 0.45);
  const back = assColor(COLORS.shadow, o.shadowAlpha ?? 0.55);
  return `Style: ${name},${o.font},${o.size},${primary},${primary},${outline},${back},${o.bold ? -1 : 0},0,0,0,100,100,${o.spacing || 0},0,1,${o.outline},${o.shadow},${o.align || 5},${o.margin},${o.margin},0,-1`;
}

/**
 * Build the .ass document.
 * cues: [{ start, end, arabic, translation|null, translationRuns?, marker: ayah number|null }]
 * fonts: { arabic, translation, ui, uiMedium, arabicUi } — family names
 */
export function buildAss({ layout, fonts, position, cues, cards = [], header, footer, duration }) {
  const L = layout;
  const ar = L.arabic;
  const tr = L.translation;
  const margin = Math.round((L.width - L.wrapWidth) / 2);
  const styles = [
    styleLine('Arabic', {
      font: fonts.arabic,
      size: ar.size,
      outline: Math.max(1, Math.round(ar.size * 0.026)),
      shadow: Math.max(1, Math.round(ar.size * 0.018)),
      outlineAlpha: 0.4,
      margin,
    }),
    styleLine('Header', {
      font: fonts.arabicUi,
      bold: true,
      size: L.header.sizeAr,
      color: COLORS.gold,
      outline: 2,
      shadow: 1,
      outlineAlpha: 0.6,
      margin,
    }),
    styleLine('HeaderSub', {
      font: fonts.uiMedium,
      size: L.header.sizeEn,
      color: COLORS.goldSoft,
      alpha: 0.1,
      spacing: Math.round(L.header.sizeEn * 0.12),
      outline: 1,
      shadow: 1,
      outlineAlpha: 0.6,
      margin,
    }),
    styleLine('Footer', {
      font: fonts.uiMedium,
      size: L.footer.size,
      alpha: 0.12,
      outline: 1,
      shadow: 1,
      outlineAlpha: 0.55,
      margin,
    }),
    styleLine('FooterAr', {
      font: fonts.arabicUi,
      size: Math.round(L.footer.size * 1.7),
      alpha: 0.12,
      outline: 1,
      shadow: 1,
      outlineAlpha: 0.55,
      margin,
    }),
    styleLine('Credit', {
      font: fonts.ui,
      size: L.footer.creditSize,
      alpha: 0.35,
      outline: 1,
      shadow: 0,
      outlineAlpha: 0.6,
      margin,
    }),
  ];
  if (tr) {
    styles.push(
      styleLine('Translation', {
        font: fonts.translation,
        size: tr.size,
        color: COLORS.translation,
        alpha: 0.04,
        outline: Math.max(2, Math.round(tr.size * 0.06)),
        shadow: 1,
        outlineAlpha: 0.42,
        margin,
      }),
    );
  }

  const tf = L.tafsir;
  if (tf && cards.length) {
    styles.push(
      styleLine('Tafsir', {
        font: fonts.tafsir,
        size: tf.size,
        color: COLORS.translation,
        alpha: 0.02,
        outline: Math.max(2, Math.round(tf.size * 0.055)),
        shadow: 1,
        outlineAlpha: 0.4,
        margin,
      }),
      styleLine('TafsirLabel', {
        font: fonts.tafsirLabel,
        bold: fonts.tafsirLabelBold,
        size: tf.labelSize,
        color: COLORS.gold,
        spacing: tf.labelArabic ? 0 : Math.round(tf.labelSize * 0.1),
        outline: 2,
        shadow: 1,
        outlineAlpha: 0.55,
        margin,
      }),
    );
  }

  const events = [];
  const ev = (start, end, style, text, layer = 0) =>
    events.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}`);

  const lower = position === 'lower';
  const anchor = lower ? `\\an2\\pos(${L.centerX},${L.main.bottom})` : `\\an5\\pos(${L.centerX},${L.main.centerY})`;
  const blurAr = Math.max(1, Math.round(ar.size * 0.025));
  for (const cue of cues) {
    let text = `{${anchor}\\fad(300,300)\\blur${blurAr}}${escapeAss(quranDisplayText(cue.arabic))}`;
    if (cue.marker != null) text += `${NBSP}{\\c${assColor(COLORS.gold)}}${ayahMarker(cue.marker)}`;
    if (tr && cue.translation) {
      const fs = cue.translationScale < 1 ? `\\fs${Math.round(tr.size * cue.translationScale)}` : '';
      text += `\\N{\\fs${L.gap}}\\h\\N{\\rTranslation\\blur2${fs}}${renderRuns(cue.translationRuns || cue.translation, fonts.translation)}`;
    }
    ev(cue.start, cue.end, 'Arabic', text, 1);
  }

  // Tafsir cards: gold book label + commentary, between ayat (the ayah text is not shown).
  if (tf) {
    const blur = Math.max(1, Math.round(tf.size * 0.03));
    for (const card of cards) {
      const text =
        `{${anchor}\\fad(${CARD_FADE_MS},${CARD_FADE_MS})\\blur1}${escapeAss(card.label)}` +
        `\\N{\\fs${tf.labelGap}}\\h\\N{\\rTafsir\\blur${blur}}${renderRuns(card.textRuns || card.text, fonts.tafsir)}`;
      ev(card.start, card.end, 'TafsirLabel', text, 1);
    }
  }

  if (header) {
    const sub = header.nameEn ? `\\N{\\rHeaderSub}${escapeAss(header.nameEn.toUpperCase())}` : '';
    ev(0, duration, 'Header', `{\\an8\\pos(${L.centerX},${L.header.y})\\fad(900,700)}${escapeAss(header.nameAr)}${sub}`);
  }

  const footerLines = [];
  if (footer.reciter) {
    const { nameEn, nameAr } = footer.reciter;
    let line = escapeAss(nameEn || '');
    if (nameAr) line += `${line ? '  ·  ' : ''}{\\rFooterAr}${escapeAss(nameAr)}`;
    footerLines.push(line);
  }
  if (footer.credit) footerLines.push(`{\\rCredit}${escapeAss(footer.credit)}`);
  if (footerLines.length) {
    ev(0, duration, 'Footer', `{\\an2\\pos(${L.centerX},${L.footer.y})\\fad(900,700)}${footerLines.join('\\N')}`);
  }

  return `[Script Info]
; Generated by Quran Video Studio
ScriptType: v4.00+
PlayResX: ${L.width}
PlayResY: ${L.height}
WrapStyle: 0
ScaledBorderAndShadow: yes
Kerning: yes
YCbCr Matrix: TV.709

[V4+ Styles]
${STYLE_FORMAT}
${styles.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
}
