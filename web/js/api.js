// Web build replacement for public/js/api.js (copied over dist/js/api.js by web/build.js).
// Same exports and return shapes, but nothing talks to a server of ours: Quran data comes
// from QuranEnc / EveryAyah directly, videos are rendered in this browser and kept in
// IndexedDB. Relative imports resolve from /js/api.js, i.e. into /js/web/.
import { ApiError } from './web/errors.js';
import * as data from './web/data.js';
import * as jobs from './web/jobs.js';
import * as store from './web/store.js';

export { ApiError };

const notAvailable = () => Promise.reject(new ApiError(404, 'not_available_web', 'Not available in the web version'));

/** Kept for compatibility: the UI only calls the named helpers below. */
export async function api(path) {
  throw new ApiError(404, 'not_available_web', `No server API in the web version (${path})`);
}

// Quran data
export const getSurahs = () => data.getSurahs();
export const getReciters = () => data.getReciters();
export const getTranslations = () => data.getTranslations();
export const getAyahs = ({ surah, from, to, translation }) => data.getAyahs({ surah, from, to, translation: translation || null });
export const getTafsirs = () => data.getTafsirs();
export const getTafsir = ({ surah, from, to, edition }) => data.getTafsir({ surah, from, to, edition });
export const audioUrl = (reciter, surah, ayah) => data.audioUrl(reciter, surah, ayah);

// Rendering & videos. url / thumbUrl are object URLs of the blobs stored in IndexedDB.
const objectUrls = new Map(); // id → Promise<{ url, thumbUrl }>

function urlsFor(id) {
  if (!objectUrls.has(id)) {
    objectUrls.set(id, store.getFiles(id).then((files) => (files?.video ? {
      url: URL.createObjectURL(files.video),
      thumbUrl: files.thumb ? URL.createObjectURL(files.thumb) : null,
    } : { url: null, thumbUrl: null })).catch(() => ({ url: null, thumbUrl: null })));
  }
  return objectUrls.get(id);
}

function revokeUrls(id) {
  const entry = objectUrls.get(id);
  objectUrls.delete(id);
  entry?.then(({ url, thumbUrl }) => {
    if (url) URL.revokeObjectURL(url);
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  });
}

async function present(record) {
  const copy = { ...record };
  if (record.status === 'done') Object.assign(copy, await urlsFor(record.id));
  else Object.assign(copy, { url: null, thumbUrl: null });
  return copy;
}

export const startRender = (request) => jobs.createBatch(request);
export const getVideos = async () => Promise.all((await jobs.listRecords()).map(present));
export async function getVideo(id) {
  const record = await jobs.getRecord(id);
  if (!record) throw new ApiError(404, 'video_not_found', `No video "${id}"`);
  return present(record);
}
export async function deleteVideo(id) {
  const result = await jobs.removeVideo(id);
  revokeUrls(id);
  return result;
}

/** Web only: { ok, reason?, maxQuality } — whether this browser can make videos. */
export const renderSupport = () => jobs.renderSupport();
/** Web only: per-request limits ({ maxVideos, maxAyahs }). */
export const limits = jobs.WEB_LIMITS;

// Background library: the curated starter clips, read-only.
export async function getSourcesStatus() {
  const library = await data.libraryCounts();
  const count = Object.values(library).reduce((n, c) => n + c.approved, 0);
  return {
    providers: {
      pexels: { enabled: false },
      pixabay: { enabled: false },
      nasa: { enabled: false },
      upload: { enabled: false },
      starter: { enabled: true, count },
    },
    library,
  };
}
export const getLibrary = (category) => data.getLibrary(category);
export const getCandidates = notAvailable;
export const approveClip = notAvailable;
export const rejectClip = notAvailable;
export const removeClip = notAvailable;

/** Upload a clip — not available in the web version. Returns { promise, abort }. */
export function uploadClip() {
  return { promise: notAvailable(), abort: () => {} };
}

// Sharing (no hosted links or QR codes in the web version)
export const getServerInfo = () => Promise.resolve({ publicBaseUrl: location.origin, lanUrls: [], shareBaseUrl: location.origin });
export const qrUrl = () => '';
