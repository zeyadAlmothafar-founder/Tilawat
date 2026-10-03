// Finds the tafsir (Quran commentary) editions QuranEnc serves and writes the allow-list to
// server/data/tafsirs.json. Most tafsir keys are NOT in /translations/list, so this probes
// `<language>_mokhtasar`, `<language>_moyassar` and `<language>_saadi` for a broad list of
// languages (plus any such key the list does mention) and keeps only editions whose surah 1
// and surah 2 are complete (every ayah present, nearly all entries non-empty).
// Usage: node scripts/check-tafsirs.js [--dry]   (--dry: print, don't write)
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../server/paths.js';

const OUT_FILE = path.join(ROOT, 'server', 'data', 'tafsirs.json');
const API = 'https://quranenc.com/api/v1';
const DELAY_MS = 350; // be polite: one request at a time with a pause
const DRY = process.argv.includes('--dry');

// language prefix → [ISO 639 code, direction, display name]
const LANGUAGES = {
  arabic: ['ar', 'rtl', 'Arabic'], english: ['en', 'ltr', 'English'], french: ['fr', 'ltr', 'French'],
  indonesian: ['id', 'ltr', 'Indonesian'], turkish: ['tr', 'ltr', 'Turkish'], bengali: ['bn', 'ltr', 'Bengali'],
  russian: ['ru', 'ltr', 'Russian'], spanish: ['es', 'ltr', 'Spanish'], persian: ['fa', 'rtl', 'Persian'],
  urdu: ['ur', 'rtl', 'Urdu'], german: ['de', 'ltr', 'German'], malay: ['ms', 'ltr', 'Malay'],
  chinese: ['zh', 'ltr', 'Chinese'], japanese: ['ja', 'ltr', 'Japanese'], korean: ['ko', 'ltr', 'Korean'],
  italian: ['it', 'ltr', 'Italian'], bosnian: ['bs', 'ltr', 'Bosnian'], albanian: ['sq', 'ltr', 'Albanian'],
  tagalog: ['tl', 'ltr', 'Tagalog'], vietnamese: ['vi', 'ltr', 'Vietnamese'], thai: ['th', 'ltr', 'Thai'],
  hindi: ['hi', 'ltr', 'Hindi'], tamil: ['ta', 'ltr', 'Tamil'], kurdish: ['ku', 'rtl', 'Kurdish'],
  kurmanji: ['kmr', 'rtl', 'Kurmanji'], pashto: ['ps', 'rtl', 'Pashto'], uzbek: ['uz', 'ltr', 'Uzbek'],
  swahili: ['sw', 'ltr', 'Swahili'], hausa: ['ha', 'ltr', 'Hausa'], amharic: ['am', 'ltr', 'Amharic'],
  somali: ['so', 'ltr', 'Somali'], portuguese: ['pt', 'ltr', 'Portuguese'], dutch: ['nl', 'ltr', 'Dutch'],
  sinhalese: ['si', 'ltr', 'Sinhala'], nepali: ['ne', 'ltr', 'Nepali'], assamese: ['as', 'ltr', 'Assamese'],
  kazakh: ['kk', 'ltr', 'Kazakh'], kyrgyz: ['ky', 'ltr', 'Kyrgyz'], tajik: ['tg', 'ltr', 'Tajik'],
  azeri: ['az', 'ltr', 'Azerbaijani'], georgian: ['ka', 'ltr', 'Georgian'], ukrainian: ['uk', 'ltr', 'Ukrainian'],
  romanian: ['ro', 'ltr', 'Romanian'], serbian: ['sr', 'ltr', 'Serbian'], macedonian: ['mk', 'ltr', 'Macedonian'],
  hebrew: ['he', 'rtl', 'Hebrew'], yoruba: ['yo', 'ltr', 'Yoruba'], oromo: ['om', 'ltr', 'Oromo'],
  fulani: ['ff', 'ltr', 'Fulani'], lingala: ['ln', 'ltr', 'Lingala'], malayalam: ['ml', 'ltr', 'Malayalam'],
  telugu: ['te', 'ltr', 'Telugu'], kannada: ['kn', 'ltr', 'Kannada'], gujarati: ['gu', 'ltr', 'Gujarati'],
  marathi: ['mr', 'ltr', 'Marathi'], punjabi: ['pa', 'ltr', 'Punjabi'], greek: ['el', 'ltr', 'Greek'],
  bulgarian: ['bg', 'ltr', 'Bulgarian'], swedish: ['sv', 'ltr', 'Swedish'], croatian: ['hr', 'ltr', 'Croatian'],
  lithuanian: ['lt', 'ltr', 'Lithuanian'], belarusian: ['be', 'ltr', 'Belarusian'], uyghur: ['ug', 'rtl', 'Uyghur'],
  dari: ['prs', 'rtl', 'Dari'], khmer: ['km', 'ltr', 'Khmer'], malagasy: ['mg', 'ltr', 'Malagasy'],
  kinyarwanda: ['rw', 'ltr', 'Kinyarwanda'], ikirundi: ['rn', 'ltr', 'Kirundi'], chichewa: ['ny', 'ltr', 'Chichewa'],
  zulu: ['zu', 'ltr', 'Zulu'], shona: ['sn', 'ltr', 'Shona'], bisayan: ['ceb', 'ltr', 'Cebuano'],
  luganda: ['lg', 'ltr', 'Luganda'], afar: ['aa', 'ltr', 'Afar'], dagbani: ['dag', 'ltr', 'Dagbani'],
};

const BOOKS = {
  mokhtasar: 'Al-Mukhtasar fi Tafsir al-Quran',
  moyassar: 'At-Tafsir al-Muyassar',
  saadi: "Tafsir As-Sa'di",
};
const BOOK_ORDER = Object.keys(BOOKS);
const KEY_RE = new RegExp(`^([a-z]+)_(${BOOK_ORDER.join('|')})$`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(DELAY_MS * (attempt + 1));
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'QuranVideoStudio/0.1 (+local)' }, signal: AbortSignal.timeout(60000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return text.trim() ? JSON.parse(text) : null;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  return null;
}

/** null if complete, otherwise the reason it is not. */
function problem(rows, expected) {
  if (!Array.isArray(rows)) return 'no rows';
  const ayat = new Set(rows.map((r) => Number(r.aya)));
  for (let a = 1; a <= expected; a++) if (!ayat.has(a)) return `ayah ${a} missing`;
  const filled = rows.filter((r) => String(r.translation ?? '').trim().length > 0).length;
  if (filled < expected * 0.9) return `only ${filled}/${expected} entries filled`;
  const distinct = new Set(rows.map((r) => String(r.translation ?? '').trim()).filter(Boolean)).size;
  if (distinct < expected * 0.5) return `only ${distinct}/${expected} distinct texts`;
  return null;
}

const listed = await getJson(`${API}/translations/list?all=1`).catch(() => null);
const listedKeys = new Map();
for (const t of listed?.translations || []) {
  if (KEY_RE.test(t.key)) listedKeys.set(t.key, t);
}

const candidates = new Set();
for (const lang of Object.keys(LANGUAGES)) for (const book of BOOK_ORDER) candidates.add(`${lang}_${book}`);
for (const key of listedKeys.keys()) candidates.add(key);

console.log(`Probing ${candidates.size} candidate keys (${listedKeys.size} mentioned by /translations/list)…`);
const found = [];
for (const key of candidates) {
  const [, lang, book] = key.match(KEY_RE);
  let status;
  try {
    const probe = await getJson(`${API}/translation/aya/${key}/1/1`);
    if (!probe?.result) {
      status = 'not available';
    } else {
      const s1 = await getJson(`${API}/translation/sura/${key}/1`);
      const s2 = s1 && (await getJson(`${API}/translation/sura/${key}/2`));
      status = problem(s1?.result, 7) || problem(s2?.result, 286);
      if (!status) {
        const meta = listedKeys.get(key);
        const [iso, dir, name] = LANGUAGES[lang] || [meta?.language_iso_code || lang.slice(0, 2), meta?.direction === 'rtl' ? 'rtl' : 'ltr', lang[0].toUpperCase() + lang.slice(1)];
        const title = lang === 'arabic' ? `${BOOKS[book]} (Arabic)` : `${BOOKS[book]} — ${name}`;
        found.push({ key, languageIso: meta?.language_iso_code || iso, title, book, direction: meta ? (meta.direction === 'rtl' ? 'rtl' : 'ltr') : dir });
        status = 'OK';
      }
    }
  } catch (err) {
    status = `error: ${err.message}`;
  }
  if (status !== 'not available') console.log(`  ${key.padEnd(24)} ${status}`);
}

// Arabic originals first, then by language name, then book.
const sortKey = (t) => [t.languageIso === 'ar' ? 0 : 1, t.title.split(' — ').pop(), BOOK_ORDER.indexOf(t.book)];
found.sort((a, b) => {
  const [x, y] = [sortKey(a), sortKey(b)];
  return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2] - y[2];
});

console.log(`\n${found.length} complete tafsir editions: ${found.map((t) => t.key).join(', ')}`);
if (!DRY) {
  if (!found.length) throw new Error('Nothing found — not overwriting the existing list');
  await fs.writeFile(OUT_FILE, `${JSON.stringify(found, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, OUT_FILE)}`);
}
