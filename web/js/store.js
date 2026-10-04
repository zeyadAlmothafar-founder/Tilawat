// IndexedDB persistence for the web build: video records (small JSON, polled by My Videos)
// and the rendered files (MP4 + JPEG blobs) kept separately so listing stays cheap.
// Falls back to memory when IndexedDB is unavailable (some private modes): videos then last
// only as long as the tab.

const DB_NAME = 'tilawat';
const DB_VERSION = 1;
const RECORDS = 'videos';
const FILES = 'files';

let dbPromise = null;
const memory = { [RECORDS]: new Map(), [FILES]: new Map() };

function openDb() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  dbPromise ??= new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

const promisify = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function run(storeName, mode, fn) {
  const db = await openDb();
  if (!db) return fn(null, memory[storeName]);
  const tx = db.transaction(storeName, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
  });
  const result = await fn(tx.objectStore(storeName), null);
  await done;
  return result;
}

/** Plain-JSON copy (no functions / object URLs) of a record. */
const clean = (record) => {
  const { url, thumbUrl, ...rest } = record;
  return JSON.parse(JSON.stringify({ ...rest, url: null, thumbUrl: null }));
};

export const putRecord = (record) =>
  run(RECORDS, 'readwrite', (store, mem) => (mem ? mem.set(record.id, clean(record)) : promisify(store.put(clean(record)))));

export const getRecord = (id) =>
  run(RECORDS, 'readonly', (store, mem) => (mem ? mem.get(id) ?? null : promisify(store.get(id)).then((r) => r ?? null)));

export const allRecords = () =>
  run(RECORDS, 'readonly', (store, mem) => (mem ? [...mem.values()] : promisify(store.getAll())));

export const deleteRecord = (id) =>
  run(RECORDS, 'readwrite', (store, mem) => (mem ? mem.delete(id) : promisify(store.delete(id))));

/** files = { video: Blob, thumb: Blob|null } */
export const putFiles = (id, files) =>
  run(FILES, 'readwrite', (store, mem) => (mem ? mem.set(id, files) : promisify(store.put(files, id))));

export const getFiles = (id) =>
  run(FILES, 'readonly', (store, mem) => (mem ? mem.get(id) ?? null : promisify(store.get(id)).then((r) => r ?? null)));

export const deleteFiles = (id) =>
  run(FILES, 'readwrite', (store, mem) => (mem ? mem.delete(id) : promisify(store.delete(id))));

/** True when videos survive a reload (IndexedDB works). */
export const isPersistent = () => openDb().then(Boolean);
