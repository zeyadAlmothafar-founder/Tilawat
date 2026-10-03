// Request validation for the library endpoints. An approved clip is taken from the
// server's own candidate memory when possible; otherwise the client's copy is accepted
// only with allow-listed hosts and sanitized fields.
import { httpError } from '../lib/errors.js';
import { isCategory } from './categories.js';
import { knownClip } from './search.js';
import { getEntry } from './library.js';
import {
  DOWNLOAD_HOSTS, MEDIA_HOSTS, PAGE_HOSTS, isAllowedUrl, orientationOf, safeStem, toNumber,
} from './util.js';
import { UPLOAD_ID_RE } from './providers/upload.js';

const ID_RE = /^(pexels|pixabay|nasa|upload):(.{1,200})$/s;
const PROVIDER_ID_RE = {
  pexels: /^\d{1,15}$/,
  pixabay: /^\d{1,15}$/,
  nasa: /^[^\u0000-\u001f\u007f]{1,200}$/,
};
const LOCAL_THUMB_RE = /^\/api\/library\/thumb\/[A-Za-z0-9_-]{1,160}\.jpg$/;

export function requireCategory(value) {
  if (!isCategory(value)) throw httpError(400, 'invalid_category', 'category must be one of nature, space, mosque, islamic');
  return value;
}

/** Split and validate a clip id → { id, provider, providerId }. */
export function parseClipId(value) {
  const m = ID_RE.exec(String(value ?? ''));
  if (!m) throw httpError(400, 'invalid_clip_id', 'Unknown clip id');
  const [, provider, providerId] = m;
  if (provider === 'upload' ? !UPLOAD_ID_RE.test(m[0]) : !PROVIDER_ID_RE[provider].test(providerId)) {
    throw httpError(400, 'invalid_clip_id', 'Unknown clip id');
  }
  return { id: m[0], provider, providerId };
}

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const number = (v, max) => {
  const n = toNumber(v);
  return n && n <= max ? n : null;
};

function mediaUrl(url, provider) {
  const base = String(url || '').split('#')[0];
  return isAllowedUrl(base, MEDIA_HOSTS[provider]) ? String(url) : null;
}

/** Build a trustworthy clip from an approve request body. */
export function clipForApproval(body) {
  if (!body || typeof body !== 'object') throw httpError(400, 'invalid_clip', 'Expected a clip object');
  const { id, provider, providerId } = parseClipId(body.id);
  if (body.provider && body.provider !== provider) throw httpError(400, 'invalid_clip', 'provider does not match id');
  const category = requireCategory(body.category);

  const existing = getEntry(id);
  if (provider === 'upload') {
    if (!existing) throw httpError(404, 'clip_not_found', 'Upload a file to add your own clip');
    return { ...existing, category };
  }
  const trusted = knownClip(id) || existing;
  if (trusted?.downloadUrl) return { ...trusted, category };

  // Unknown to this server (e.g. after a restart): accept only safe, allow-listed fields.
  if (!isAllowedUrl(body.downloadUrl, DOWNLOAD_HOSTS[provider])) {
    throw httpError(400, 'invalid_clip', 'downloadUrl must point to the provider\'s own servers');
  }
  const width = number(body.width, 10000);
  const height = number(body.height, 10000);
  const defaults = { pexels: 'https://www.pexels.com', pixabay: 'https://pixabay.com', nasa: 'https://images.nasa.gov' };
  const thumbUrl = provider === 'nasa'
    ? `/api/library/thumb/${safeStem('nasa', providerId)}.jpg`
    : (LOCAL_THUMB_RE.test(String(body.thumbUrl)) ? body.thumbUrl : mediaUrl(body.thumbUrl, provider));
  return {
    id,
    provider,
    providerId,
    category,
    title: text(body.title, 200) || id,
    tags: (Array.isArray(body.tags) ? body.tags : []).map((t) => text(t, 50)).filter(Boolean).slice(0, 20),
    author: text(body.author, 100) || (provider === 'nasa' ? 'NASA' : null),
    authorUrl: isAllowedUrl(body.authorUrl, PAGE_HOSTS[provider]) ? body.authorUrl : defaults[provider],
    sourceUrl: isAllowedUrl(body.sourceUrl, PAGE_HOSTS[provider]) ? body.sourceUrl : defaults[provider],
    thumbUrl,
    previewUrl: mediaUrl(body.previewUrl, provider),
    width,
    height,
    duration: number(body.duration, 36000),
    orientation: orientationOf(width, height),
    downloadUrl: body.downloadUrl,
  };
}
