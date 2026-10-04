#!/usr/bin/env node
// Test server for the browser renderer (W1). No dependencies.
//
//   node scripts/web-test-server.js            → http://localhost:4710/test/render.html
//
// Serves the same URL layout as dist/ (so module-relative URLs behave identically):
//   /js/web/render/*  → web/js/render/*
//   /js/web/*         → web/js/*            (W2's modules, when present)
//   /vendor/*         → web/vendor/*
//   /fonts/*          → assets/fonts/*
//   /data/*           → server/data/*       (surahs, reciters, tafsirs, starter-library)
//   /test/*           → web/test/*
//   /clips/*          → tmp/web-clips/*     (W3's pre-cut R2 segments, when present)
// and accepts POST /__save?name=x.mp4 (raw body) → tmp/web-test/x.mp4, so renders can be
// inspected with ffprobe/ffmpeg.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4710;
const OUT_DIR = path.join(ROOT, 'tmp', 'web-test');

const ROUTES = [
  ['/js/web/render/', 'web/js/render/'],
  ['/js/web/', 'web/js/'],
  ['/vendor/', 'web/vendor/'],
  ['/fonts/', 'assets/fonts/'],
  ['/data/', 'server/data/'],
  ['/test/', 'web/test/'],
  ['/clips/', 'tmp/web-clips/'], // W3's pre-cut segments + clips.r2.json (R2 layout)
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function resolve(urlPath) {
  for (const [prefix, dir] of ROUTES) {
    if (!urlPath.startsWith(prefix)) continue;
    const rel = decodeURIComponent(urlPath.slice(prefix.length));
    const base = path.join(ROOT, dir);
    const file = path.resolve(base, rel);
    if (!file.startsWith(base)) return null;
    return file;
  }
  // Saved outputs, for viewing in the browser.
  if (urlPath.startsWith('/out/')) {
    const file = path.resolve(OUT_DIR, decodeURIComponent(urlPath.slice(5)));
    return file.startsWith(OUT_DIR) ? file : null;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'POST' && url.pathname === '/__save') {
      const name = path.basename(url.searchParams.get('name') || 'out.bin').replace(/[^\w.\-]/g, '_');
      await fsp.mkdir(OUT_DIR, { recursive: true });
      const file = path.join(OUT_DIR, name);
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await fsp.writeFile(file, Buffer.concat(chunks));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, file, bytes: Buffer.concat(chunks).length }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__log') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await fsp.mkdir(OUT_DIR, { recursive: true });
      await fsp.appendFile(path.join(OUT_DIR, 'log.txt'), Buffer.concat(chunks).toString('utf8') + '\n');
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/test' || url.pathname === '/test/') {
      res.writeHead(302, { Location: '/test/render.html' }).end();
      return;
    }
    const file = resolve(url.pathname);
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(500).end(String(err?.message || err));
  }
});

server.listen(PORT, () => console.log(`[web-test] http://localhost:${PORT}/test/render.html  (outputs → ${OUT_DIR})`));
