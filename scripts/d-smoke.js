#!/usr/bin/env node
// Smoke test for the sharing endpoints and the frontend's static assets.
//   node scripts/d-smoke.js [baseUrl]     (default http://localhost:4704)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[2] || 'http://localhost:4704').replace(/\/$/, '');
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { failures++; console.log(`  ✗ ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

async function get(url) {
  const res = await fetch(BASE + url);
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  return { status: res.status, type, body };
}

console.log(`Sharing API (${BASE})`);
{
  const r = await get('/api/server-info');
  const info = JSON.parse(r.body);
  check(r.status === 200, `GET /api/server-info → ${r.status}`);
  check(Number.isInteger(info.port) && Array.isArray(info.lanUrls) && 'publicBaseUrl' in info && typeof info.shareBaseUrl === 'string',
    `server-info shape ${JSON.stringify(info)}`);
  check(!info.shareBaseUrl.endsWith('/'), 'shareBaseUrl has no trailing slash');
}
{
  const r = await get(`/api/qr.svg?text=${encodeURIComponent('http://192.168.1.5:4704/v/test')}`);
  check(r.status === 200 && r.type.startsWith('image/svg+xml'), `GET /api/qr.svg → ${r.status} ${r.type}`);
  check(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(r.body) && r.body.trim().endsWith('</svg>'), 'QR body is a complete SVG document');
}
for (const [label, text] of [
  ['missing text', null],
  ['javascript: URL', 'javascript:alert(1)'],
  ['plain text', 'hello world'],
  ['1001 chars', `http://x.test/${'a'.repeat(987)}`],
]) {
  const r = await get(text == null ? '/api/qr.svg' : `/api/qr.svg?text=${encodeURIComponent(text)}`);
  let code = null;
  try { code = JSON.parse(r.body).error.code; } catch { /* not JSON */ }
  check(r.status === 400 && code === 'invalid_text', `qr.svg rejects ${label} → ${r.status} ${code}`);
}

console.log('\nPages');
{
  const r = await get('/');
  check(r.status === 200 && r.body.includes('/js/main.js'), 'GET / serves index.html');
  const v = await get('/v/abc');
  check(v.status === 200 && v.body.includes('/js/share-page.js'), 'GET /v/abc serves share.html');
}

console.log('\nStatic assets referenced by the pages and modules');
const assets = new Set(['/i18n/en.json', '/i18n/languages.js']);
for (const file of fs.readdirSync(path.join(PUBLIC, 'i18n'))) assets.add(`/i18n/${file}`);
for (const page of ['index.html', 'share.html']) {
  const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
  for (const m of html.matchAll(/(?:href|src)="(\/[^"]+)"/g)) assets.add(m[1]);
}
for (const file of fs.readdirSync(path.join(PUBLIC, 'js'))) {
  assets.add(`/js/${file}`);
  const src = fs.readFileSync(path.join(PUBLIC, 'js', file), 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'([^']+\.js)'/g)) {
    assets.add(m[1].startsWith('/') ? m[1] : `/js/${m[1].replace(/^\.\//, '')}`);
  }
}
const css = fs.readFileSync(path.join(PUBLIC, 'css', 'app.css'), 'utf8');
for (const m of css.matchAll(/url\("(\/[^"]+)"\)/g)) if (!m[1].startsWith('/fonts/')) assets.add(m[1]);

for (const url of [...assets].sort()) {
  const r = await get(url);
  check(r.status === 200, `${url} → ${r.status}`);
  if (url.endsWith('.json')) {
    try { JSON.parse(r.body); } catch (e) { fail(`${url} is not valid JSON: ${e.message}`); }
  }
}
for (const font of ['/fonts/AmiriQuran-Regular.ttf', '/fonts/ScheherazadeNew-Regular.ttf']) {
  const r = await fetch(BASE + font, { method: 'HEAD' });
  console.log(`  ${r.ok ? '✓' : '-'} ${font} → ${r.status}${r.ok ? '' : ' (optional; Google Fonts fallback is used)'}`);
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all good'}`);
process.exit(failures ? 1 : 0);
