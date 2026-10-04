import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const USER_AGENT = 'Tilawat/0.1 (+local)';

async function fetchWithTimeout(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.httpStatus = res.status;
    throw err;
  }
  return res;
}

/**
 * GET a JSON document. With `cacheFile`, the response is stored on disk and reused
 * until it is older than `maxAgeMs` (default: forever). A stale cache is still
 * returned if the network request fails.
 */
export async function fetchJson(url, { headers, timeoutMs, cacheFile, maxAgeMs = Infinity } = {}) {
  let cached;
  if (cacheFile) {
    try {
      const stat = await fsp.stat(cacheFile);
      cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
      if (Date.now() - stat.mtimeMs < maxAgeMs) return cached;
    } catch {
      cached = undefined;
    }
  }
  try {
    const res = await fetchWithTimeout(url, { headers, timeoutMs });
    const data = await res.json();
    if (cacheFile) {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(data));
      await fsp.rename(tmp, cacheFile);
    }
    return data;
  } catch (err) {
    if (cached !== undefined) return cached;
    throw err;
  }
}

const inflight = new Map();

/**
 * Download `url` to `dest` unless `dest` already exists. Writes to a temp file and
 * renames, so a half-finished download never looks complete. Concurrent calls for
 * the same `dest` share one download. Resolves to `dest`.
 */
export function download(url, dest, { headers, timeoutMs = 120000 } = {}) {
  if (inflight.has(dest)) return inflight.get(dest);
  const job = (async () => {
    try {
      const stat = await fsp.stat(dest);
      if (stat.size > 0) return dest;
    } catch {
      // not cached yet
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const res = await fetchWithTimeout(url, { headers, timeoutMs });
    const tmp = `${dest}.${process.pid}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      await fsp.rename(tmp, dest);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    return dest;
  })().finally(() => inflight.delete(dest));
  inflight.set(dest, job);
  return job;
}
