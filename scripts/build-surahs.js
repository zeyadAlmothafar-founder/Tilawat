// Builds server/data/surahs.json from quran.com chapter metadata (one-off; the app never
// calls quran.com at runtime). Ayah counts are cross-checked against EveryAyah.
// Usage: node scripts/build-surahs.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../server/paths.js';
import { fetchJson } from '../server/lib/http.js';

const OUT_FILE = path.join(ROOT, 'server', 'data', 'surahs.json');
const CHAPTERS_URL = 'https://api.quran.com/api/v4/chapters?language=';
const EVERYAYAH_URL = 'https://everyayah.com/data/recitations.js';
const TOTAL_AYAT = 6236;

// UI language → quran.com `language_name` expected in translated_name. Arabic is left out on
// purpose: quran.com only returns "سورة …" (the name itself) for two surahs.
const MEANING_LANGS = {
  ur: 'urdu', fa: 'persian', fr: 'french', tr: 'turkish', id: 'indonesian', ms: 'malay',
  bn: 'bengali', es: 'spanish', de: 'german', ru: 'russian',
};

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

async function chapters(lang) {
  const data = await fetchJson(CHAPTERS_URL + lang, { timeoutMs: 30000 });
  if (!Array.isArray(data.chapters) || data.chapters.length !== 114) {
    throw new Error(`quran.com (${lang}) returned ${data.chapters?.length} chapters`);
  }
  return data.chapters;
}

/** Translated surah-name meanings for one language, or null if it is missing / English. */
async function meaningsFor(lang, languageName) {
  try {
    const list = await chapters(lang);
    const names = list.map((c) => (c.translated_name?.language_name === languageName ? clean(c.translated_name.name) : null));
    const found = names.filter(Boolean).length;
    console.log(`  ${lang}: ${found}/114 localized`);
    return found ? names : null;
  } catch (err) {
    console.warn(`  ${lang}: skipped (${err.message})`);
    return null;
  }
}

async function main() {
  console.log('Fetching chapter metadata…');
  const base = await chapters('en');
  const everyAyah = await fetchJson(EVERYAYAH_URL, { timeoutMs: 30000 });
  const counts = everyAyah.ayahCount;

  const localized = {};
  for (const [lang, languageName] of Object.entries(MEANING_LANGS)) {
    const names = await meaningsFor(lang, languageName);
    if (names) localized[lang] = names;
  }

  const surahs = base.map((c, i) => {
    const number = i + 1;
    if (c.id !== number) throw new Error(`Unexpected chapter order at ${i}: id ${c.id}`);
    if (c.verses_count !== counts[i]) {
      throw new Error(`Ayah count mismatch for surah ${number}: quran.com ${c.verses_count}, EveryAyah ${counts[i]}`);
    }
    const meaningEn = clean(c.translated_name.name);
    const meanings = { en: meaningEn };
    for (const [lang, names] of Object.entries(localized)) if (names[i]) meanings[lang] = names[i];
    return {
      number,
      nameAr: clean(c.name_arabic),
      nameEn: clean(c.name_simple),
      meaningEn,
      meanings,
      ayahCount: c.verses_count,
      revelation: c.revelation_place === 'madinah' ? 'medinan' : 'meccan',
    };
  });

  const total = surahs.reduce((sum, s) => sum + s.ayahCount, 0);
  if (total !== TOTAL_AYAT || counts.length !== 114) throw new Error(`Total ayat ${total} ≠ ${TOTAL_AYAT}`);

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, `${JSON.stringify(surahs, null, 1)}\n`);
  console.log(`Wrote ${surahs.length} surahs (${total} ayat, matches EveryAyah) → ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`Meaning languages: en, ${Object.keys(localized).join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
