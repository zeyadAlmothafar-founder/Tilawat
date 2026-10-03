// Reciters (curated EveryAyah allow-list in server/data/reciters.json) and per-ayah audio,
// cached under AUDIO_CACHE_DIR/{reciterId}/{SSSAAA}.mp3 with durations in durations.json.
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AUDIO_CACHE_DIR } from './paths.js';
import { download } from './lib/http.js';
import { probe } from './lib/ffmpeg.js';
import { httpError } from './lib/errors.js';

const AUDIO_BASE = 'https://everyayah.com/data';
const readData = (file) => JSON.parse(fs.readFileSync(new URL(`./data/${file}`, import.meta.url), 'utf8'));

const RECITERS = Object.freeze(readData('reciters.json').map((r) => Object.freeze(r)));
const RECITER_BY_ID = new Map(RECITERS.map((r) => [r.id, r]));
const AYAH_COUNTS = readData('surahs.json').map((s) => s.ayahCount);

export async function getReciters() {
  return RECITERS;
}

export async function getReciter(id) {
  const reciter = RECITER_BY_ID.get(String(id));
  if (!reciter) throw httpError(404, 'reciter_not_found', `Unknown reciter "${id}"`);
  return reciter;
}

// ---------------------------------------------------------------------------
// Durations: memoized per reciter and persisted to AUDIO_CACHE_DIR/{id}/durations.json

const durationStores = new Map(); // id → Promise<{ values, saving, dirty }>

function durationsFile(id) {
  return path.join(AUDIO_CACHE_DIR, id, 'durations.json');
}

function durationStore(id) {
  if (!durationStores.has(id)) {
    const load = fsp
      .readFile(durationsFile(id), 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => ({}))
      .then((values) => ({ values, saving: null, dirty: false }));
    durationStores.set(id, load);
  }
  return durationStores.get(id);
}

async function writeDurations(id, store) {
  while (store.dirty) {
    store.dirty = false;
    const file = durationsFile(id);
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(store.values));
    await fsp.rename(tmp, file);
  }
}

function persistDurations(id, store) {
  store.dirty = true;
  store.saving ??= writeDurations(id, store)
    .catch((err) => console.warn(`[reciters] could not save durations for ${id}: ${err.message}`))
    .finally(() => {
      store.saving = null;
    });
}

// ---------------------------------------------------------------------------
// Audio

function toInt(value) {
  if (typeof value === 'number') return value;
  return /^\s*\d+\s*$/.test(String(value ?? '')) ? Number(value) : NaN;
}

function validateAyah(surah, ayah) {
  if (!Number.isInteger(surah) || surah < 1 || surah > 114) {
    throw httpError(400, 'invalid_range', 'Surah must be a number from 1 to 114');
  }
  const count = AYAH_COUNTS[surah - 1];
  if (!Number.isInteger(ayah) || ayah < 1 || ayah > count) {
    throw httpError(400, 'invalid_range', `Ayah must be 1–${count} for surah ${surah}`);
  }
}

/** Downloads (once) and returns { path, duration } for one ayah's recitation. */
export async function getAyahAudio(reciterId, surah, ayah) {
  const { id } = await getReciter(reciterId);
  [surah, ayah] = [toInt(surah), toInt(ayah)];
  validateAyah(surah, ayah);

  const name = `${String(surah).padStart(3, '0')}${String(ayah).padStart(3, '0')}`;
  const file = path.join(AUDIO_CACHE_DIR, id, `${name}.mp3`);
  try {
    await download(`${AUDIO_BASE}/${id}/${name}.mp3`, file, { timeoutMs: 60000 });
  } catch (err) {
    throw httpError(502, 'upstream_unavailable', `Could not download audio ${id}/${name} (${err.message})`);
  }

  const store = await durationStore(id);
  if (!(store.values[name] > 0)) {
    let duration = 0;
    try {
      ({ duration } = await probe(file));
    } catch {
      duration = 0;
    }
    if (!(duration > 0)) {
      await fsp.rm(file, { force: true }); // unreadable download: fetch again next time
      throw httpError(502, 'upstream_unavailable', `Audio ${id}/${name} is not a valid MP3`);
    }
    store.values[name] = duration;
    persistDurations(id, store);
  }
  return { path: file, duration: store.values[name] };
}

// ---------------------------------------------------------------------------
// HTTP

export const router = express.Router();

router.get('/reciters', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(await getReciters());
});

router.get('/reciters/:id/audio/:surah/:ayah', async (req, res) => {
  const { path: file } = await getAyahAudio(req.params.id, req.params.surah, req.params.ayah);
  res.type('audio/mpeg');
  res.sendFile(file, { maxAge: '7d', immutable: true });
});
