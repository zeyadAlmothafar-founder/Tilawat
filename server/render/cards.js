// Tafsir cards: reading time and the silent pause each one adds to the video.
import { detectScript } from './fonts.js';
import { baseLength, splitTafsir } from './layout.js';

export const MIN_CARD_SECONDS = 4;
const WORDS_PER_SECOND = 2.8;
const CARD_EXTRA = 1.5; // time to notice the card and settle in
const CARD_LEAD = 0.15; // after the ayah text has faded out
const CARD_TRAIL = 0.3; // before the next ayah fades in
export const CARD_FADE_MS = 400;

/** Word count; scripts written without spaces count characters per typical word. */
export function wordCount(text) {
  const script = detectScript(text);
  if (script === 'han' || script === 'kana') return baseLength(text) / 1.5;
  if (['thai', 'khmer', 'lao', 'myanmar'].includes(script)) return baseLength(text) / 5;
  return String(text).split(/\s+/).filter(Boolean).length;
}

/** Seconds one card stays on screen: max(4 s, words / 2.8 + 1.5 s). */
export function readingSeconds(text) {
  return Math.max(MIN_CARD_SECONDS, wordCount(text) / WORDS_PER_SECOND + CARD_EXTRA);
}

/** Rough total for a tafsir text before the layout is known (used to pick enough footage). */
export function estimateTafsirSeconds(text) {
  const words = wordCount(text);
  const cards = Math.max(1, Math.ceil(words / 80));
  return Math.max(MIN_CARD_SECONDS, words / WORDS_PER_SECOND + CARD_EXTRA * cards) + CARD_LEAD + CARD_TRAIL;
}

/** Text → [{ text, duration }] cards that fit the layout's tafsir area. */
export function planCards(layout, text) {
  return splitTafsir(layout, text).map((t) => ({ text: t, duration: Math.round(readingSeconds(t) * 100) / 100 }));
}

/** Seconds of silence to insert for these cards (0 when none). */
export function gapSeconds(cards) {
  if (!cards?.length) return 0;
  return CARD_LEAD + cards.reduce((s, c) => s + c.duration, 0) + CARD_TRAIL;
}

/**
 * Place cards inside the silent gap [gapStart, gapEnd]: back to back, each with its own
 * fade in/out. → [{ start, end, text }]
 */
export function placeCards(cards, gapStart) {
  let t = gapStart + CARD_LEAD;
  return cards.map((c) => {
    const placed = { start: t, end: t + c.duration, text: c.text };
    t += c.duration;
    return placed;
  });
}
