// NASA Image and Video Library (https://images.nasa.gov, no API key). Only used for
// `space`. The library is mostly briefings, interviews and captioned explainers, so only
// items matching a strict "Earth from the ISS" allow-list are used (verified by
// sampling frames). Those reels run 3–50 minutes, so each is offered as several ~30s
// segments (`nasa:<nasa_id>@<startSeconds>`); a segment is fetched by letting ffmpeg seek
// over HTTP and re-encode just that window (silent H.264), never the whole file.
import fs from 'node:fs/promises';
import { fetchJson, download } from '../../lib/http.js';
import { probe, runFfmpeg } from '../../lib/ffmpeg.js';
import { checkClip, makeMatcher, normalizeText } from '../filter.js';
import {
  DOWNLOAD_HOSTS, MEDIA_HOSTS, SEARCH_MAX_AGE, isAllowedUrl, orientationOf, safeStem, searchCacheFile, toNumber, mapLimit,
} from '../util.js';

const API = 'https://images-api.nasa.gov/search';
const ASSET_HOST = 'images-assets.nasa.gov';
const ASSET_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const POOL_MAX_AGE = 60 * 60 * 1000;
export const SEGMENT_SECONDS = 30;
const MAX_SEGMENTS = 8;

export const enabled = () => true;

export const QUERIES = [
  'earth views', 'earthviews', 'earth 4k', 'earth from space', 'hdev',
  'views from the international space station', 'ultra high definition',
];

// Title/keywords must contain one of these (ISS Earth-viewing reels).
const matchScenic = makeMatcher([
  'earth views', 'earthviews', 'earth view', 'earth from space', 'earth in 4k', 'hdev', 'earth from the iss',
  'earth from iss', 'earth from international space station', 'earth from the international space station',
]);

// …and none of these formats that show people, captions or talk.
const matchJunk = makeMatcher([
  'this week', '@nasa', 'twan', 'what s up', 'skywatching', 'science live', 'sciencecasts', 'nasa minute',
  'in a minute', 'briefing', 'conference', 'interview', 'press', 'panel', 'remarks', 'talk', 'news', 'event',
  'ceremony', 'launch', 'landing', 'liftoff', 'countdown', 'docking', 'undocking', 'spacewalk', 'eva',
  'training', 'podcast', 'live', 'livestream', 'stream', 'twitch', 'episode', 'highlights', 'explained',
  'explains', 'expert', 'tips', 'anniversary', 'overview', 'mission video', 'cleanroom', 'clean room',
  'engineer', 'scientist', 'profile', 'lecture', 'webinar', 'q&a', 'asked', 'how to', 'how can', 'what is',
  'why', 'top 5', 'top 20', 'trailer', 'teaser', 'promo', 'social', 'animation', 'infographic', 'narrated',
  'visit', 'tour', 'meeting', 'award', 'tribute', 'memorial', 'speech', 'town hall', 'b roll', 'broll',
  'video file', 'vnr', 'rocket', 'test', 'testing', 'hardware', 'logo', 'intro', 'down to earth', 'artemis',
  'apogee', 'burn', 'hurricane', 'typhoon', 'stemonstration', 'step inside', 'images of',
]);

const matchTalkDescription = makeMatcher([
  'interview', 'briefing', 'press conference', 'news conference', 'panel discussion', 'panelists', 'hosted by',
  'explains', 'discusses', 'shares how', 'shares his', 'shares her', 'talks about', 'speaks', 'answer questions',
  'q&a', 'episode', 'podcast', 'live coverage', 'webcast', 'tune in', 'narrator', 'narrated', 'sat down with',
]);

/** Re-encode an asset URL from a manifest (http, raw spaces) as a clean https URL. */
export function assetUrl(raw) {
  const m = /^https?:\/\/([^/]+)(\/[^?#]*)$/i.exec(String(raw || '').trim());
  if (!m || m[1].toLowerCase() !== ASSET_HOST) return null;
  const pathname = m[2].split('/').map((s) => {
    let decoded = s;
    try { decoded = decodeURIComponent(s); } catch { /* keep raw */ }
    return encodeURIComponent(decoded);
  }).join('/');
  return `https://${ASSET_HOST}${pathname}`;
}

/** "0:03:20" or "12.5 s" → seconds. */
export function parseDuration(value) {
  const text = String(value ?? '').trim();
  let m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(text);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = /^(\d+(?:\.\d+)?)\s*s$/.exec(text);
  return m ? Number(m[1]) : null;
}

/** Pick files from an asset manifest (array of URLs). */
export function pickAssets(manifest) {
  const urls = (Array.isArray(manifest) ? manifest : []).map(assetUrl).filter(Boolean);
  const find = (suffix) => urls.find((u) => u.toLowerCase().endsWith(suffix));
  return {
    download: find('~large.mp4') || find('~medium.mp4') || null,
    preview: find('~preview.mp4') || find('~mobile.mp4') || find('~small.mp4') || null,
    metadata: find('/metadata.json') || null,
  };
}

/** Duration and expected size of the chosen rendition (~large ≤ 1920 wide, ~medium ≤ 1280). */
export function parseMetadata(meta, downloadUrl = '') {
  if (!meta || typeof meta !== 'object') return { duration: null, width: null, height: null };
  const duration = parseDuration(meta['QuickTime:Duration']) ?? parseDuration(meta['QuickTime:TrackDuration'])
    ?? parseDuration(meta['Composite:Duration']);
  let width = toNumber(meta['QuickTime:ImageWidth']);
  let height = toNumber(meta['QuickTime:ImageHeight']);
  const size = /^(\d+)x(\d+)$/.exec(String(meta['Composite:ImageSize'] || ''));
  if ((!width || !height) && size) [width, height] = [Number(size[1]), Number(size[2])];
  if (!width || !height) return { duration, width: null, height: null };
  // Renditions fit inside 1920x1080 (~large) or 1280x720 (~medium), keeping the aspect.
  const [boxW, boxH] = downloadUrl.toLowerCase().endsWith('~medium.mp4') ? [1280, 720] : [1920, 1080];
  const scale = Math.min(1, boxW / width, boxH / height);
  const even = (n) => Math.round(n / 2) * 2;
  return { duration, width: even(width * scale), height: even(height * scale) };
}

/** First-pass filter on a search item's own metadata ({ title, keywords, description }). */
export function screenItem(data) {
  const main = normalizeText([data.title, ...(data.keywords || [])].join(' | '));
  if (!matchScenic(main)) return { ok: false, reason: 'not an Earth-view reel' };
  const junk = matchJunk(main) || matchTalkDescription(normalizeText(data.description));
  if (junk) return { ok: false, reason: `looks like "${junk}"` };
  return { ok: true };
}

/** Segment start times (seconds) for a video of `duration`; [null] = use the whole file. */
export function segmentStarts(duration) {
  if (!duration || duration <= SEGMENT_SECONDS + 15) return [null];
  const first = duration * 0.1;
  const last = duration * 0.9 - SEGMENT_SECONDS;
  const count = Math.max(1, Math.min(MAX_SEGMENTS, Math.floor((last - first) / 150) + 1));
  if (count === 1 || last <= first) return [Math.round(Math.max(0, Math.min(duration * 0.3, duration - SEGMENT_SECONDS - 2)))];
  return Array.from({ length: count }, (_, k) => Math.round(first + (k * (last - first)) / (count - 1)));
}

/** "jsc2021m000138_4K_Earth_Views_..._210422-4KMP4" → "4K Earth Views ...". */
export function cleanTitle(title) {
  const text = String(title || '')
    .replace(/^(jscm?|iss|nhq|ksc|gsfc|jpl|msfc)[\dm_]*_/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\d{6,}\b/g, '')
    .replace(/-?\b4k ?mp4\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || String(title || '');
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Build the clip(s) for one search item plus its manifest and metadata. */
export function buildClips(item, manifest, meta) {
  const data = item.data?.[0] || {};
  const assets = pickAssets(manifest);
  if (!data.nasa_id || !assets.download) return [];
  const { duration, width, height } = parseMetadata(meta, assets.download);
  const title = cleanTitle(data.title || data.nasa_id).slice(0, 160);
  return segmentStarts(duration).map((start) => {
    const providerId = start === null ? String(data.nasa_id) : `${data.nasa_id}@${start}`;
    return {
      id: `nasa:${providerId}`,
      provider: 'nasa',
      providerId,
      category: 'space',
      title: start === null ? title : `${title} · ${clock(start)}`,
      tags: (data.keywords || []).filter((k) => typeof k === 'string').slice(0, 15),
      author: data.center ? `NASA ${data.center}` : 'NASA',
      authorUrl: 'https://images.nasa.gov',
      sourceUrl: `https://images.nasa.gov/details/${encodeURIComponent(data.nasa_id)}`,
      thumbUrl: `/api/library/thumb/${safeStem('nasa', providerId)}.jpg`, // generated on demand
      previewUrl: assets.preview ? (start === null ? assets.preview : `${assets.preview}#t=${start},${start + SEGMENT_SECONDS}`) : null,
      width,
      height,
      duration: start === null ? duration : SEGMENT_SECONDS,
      orientation: orientationOf(width, height),
      downloadUrl: assets.download,
    };
  });
}

async function resolveItem(item) {
  const href = assetUrl(item.href);
  if (!href) return [];
  const manifest = await fetchJson(href, { timeoutMs: 15000, cacheFile: searchCacheFile('nasa', href), maxAgeMs: ASSET_MAX_AGE });
  const { metadata } = pickAssets(manifest);
  const meta = metadata
    ? await fetchJson(metadata, { timeoutMs: 15000, cacheFile: searchCacheFile('nasa', metadata), maxAgeMs: ASSET_MAX_AGE }).catch(() => null)
    : null;
  const description = item.data?.[0]?.description;
  return buildClips(item, manifest, meta).filter((c) => checkClip({ ...c, description }, 'space').ok);
}

async function searchItems(query) {
  const url = `${API}?${new URLSearchParams({ q: query, media_type: 'video', page_size: '100' })}`;
  const json = await fetchJson(url, { timeoutMs: 20000, cacheFile: searchCacheFile('nasa', url), maxAgeMs: SEARCH_MAX_AGE });
  return json?.collection?.items || [];
}

/** Interleave lists round-robin so consecutive clips come from different videos. */
function interleave(lists) {
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

let pool = { at: 0, promise: null };

/** All usable NASA segments (memoized for an hour; responses are cached on disk). */
export function loadPool() {
  if (pool.promise && Date.now() - pool.at < POOL_MAX_AGE) return pool.promise;
  const promise = (async () => {
    const results = await mapLimit(QUERIES, 3, searchItems);
    const byTitle = new Map();
    for (const r of results) {
      for (const item of r.ok ? r.value : []) {
        const data = item.data?.[0];
        if (!data?.nasa_id || !screenItem(data).ok) continue;
        // "X" and "X - No Music" are the same footage (audio is stripped anyway).
        const key = normalizeText(data.title).replace(/\bno music\b/, '').replace(/\s+/g, ' ').trim();
        if (!byTitle.has(key)) byTitle.set(key, item);
      }
    }
    const resolved = await mapLimit([...byTitle.values()], 4, resolveItem);
    const failed = resolved.filter((r) => !r.ok);
    if (failed.length) console.warn(`[sources] nasa: ${failed.length} item(s) failed to resolve: ${failed[0].error.message}`);
    if (!results.some((r) => r.ok)) throw results[0].error;
    return interleave(resolved.filter((r) => r.ok).map((r) => r.value));
  })();
  pool = { at: Date.now(), promise };
  promise.catch(() => { if (pool.promise === promise) pool = { at: 0, promise: null }; });
  return promise;
}

/** A page of the pool, skipping `exclude`d ids first so reviewed clips don't leave gaps. */
export async function search({ category, page = 1, perPage = 12, exclude = new Set() }) {
  if (category !== 'space') return { clips: [], hasMore: false };
  const clips = (await loadPool()).filter((c) => !exclude.has(c.id));
  const start = (page - 1) * perPage;
  return { clips: clips.slice(start, start + perPage), hasMore: start + perPage < clips.length };
}

/** Segment start encoded in a providerId ("<nasa_id>@<seconds>"), or null. */
export function segmentStart(providerId) {
  const m = /@(\d{1,6})$/.exec(String(providerId));
  return m ? Number(m[1]) : null;
}

function stripFragment(url) {
  return String(url || '').split('#')[0];
}

const inflight = new Map();

function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const job = fn().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function exists(file) {
  try {
    return (await fs.stat(file)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch a NASA clip to `dest` (resolves to `dest`). Segments are cut from the remote file
 * with ffmpeg; a short video without a segment is downloaded whole.
 */
export function fetchClip(clip, dest) {
  if (!isAllowedUrl(clip.downloadUrl, DOWNLOAD_HOSTS.nasa)) return Promise.reject(new Error('NASA download host not allowed'));
  return once(dest, async () => {
    if (await exists(dest)) return dest;
    let start = segmentStart(clip.providerId);
    if (start === null) {
      const duration = toNumber(clip.duration) || (await probe(clip.downloadUrl)).duration;
      if (duration <= SEGMENT_SECONDS + 15) return download(clip.downloadUrl, dest, { timeoutMs: 300000 });
      start = Math.round(Math.max(0, Math.min(duration * 0.3, duration - SEGMENT_SECONDS - 2)));
    }
    const tmp = `${dest}.${process.pid}.part`;
    try {
      await runFfmpeg([
        '-rw_timeout', '30000000',
        '-ss', String(start), '-i', clip.downloadUrl, '-t', String(SEGMENT_SECONDS),
        '-map', '0:v:0', '-an', '-sn', '-dn',
        '-vf', "scale='min(1920,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4', tmp,
      ], { signal: AbortSignal.timeout(300000) });
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    return dest;
  });
}

/** Grab a JPG frame for a clip/segment from its small preview rendition into `dest`. */
export function makeThumb(clip, dest) {
  const source = stripFragment(clip.previewUrl);
  if (!isAllowedUrl(source, MEDIA_HOSTS.nasa)) return Promise.reject(new Error('NASA preview host not allowed'));
  return once(dest, async () => {
    if (await exists(dest)) return dest;
    const start = segmentStart(clip.providerId);
    const at = start === null ? Math.min(5, (toNumber(clip.duration) || 10) / 2) : start + 3;
    const tmp = `${dest}.${process.pid}.part`;
    try {
      await runFfmpeg([
        '-rw_timeout', '20000000', '-ss', String(at), '-i', source,
        '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', '-f', 'image2', tmp,
      ], { signal: AbortSignal.timeout(60000) });
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    return dest;
  });
}
