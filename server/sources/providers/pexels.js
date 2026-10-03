// Pexels video search (https://www.pexels.com/api/documentation/#videos-search).
// Rate limit is 200 requests/hour, so search responses are cached on disk for 24h.
import { fetchJson } from '../../lib/http.js';
import {
  DOWNLOAD_HOSTS, MEDIA_HOSTS, SEARCH_MAX_AGE, isAllowedUrl, orientationOf, searchCacheFile, titleFromSlug, toNumber,
} from '../util.js';

const API = 'https://api.pexels.com/v1/videos/search';

const apiKey = () => (process.env.PEXELS_API_KEY || '').trim();
export const enabled = () => Boolean(apiKey());

const shortSide = (f) => Math.min(f.width, f.height);
const area = (f) => f.width * f.height;

function mp4Files(files, hosts) {
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && f.file_type === 'video/mp4' && f.width > 0 && f.height > 0 && isAllowedUrl(f.link, hosts))
    .sort((a, b) => area(a) - area(b));
}

/** Smallest mp4 whose short side is ≥ 1080, else the largest available. */
export function pickDownloadFile(files) {
  const list = mp4Files(files, DOWNLOAD_HOSTS.pexels);
  return list.find((f) => shortSide(f) >= 1080) || list[list.length - 1] || null;
}

/** Smallest mp4 that is at least 360p (for hover previews). */
export function pickPreviewFile(files) {
  const list = mp4Files(files, MEDIA_HOSTS.pexels);
  return list.find((f) => shortSide(f) >= 360) || list[list.length - 1] || null;
}

export function parseVideo(video, category) {
  if (!video || !video.id) return null;
  const file = pickDownloadFile(video.video_files);
  if (!file) return null;
  const preview = pickPreviewFile(video.video_files);
  const thumb = [video.image, video.video_pictures?.[0]?.picture].find((u) => isAllowedUrl(u, MEDIA_HOSTS.pexels));
  return {
    id: `pexels:${video.id}`,
    provider: 'pexels',
    providerId: String(video.id),
    category,
    title: titleFromSlug(video.url, `Pexels video ${video.id}`),
    tags: Array.isArray(video.tags) ? video.tags.filter((t) => typeof t === 'string').slice(0, 20) : [],
    author: video.user?.name || 'Pexels',
    authorUrl: video.user?.url || 'https://www.pexels.com',
    sourceUrl: video.url || `https://www.pexels.com/video/${video.id}/`,
    thumbUrl: thumb || null,
    previewUrl: preview?.link || file.link,
    width: file.width,
    height: file.height,
    duration: toNumber(video.duration),
    orientation: orientationOf(file.width, file.height),
    downloadUrl: file.link,
  };
}

/** Parse a /videos/search response → { clips, hasMore }. */
export function parseResponse(json, category) {
  const clips = (json?.videos || []).map((v) => parseVideo(v, category)).filter(Boolean);
  return { clips, hasMore: Boolean(json?.next_page) };
}

export async function search({ category, query, providerPage = 1, orientation, perPage = 15 }) {
  if (!enabled()) return { clips: [], hasMore: false };
  const params = new URLSearchParams({ query, size: 'medium', per_page: String(perPage), page: String(providerPage) });
  if (['portrait', 'landscape', 'square'].includes(orientation)) params.set('orientation', orientation);
  const url = `${API}?${params}`;
  const json = await fetchJson(url, {
    headers: { Authorization: apiKey() },
    timeoutMs: 15000,
    cacheFile: searchCacheFile('pexels', url),
    maxAgeMs: SEARCH_MAX_AGE,
  });
  return parseResponse(json, category);
}
