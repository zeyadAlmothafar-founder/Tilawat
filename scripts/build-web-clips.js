// Builds the background-clip set for the web version (docs/WEB.md, "Clip manifest").
//
//   node scripts/build-web-clips.js [--force] [--only=<id,id>] [--jobs=2]
//     → for every starter clip (server/data/starter-library.json): download the HD rendition
//       into cache/clips/ (reused when present), cut 1–2 short segments with FFmpeg at 1080p
//       and 720p in the clip's own orientation, plus a JPEG thumbnail:
//         tmp/web-clips/segments/<id>-a-1080.mp4, <id>-a-720.mp4, <id>-b-1080.mp4, …
//         tmp/web-clips/thumbs/<id>.jpg
//       verifies every file with ffprobe and writes the r2-mode manifest to
//       tmp/web-clips/clips.r2.json (web/clips.json is written by scripts/upload-r2.js
//       once the files are on R2).
//
//   node scripts/build-web-clips.js --mode pixabay-direct
//     → writes web/clips.json pointing straight at Pixabay's CDN renditions
//       (small → "1080", tiny → "720"), so the web app works before R2 exists.
//
// Needs PIXABAY_API_KEY (read from .env automatically) for fresh download URLs; without it
// the stored starter-library links are used (pixabay-direct mode requires the key).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, TMP_DIR, CLIP_CACHE_DIR } from '../server/paths.js';
import { download, fetchJson } from '../server/lib/http.js';
import { runFfmpeg, FFPROBE } from '../server/lib/ffmpeg.js';
import { pickRendition } from '../server/sources/providers/pixabay.js';
import { DOWNLOAD_HOSTS, MEDIA_HOSTS, SEARCH_MAX_AGE, isAllowedUrl, searchCacheFile } from '../server/sources/util.js';

try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env */ }

const execFileP = promisify(execFile);

export const STARTER = path.join(ROOT, 'server', 'data', 'starter-library.json');
export const OUT_DIR = path.join(TMP_DIR, 'web-clips');
export const SEG_DIR = path.join(OUT_DIR, 'segments');
export const THUMB_DIR = path.join(OUT_DIR, 'thumbs');
export const R2_MANIFEST = path.join(OUT_DIR, 'clips.r2.json');
export const WEB_MANIFEST = path.join(ROOT, 'web', 'clips.json');

const SEG_SECONDS = 8;
const TWO_SEGMENTS_MIN = 18; // shorter clips get one segment
const EDGE = 0.1; // skip the first/last 10 % when there is room
const FPS = 30;
const SIZES = {
  portrait: { 1080: [1080, 1920], 720: [720, 1280] },
  landscape: { 1080: [1920, 1080], 720: [1280, 720] },
};
// CRF with a VBV cap: clean where the footage is easy, capped where it is busy.
const RATE = {
  1080: { crf: 26, maxrate: '2500k', bufsize: '5000k' },
  720: { crf: 26, maxrate: '1200k', bufsize: '2400k' },
};
const THUMB_LONG = 480;
// Baked-in letterbox bars to remove before scaling (checked by eye: an automatic cropdetect
// would also eat the dark sky of the space/night clips, so this is an explicit list).
const PRE_CROP = {
  732: 'crop=1280:536:0:98', // 2.39:1 film inside a 1280x720 frame
};
const preCrop = (clip) => (PRE_CROP[clip.providerId] ? `${PRE_CROP[clip.providerId]},` : '');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback = null) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1] ?? fallback;
};

const apiKey = () => (process.env.PIXABAY_API_KEY || '').trim();
const mb = (bytes) => (bytes / 1e6).toFixed(1);
const round2 = (n) => Math.round(n * 100) / 100;

function loadStarter() {
  const lib = JSON.parse(fs.readFileSync(STARTER, 'utf8'));
  return lib.clips.filter((c) => c.provider === 'pixabay' && /^\d+$/.test(c.providerId));
}

/** Raw Pixabay API hit for one id (shares the server's 24 h on-disk cache; the key never appears in logs). */
async function apiHit(id) {
  if (!apiKey()) return null;
  const publicUrl = `https://pixabay.com/api/videos/?id=${id}`;
  const json = await fetchJson(`${publicUrl}&key=${encodeURIComponent(apiKey())}`, {
    timeoutMs: 15000,
    cacheFile: searchCacheFile('pixabay', publicUrl),
    maxAgeMs: SEARCH_MAX_AGE,
  });
  return json?.hits?.[0] || null;
}

function credits(clip) {
  return {
    id: clip.id,
    provider: clip.provider,
    category: clip.category,
    orientation: clip.orientation,
    title: clip.title,
    author: clip.author,
    authorUrl: clip.authorUrl,
    sourceUrl: clip.sourceUrl,
  };
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

/* ------------------------------------------------------------------ pixabay-direct */

async function buildDirect() {
  if (!apiKey()) throw new Error('PIXABAY_API_KEY is missing (put it in .env) — needed for --mode pixabay-direct.');
  const clips = [];
  for (const clip of loadStarter()) {
    const hit = await apiHit(clip.providerId).catch((err) => {
      console.warn(`  ${clip.id}: API lookup failed (${err.httpStatus || err.message})`);
      return null;
    });
    if (!hit) { console.warn(`  ${clip.id}: skipped (not available on Pixabay)`); continue; }
    const v = hit.videos || {};
    const ok = (r) => r && r.width > 0 && r.height > 0 && isAllowedUrl(r.url, MEDIA_HOSTS.pixabay);
    const seg = (res, r) => ({ res, url: r.url, width: r.width, height: r.height, duration: Number(hit.duration) || clip.duration });
    const segments = [];
    const hi = [v.small, v.medium, v.tiny].find(ok);
    const lo = [v.tiny, v.small].find(ok);
    if (hi) segments.push(seg('1080', hi));
    if (lo) segments.push(seg('720', lo));
    if (!segments.length) { console.warn(`  ${clip.id}: skipped (no usable rendition)`); continue; }
    const thumb = [v.medium?.thumbnail, v.small?.thumbnail, v.tiny?.thumbnail].find((u) => isAllowedUrl(u, MEDIA_HOSTS.pixabay)) || clip.thumbUrl;
    clips.push({ ...credits(clip), thumb, segments });
  }
  const manifest = { version: 1, mode: 'pixabay-direct', base: null, generatedAt: new Date().toISOString(), clips };
  await writeJson(WEB_MANIFEST, manifest);
  const portrait = clips.filter((c) => c.orientation === 'portrait').length;
  console.log(`Wrote ${path.relative(ROOT, WEB_MANIFEST)}: ${clips.length} clips (${portrait} portrait, ${clips.length - portrait} landscape), pixabay-direct.`);
}

/* ------------------------------------------------------------------ probing */

/** Top-level MP4 box types in file order (to check that moov comes before mdat). */
export function topLevelBoxes(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    const types = [];
    let pos = 0;
    while (pos + 8 <= size && types.length < 64) {
      fs.readSync(fd, head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      else if (len === 0) len = size - pos;
      if (len < 8) break;
      types.push(type);
      pos += len;
    }
    return types;
  } finally {
    fs.closeSync(fd);
  }
}

async function ffprobe(file) {
  const { stdout } = await execFileP(FFPROBE, [
    '-v', 'error', '-show_entries',
    'format=duration,size:stream=codec_type,codec_name,profile,pix_fmt,width,height,avg_frame_rate,nb_frames',
    '-of', 'json', file,
  ], { windowsHide: true });
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video') || {};
  return {
    duration: Number(info.format?.duration) || 0,
    size: Number(info.format?.size) || 0,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    codec: video.codec_name,
    profile: video.profile,
    pixFmt: video.pix_fmt,
    width: video.width || 0,
    height: video.height || 0,
    fps: video.avg_frame_rate,
  };
}

/** Throws unless `file` is exactly the segment we want. Returns its probe info. */
async function verifySegment(file, width, height, expectedDuration) {
  const p = await ffprobe(file);
  const problems = [];
  if (p.width !== width || p.height !== height) problems.push(`size ${p.width}x${p.height}`);
  if (p.hasAudio) problems.push('has audio');
  if (p.codec !== 'h264' || p.profile !== 'High') problems.push(`codec ${p.codec}/${p.profile}`);
  if (p.pixFmt !== 'yuv420p') problems.push(`pix_fmt ${p.pixFmt}`);
  if (p.fps !== `${FPS}/1`) problems.push(`fps ${p.fps}`);
  if (Math.abs(p.duration - expectedDuration) > 0.15) problems.push(`duration ${p.duration.toFixed(2)} (want ${expectedDuration.toFixed(2)})`);
  const boxes = topLevelBoxes(file);
  if (!(boxes.indexOf('moov') >= 0 && boxes.indexOf('moov') < boxes.indexOf('mdat'))) problems.push(`not faststart (${boxes.join(',')})`);
  if (problems.length) throw new Error(`${path.basename(file)}: ${problems.join('; ')}`);
  return p;
}

/* ------------------------------------------------------------------ segments */

/** Segment windows [start, length] for a clip of `duration` seconds. */
export function planSegments(duration) {
  const len = Math.min(SEG_SECONDS, duration);
  if (duration < TWO_SEGMENTS_MIN) {
    // one segment around the middle, kept off the edges when the clip is long enough
    const lo = duration - 2 * EDGE * duration >= len ? EDGE * duration : 0;
    const start = Math.max(lo, (duration - len) / 2);
    return [[round2(start), len]];
  }
  const lo = EDGE * duration;
  const hi = duration - EDGE * duration;
  const at = (center) => round2(Math.min(hi - len, Math.max(lo, center - len / 2)));
  return [[at(duration * 0.3), len], [at(duration * 0.7), len]];
}

const segName = (id, part, res) => `${id}-${part}-${res}.mp4`;

async function sourceFile(clip) {
  const dest = path.join(CLIP_CACHE_DIR, `pixabay-${clip.providerId}.mp4`);
  try {
    if ((await fsp.stat(dest)).size > 0) return dest;
  } catch { /* not cached */ }
  let url = clip.downloadUrl;
  const hit = await apiHit(clip.providerId).catch(() => null);
  const fresh = hit && pickRendition(hit.videos);
  if (fresh?.url) url = fresh.url;
  if (!isAllowedUrl(url, DOWNLOAD_HOSTS.pixabay)) throw new Error('download host not allowed');
  console.log(`  ${clip.id}: downloading…`);
  try {
    return await download(url, dest, { timeoutMs: 600000 });
  } catch (err) {
    if (url === clip.downloadUrl) throw err;
    return download(clip.downloadUrl, dest, { timeoutMs: 600000 });
  }
}

async function encodeSegment(src, clip, part, start, len, force) {
  const sizes = SIZES[clip.orientation === 'portrait' ? 'portrait' : 'landscape'];
  const outs = ['1080', '720'].map((res) => ({ res, file: path.join(SEG_DIR, segName(clip.providerId, part, res)), w: sizes[res][0], h: sizes[res][1] }));
  if (!force) {
    try {
      return await Promise.all(outs.map(async (o) => ({ ...o, info: await verifySegment(o.file, o.w, o.h, len) })));
    } catch { /* (re)build */ }
  }
  const chains = outs.map((o, i) => `[s${i}]scale=${o.w}:${o.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${o.w}:${o.h},setsar=1,hqdn3d=2:2:6:6,format=yuv420p[v${i}]`);
  const graph = `[0:v]${preCrop(clip)}fps=${FPS},split=2[s0][s1];${chains.join(';')}`;
  const outArgs = outs.flatMap((o, i) => [
    '-map', `[v${i}]`, '-an', '-sn', '-dn', '-map_metadata', '-1',
    '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-crf', String(RATE[o.res].crf), '-maxrate', RATE[o.res].maxrate, '-bufsize', RATE[o.res].bufsize,
    '-g', String(FPS * 2), '-keyint_min', String(FPS * 2), '-sc_threshold', '0',
    '-r', String(FPS), '-t', String(len), '-movflags', '+faststart', '-tag:v', 'avc1', o.file,
  ]);
  await runFfmpeg(['-ss', String(start), '-t', String(len), '-i', src, '-filter_complex', graph, ...outArgs]);
  return Promise.all(outs.map(async (o) => ({ ...o, info: await verifySegment(o.file, o.w, o.h, len) })));
}

async function makeThumb(src, clip, at, force) {
  const file = path.join(THUMB_DIR, `${clip.providerId}.jpg`);
  if (!force && fs.existsSync(file)) return file;
  const [w, h] = clip.orientation === 'portrait' ? [Math.round(THUMB_LONG * 9 / 16), THUMB_LONG] : [THUMB_LONG, Math.round(THUMB_LONG * 9 / 16)];
  await runFfmpeg(['-ss', String(at), '-i', src, '-frames:v', '1',
    '-vf', `${preCrop(clip)}scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1`,
    '-q:v', '4', file]);
  return file;
}

async function buildClip(clip, force) {
  const src = await sourceFile(clip);
  const srcInfo = await ffprobe(src);
  if (!(srcInfo.duration > 1)) throw new Error('source is not a playable video');
  const plan = planSegments(srcInfo.duration);
  const segments = [];
  for (const [i, [start, len]] of plan.entries()) {
    const part = 'ab'[i];
    const outs = await encodeSegment(src, clip, part, start, len, force);
    for (const o of outs) {
      segments.push({ res: o.res, part, url: `segments/${path.basename(o.file)}`, width: o.w, height: o.h, duration: round2(o.info.duration), bytes: o.info.size });
    }
  }
  const [s0, l0] = plan[0];
  await makeThumb(src, clip, s0 + l0 / 2, force);
  console.log(`  ${clip.id} (${clip.orientation}, src ${srcInfo.width}x${srcInfo.height} ${srcInfo.duration.toFixed(1)}s): ${plan.length} segment(s) ${segments.map((s) => `${s.part}${s.res}=${mb(s.bytes)}MB`).join(' ')}`);
  return { ...credits(clip), thumb: `thumbs/${clip.providerId}.jpg`, segments };
}

async function buildR2() {
  const force = flag('force');
  const only = (option('only') || '').split(',').map((s) => s.trim().replace(/^pixabay:/, '')).filter(Boolean);
  const jobs = Math.max(1, Number(option('jobs', 2)) || 2);
  await fsp.mkdir(SEG_DIR, { recursive: true });
  await fsp.mkdir(THUMB_DIR, { recursive: true });
  if (!apiKey()) console.warn('PIXABAY_API_KEY not set — using the stored starter-library download links.');

  const starter = loadStarter().filter((c) => !only.length || only.includes(c.providerId));
  const results = new Array(starter.length);
  const failures = [];
  let next = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < starter.length) {
      const i = next++;
      try {
        results[i] = await buildClip(starter[i], force);
      } catch (err) {
        failures.push(`${starter[i].id}: ${err.message}`);
        console.error(`  ${starter[i].id}: FAILED — ${err.message}`);
      }
    }
  }));

  const clips = results.filter(Boolean);
  const segs = clips.flatMap((c) => c.segments);
  const sum = (res) => segs.filter((s) => s.res === res).reduce((n, s) => n + s.bytes, 0);
  const count = (res) => segs.filter((s) => s.res === res).length;
  const thumbsBytes = clips.reduce((n, c) => n + fs.statSync(path.join(OUT_DIR, c.thumb)).size, 0);

  const manifest = {
    version: 1,
    mode: 'r2',
    base: (process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, '') || null,
    generatedAt: new Date().toISOString(),
    clips: clips.map((c) => ({ ...c, segments: c.segments.map(({ bytes, ...s }) => s) })),
  };
  if (!only.length) await writeJson(R2_MANIFEST, manifest);

  const n1080 = count('1080');
  const n720 = count('720');
  console.log(`\n${clips.length}/${starter.length} clips in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(`1080: ${n1080} segments, ${mb(sum('1080'))} MB (avg ${mb(sum('1080') / (n1080 || 1))} MB)`);
  console.log(` 720: ${n720} segments, ${mb(sum('720'))} MB (avg ${mb(sum('720') / (n720 || 1))} MB)`);
  console.log(`thumbs: ${clips.length}, ${mb(thumbsBytes)} MB`);
  if (!only.length) console.log(`r2 manifest → ${path.relative(ROOT, R2_MANIFEST)} (upload with: node scripts/upload-r2.js)`);
  if (failures.length) {
    console.error(`\n${failures.length} failure(s):\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  }
}

const mode = option('mode', 'r2');
if (mode === 'pixabay-direct') await buildDirect();
else if (mode === 'r2') await buildR2();
else {
  console.error(`Unknown --mode "${mode}" (use r2 or pixabay-direct)`);
  process.exitCode = 2;
}
