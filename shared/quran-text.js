// Display-only glyph mapping for QuranEnc's Arabic text (shared by the server renderer and
// the web build). QuranEnc follows the KFGQPC Hafs encoding, which writes the open
// (staggered) tanween as U+0657 / U+065E / U+0656; OFL fonts draw those code points as other
// marks, so for display they become the standard Unicode open-tanween characters
// U+08F0–U+08F2. Letters and words are never changed.
// Pure, dependency-free ESM: used by Node and by the browser (served as /shared/*).

export const OPEN_TANWEEN = Object.freeze({ 'ٗ': 'ࣰ', 'ٞ': 'ࣱ', 'ٖ': 'ࣲ' });

export const quranDisplayText = (text) => String(text ?? '').replace(/[ٖٗٞ]/g, (c) => OPEN_TANWEEN[c]);
