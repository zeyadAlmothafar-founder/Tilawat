#!/usr/bin/env node
// Builds the static web version (docs/WEB.md "Build") into dist/:
//   public/** (minus share.html) → dist/, web/js/api.js → dist/js/api.js,
//   web/js/** → dist/js/web/**, web/vendor/** → dist/vendor/**, shared/** → dist/shared/**,
//   server/data/{surahs,reciters,tafsirs}.json + web/clips.json → dist/data/,
//   cache/quran/translations.json → dist/data/translations.json (offline snapshot, if present),
//   assets/fonts/** → dist/fonts/, and dist/index.html switched to <html data-mode="web">.
// No network, no FFmpeg, no dependencies (runs on Netlify with Node 22).
//
//   node web/build.js            # → dist/
//   node web/build.js --out x    # another output folder
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const DIST = path.resolve(ROOT, outArg > 0 ? process.argv[outArg + 1] : 'dist');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

if (DIST === ROOT || !DIST.startsWith(ROOT + path.sep)) throw new Error(`Refusing to build into ${DIST}`);

const started = Date.now();
let files = 0;
let bytes = 0;

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  files++;
  bytes += fs.statSync(to).size;
}

/** Copy a directory tree; `skip(relativePath)` → true leaves a file out. */
function copyDir(from, to, skip = () => false, base = from) {
  if (!fs.existsSync(from)) return false;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const r = path.relative(base, src).replace(/\\/g, '/');
    if (entry.name.startsWith('.') || skip(r, entry)) continue;
    if (entry.isDirectory()) copyDir(src, path.join(to, entry.name), skip, base);
    else if (entry.isFile()) copyFile(src, path.join(to, entry.name));
  }
  return true;
}

function writeFile(to, content) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, content);
  files++;
  bytes += Buffer.byteLength(content);
}

const warn = (msg) => console.warn(`! ${msg}`);

// ---------------------------------------------------------------------------

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. The UI (same files as the self-hosted app). The /v/:id share page needs a server.
copyDir(path.join(ROOT, 'public'), DIST, (r) => r === 'share.html' || r === 'js/share-page.js');

// 2. Web adapter + render engine (web/js/** → /js/web/**), api.js replaces the server client.
copyDir(path.join(ROOT, 'web/js'), path.join(DIST, 'js/web'), (r) => r === 'api.js');
copyFile(path.join(ROOT, 'web/js/api.js'), path.join(DIST, 'js/api.js'));
if (!fs.existsSync(path.join(ROOT, 'web/js/render/index.js'))) warn('web/js/render/index.js is missing — videos cannot be rendered');
if (!copyDir(path.join(ROOT, 'web/vendor'), path.join(DIST, 'vendor'))) warn('web/vendor/ is missing');
copyDir(path.join(ROOT, 'shared'), path.join(DIST, 'shared'));

// 3. Data.
for (const name of ['surahs.json', 'reciters.json', 'tafsirs.json']) {
  copyFile(path.join(ROOT, 'server/data', name), path.join(DIST, 'data', name));
}
const clipsFile = path.join(ROOT, 'web/clips.json');
let manifest = { version: 1, mode: null, base: null, clips: [] };
if (fs.existsSync(clipsFile)) {
  manifest = JSON.parse(fs.readFileSync(clipsFile, 'utf8'));
  copyFile(clipsFile, path.join(DIST, 'data/clips.json'));
} else {
  warn('web/clips.json is missing — videos will use a plain background');
  writeFile(path.join(DIST, 'data/clips.json'), JSON.stringify(manifest));
}
// Offline fallback for the translation list: the live server cache if present, else the
// committed snapshot (web/data/translations.json). The site fetches the live list from QuranEnc first.
const snapshot = [path.join(ROOT, 'cache/quran/translations.json'), path.join(ROOT, 'web/data/translations.json')].find((f) => fs.existsSync(f));
if (snapshot) {
  const data = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  if (Array.isArray(data?.translations)) writeFile(path.join(DIST, 'data/translations.json'), JSON.stringify({ translations: data.translations }));
}

// 4. Fonts for the renderer (same OFL files as the server renderer).
if (!copyDir(path.join(ROOT, 'assets/fonts'), path.join(DIST, 'fonts'))) warn('assets/fonts/ is missing');

// 5. index.html: web mode, and the inline boot script moved to a file (CSP: script-src 'self').
const indexFile = path.join(DIST, 'index.html');
let html = fs.readFileSync(indexFile, 'utf8');
html = html.replace(/<html\b([^>]*)>/, (m, attrs) => (/data-mode=/.test(attrs) ? m : `<html${attrs} data-mode="web">`));
const inline = /<script>([\s\S]*?)<\/script>/.exec(html);
if (inline) {
  writeFile(path.join(DIST, 'js/boot.js'), `${inline[1].trim()}\n`);
  html = html.replace(inline[0], '<script src="/js/boot.js"></script>');
}
if (/<script>/.test(html)) warn('index.html still has an inline <script> (blocked by the CSP)');
fs.writeFileSync(indexFile, html);

// 6. Check that the CSP in netlify.toml allows the clip host.
const toml = fs.existsSync(path.join(ROOT, 'netlify.toml')) ? fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8') : '';
const csp = /Content-Security-Policy\s*=\s*"([^"]+)"/.exec(toml)?.[1] || '';
const hosts = new Set();
for (const clip of manifest.clips || []) {
  for (const u of [clip.thumb, ...(clip.segments || []).map((s) => s.url)]) {
    try { hosts.add(new URL(u, manifest.base || 'https://relative.invalid/').host); } catch { /* ignore */ }
  }
}
hosts.delete('relative.invalid');
const connect = /connect-src ([^;]+)/.exec(csp)?.[1].split(/\s+/) || [];
const allowed = (host) => connect.some((src) => {
  const h = src.replace(/^https?:\/\//, '');
  return h === host || (h.startsWith('*.') && host.endsWith(h.slice(1)));
});
for (const host of hosts) if (csp && !allowed(host)) warn(`clip host ${host} is not in the CSP connect-src of netlify.toml`);

// 7. Build stamp (for support / cache debugging).
const hash = crypto.createHash('sha256').update(html).update(String(files)).digest('hex').slice(0, 10);
writeFile(path.join(DIST, 'build.json'), JSON.stringify({ builtAt: new Date().toISOString(), hash, clips: manifest.clips?.length || 0, clipMode: manifest.mode || null }, null, 1));

console.log(`web build → ${rel(DIST)}/: ${files} files, ${(bytes / 1e6).toFixed(1)} MB, ${manifest.clips?.length || 0} clips (${manifest.mode || 'none'}) in ${Date.now() - started} ms`);
