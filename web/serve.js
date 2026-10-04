#!/usr/bin/env node
// Tiny static server for dist/ that applies the [[headers]] of netlify.toml (so the CSP and
// cache rules are tested locally). No dependencies.
//
//   node web/build.js && node web/serve.js          # http://localhost:4711
//   PORT=5000 node web/serve.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 4711;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.wasm': 'application/wasm',
};

/** [{ for: '/fonts/*', values: { 'Cache-Control': '…' } }] from netlify.toml. */
function readHeaderRules() {
  const file = path.join(ROOT, 'netlify.toml');
  if (!fs.existsSync(file)) return [];
  const rules = [];
  let current = null;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '[[headers]]') { current = { for: null, values: {} }; rules.push(current); continue; }
    if (/^\[/.test(line) && line !== '[headers.values]') { current = null; continue; }
    const m = /^([\w-]+)\s*=\s*"(.*)"$/.exec(line);
    if (!current || !m) continue;
    if (m[1] === 'for') current.for = m[2];
    else current.values[m[1]] = m[2];
  }
  return rules.filter((r) => r.for);
}

const matches = (pattern, url) => (pattern.endsWith('*') ? url.startsWith(pattern.slice(0, -1)) : url === pattern);

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(DIST, url);
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  const servedPath = path.relative(DIST, file).replace(/\\/g, '/');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
  const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' };
  for (const rule of readHeaderRules()) {
    if (matches(rule.for, url) || matches(rule.for, `/${servedPath}`)) Object.assign(headers, rule.values);
  }
  delete headers['Strict-Transport-Security']; // plain http locally
  headers['Content-Security-Policy'] = headers['Content-Security-Policy']?.replace(/;\s*upgrade-insecure-requests/, '');
  if (!headers['Content-Security-Policy']) delete headers['Content-Security-Policy'];
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => console.log(`dist/ on http://localhost:${PORT}`));
