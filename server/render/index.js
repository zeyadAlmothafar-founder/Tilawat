// Render jobs: REST API, an in-process queue (RENDER_CONCURRENCY, default 1) and
// persistence of video records in data/videos.json.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { DATA_DIR, OUTPUT_DIR, TMP_DIR } from '../paths.js';
import { httpError } from '../lib/errors.js';
import { renderVideo } from './pipeline.js';
import { buildSpec } from './inputs.js';
import { outputSize } from './layout.js';
import { normalizeRequest } from './request.js';
import { clamp, randomId, writeFileAtomic } from './util.js';

const STORE = path.join(DATA_DIR, 'videos.json');
const CONCURRENCY = clamp(Math.floor(Number(process.env.RENDER_CONCURRENCY)) || 1, 1, 8);
const ACTIVE = new Set(['queued', 'running']);

const videos = new Map(); // id → record, insertion order = creation order
const queue = []; // ids waiting to run
const running = new Map(); // id → AbortController

// ---------------------------------------------------------------------------
// Persistence (atomic writes; progress updates are debounced)

let saveTimer = null;
let saveChain = Promise.resolve();

function save({ soon = false } = {}) {
  if (saveTimer && soon) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, soon ? 1000 : 0);
}

function flush() {
  saveTimer = null;
  const data = JSON.stringify(listVideos(), null, 1);
  saveChain = saveChain
    .then(() => writeFileAtomic(STORE, data))
    .catch((err) => console.warn(`[render] could not save ${STORE}: ${err.message}`));
  return saveChain;
}

export async function init() {
  let records = [];
  try {
    records = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[render] ignoring unreadable ${STORE}: ${err.message}`);
  }
  if (!Array.isArray(records)) records = [];
  // The file is newest first; keep the map oldest first.
  let dropped = 0;
  for (const r of records.reverse()) {
    if (!r?.id) continue;
    if (r.status === 'done' && !fs.existsSync(path.join(OUTPUT_DIR, `${r.id}.mp4`))) {
      dropped++; // file deleted by hand: forget the record
      continue;
    }
    if (ACTIVE.has(r.status)) {
      Object.assign(r, { status: 'queued', stage: 'queued', progress: 0, error: null });
      queue.push(r.id);
    }
    videos.set(r.id, r);
  }
  if (queue.length) console.log(`[render] re-queued ${queue.length} unfinished video(s)`);
  if (dropped) console.log(`[render] dropped ${dropped} video record(s) whose file is missing`);
  if (queue.length || dropped) save();
  setImmediate(pump);
}

// ---------------------------------------------------------------------------
// Queue

function pump() {
  while (running.size < CONCURRENCY && queue.length) {
    const id = queue.shift();
    const record = videos.get(id);
    if (record?.status === 'queued') runJob(record);
  }
}

// Overall progress: fetching inputs 0–8 %, the pipeline 8–100 %.
const FETCH_SHARE = 0.08;

async function runJob(record) {
  const controller = new AbortController();
  const { signal } = controller;
  running.set(record.id, controller);
  Object.assign(record, { status: 'running', stage: 'audio', progress: 0, error: null, startedAt: new Date().toISOString() });
  save();
  const setProgress = (stage, p) => {
    if (signal.aborted) return;
    record.stage = stage;
    record.progress = Math.round(clamp(p, 0, 1) * 1000) / 1000;
    save({ soon: true });
  };
  const started = Date.now();
  let workDir = null;
  try {
    const spec = await buildSpec(record, {
      signal,
      onProgress: (stage, f) => setProgress(stage, stage === 'audio' ? f * FETCH_SHARE * 0.6 : FETCH_SHARE * 0.6 + f * FETCH_SHARE * 0.4),
    });
    workDir = spec.workDir;
    const result = await renderVideo(spec, {
      signal,
      onProgress: (stage, p) => setProgress(stage === 'done' ? 'finalize' : stage, FETCH_SHARE + p * (1 - FETCH_SHARE)),
    });
    signal.throwIfAborted(); // canceled during a step that cannot be interrupted
    Object.assign(record, {
      status: 'done',
      stage: 'done',
      progress: 1,
      duration: Math.round(result.duration * 100) / 100,
      sizeBytes: result.sizeBytes,
      url: `/output/${record.id}.mp4`,
      thumbUrl: `/output/${record.id}.jpg`,
      credits: result.credits,
      renderSeconds: Math.round((Date.now() - started) / 100) / 10,
      finishedAt: new Date().toISOString(),
    });
    console.log(`[render] ${record.id} done: ${record.duration}s video in ${record.renderSeconds}s`);
  } catch (err) {
    if (signal.aborted) {
      await removeFiles(record.id);
    } else {
      record.status = 'error';
      record.error = {
        code: err.expose && err.code ? err.code : `${record.stage || 'render'}_failed`,
        message: String(err.message || err).slice(0, 600),
      };
      record.finishedAt = new Date().toISOString();
      console.error(`[render] ${record.id} failed in stage ${record.stage}: ${err.message}${workDir ? `\n  work dir kept: ${workDir}` : ''}`);
    }
  } finally {
    running.delete(record.id);
    if (videos.has(record.id)) save();
    pump();
  }
}

// ---------------------------------------------------------------------------
// Public API

export function getVideo(id) {
  return videos.get(id);
}

export function listVideos() {
  return [...videos.values()].reverse();
}

async function createBatch(body) {
  const { common, videos: items } = await normalizeRequest(body);
  const batchId = randomId('b', 9);
  const { width, height } = outputSize(common.aspect, common.quality);
  const now = new Date().toISOString();
  const records = items.map((item) => {
    let id;
    do id = randomId('v');
    while (videos.has(id));
    return {
      id,
      batchId,
      status: 'queued',
      progress: 0,
      stage: 'queued',
      error: null,
      request: {
        surah: item.surah.number,
        from: item.from,
        to: item.to,
        ...common,
        reciter: common.reciter.id,
        translation: common.translation?.key ?? null,
        tafsir: common.tafsir?.key ?? null,
      },
      surah: item.surah,
      from: item.from,
      to: item.to,
      reciter: common.reciter,
      translation: common.translation,
      tafsir: common.tafsir,
      aspect: common.aspect,
      width,
      height,
      duration: null,
      sizeBytes: null,
      url: null,
      thumbUrl: null,
      credits: [],
      createdAt: now,
      finishedAt: null,
    };
  });
  for (const r of records) {
    videos.set(r.id, r);
    queue.push(r.id);
  }
  save();
  setImmediate(pump);
  return { batchId, videos: records };
}

async function removeFiles(id) {
  const opts = { force: true, maxRetries: 5, retryDelay: 200 };
  await Promise.all([
    fsp.rm(path.join(OUTPUT_DIR, `${id}.mp4`), opts),
    fsp.rm(path.join(OUTPUT_DIR, `${id}.jpg`), opts),
    fsp.rm(path.join(TMP_DIR, `render-${id}`), { ...opts, recursive: true }),
  ]).catch((err) => console.warn(`[render] could not remove files of ${id}: ${err.message}`));
}

export const router = express.Router();

router.post('/render', async (req, res) => {
  res.status(202).json(await createBatch(req.body));
});

router.get('/videos', (req, res) => {
  const { status } = req.query;
  const list = listVideos();
  res.json(status ? list.filter((v) => v.status === status) : list);
});

router.get('/videos/:id', (req, res) => {
  const record = videos.get(req.params.id);
  if (!record) throw httpError(404, 'video_not_found', `No video "${req.params.id}"`);
  res.json(record);
});

// Queued/running → canceled (record kept so the UI can show it); finished → deleted.
router.delete('/videos/:id', async (req, res) => {
  const { id } = req.params;
  const record = videos.get(id);
  if (!record) throw httpError(404, 'video_not_found', `No video "${id}"`);
  if (ACTIVE.has(record.status)) {
    const i = queue.indexOf(id);
    if (i >= 0) queue.splice(i, 1);
    running.get(id)?.abort();
    Object.assign(record, { status: 'canceled', finishedAt: new Date().toISOString() });
  } else {
    videos.delete(id);
  }
  if (!running.has(id)) await removeFiles(id);
  save();
  res.json({ ok: true });
});
