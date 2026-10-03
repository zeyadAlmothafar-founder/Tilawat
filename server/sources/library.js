// Approved / rejected background clips, persisted in data/library.json.
// Writes are atomic (temp file + rename) and serialized through one promise chain.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../paths.js';
import { CATEGORY_IDS } from './categories.js';

const FILE = path.join(DATA_DIR, 'library.json');
// Curated clips shipped with the app (metadata and links only — no video files), merged
// into the library on load unless the user already reviewed or removed them.
const STARTER_FILE = new URL('../data/starter-library.json', import.meta.url);

// Fields kept on a library entry (the Clip object + what's needed to fetch it again).
const FIELDS = [
  'id', 'provider', 'providerId', 'category', 'title', 'tags', 'author', 'authorUrl', 'sourceUrl', 'thumbUrl',
  'previewUrl', 'width', 'height', 'duration', 'orientation', 'downloadUrl', 'file', 'status', 'addedAt', 'starter',
];

let entries = null;
let writeChain = Promise.resolve();

function pick(obj) {
  const out = {};
  for (const key of FIELDS) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}

function readClips(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[sources] cannot read ${label}: ${err.message}`);
    return [];
  }
  try {
    return (JSON.parse(text).clips || []).filter((e) => e && typeof e.id === 'string');
  } catch (err) {
    if (file === FILE) {
      // Keep the unreadable file for inspection instead of overwriting it on the next save.
      const backup = `${FILE}.corrupt-${Date.now()}`;
      fs.renameSync(FILE, backup);
      console.warn(`[sources] library.json was invalid (${err.message}); moved to ${path.basename(backup)}`);
    } else {
      console.warn(`[sources] ${label} is invalid: ${err.message}`);
    }
    return [];
  }
}

export function loadLibrary() {
  if (entries) return entries;
  entries = new Map(readClips(FILE, 'library.json').map((e) => [e.id, e]));
  for (const e of readClips(STARTER_FILE, 'starter-library.json')) {
    if (!entries.has(e.id)) entries.set(e.id, { ...e, status: 'approved', starter: true });
  }
  return entries;
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      // Windows may briefly lock the target (antivirus, indexer).
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

function save() {
  const snapshot = JSON.stringify({ version: 1, clips: [...loadLibrary().values()] }, null, 2);
  const job = writeChain.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, snapshot);
    await renameWithRetry(tmp, FILE);
  });
  writeChain = job.catch((err) => console.error(`[sources] saving library.json failed: ${err.message}`));
  return job;
}

const newestFirst = (a, b) => String(b.addedAt).localeCompare(String(a.addedAt));

export function getEntry(id) {
  return loadLibrary().get(id);
}

/** Approved clips, newest first; one category or all. */
export function listApproved(category) {
  return [...loadLibrary().values()]
    .filter((e) => e.status === 'approved' && (!category || e.category === category))
    .sort(newestFirst);
}

/** Ids that must not show up as candidates again (approved or rejected). */
export function reviewedIds() {
  return new Set(loadLibrary().keys());
}

export function counts() {
  const out = Object.fromEntries(CATEGORY_IDS.map((c) => [c, { approved: 0, rejected: 0 }]));
  for (const e of loadLibrary().values()) {
    if (out[e.category] && (e.status === 'approved' || e.status === 'rejected')) out[e.category][e.status] += 1;
  }
  return out;
}

export async function approve(clip) {
  const previous = getEntry(clip.id);
  const entry = pick({ ...previous, ...clip, status: 'approved', addedAt: new Date().toISOString() });
  loadLibrary().set(entry.id, entry);
  await save();
  return entry;
}

export async function reject(clip) {
  const previous = getEntry(clip.id);
  const entry = pick({ ...previous, ...clip, status: 'rejected', addedAt: new Date().toISOString() });
  loadLibrary().set(entry.id, entry);
  await save();
  return entry;
}

/** Remove an entry; resolves to the removed entry or null. */
export async function remove(id) {
  const entry = getEntry(id);
  if (!entry) return null;
  // A removed starter clip is remembered as rejected so it isn't merged back in.
  if (entry.starter) loadLibrary().set(id, { ...entry, status: 'rejected' });
  else loadLibrary().delete(id);
  await save();
  return entry;
}
