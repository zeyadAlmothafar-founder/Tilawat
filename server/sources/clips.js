// Local files for clips: download (allow-listed hosts only) + probe, and thumbnails.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLIP_CACHE_DIR, THUMB_CACHE_DIR } from '../paths.js';
import { download } from '../lib/http.js';
import { probe } from '../lib/ffmpeg.js';
import { DOWNLOAD_HOSTS, isAllowedUrl, safeStem } from './util.js';
import { loadLibrary } from './library.js';
import { knownClipByStem } from './search.js';
import * as nasa from './providers/nasa.js';
import { uploadPath } from './providers/upload.js';

export const THUMB_FILE_RE = /^[A-Za-z0-9_-]{1,160}\.jpg$/;

export function clipCachePath(clip) {
  if (clip.provider === 'upload') return uploadPath(clip);
  return path.join(CLIP_CACHE_DIR, `${safeStem(clip.provider, clip.providerId)}.mp4`);
}

async function obtain(clip) {
  const dest = clipCachePath(clip);
  if (!dest) throw new Error('no local path');
  if (clip.provider === 'upload') {
    await fsp.access(dest);
    return dest;
  }
  if (clip.provider === 'nasa') return nasa.fetchClip(clip, dest);
  if (!isAllowedUrl(clip.downloadUrl, DOWNLOAD_HOSTS[clip.provider])) throw new Error('download host not allowed');
  return download(clip.downloadUrl, dest, { timeoutMs: 300000 });
}

/**
 * Make sure a clip exists locally and plays. Resolves to the pickClips() shape; rejects
 * (and deletes a broken cached download) otherwise.
 */
export async function fetchClip(clip) {
  const file = await obtain(clip);
  const info = await probe(file).catch(() => null);
  if (!info?.hasVideo || !(info.duration >= 1)) {
    if (clip.provider !== 'upload') await fsp.rm(file, { force: true });
    throw new Error('downloaded file is not a playable video');
  }
  return {
    id: clip.id,
    path: file,
    duration: Math.round(info.duration * 100) / 100,
    width: info.width,
    height: info.height,
    provider: clip.provider,
    author: clip.author ?? null,
    sourceUrl: clip.sourceUrl ?? null,
    category: clip.category,
    title: clip.title,
  };
}

function findByStem(stem) {
  const fromSearch = knownClipByStem(stem);
  if (fromSearch) return fromSearch;
  for (const entry of loadLibrary().values()) if (safeStem(entry.provider, entry.providerId) === stem) return entry;
  return null;
}

/**
 * Absolute path of a thumbnail in THUMB_CACHE_DIR, generating NASA segment thumbnails
 * on first request. Resolves to null if unknown.
 */
export async function thumbPath(file) {
  if (!THUMB_FILE_RE.test(file)) return null;
  const full = path.join(THUMB_CACHE_DIR, file);
  try {
    await fsp.access(full);
    return full;
  } catch { /* not generated yet */ }
  const stem = file.slice(0, -4);
  if (!stem.startsWith('nasa-')) return null;
  const clip = findByStem(stem);
  if (!clip || clip.provider !== 'nasa') return null;
  await fsp.mkdir(THUMB_CACHE_DIR, { recursive: true });
  return nasa.makeThumb(clip, full);
}
