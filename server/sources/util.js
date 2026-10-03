import crypto from 'node:crypto';
import path from 'node:path';
import { CACHE_DIR } from '../paths.js';

export const SEARCH_MAX_AGE = 24 * 60 * 60 * 1000;

// Hosts the server may download clip files from (the providers' own CDNs). Checked for
// every download, so a client can never make the server fetch from an arbitrary host.
export const DOWNLOAD_HOSTS = {
  pexels: ['videos.pexels.com', 'player.vimeo.com'],
  pixabay: ['cdn.pixabay.com', 'player.vimeo.com'],
  nasa: ['images-assets.nasa.gov'],
};

// Hosts allowed for thumbnails / previews shown in the browser.
export const MEDIA_HOSTS = {
  pexels: ['images.pexels.com', 'static-videos.pexels.com', 'videos.pexels.com', 'player.vimeo.com', 'i.vimeocdn.com'],
  pixabay: ['cdn.pixabay.com', 'pixabay.com', 'i.vimeocdn.com', 'player.vimeo.com'],
  nasa: ['images-assets.nasa.gov'],
};

// Hosts allowed for credit links (source page / author page).
export const PAGE_HOSTS = {
  pexels: ['www.pexels.com', 'pexels.com'],
  pixabay: ['pixabay.com'],
  nasa: ['images.nasa.gov', 'www.nasa.gov'],
};

/** True if `url` is an https URL whose host is exactly one of `hosts`. */
export function isAllowedUrl(url, hosts = []) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hosts.includes(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function orientationOf(width, height) {
  if (!width || !height) return 'landscape';
  const ratio = width / height;
  if (ratio > 1.1) return 'landscape';
  if (ratio < 0.9) return 'portrait';
  return 'square';
}

/** On-disk cache path for a provider search URL (the API key is never part of the URL hashed). */
export function searchCacheFile(provider, url) {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 20);
  return path.join(CACHE_DIR, 'search', provider, `${hash}.json`);
}

/** Readable title from a page URL slug: /video/aerial-view-of-waves-123/ → "Aerial view of waves". */
export function titleFromSlug(url, fallback = '') {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const slug = segments[segments.length - 1] || '';
    const words = decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\b(id )?\d+$/, '').trim();
    if (!words || /^\d+$/.test(words)) return fallback;
    return words.charAt(0).toUpperCase() + words.slice(1);
  } catch {
    return fallback;
  }
}

export function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** A clip id / filename-safe stem: "nasa:Earth Views" → "nasa-Earth_Views-1a2b3c4d". */
export function safeStem(provider, providerId) {
  const id = String(providerId);
  const clean = id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
  if (clean === id) return `${provider}-${id}`;
  const hash = crypto.createHash('sha1').update(id).digest('hex').slice(0, 8);
  return `${provider}-${clean}-${hash}`;
}

/** Shuffle a copy of an array (Fisher–Yates). */
export function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Run `fn` over items with at most `limit` in flight; resolves when all settle. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
