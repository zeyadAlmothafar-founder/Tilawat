// Display-only glyph mapping for QuranEnc's Arabic text, mirroring quranDisplayText() in
// server/render/subtitles.js so the browser shows what the video shows.
// QuranEnc follows the KFGQPC Hafs encoding, which writes the open (staggered) tanween as
// U+0657 / U+065E / U+0656; web fonts draw those as other marks, so they are shown as the
// standard Unicode open-tanween characters. Letters and words are never changed.
const OPEN_TANWEEN = { 'ٗ': 'ࣰ', 'ٞ': 'ࣱ', 'ٖ': 'ࣲ' };

export const quranDisplayText = (text) => String(text ?? '').replace(/[ٖٗٞ]/g, (c) => OPEN_TANWEEN[c]);
