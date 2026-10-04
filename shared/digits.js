// Decimal digits used by QuranEnc texts: ASCII, Arabic-Indic, Persian, Devanagari, Bengali.
// Pure, dependency-free ESM (Node + browser).

export const DIGIT = '0-9٠-٩۰-۹०-९০-৯';
const DIGIT_ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6];

/** Numeric value of a run of digits from any of the scripts above. */
export function digitsValue(text) {
  let value = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9);
    value = value * 10 + (code - zero);
  }
  return value;
}
