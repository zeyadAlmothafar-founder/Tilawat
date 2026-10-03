// The user's own clips. The request body is streamed straight to disk (not buffered in
// memory), probed, given a JPG thumbnail and returned as an approved library entry.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CLIP_CACHE_DIR, THUMB_CACHE_DIR } from '../../paths.js';
import { probe, runFfmpeg } from '../../lib/ffmpeg.js';
import { httpError } from '../../lib/errors.js';
import { orientationOf } from '../util.js';

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const EXTENSIONS = ['mp4', 'webm', 'mov'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const UPLOAD_ID_RE = new RegExp(`^upload:(${UUID})$`);
export const UPLOAD_FILE_RE = new RegExp(`^upload-${UUID}\\.(mp4|webm|mov)$`);

export const enabled = () => true;

function decodeFilename(header) {
  const raw = String(header || '').trim();
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function titleFrom(filename) {
  const base = path.basename(filename.replace(/\\/g, '/')).replace(/\.[^.]+$/, '');
  const clean = base.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/[_]+/g, ' ').trim().slice(0, 100);
  return clean || 'My clip';
}

export function uploadPath(entry) {
  if (!UPLOAD_FILE_RE.test(String(entry?.file))) return null;
  return path.join(CLIP_CACHE_DIR, entry.file);
}

export function uploadThumbPath(entry) {
  const m = UPLOAD_ID_RE.exec(String(entry?.id));
  return m ? path.join(THUMB_CACHE_DIR, `upload-${m[1]}.jpg`) : null;
}

/** Stream `req` into a temp file, enforcing the size limit. Resolves to bytes written. */
async function receive(req, tmp) {
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) cb(httpError(413, 'file_too_large', 'The file is larger than 500 MB'));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limit, fs.createWriteStream(tmp));
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err.expose ? err : httpError(400, 'upload_failed', 'The upload was interrupted');
  }
  return bytes;
}

async function makeThumb(file, duration, dest) {
  try {
    await runFfmpeg(['-ss', String(Math.min(1, duration / 2)), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', dest]);
    return true;
  } catch (err) {
    console.warn(`[sources] upload thumbnail failed: ${err.message}`);
    return false;
  }
}

/** Save an uploaded clip from a raw request body; resolves to a library entry (not yet persisted). */
export async function saveUpload(req, category) {
  const filename = decodeFilename(req.get('x-filename'));
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!EXTENSIONS.includes(ext)) throw httpError(400, 'invalid_file_type', 'Only .mp4, .webm and .mov files are supported');
  const type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('video/')) throw httpError(415, 'unsupported_media_type', 'Send the file with a video/* Content-Type');
  if (Number(req.get('content-length')) > MAX_UPLOAD_BYTES) throw httpError(413, 'file_too_large', 'The file is larger than 500 MB');

  const uuid = crypto.randomUUID();
  const file = `upload-${uuid}.${ext}`;
  const dest = path.join(CLIP_CACHE_DIR, file);
  const tmp = `${dest}.part`;
  await fsp.mkdir(CLIP_CACHE_DIR, { recursive: true });
  const bytes = await receive(req, tmp);
  if (!bytes) {
    await fsp.rm(tmp, { force: true });
    throw httpError(400, 'empty_upload', 'The uploaded file is empty');
  }
  await fsp.rename(tmp, dest);

  const info = await probe(dest).catch(() => null);
  if (!info?.hasVideo || !(info.duration > 0)) {
    await fsp.rm(dest, { force: true });
    throw httpError(400, 'invalid_video', 'That file does not contain a playable video');
  }
  await fsp.mkdir(THUMB_CACHE_DIR, { recursive: true });
  const hasThumb = await makeThumb(dest, info.duration, path.join(THUMB_CACHE_DIR, `upload-${uuid}.jpg`));
  return {
    id: `upload:${uuid}`,
    provider: 'upload',
    providerId: uuid,
    category,
    title: titleFrom(filename),
    tags: [],
    author: null,
    authorUrl: null,
    sourceUrl: null,
    thumbUrl: hasThumb ? `/api/library/thumb/upload-${uuid}.jpg` : null,
    previewUrl: `/api/library/clip/${encodeURIComponent(`upload:${uuid}`)}`,
    width: info.width,
    height: info.height,
    duration: Math.round(info.duration * 100) / 100,
    orientation: orientationOf(info.width, info.height),
    file,
  };
}

/** Delete an upload's clip and thumbnail files. */
export async function deleteUploadFiles(entry) {
  for (const file of [uploadPath(entry), uploadThumbPath(entry)]) {
    if (file) await fsp.rm(file, { force: true }).catch(() => {});
  }
}
