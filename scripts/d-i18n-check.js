#!/usr/bin/env node
// Checks the UI translations in public/i18n against en.json (the source of truth).
//
//   node scripts/d-i18n-check.js          # every language file present
//   node scripts/d-i18n-check.js fr de    # only these languages
//   node scripts/d-i18n-check.js --strict # also fail when a language file is missing
//
// Reports per language: JSON errors, missing / extra keys, string-vs-plural mismatches,
// missing CLDR plural categories (via Intl.PluralRules), placeholder differences and
// empty strings. Also scans public/ for keys used in HTML/JS that en.json lacks.
// Exit code 1 when any error is found.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const I18N = path.join(PUBLIC, 'i18n');
const PLURAL_CATS = ['zero', 'one', 'two', 'few', 'many', 'other'];

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const only = args.filter((a) => !a.startsWith('--'));

const { LANGUAGES } = await import(pathToFileURL(path.join(I18N, 'languages.js')).href);

let errors = 0;
let warnings = 0;
const err = (msg) => { errors++; console.log(`  ✗ ${msg}`); };
const warn = (msg) => { warnings++; console.log(`  ! ${msg}`); };

const isPluralGroup = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) && 'other' in v && Object.keys(v).every((k) => PLURAL_CATS.includes(k));

/** Flatten nested JSON to { 'a.b': string | { plural: {...} } }. */
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPluralGroup(v)) out[key] = { plural: v };
    else if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const placeholders = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const pluralText = (v) => (typeof v === 'object' && v ? Object.values(v.plural).join(' ') : v);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { __error: e.message };
  }
}

// ---------- source ----------
console.log('en (source)');
const enRaw = readJson(path.join(I18N, 'en.json'));
if (enRaw.__error) {
  err(`en.json: ${enRaw.__error}`);
  process.exit(1);
}
const en = flatten(enRaw);
for (const [key, v] of Object.entries(en)) {
  if (typeof v === 'string') { if (!v.trim()) warn(`${key}: empty string`); continue; }
  if (v && typeof v === 'object') {
    const needed = new Intl.PluralRules('en').resolvedOptions().pluralCategories;
    for (const c of needed) if (!(c in v.plural)) err(`${key}: missing plural form "${c}"`);
    continue;
  }
  err(`${key}: value must be a string or plural object`);
}
console.log(`  ${Object.keys(en).length} keys`);

// ---------- usage scan ----------
function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const used = new Set();
const dynamicPrefixes = new Set();
for (const file of walk(PUBLIC, ['.html', '.js'])) {
  if (file.startsWith(I18N)) continue;
  const src = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.html')) {
    for (const m of src.matchAll(/data-i18n="([\w.]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) {
      for (const pair of m[1].split(';')) { const key = pair.split(':')[1]?.trim(); if (key) used.add(key); }
    }
    continue;
  }
  const call = String.raw`(?<![.\w])(?:t|tNodes|has)\(\s*`;
  for (const m of src.matchAll(new RegExp(`${call}'([\\w.]+)'`, 'g'))) used.add(m[1]);
  // Keys picked by a ternary inside t(…), e.g. t(cond ? 'a.b' : 'a.c')
  for (const m of src.matchAll(new RegExp(`${call}[^'\`()]*?\\?\\s*'([\\w.]+)'\\s*:\\s*'([\\w.]+)'`, 'g'))) { used.add(m[1]); used.add(m[2]); }
  for (const m of src.matchAll(new RegExp(`${call}\`([\\w.]+)\\.\\$\\{`, 'g'))) dynamicPrefixes.add(m[1]);
  for (const m of src.matchAll(/'((?:create|videos|library|share|sharePage|about|errors|common|nav|header|categories|providers)\.[\w.]+)'/g)) used.add(m[1]);
}
console.log('\nusage (public/**/*.html, public/js/*.js)');
const enKeys = new Set(Object.keys(en));
const groupPrefixes = new Set(Object.keys(en).flatMap((k) => k.split('.').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('.'))));
let missingUsed = 0;
for (const key of [...used].sort()) {
  if (!enKeys.has(key) && !groupPrefixes.has(key)) { err(`used but missing in en.json: ${key}`); missingUsed++; }
}
for (const prefix of dynamicPrefixes) {
  if (!groupPrefixes.has(prefix)) err(`dynamic key prefix "${prefix}.*" has no group in en.json`);
}
const unused = [...enKeys].filter(
  (k) => !used.has(k) && ![...dynamicPrefixes].some((p) => k.startsWith(`${p}.`)) && !k.startsWith('errors.'),
);
if (unused.length) console.log(`  (info) ${unused.length} key(s) not referenced literally: ${unused.join(', ')}`);
if (!missingUsed) console.log(`  ${used.size} literal keys referenced, all present`);

// ---------- each language ----------
for (const lang of LANGUAGES) {
  if (lang.code === 'en') continue;
  if (only.length && !only.includes(lang.code)) continue;
  const file = path.join(I18N, `${lang.code}.json`);
  console.log(`\n${lang.code} (${lang.name})`);
  if (!fs.existsSync(file)) {
    if (strict) err(`${lang.code}.json is missing`);
    else console.log('  - not translated yet (falls back to English)');
    continue;
  }
  const raw = readJson(file);
  if (raw.__error) { err(`invalid JSON: ${raw.__error}`); continue; }
  const tr = flatten(raw);
  const required = new Intl.PluralRules(lang.locale || lang.code).resolvedOptions().pluralCategories;
  let missing = 0;
  let extra = 0;
  for (const [key, source] of Object.entries(en)) {
    if (!(key in tr)) { err(`missing: ${key}`); missing++; continue; }
    const value = tr[key];
    const srcPlural = typeof source === 'object';
    const trPlural = value && typeof value === 'object';
    if (srcPlural !== trPlural) { err(`${key}: ${srcPlural ? 'must be a plural object' : 'must be a string'}`); continue; }
    if (trPlural) {
      for (const c of required) if (!(c in value.plural)) err(`${key}: missing plural form "${c}" (needed for ${lang.code})`);
      for (const c of Object.keys(value.plural)) if (!required.includes(c) && c !== 'zero') warn(`${key}: plural form "${c}" is never used for ${lang.code}`);
      for (const [c, s] of Object.entries(value.plural)) if (typeof s !== 'string' || !s.trim()) err(`${key}.${c}: empty`);
    } else if (typeof value !== 'string') {
      err(`${key}: must be a string`);
      continue;
    } else if (!value.trim()) {
      warn(`${key}: empty string`);
    }
    const srcVars = placeholders(pluralText(source));
    const trVars = placeholders(pluralText(value));
    for (const v of trVars) if (!srcVars.has(v)) err(`${key}: unknown placeholder {${v}}`);
    for (const v of srcVars) if (!trVars.has(v) && v !== 'count') warn(`${key}: placeholder {${v}} not used`);
  }
  for (const key of Object.keys(tr)) if (!(key in en)) { err(`extra (not in en.json): ${key}`); extra++; }
  if (!missing && !extra) console.log(`  ${Object.keys(tr).length} keys — same key set as en.json`);
}

console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
