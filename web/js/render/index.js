// Browser render engine — public API (docs/WEB.md).
//
//   canRender()  → { ok, reason?, aac?, hardware?, maxQuality }
//                  Returned object is ALSO a Promise: the synchronous fields are a quick
//                  feature check; `await canRender()` gives the full codec check
//                  (H.264 at 1080/720 in every aspect, AAC native or WASM fallback).
//   renderVideo(job, { onProgress(stage, overall 0..1), signal })
//                → { blob, thumbBlob, duration, width, height, sizeBytes, ...diagnostics }
//                Rejects with a DOMException named 'AbortError' when canceled.
//
// Recitations are fetched + decoded here on the main thread (Web Audio's MP3 decoder isn't
// available in workers — cheap); everything else runs in a module Worker with an
// OffscreenCanvas (not throttled in background tabs). Falls back to the main thread when
// module workers / worker fonts / WebCodecs-in-worker are unavailable.

import { decodeRecitations } from './audio.js';

const AUDIO_SHARE = 0.1; // overall progress used by the audio stage

const abortError = () => new DOMException('Render canceled', 'AbortError');

function quickCheck() {
  const g = globalThis;
  if (typeof g.VideoEncoder === 'undefined' || typeof g.VideoFrame === 'undefined') return { ok: false, reason: 'no_webcodecs' };
  if (typeof g.OfflineAudioContext === 'undefined' && typeof g.webkitOfflineAudioContext === 'undefined') return { ok: false, reason: 'no_web_audio' };
  if (typeof g.WebAssembly === 'undefined' && typeof g.AudioEncoder === 'undefined') return { ok: false, reason: 'no_aac' };
  return { ok: true };
}

let fullCheck = null;
async function detailedCheck() {
  const quick = quickCheck();
  if (!quick.ok) return { ...quick, maxQuality: null };
  const mb = await import('../../../vendor/mediabunny.mjs');
  const sizes = {
    1080: [[1080, 1920], [1920, 1080], [1080, 1080]],
    720: [[720, 1280], [1280, 720], [720, 720]],
  };
  const ok = async (list, bitrate) => (await Promise.all(list.map(([width, height]) => mb.canEncodeVideo('avc', { width, height, bitrate }).catch(() => false)))).every(Boolean);
  let maxQuality = null;
  if (await ok(sizes[1080], 5e6)) maxQuality = '1080';
  else if (await ok(sizes[720], 3e6)) maxQuality = '720';
  if (!maxQuality) return { ok: false, reason: 'no_h264', maxQuality: null };

  let aac = null;
  if (await mb.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 44100, bitrate: 128e3 }).catch(() => false)) aac = 'native';
  else if (typeof WebAssembly === 'object' && typeof Worker !== 'undefined') aac = 'wasm'; // @mediabunny/aac-encoder
  if (!aac) return { ok: false, reason: 'no_aac', maxQuality };

  let hardware = false;
  try {
    const [w, h] = maxQuality === '1080' ? [1080, 1920] : [720, 1280];
    const res = await VideoEncoder.isConfigSupported({ codec: maxQuality === '1080' ? 'avc1.640028' : 'avc1.64001f', width: w, height: h, bitrate: 2.2e6, framerate: 30, hardwareAcceleration: 'prefer-hardware' });
    hardware = Boolean(res.supported);
  } catch {
    hardware = false;
  }
  return { ok: true, aac, hardware, maxQuality };
}

export function canRender() {
  const quick = quickCheck();
  fullCheck ??= detailedCheck().catch((err) => ({ ok: false, reason: `check_failed: ${err.message}`, maxQuality: null }));
  const p = fullCheck.then((r) => r);
  return Object.assign(p, { ...quick, maxQuality: quick.ok ? '1080' : null, preliminary: true });
}

// ---------------------------------------------------------------------------------

let workerProbe = null; // Promise<boolean>
function probeWorker() {
  if (workerProbe) return workerProbe;
  workerProbe = new Promise((resolve) => {
    let w;
    try {
      w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      w.terminate();
      resolve(false);
    }, 8000);
    w.onmessage = (e) => {
      clearTimeout(timer);
      w.terminate();
      if (!e.data?.ok) console.warn(`[render] worker unavailable (${e.data?.reason}); rendering on the main thread`);
      resolve(Boolean(e.data?.ok));
    };
    w.onerror = () => {
      clearTimeout(timer);
      w.terminate();
      resolve(false);
    };
    w.postMessage({ type: 'probe' });
  });
  return workerProbe;
}

function renderInWorker(job, parts, { onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      w.terminate();
      fn(value);
    };
    const onAbort = () => {
      w.postMessage({ type: 'cancel' });
      // Give the worker a moment to cancel the output cleanly, then kill it.
      setTimeout(() => finish(reject, abortError()), 300);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    w.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'progress') onProgress?.(msg.stage, msg.fraction);
      else if (msg.type === 'done') finish(resolve, msg.result);
      else if (msg.type === 'error') {
        const err = msg.error.name === 'AbortError' ? abortError() : Object.assign(new Error(msg.error.message), { name: msg.error.name, workerStack: msg.error.stack });
        finish(reject, err);
      }
    };
    w.onerror = (e) => finish(reject, new Error(`Render worker failed: ${e.message || 'unknown error'}`));
    const transfer = parts.flatMap((p) => p.channels.map((c) => c.buffer));
    w.postMessage({ type: 'render', job, parts, range: [AUDIO_SHARE, 1] }, transfer);
  });
}

/**
 * Render one video in the browser. See docs/WEB.md for the job shape.
 * Stages reported: 'audio', 'clips', 'render', 'finalize' (fraction = overall progress).
 */
export async function renderVideo(job, { onProgress = () => {}, signal, forceMainThread = false } = {}) {
  if (signal?.aborted) throw abortError();
  if (!job?.items?.length) throw new Error('renderVideo: job has no items');
  const started = performance.now();
  onProgress('audio', 0);
  const useWorker = probeWorker();
  let parts;
  try {
    parts = await decodeRecitations(job.items.map((it) => it.audioUrl), {
      signal,
      onProgress: (f) => onProgress('audio', f * AUDIO_SHARE),
    });
  } catch (err) {
    if (signal?.aborted) throw abortError();
    throw err;
  }
  if (signal?.aborted) throw abortError();
  const plain = JSON.parse(JSON.stringify(job)); // structured-clone safe
  let result;
  if (!forceMainThread && (await useWorker)) {
    result = await renderInWorker(plain, parts, { onProgress, signal });
    result.mode = 'worker';
  } else {
    const { runRender } = await import('./engine.js');
    try {
      result = await runRender(plain, parts, { onProgress, signal, range: [AUDIO_SHARE, 1] });
    } catch (err) {
      if (signal?.aborted) throw abortError();
      throw err;
    }
    result.mode = 'main';
  }
  result.wallSeconds = (performance.now() - started) / 1000;
  result.speed = result.duration / result.wallSeconds;
  return result;
}
