// Thin client for the REST API described in docs/ARCHITECTURE.md.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers }, signal };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network', err.message);
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code || (res.status === 404 ? 'not_found' : `http_${res.status}`), e?.message || res.statusText);
  }
  return data;
}

// Responses that don't change while the page is open are memoized (failures are not).
const memo = new Map();
function cached(key, load) {
  if (!memo.has(key)) {
    memo.set(key, load().catch((err) => { memo.delete(key); throw err; }));
  }
  return memo.get(key);
}

const qs = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
const enc = encodeURIComponent;

// Quran data
export const getSurahs = () => cached('surahs', () => api('/api/surahs'));
export const getReciters = () => cached('reciters', () => api('/api/reciters'));
export const getTranslations = () => cached('translations', () => api('/api/translations'));
export const getAyahs = ({ surah, from, to, translation }) => {
  const tr = translation || 'none';
  return cached(`ayahs:${surah}:${from}:${to}:${tr}`, () => api(`/api/ayahs?${qs({ surah, from, to, translation: tr })}`));
};
export const getTafsirs = () => cached('tafsirs', () => api('/api/tafsirs'));
export const getTafsir = ({ surah, from, to, edition }) =>
  cached(`tafsir:${surah}:${from}:${to}:${edition}`, () => api(`/api/tafsir?${qs({ surah, from, to, edition })}`));
export const audioUrl =(reciter, surah, ayah) => `/api/reciters/${enc(reciter)}/audio/${surah}/${ayah}`;

// Rendering & videos
export const startRender = (request) => api('/api/render', { method: 'POST', body: request });
export const getVideos = () => api('/api/videos');
export const getVideo = (id) => api(`/api/videos/${enc(id)}`);
export const deleteVideo = (id) => api(`/api/videos/${enc(id)}`, { method: 'DELETE' });

// Background library
export const getSourcesStatus = () => api('/api/sources/status');
export const getLibrary = (category) => api(`/api/library?${qs({ category })}`);
export const getCandidates = ({ category, page = 1, orientation }) =>
  api(`/api/library/candidates?${qs({ category, page, orientation })}`);
export const approveClip = (clip) => api('/api/library/approve', { method: 'POST', body: clip });
export const rejectClip = ({ id, category }) => api('/api/library/reject', { method: 'POST', body: { id, category } });
export const removeClip = (id) => api(`/api/library/${enc(id)}`, { method: 'DELETE' });

/** Upload a clip with progress. Returns { promise, abort }. */
export function uploadClip(file, { category, type, onProgress } = {}) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', `/api/library/upload?${qs({ category })}`);
    xhr.setRequestHeader('Content-Type', type || file.type || 'video/mp4');
    xhr.setRequestHeader('X-Filename', enc(file.name));
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error?.code || (xhr.status === 413 ? 'file_too_large' : 'upload_failed'), data?.error?.message));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Network error'));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

// Sharing
export const getServerInfo = () => cached('server-info', () => api('/api/server-info'));
export const qrUrl = (text) => `/api/qr.svg?${qs({ text })}`;
