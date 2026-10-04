// Cloudflare Worker that serves the Tilawat clip bucket (R2 binding "CLIPS") to browsers.
// Read-only: GET/HEAD (+ CORS preflight), any origin, long immutable caching, Range requests.
// Only keys like "segments/<name>.mp4" and "thumbs/<name>.jpg" are served.
// Deploy: see README.md in this folder.

const KEY_RE = /^(segments|thumbs)\/[A-Za-z0-9._-]{1,200}$/;

const BASE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-None-Match, If-Modified-Since',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
  'Access-Control-Max-Age': '86400',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff',
};

function reply(status, body = null, extra = {}) {
  return new Response(body, { status, headers: { ...BASE_HEADERS, 'Cache-Control': 'no-store', ...extra } });
}

function objectHeaders(object) {
  const headers = new Headers(BASE_HEADERS);
  object.writeHttpMetadata(headers); // Content-Type (and Cache-Control) stored at upload
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag);
  headers.set('Last-Modified', object.uploaded.toUTCString());
  headers.set('Accept-Ranges', 'bytes');
  return headers;
}

/** Byte window R2 actually returned for a ranged get → [start, end] (inclusive), or null. */
function servedRange(object) {
  const r = object.range;
  if (!r) return null;
  const size = object.size;
  if ('suffix' in r && r.suffix != null) {
    const len = Math.min(r.suffix, size);
    return [size - len, size - 1];
  }
  const start = r.offset ?? 0;
  const length = r.length ?? size - start;
  return [start, Math.min(size, start + length) - 1];
}

export default {
  async fetch(request, env) {
    const { method } = request;
    if (method === 'OPTIONS') return reply(204);
    if (method !== 'GET' && method !== 'HEAD') return reply(405, 'Method not allowed\n', { Allow: 'GET, HEAD, OPTIONS' });

    let key;
    try {
      key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    } catch {
      return reply(400, 'Bad path\n');
    }
    if (!KEY_RE.test(key)) return reply(404, 'Not found\n');

    if (method === 'HEAD') {
      const object = await env.CLIPS.head(key);
      if (!object) return reply(404);
      const headers = objectHeaders(object);
      headers.set('Content-Length', String(object.size));
      return new Response(null, { status: 200, headers });
    }

    const wantsRange = request.headers.has('Range');
    let object;
    try {
      object = await env.CLIPS.get(key, { range: request.headers, onlyIf: request.headers });
    } catch {
      // Malformed or unsatisfiable Range header.
      const head = await env.CLIPS.head(key);
      if (!head) return reply(404, 'Not found\n');
      return reply(416, null, { 'Content-Range': `bytes */${head.size}` });
    }
    if (!object) return reply(404, 'Not found\n');

    const headers = objectHeaders(object);
    if (!('body' in object) || !object.body) {
      // A conditional header matched (If-None-Match / If-Modified-Since): nothing changed.
      return new Response(null, { status: 304, headers });
    }
    const range = wantsRange ? servedRange(object) : null;
    if (range) {
      headers.set('Content-Range', `bytes ${range[0]}-${range[1]}/${object.size}`);
      return new Response(object.body, { status: 206, headers });
    }
    return new Response(object.body, { status: 200, headers });
  },
};
