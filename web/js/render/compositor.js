// Background: footage segments (~7 s each, cycling through the clips) with 0.8 s
// crossfades, decoded with Mediabunny at the output size (cover crop), or an animated
// dark gradient when there is no footage. The "look" (darkening, a darker band behind the
// text, vignette) is one precomputed black-alpha overlay. Mirrors server/render/background.js.

import { Input, BlobSource, ALL_FORMATS, VideoSampleSink } from '../../../vendor/mediabunny.mjs';
import { makeCanvas, ctx2d, canvasMode } from './text.js';

export const FPS = 30;
const FADE = 24; // crossfade frames (0.8 s)
const TARGET = 7 * FPS; // segment frames

// ---------------------------------------------------------------------------------
// Footage

/** Download + open clips; undecodable or failing ones are dropped. → [{ ...clip, input, track, duration, first }] */
export async function openClips(clips, { signal, onProgress, concurrency = 3 } = {}) {
  const list = (clips || []).filter((c) => c?.url);
  const unique = [...new Map(list.map((c) => [c.url, c])).values()];
  const loadedBytes = new Array(unique.length).fill(0);
  const totals = unique.map((c) => (c.size > 0 ? c.size : 4e6));
  const report = () => onProgress?.(Math.min(1, loadedBytes.reduce((a, b) => a + b, 0) / totals.reduce((a, b) => a + b, 0)));
  const opened = new Map();
  let next = 0;
  const work = async () => {
    while (next < unique.length) {
      const i = next++;
      const clip = unique[i];
      try {
        const res = await fetch(clip.url, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length')) || 0;
        if (len) totals[i] = len;
        const chunks = [];
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loadedBytes[i] += value.byteLength;
          report();
        }
        const blob = new Blob(chunks, { type: 'video/mp4' });
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track || !(await track.canDecode())) throw new Error('not decodable');
        const duration = await track.computeDuration();
        const first = await track.getFirstTimestamp();
        // Decode one frame to be sure.
        const sink = new VideoSampleSink(track);
        const probe = await sink.getSample(first);
        if (!probe) throw new Error('no frames');
        probe.close();
        opened.set(clip.url, { ...clip, input, track, duration: duration - first, first, bytes: blob.size });
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[render] skipping clip ${clip.url}: ${err.message}`);
      }
      loadedBytes[i] = totals[i];
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, work));
  signal?.throwIfAborted();
  // Keep the caller's order (and repeats).
  return list.map((c) => opened.get(c.url)).filter((c) => c && c.duration > 0.5);
}

/** Where to cut a segment: around the clip's middle, shifted for each reuse; loop short clips. */
function pickWindow(clipDuration, length, use) {
  const room = clipDuration - length - 0.2;
  if (room < 0) return { start: 0, loop: true };
  const lo = Math.min(0.3, room / 2);
  const pos = (0.5 + use * 0.37) % 1;
  return { start: lo + (room - lo) * pos, loop: false };
}

/** Segments covering `totalFrames`: [{ clip, from (global frame), frames, start, loop }]. */
export function planSegments(clips, totalFrames) {
  if (!clips.length) return [];
  const count = Math.max(1, Math.ceil((totalFrames - FADE) / (TARGET - FADE)));
  const base = Math.floor((totalFrames + (count - 1) * FADE) / count);
  const segments = [];
  let assigned = 0;
  let from = 0;
  for (let i = 0; i < count; i++) {
    const frames = i === count - 1 ? totalFrames + (count - 1) * FADE - assigned : base;
    assigned += frames;
    const clip = clips[i % clips.length];
    const use = Math.floor(i / clips.length);
    segments.push({ clip, from, frames, ...pickWindow(clip.duration, frames / FPS, use) });
    from += frames - FADE;
  }
  return segments;
}

class Segment {
  constructor(seg) {
    this.seg = seg;
    // On a CPU surface, software-decoded frames (already in CPU memory) avoid a GPU readback per draw.
    this.sink = new VideoSampleSink(seg.clip.track, canvasMode() === 'cpu' ? { hardwareAcceleration: 'prefer-software' } : {});
    const { start, loop, frames, clip } = seg;
    const times = [];
    for (let j = 0; j < frames; j++) {
      let t = start + j / FPS;
      if (loop) t %= Math.max(0.1, clip.duration - 0.05);
      times.push(clip.first + t);
    }
    this.iter = this.sink.samplesAtTimestamps(times);
    this.last = null;
    this.failed = false;
  }

  async next() {
    if (this.failed) return this.last;
    try {
      const { value, done } = await this.iter.next();
      if (!done && value) {
        this.last?.close();
        this.last = value;
      }
    } catch (err) {
      console.warn(`[render] clip decode failed mid-way: ${err.message}`);
      this.failed = true;
    }
    return this.last;
  }

  close() {
    this.last?.close();
    this.last = null;
    this.iter.return?.().catch(() => {});
  }
}

function drawCover(ctx, sample, W, H, alpha) {
  const w = sample.displayWidth;
  const h = sample.displayHeight;
  const s = Math.max(W / w, H / h);
  const dw = w * s;
  const dh = h * s;
  ctx.globalAlpha = alpha;
  sample.draw(ctx, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.globalAlpha = 1;
}

export class FootageBackground {
  constructor(clips, totalFrames, width, height) {
    this.segments = planSegments(clips, totalFrames);
    this.W = width;
    this.H = height;
    this.active = new Map(); // index → Segment
    this.usedClips = [...new Set(this.segments.map((s) => s.clip))];
  }

  async draw(ctx, f) {
    const live = [];
    this.segments.forEach((seg, i) => {
      if (f >= seg.from && f < seg.from + seg.frames) live.push(i);
    });
    // Close finished segments.
    for (const [i, s] of this.active) {
      if (!live.includes(i)) {
        s.close();
        this.active.delete(i);
      }
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.W, this.H);
    for (const i of live) {
      if (!this.active.has(i)) this.active.set(i, new Segment(this.segments[i]));
    }
    const samples = await Promise.all(live.map((i) => this.active.get(i).next()));
    live.forEach((i, k) => {
      const sample = samples[k];
      if (!sample) return;
      const seg = this.segments[i];
      // The later segment fades in over the earlier one.
      const alpha = k === 0 ? 1 : Math.min(1, Math.max(0, (f - seg.from + 1) / (FADE + 1)));
      drawCover(ctx, sample, this.W, this.H, alpha);
    });
  }

  close() {
    for (const s of this.active.values()) s.close();
    this.active.clear();
    for (const c of this.usedClips) c.input?.dispose?.();
  }
}

// ---------------------------------------------------------------------------------
// Generated fallback: slow drifting gradients (emerald / midnight navy / muted gold)

const PALETTES = [
  ['#0f3b2f', '#08142a', '#0d2f3a', '#4a3b1c'],
  ['#0a1a3a', '#050b1a', '#123a3a', '#3d3218'],
  ['#06261f', '#0b1530', '#1d3b4f', '#5a4622'],
];

export class GradientBackground {
  constructor(width, height, seed = 0) {
    this.W = width;
    this.H = height;
    this.p = PALETTES[Math.abs(seed) % PALETTES.length];
    this.phase = (Math.abs(seed) % 1000) / 159;
    this.usedClips = [];
    this.mode = null;
  }

  async draw(ctx, f) {
    if (this.mode !== canvasMode()) {
      this.mode = canvasMode();
      this.small = makeCanvas(Math.round(this.W / 4), Math.round(this.H / 4));
      this.sctx = ctx2d(this.small);
    }
    const { small, sctx, p } = this;
    const w = small.width;
    const h = small.height;
    const t = f / FPS;
    const a = this.phase + t * 0.06;
    sctx.fillStyle = p[1];
    sctx.fillRect(0, 0, w, h);
    const r = Math.hypot(w, h) / 2;
    const g = sctx.createLinearGradient(w / 2 - Math.cos(a) * r, h / 2 - Math.sin(a) * r, w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
    g.addColorStop(0, p[0]);
    g.addColorStop(0.45, p[1]);
    g.addColorStop(0.75, p[2]);
    g.addColorStop(1, p[3]);
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, w, h);
    // Two soft glows drifting slowly.
    for (const [k, color] of [[0, p[3]], [1, p[0]]]) {
      const cx = w * (0.5 + 0.35 * Math.cos(a * (1.3 + k * 0.4) + k * 2));
      const cy = h * (0.5 + 0.35 * Math.sin(a * (0.9 + k * 0.5) + k));
      const rg = sctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.8);
      rg.addColorStop(0, `${color}aa`);
      rg.addColorStop(1, `${color}00`);
      sctx.fillStyle = rg;
      sctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, this.W, this.H);
  }

  close() {}
}

// ---------------------------------------------------------------------------------
// The look

/**
 * One black overlay with per-pixel alpha = 1 − (1 − overlay)·(1 − band·mask(y))·vignette(x, y).
 * band = { top, bottom, feather, strength } | null. vignette = ffmpeg's cos⁴(0.6·d/dmax).
 */
export function lookOverlay(width, height, { overlay, band }) {
  const canvas = makeCanvas(width, height);
  const ctx = ctx2d(canvas);
  const img = ctx.createImageData(width, height);
  const data = img.data;
  const k = 1 - Math.max(0, Math.min(0.95, overlay));
  const rowFactor = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let m = 0;
    if (band && band.strength > 0) {
      const f = band.feather;
      const s = Math.min(Math.max(Math.min((y - (band.top - f)) / f, (band.bottom + f - y) / f), 0), 1);
      m = s * s * (3 - 2 * s);
    }
    rowFactor[y] = k * (1 - (band ? band.strength : 0) * m);
  }
  const cx = width / 2;
  const cy = height / 2;
  const dmax = Math.hypot(cx, cy);
  const vx = new Float32Array(width);
  for (let x = 0; x < width; x++) vx[x] = (x - cx) * (x - cx);
  for (let y = 0; y < height; y++) {
    const dy2 = (y - cy) * (y - cy);
    const row = rowFactor[y];
    let o = y * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      const c = Math.cos((0.6 * Math.sqrt(vx[x] + dy2)) / dmax);
      const v = c * c * c * c;
      data[o + 3] = Math.round((1 - row * v) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
