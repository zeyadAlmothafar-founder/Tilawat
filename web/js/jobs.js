// Web build render jobs: request validation (mirrors server/render/request.js with the web
// limits), video records persisted in IndexedDB, the render job handed to the in-browser
// engine (web/js/render/index.js, contract in docs/WEB.md) and a sequential queue.
//
// Rendering runs in this tab (the engine uses a Worker, so it keeps going in the background)
// but stops when the tab closes: on the next visit such videos become errors with code
// "interrupted". Each tab holds a Web Lock named after its id, so another open tab can tell
// whether a queued/running video still has a live owner.
import { ApiError } from './errors.js';
import * as data from './data.js';
import * as store from './store.js';
import {
  LIMITS, ASPECTS, FILE_SIZES, CATEGORY_IDS, DEFAULT_CATEGORIES, DEFAULTS,
  normalizeStyle, outputSize, orientationOf, wantsBismillah,
} from '../../shared/render-rules.js';
import { tafsirCardsFor } from '../../shared/tafsir.js';
import { creditLine, clipCredits } from '../../shared/credits.js';
import { quranDisplayText } from '../../shared/quran-text.js';

export const WEB_LIMITS = LIMITS.web;
const ACTIVE = new Set(['queued', 'running']);
const TAB_ID = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const LOCK_PREFIX = 'tilawat-tab-';
const CHANNEL = 'tilawat-jobs';
const SAVE_EVERY_MS = 800;

const deps = {
  data,
  store,
  loadEngine: () => import('./render/index.js'),
  now: () => new Date(),
};

/** Tests: replace data / store / loadEngine. */
export function configureJobs(overrides) {
  Object.assign(deps, overrides);
  enginePromise = null;
}

// ---------------------------------------------------------------------------
// Engine

let enginePromise = null;
const engine = () => (enginePromise ??= deps.loadEngine().catch((err) => {
  enginePromise = null;
  throw err;
}));

/** { ok, reason?, maxQuality } from the engine's canRender(); never throws. */
export async function renderSupport() {
  try {
    const mod = await engine();
    const result = await mod.canRender();
    return { maxQuality: '1080', ...result, ok: Boolean(result?.ok) };
  } catch (err) {
    return { ok: false, reason: `engine_unavailable: ${err.message}`, maxQuality: '720' };
  }
}

// ---------------------------------------------------------------------------
// Request normalization (server/render/request.js with the web limits)

const toInt = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const isNone = (v) => v === null || v === false || v === '' || v === 'none' || v === 'null';

async function resolveItem(item, index) {
  if (!item || typeof item !== 'object') throw new ApiError(400, 'invalid_items', `items[${index}] must be an object`);
  const number = toInt(item.surah);
  if (!Number.isInteger(number) || number < 1 || number > 114) {
    throw new ApiError(400, 'invalid_surah', `items[${index}].surah must be 1–114`);
  }
  const s = (await deps.data.getSurahs())[number - 1];
  const from = Number.isInteger(toInt(item.from)) ? toInt(item.from) : 1;
  const to = Number.isInteger(toInt(item.to)) ? toInt(item.to) : from;
  if (from < 1 || to < from || to > s.ayahCount) {
    throw new ApiError(400, 'invalid_range', `items[${index}]: ayat ${from}–${to} are not in surah ${number} (1–${s.ayahCount})`);
  }
  return { surah: { number: s.number, nameAr: s.nameAr, nameEn: s.nameEn }, from, to };
}

async function resolveReciter(value) {
  const id = value ? String(value) : DEFAULTS.reciter;
  const r = (await deps.data.getReciters()).find((x) => x.id === id);
  if (!r) throw new ApiError(400, 'invalid_reciter', `Unknown reciter "${id}"`);
  return { id: r.id, nameEn: r.nameEn, nameAr: r.nameAr };
}

async function resolveTranslation(value) {
  if (value === undefined) value = DEFAULTS.translation;
  if (isNone(value)) return null;
  const key = String(value);
  const { translations } = await deps.data.getTranslations();
  const t = translations.find((x) => x.key === key);
  if (!t) throw new ApiError(400, 'invalid_translation', `Unknown translation "${key}"`);
  return { key: t.key, languageIso: t.languageIso, title: t.title, version: t.version || null, direction: t.direction || null };
}

async function resolveTafsir(value) {
  if (value === undefined || isNone(value)) return null;
  const key = String(value);
  const { tafsirs } = await deps.data.getTafsirs();
  const t = tafsirs.find((x) => x.key === key);
  if (!t) throw new ApiError(400, 'invalid_tafsir', `Unknown tafsir "${key}"`);
  return { key: t.key, title: t.title, languageIso: t.languageIso, direction: t.direction };
}

/**
 * Body → { common, videos: [{ surah: {number,nameAr,nameEn}, from, to }] }; throws ApiError(400)
 * with the server's codes. `maxQuality` ('720' on devices that can't encode 1080p) caps quality.
 */
export async function normalizeRequest(body, { limits = WEB_LIMITS, maxQuality = '1080' } = {}) {
  if (!body || typeof body !== 'object') throw new ApiError(400, 'invalid_request', 'Expected an object');
  const items = Array.isArray(body.items) ? body.items : body.surah ? [body] : [];
  if (!items.length) throw new ApiError(400, 'invalid_items', 'items must be a non-empty array');
  if (items.length > limits.maxVideos) throw new ApiError(400, 'too_many_videos', `At most ${limits.maxVideos} videos at a time`);

  const mode = body.mode === 'perAyah' ? 'perAyah' : 'combined';
  const resolved = [];
  for (const [i, item] of items.entries()) resolved.push(await resolveItem(item, i));

  const videos = [];
  for (const item of resolved) {
    if (mode === 'perAyah') {
      for (let a = item.from; a <= item.to; a++) videos.push({ surah: item.surah, from: a, to: a });
    } else {
      if (item.to - item.from + 1 > limits.maxAyahs) {
        throw new ApiError(400, 'too_many_ayahs', `At most ${limits.maxAyahs} ayat per video (surah ${item.surah.number}: ${item.from}–${item.to})`);
      }
      videos.push(item);
    }
    if (videos.length > limits.maxVideos) throw new ApiError(400, 'too_many_videos', `At most ${limits.maxVideos} videos at a time`);
  }

  const categories = [...new Set((Array.isArray(body.categories) ? body.categories : []).filter((c) => CATEGORY_IDS.includes(c)))];
  const quality = String(body.quality) === '720' || String(maxQuality) === '720' ? '720' : '1080';
  const [reciter, translation, tafsir] = await Promise.all([
    resolveReciter(body.reciter),
    resolveTranslation(body.translation),
    resolveTafsir(body.tafsir),
  ]);
  const common = {
    mode,
    reciter,
    translation,
    tafsir,
    categories: categories.length ? categories : DEFAULT_CATEGORIES,
    aspect: ASPECTS.includes(body.aspect) ? body.aspect : '9:16',
    quality,
    fileSize: FILE_SIZES.includes(body.fileSize) ? body.fileSize : 'balanced',
    bismillah: body.bismillah !== false,
    approvedOnly: false, // every clip in the web build is curated
    style: normalizeStyle(body.style),
  };
  return { common, videos };
}

// ---------------------------------------------------------------------------
// Render job (docs/WEB.md "Render job")

const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭ࣓-ࣿ\s]/g;
const TAFSIR_WORDS_PER_SECOND = 2.8;

/** Rough recitation length before any audio is downloaded (only used to pick enough clips). */
export function estimateSeconds(items) {
  let total = 1.5; // lead-in + tail
  for (const it of items) {
    const letters = String(it.arabic || '').replace(ARABIC_MARKS, '').length;
    total += letters / 3 + 1;
    if (it.tafsirText) {
      const words = it.tafsirText.split(/\s+/).filter(Boolean).length;
      total += Math.max(4, words / TAFSIR_WORDS_PER_SECOND + 1.5) + 0.45;
    }
  }
  return total;
}

/** Video record → the job for renderVideo(). */
export async function buildJob(record) {
  const req = record.request;
  const d = deps.data;
  const [ayahRes, reciters, tafsirRes, edition] = await Promise.all([
    d.getAyahs({ surah: req.surah, from: req.from, to: req.to, translation: req.translation }),
    d.getReciters(),
    req.tafsir ? d.getTafsir({ surah: req.surah, from: req.from, to: req.to, edition: req.tafsir }) : null,
    req.tafsir ? d.getTafsirs().then(({ tafsirs }) => tafsirs.find((t) => t.key === req.tafsir) || null) : null,
  ]);
  const reciter = reciters.find((r) => r.id === req.reciter) || record.reciter;
  const cards = tafsirRes ? tafsirCardsFor(tafsirRes.ayahs, req.from, req.to) : new Map();

  const items = ayahRes.ayahs.map((a) => {
    const card = cards.get(a.ayah) || null;
    return {
      kind: 'ayah',
      ayah: a.ayah,
      arabic: quranDisplayText(a.arabic),
      translation: req.translation ? a.translation ?? null : null,
      audioUrl: d.audioUrl(req.reciter, req.surah, a.ayah),
      tafsirText: card ? card.text : null,
      // Ayat the card explains (for its label, e.g. "AL-MUKHTASAR · 2:3–4"); clipped to the video.
      tafsirFrom: card ? card.groupStart : null,
      tafsirTo: card ? card.groupEnd : null,
    };
  });

  if (wantsBismillah(req)) {
    const [arabic, first] = await Promise.all([
      d.getBismillahText(),
      req.translation ? d.getAyahs({ surah: 1, from: 1, to: 1, translation: req.translation }) : null,
    ]);
    items.unshift({
      kind: 'bismillah',
      ayah: null,
      arabic: quranDisplayText(arabic),
      translation: first?.ayahs?.[0]?.translation ?? null,
      audioUrl: d.audioUrl(req.reciter, 1, 1),
      tafsirText: null,
      tafsirFrom: null,
      tafsirTo: null,
    });
  }

  const tafsir = edition
    ? { key: edition.key, languageIso: edition.languageIso, direction: edition.direction, title: edition.title, label: edition.label, book: edition.book }
    : null;
  const translationShown = Boolean(record.translation && items.some((it) => it.translation));
  const tafsirShown = Boolean(tafsir && items.some((it) => it.tafsirText));

  let clips = [];
  try {
    clips = await d.pickClips({
      categories: req.categories,
      totalDuration: estimateSeconds(items),
      orientation: orientationOf(req.aspect),
      quality: req.quality,
    });
  } catch (err) {
    console.warn(`[jobs] no footage for ${record.id}: ${err.message}`); // the engine falls back to a plain background
  }

  const { width, height } = outputSize(req.aspect, req.quality);
  return {
    id: record.id,
    aspect: req.aspect,
    width,
    height,
    fps: 30,
    fileSize: req.fileSize,
    style: req.style,
    surah: record.surah,
    reciter: { id: reciter.id, nameEn: reciter.nameEn, nameAr: reciter.nameAr },
    translation: record.translation
      ? { key: record.translation.key, languageIso: record.translation.languageIso, direction: record.translation.direction, version: record.translation.version, title: record.translation.title }
      : null,
    tafsir,
    items,
    clips,
    credit: creditLine({
      credits: req.style.credits,
      translation: translationShown ? record.translation : null,
      tafsir: tafsirShown ? tafsir : null,
      clips,
    }),
  };
}

// ---------------------------------------------------------------------------
// Records & queue

const live = new Map(); // id → record owned by this tab (fresher than IndexedDB)
const queue = []; // ids waiting to run in this tab
const controllers = new Map(); // id → AbortController of the running job
let pumping = false;
let ownerLock = null;
let channel = null;

function setupTab() {
  if (ownerLock !== null) return;
  ownerLock = false;
  try {
    if (globalThis.navigator?.locks) {
      ownerLock = true;
      navigator.locks.request(`${LOCK_PREFIX}${TAB_ID}`, () => new Promise(() => {})).catch(() => { ownerLock = false; });
    }
  } catch { ownerLock = false; }
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e) => {
      if (e.data?.type === 'cancel' && live.has(e.data.id)) cancelLocal(e.data.id);
    };
    channel.unref?.(); // Node (tests): don't keep the process alive
  } catch { channel = null; }
  globalThis.addEventListener?.('beforeunload', (e) => {
    if ([...live.values()].some((r) => ACTIVE.has(r.status))) {
      e.preventDefault();
      e.returnValue = ''; // closing the tab stops rendering
    }
  });
}

async function liveTabs() {
  try {
    if (!globalThis.navigator?.locks?.query) return null;
    const { held = [] } = await navigator.locks.query();
    return new Set(held.map((l) => l.name).filter((n) => n?.startsWith(LOCK_PREFIX)).map((n) => n.slice(LOCK_PREFIX.length)));
  } catch {
    return null;
  }
}

const throttles = new Map(); // id → timer
function save(record, { soon = false } = {}) {
  clearTimeout(throttles.get(record.id));
  if (soon) {
    throttles.set(record.id, setTimeout(() => {
      throttles.delete(record.id);
      deps.store.putRecord(record).catch(() => {});
    }, SAVE_EVERY_MS));
    return Promise.resolve();
  }
  throttles.delete(record.id);
  return deps.store.putRecord(record);
}

/** Records newest first; queued/running videos of closed tabs become "interrupted" errors. */
export async function listRecords() {
  setupTab();
  const stored = await deps.store.allRecords();
  const byId = new Map(stored.map((r) => [r.id, r]));
  for (const [id, r] of live) if (byId.has(id) || ACTIVE.has(r.status)) byId.set(id, r);
  let alive = null;
  for (const r of byId.values()) {
    if (!ACTIVE.has(r.status) || live.has(r.id)) continue;
    alive ??= (await liveTabs()) || new Set();
    if (r.ownerTab && alive.has(r.ownerTab)) continue;
    Object.assign(r, {
      status: 'error',
      error: { code: 'interrupted', message: 'The page was closed before this video was finished.' },
      finishedAt: deps.now().toISOString(),
    });
    await deps.store.putRecord(r).catch(() => {});
  }
  return [...byId.values()].sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
}

export async function getRecord(id) {
  if (live.has(id)) return live.get(id);
  const list = await listRecords();
  return list.find((r) => r.id === id) || null;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomId(prefix, length = 7) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = prefix;
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}

/** POST /api/render equivalent → { batchId, videos }. */
export async function createBatch(body) {
  setupTab();
  const support = await renderSupport();
  if (!support.ok) throw new ApiError(400, 'unsupported_browser', support.reason || 'This browser cannot render videos');
  const { common, videos } = await normalizeRequest(body, { maxQuality: support.maxQuality });
  const batchId = randomId('b', 9);
  const { width, height } = outputSize(common.aspect, common.quality);
  const now = deps.now();
  const base = now.getTime() * 100;
  const records = videos.map((item, i) => ({
    id: randomId('v'),
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
    createdAt: now.toISOString(),
    finishedAt: null,
    order: base + i,
    ownerTab: TAB_ID,
  }));
  for (const r of records) {
    live.set(r.id, r);
    await save(r);
    queue.push(r.id);
  }
  setTimeout(pump, 0);
  return { batchId, videos: records.map((r) => ({ ...r })) };
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const record = live.get(queue.shift());
      if (record?.status === 'queued') await runJob(record);
    }
  } finally {
    pumping = false;
  }
}

// Overall progress: fetching texts 0–4 %, then the engine (it reports overall 0..1 with the
// stage name: 'audio', 'clips', 'render', 'finalize').
const FETCH_SHARE = 0.04;

/** Engine progress (stage, overall fraction) → record progress 0..1. */
export function overallProgress(stage, fraction) {
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  return FETCH_SHARE + f * (1 - FETCH_SHARE);
}

const KNOWN_CODES = new Set(['upstream_unavailable', 'unsupported_browser', 'storage_full', 'invalid_range', 'unknown_translation', 'unknown_tafsir']);

async function runJob(record) {
  const controller = new AbortController();
  const { signal } = controller;
  controllers.set(record.id, controller);
  Object.assign(record, { status: 'running', stage: 'audio', progress: 0, error: null, startedAt: deps.now().toISOString() });
  await save(record).catch(() => {});
  const setProgress = (stage, p) => {
    if (signal.aborted) return;
    record.stage = stage;
    record.progress = Math.max(record.progress || 0, Math.round(Math.min(1, Math.max(0, p)) * 1000) / 1000);
    save(record, { soon: true });
  };
  const started = Date.now();
  try {
    const job = await buildJob(record);
    signal.throwIfAborted();
    setProgress('audio', FETCH_SHARE);
    const { renderVideo } = await engine();
    const result = await renderVideo(job, {
      signal,
      onProgress: (stage, fraction) => setProgress(stage === 'done' ? 'finalize' : stage, overallProgress(stage, fraction)),
    });
    signal.throwIfAborted(); // canceled during a step that cannot be interrupted
    try {
      await deps.store.putFiles(record.id, { video: result.blob, thumb: result.thumbBlob || null });
    } catch (err) {
      throw Object.assign(new Error(`Could not save the video in this browser (${err.message})`), {
        code: err?.name === 'QuotaExceededError' ? 'storage_full' : 'storage_failed',
      });
    }
    requestPersistence();
    Object.assign(record, {
      status: 'done',
      stage: 'done',
      progress: 1,
      duration: Math.round(Number(result.duration) * 100) / 100,
      sizeBytes: result.sizeBytes ?? result.blob?.size ?? null,
      width: result.width || record.width,
      height: result.height || record.height,
      credits: clipCredits(job.clips),
      renderSeconds: Math.round((Date.now() - started) / 100) / 10,
      finishedAt: deps.now().toISOString(),
    });
  } catch (err) {
    if (signal.aborted) {
      await deps.store.deleteFiles(record.id).catch(() => {});
    } else {
      console.error(`[jobs] ${record.id} failed in stage ${record.stage}:`, err);
      record.status = 'error';
      record.error = {
        code: err?.code && (KNOWN_CODES.has(err.code) || err.code === 'storage_failed') ? err.code : 'render_failed',
        message: String(err?.message || err).slice(0, 600),
      };
      record.finishedAt = deps.now().toISOString();
    }
  } finally {
    controllers.delete(record.id);
    if (!signal.aborted || record.status === 'canceled') await save(record).catch(() => {});
  }
}

let persistenceAsked = false;
function requestPersistence() {
  if (persistenceAsked) return;
  persistenceAsked = true;
  // Chromium decides silently (no prompt); other browsers may prompt, so only ask there.
  if (globalThis.navigator?.userAgentData && navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

function cancelLocal(id) {
  const record = live.get(id);
  if (!record || !ACTIVE.has(record.status)) return false;
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  controllers.get(id)?.abort();
  clearTimeout(throttles.get(id));
  Object.assign(record, { status: 'canceled', finishedAt: deps.now().toISOString() });
  save(record).catch(() => {});
  return true;
}

/**
 * DELETE /api/videos/:id equivalent: queued/running → canceled (record kept, like the server);
 * finished → record and files deleted.
 */
export async function removeVideo(id) {
  const record = await getRecord(id);
  if (!record) throw new ApiError(404, 'video_not_found', `No video "${id}"`);
  if (ACTIVE.has(record.status)) {
    if (!cancelLocal(id)) {
      // Owned by another open tab: ask it to stop, and mark it here too.
      channel?.postMessage({ type: 'cancel', id });
      Object.assign(record, { status: 'canceled', finishedAt: deps.now().toISOString() });
      await deps.store.putRecord(record);
    }
  } else {
    live.delete(id);
    await Promise.all([deps.store.deleteRecord(id), deps.store.deleteFiles(id)]);
  }
  return { ok: true };
}

export const hasActiveJobs = () => [...live.values()].some((r) => ACTIVE.has(r.status));
