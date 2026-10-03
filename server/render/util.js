import crypto from 'node:crypto';
import fsp from 'node:fs/promises';

/** Run `fn` over `items` with at most `limit` in flight; resolves to results in order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short random id like 'v8f3k2a1' (prefix + 7 chars). */
export function randomId(prefix, length = 7) {
  const bytes = crypto.randomBytes(length);
  let id = prefix;
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}

/** Write a file atomically (temp + rename), retrying briefly when Windows locks the target. */
export async function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
