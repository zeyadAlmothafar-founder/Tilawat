// Builds server/data/starter-library.json: a curated set of Pixabay background clips
// (links + credits only, never the video files) shipped so the app has footage out of the box.
//
//   node --env-file=.env scripts/build-starter-library.js collect
//     → searches Pixabay (needs PIXABAY_API_KEY), filters, writes tmp/starter/candidates.json
//   node scripts/build-starter-library.js sheets [perGroup=24]
//     → numbered contact sheets of the most popular candidates per orientation and category
//       (tmp/starter/sheet-<orientation>-<category>.png) for visual review
//   node --env-file=.env scripts/build-starter-library.js write <n,n,...>
//     → writes the chosen candidate numbers to server/data/starter-library.json
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TMP_DIR } from '../server/paths.js';
import { download } from '../server/lib/http.js';
import { runFfmpeg } from '../server/lib/ffmpeg.js';
import { CATEGORIES, CATEGORY_IDS } from '../server/sources/categories.js';
import { checkClip } from '../server/sources/filter.js';
import * as pixabay from '../server/sources/providers/pixabay.js';

const OUT = path.join(TMP_DIR, 'starter');
const CANDIDATES = path.join(OUT, 'candidates.json');
const STARTER = path.join(ROOT, 'server', 'data', 'starter-library.json');
const MIN_SECONDS = 8;
const PAUSE_MS = 700; // stays under Pixabay's 100 requests/minute
const PER_SHEET = 24;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const orientation = (c) => (c.height > c.width ? 'portrait' : 'landscape');

async function collect() {
  if (!pixabay.enabled()) throw new Error('PIXABAY_API_KEY is not set (run with --env-file=.env)');
  const found = new Map();
  for (const category of CATEGORY_IDS) {
    const queries = CATEGORIES[category].queries.flatMap((q) => [q, `${q} vertical`]);
    for (const [index, query] of queries.entries()) {
      for (const providerPage of [1, 2]) {
        let result;
        try {
          result = await pixabay.search({ category, query, index, providerPage, perPage: 50 });
        } catch (err) {
          console.warn(`  ${err.message}`);
          break;
        }
        for (const clip of result.clips) {
          if (found.has(clip.id) || !(clip.duration >= MIN_SECONDS) || !checkClip(clip, category).ok) continue;
          found.set(clip.id, { ...clip, query });
        }
        await sleep(PAUSE_MS);
        if (!result.hasMore) break;
      }
    }
    console.log(`${category}: ${[...found.values()].filter((c) => c.category === category).length} candidates`);
  }

  const list = [...found.values()].sort((a, b) => orientation(a).localeCompare(orientation(b)) || a.category.localeCompare(b.category));
  list.forEach((c, i) => { c.n = i + 1; });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(CANDIDATES, JSON.stringify(list, null, 2));
  for (const o of ['portrait', 'landscape']) console.log(`${o}: ${list.filter((c) => orientation(c) === o).length} candidates`);
}

/** Round-robin across the search queries so one subject (e.g. ocean waves) doesn't dominate. */
function varied(clips) {
  const byQuery = new Map();
  for (const c of clips) {
    const key = c.query.replace(/ vertical$/, '');
    byQuery.set(key, [...(byQuery.get(key) || []), c]);
  }
  const lists = [...byQuery.values()];
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

/** Search results come back most-popular first, so the first per group are the best bets. */
async function sheets(perGroup) {
  const list = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8'));
  for (const o of ['portrait', 'landscape']) {
    for (const category of CATEGORY_IDS) {
      const group = varied(list.filter((c) => orientation(c) === o && c.category === category)).slice(0, perGroup);
      if (group.length) await sheet(group, `${o}-${category}`);
    }
  }
}

/** A labelled contact sheet of thumbnails (6 per row). */
async function sheet(clips, name) {
  const dir = path.join(OUT, `tiles-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const font = path.relative(ROOT, path.join(ROOT, 'assets', 'fonts', 'NotoSans-Regular.ttf')).replaceAll('\\', '/');
  let i = 0;
  for (const c of clips) {
    const thumb = path.join(OUT, 'thumbs', `${c.providerId}.jpg`);
    try {
      await download(c.thumbUrl, thumb);
    } catch {
      continue;
    }
    const label = `${c.n} ${c.category} ${Math.round(c.duration)}s`;
    await runFfmpeg([
      '-i', path.relative(ROOT, thumb),
      '-vf', `scale=320:320:force_original_aspect_ratio=decrease,pad=320:340:(ow-iw)/2:0:black,drawtext=fontfile=${font}:text='${label}':x=6:y=318:fontsize=16:fontcolor=white`,
      '-frames:v', '1', path.relative(ROOT, path.join(dir, `t${String(++i).padStart(3, '0')}.png`)),
    ], { cwd: ROOT });
  }
  if (!i) return;
  const rows = Math.ceil(i / 6);
  await runFfmpeg(['-i', path.relative(ROOT, path.join(dir, 't%03d.png')), '-vf', `tile=6x${rows}:padding=4`, '-frames:v', '1',
    path.relative(ROOT, path.join(OUT, `sheet-${name}.png`))], { cwd: ROOT });
  console.log(`  sheet-${name}.png (${i} clips)`);
}

function write(numbers) {
  const wanted = new Set(numbers.split(',').map((n) => Number(n.trim())).filter(Boolean));
  const list = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8')).filter((c) => wanted.has(c.n));
  const clips = list.map(({ n, query, ...c }) => ({ ...c, addedAt: new Date().toISOString() }));
  fs.writeFileSync(STARTER, `${JSON.stringify({ version: 1, source: 'Pixabay (https://pixabay.com/service/license-summary/)', clips }, null, 2)}\n`);
  const count = (o) => clips.filter((c) => orientation(c) === o).length;
  console.log(`wrote ${clips.length} clips (${count('portrait')} portrait, ${count('landscape')} landscape) to ${path.relative(ROOT, STARTER)}`);
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'collect') await collect();
else if (mode === 'sheets') await sheets(Number(arg) || PER_SHEET);
else if (mode === 'write' && arg) write(arg);
else console.log('usage: build-starter-library.js collect | sheets [perGroup] | write <n,n,...>');
