// Checks glyph coverage of the renderer fonts against real QuranEnc text.
// Usage: node scripts/check-font-coverage.js   (scans the Quran texts cached under cache/quran)
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../server/paths.js';
import { fontCoverage } from '../server/render/fonts.js';

const files = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.json')) files.push(p);
  }
};
walk(path.join(CACHE_DIR, 'quran'));

const arabic = new Set();
const byLang = {};
const collect = (row, key) => {
  if (row?.arabic_text) for (const c of row.arabic_text) arabic.add(c);
  if (row?.translation) for (const c of row.translation) (byLang[key] ??= new Set()).add(c);
};
for (const f of files) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    continue;
  }
  const rows = data.result || (Array.isArray(data) ? data : []);
  const key = path.basename(f).replace(/_\d+\.json$/, '').replace(/\.json$/, '');
  for (const row of rows) collect(row, key);
}
const hex = (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
const report = async (label, chars, key) => {
  const cov = await fontCoverage(key);
  const missing = [...chars].filter((c) => !/\s/.test(c) && !cov.has(c.codePointAt(0)));
  console.log(`${label} in ${key}: ${chars.size} chars, missing ${missing.length}: ${missing.map((c) => `${hex(c)}(${c})`).join(' ')}`);
};
console.log(`files: ${files.length}`);
await report('Quran arabic', arabic, 'amiriQuran');
await report('Quran arabic', arabic, 'scheherazade');
const fonts = { english: 'notoSansMedium', urdu: 'nastaliq', persian: 'naskh', bengali: 'bengali', hindi: 'devanagari', chinese: 'cjkSc' };
for (const [key, chars] of Object.entries(byLang)) {
  const font = Object.entries(fonts).find(([p]) => key.startsWith(p))?.[1] || 'notoSansMedium';
  await report(key, chars, font);
}
for (const key of ['notoSans', 'notoSansMedium', 'naskh', 'nastaliq', 'amiri', 'amiriQuran', 'scheherazade']) {
  const cov = await fontCoverage(key);
  console.log(`${key}: ﷺ ${cov.has(0xfdfa)} ﷻ ${cov.has(0xfdfb)} ﻻ ${cov.has(0xfefb)} ā ${cov.has(0x101)} ’ ${cov.has(0x2019)}`);
}
