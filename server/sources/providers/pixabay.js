// Pixabay video search (https://pixabay.com/api/docs/#api_search_videos).
// Pixabay's terms require caching responses for 24h, which we do on disk.
import { fetchJson } from '../../lib/http.js';
import { CATEGORIES } from '../categories.js';
import {
  DOWNLOAD_HOSTS, MEDIA_HOSTS, SEARCH_MAX_AGE, isAllowedUrl, orientationOf, searchCacheFile, titleFromSlug, toNumber,
} from '../util.js';

const API = 'https://pixabay.com/api/videos/';

const apiKey = () => (process.env.PIXABAY_API_KEY || '').trim();
export const enabled = () => Boolean(apiKey());

const usable = (r, hosts) => r && r.width > 0 && r.height > 0 && isAllowedUrl(r.url, hosts);

function titleFromTags(tags, id) {
  if (!tags.length) return `Pixabay video ${id}`;
  const text = tags.slice(0, 3).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Download rendition: "medium" is usually 1920x1080, but only 1280x720 on older videos,
 * where "large" is the 1080p one. Otherwise the biggest usable rendition.
 */
export function pickRendition(videos = {}) {
  const ok = (r) => usable(r, DOWNLOAD_HOSTS.pixabay);
  const hd = [videos.medium, videos.large].find((r) => ok(r) && Math.min(r.width, r.height) >= 1080);
  if (hd) return hd;
  return [videos.medium, videos.large, videos.small].filter(ok).sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
}

export function parseHit(hit, category) {
  if (!hit || !hit.id) return null;
  const v = hit.videos || {};
  const file = pickRendition(v);
  if (!file) return null;
  const preview = [v.tiny, v.small, v.medium].find((r) => usable(r, MEDIA_HOSTS.pixabay));
  const thumb = [v.medium?.thumbnail, v.tiny?.thumbnail, v.small?.thumbnail]
    .find((u) => isAllowedUrl(u, MEDIA_HOSTS.pixabay))
    || (/^\d+$/.test(String(hit.picture_id || '')) ? `https://i.vimeocdn.com/video/${hit.picture_id}_640x360.jpg` : null);
  const tags = String(hit.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20);
  const user = String(hit.user || 'Pixabay');
  return {
    id: `pixabay:${hit.id}`,
    provider: 'pixabay',
    providerId: String(hit.id),
    category,
    title: titleFromSlug(hit.pageURL, '') || titleFromTags(tags, hit.id),
    tags,
    author: user,
    authorUrl: hit.user_id ? `https://pixabay.com/users/${encodeURIComponent(user)}-${hit.user_id}/` : 'https://pixabay.com',
    sourceUrl: isAllowedUrl(hit.pageURL, ['pixabay.com']) ? hit.pageURL : `https://pixabay.com/videos/id-${hit.id}/`,
    thumbUrl: thumb,
    previewUrl: preview?.url || file.url,
    width: file.width,
    height: file.height,
    duration: toNumber(hit.duration),
    orientation: orientationOf(file.width, file.height),
    downloadUrl: file.url,
  };
}

/** Parse a /api/videos response → { clips, hasMore }. */
export function parseResponse(json, category, { page = 1, perPage = 15 } = {}) {
  const clips = (json?.hits || []).map((h) => parseHit(h, category)).filter(Boolean);
  return { clips, hasMore: Number(json?.totalHits) > page * perPage };
}

/** Pixabay category for a candidate page (some categories rotate between two). */
export function pixabayCategory(category, index = 0) {
  const list = CATEGORIES[category]?.pixabay || [];
  return list.length ? list[index % list.length] : '';
}

export async function search({ category, query, index = 0, providerPage = 1, perPage = 15 }) {
  if (!enabled()) return { clips: [], hasMore: false };
  const params = new URLSearchParams({
    q: query.slice(0, 100),
    safesearch: 'true',
    per_page: String(perPage),
    page: String(providerPage),
    min_width: '1080',
  });
  const pxCategory = pixabayCategory(category, index);
  if (pxCategory) params.set('category', pxCategory);
  const publicUrl = `${API}?${params}`; // the key is never part of the cache name or logs
  try {
    const json = await fetchJson(`${publicUrl}&key=${encodeURIComponent(apiKey())}`, {
      timeoutMs: 15000,
      cacheFile: searchCacheFile('pixabay', publicUrl),
      maxAgeMs: SEARCH_MAX_AGE,
    });
    return parseResponse(json, category, { page: providerPage, perPage });
  } catch (err) {
    throw new Error(`Pixabay ${err.httpStatus ? `HTTP ${err.httpStatus}` : 'request failed'} for "${query}"`);
  }
}

/** Fresh metadata (and download URL) for one video id, or null. Cached like searches. */
export async function lookup(id, category) {
  if (!enabled() || !/^\d+$/.test(String(id))) return null;
  const publicUrl = `${API}?id=${id}`;
  const json = await fetchJson(`${publicUrl}&key=${encodeURIComponent(apiKey())}`, {
    timeoutMs: 15000,
    cacheFile: searchCacheFile('pixabay', publicUrl),
    maxAgeMs: SEARCH_MAX_AGE,
  });
  return parseHit(json?.hits?.[0], category);
}
