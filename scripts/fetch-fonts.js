// Downloads the renderer's base fonts into assets/fonts/ and prints their family names.
// Usage: node scripts/fetch-fonts.js [--all]   (--all also fetches the on-demand script fonts)
import { FONTS, ensureFont, fontPath, readFontFamilies } from '../server/render/fonts.js';

const all = process.argv.includes('--all');
for (const [key, font] of Object.entries(FONTS)) {
  if (!font.base && !all) continue;
  try {
    await ensureFont(key);
    const names = await readFontFamilies(fontPath(key));
    const ok = names.some((n) => n.endsWith(`:${font.family}`));
    console.log(`${ok ? 'ok  ' : 'WARN'} ${key.padEnd(18)} ${font.file.padEnd(32)} ${names.join(' | ')}`);
  } catch (err) {
    console.log(`FAIL ${key}: ${err.message}`);
    process.exitCode = 1;
  }
}
