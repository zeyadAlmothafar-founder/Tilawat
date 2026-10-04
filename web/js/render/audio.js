// Recitation audio: decode + silence trim (main thread — Web Audio's decoder is not
// available in workers), then the exact timeline + loudness normalization (anywhere).
// Mirrors server/render/audio.js: 44.1 kHz stereo, -42 dB trim threshold keeping 0.12 s
// before / 0.3 s after the voice, 0.4 s lead-in, 1.2 s tail, silent gaps for tafsir cards,
// normalization to about -16 LUFS (BS.1770 gated loudness), fade in/out.

export const RATE = 44100;
export const LEAD_IN = 0.4;
export const TAIL = 1.2;
const THRESHOLD = 10 ** (-42 / 20);
const KEEP_START = 0.12;
const KEEP_END = 0.3;
const TARGET_LUFS = -16;
const PEAK_LIMIT = 10 ** (-1.5 / 20);

async function fetchWithRetry(url, { signal, tries = 3 }) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    signal?.throwIfAborted();
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Trim leading/trailing silence (20 ms RMS windows) → [start, end) sample indices. */
export function trimBounds(channels, length) {
  const win = Math.round(RATE * 0.02);
  const loud = [];
  for (let s = 0; s < length; s += win) {
    const e = Math.min(length, s + win);
    let sum = 0;
    for (const ch of channels) for (let i = s; i < e; i++) sum += ch[i] * ch[i];
    loud.push(Math.sqrt(sum / ((e - s) * channels.length)) >= THRESHOLD);
  }
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  if (first < 0) return [0, length];
  const start = Math.max(0, first * win - Math.round(KEEP_START * RATE));
  const end = Math.min(length, (last + 1) * win + Math.round(KEEP_END * RATE));
  if (end - start < 0.3 * RATE) return [0, length];
  return [start, end];
}

/**
 * Fetch + decode + trim each recitation file. Main thread only (needs OfflineAudioContext).
 * → [{ channels: [Float32Array, Float32Array], length }] at 44.1 kHz.
 */
export async function decodeRecitations(urls, { signal, onProgress, concurrency = 4 } = {}) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('OfflineAudioContext unavailable');
  const out = new Array(urls.length);
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      const data = await fetchWithRetry(urls[i], { signal });
      signal?.throwIfAborted();
      const ctx = new Ctx(2, 1, RATE);
      const buf = await new Promise((resolve, reject) => {
        const p = ctx.decodeAudioData(data, resolve, reject);
        if (p?.then) p.then(resolve, reject);
      });
      const src = [buf.getChannelData(0), buf.getChannelData(Math.min(1, buf.numberOfChannels - 1))];
      const [s, e] = trimBounds(src, buf.length);
      out[i] = { channels: src.map((ch) => ch.slice(s, e)), length: e - s };
      onProgress?.(++done / urls.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

// --- BS.1770 loudness ---------------------------------------------------------------

function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

function kWeight(x, fs) {
  // Stage 1: high shelf
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const s1 = biquad(x, (Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  // Stage 2: high pass
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  return biquad(s1, 1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
}

/** Integrated loudness (LUFS) of [start, end) of the channels, gated per BS.1770. */
export function integratedLoudness(channels, start, end, fs = RATE) {
  const weighted = channels.map((ch) => kWeight(ch.subarray(start, end), fs));
  const block = Math.round(0.4 * fs);
  const hop = Math.round(0.1 * fs);
  const len = end - start;
  const powers = [];
  for (let s = 0; s + block <= len; s += hop) {
    let p = 0;
    for (const w of weighted) {
      let sum = 0;
      for (let i = s; i < s + block; i++) sum += w[i] * w[i];
      p += sum / block;
    }
    powers.push(p);
  }
  if (!powers.length) return -70;
  const lufs = (p) => -0.691 + 10 * Math.log10(p);
  const abs = powers.filter((p) => lufs(p) > -70);
  if (!abs.length) return -70;
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const rel = lufs(mean(abs)) - 10;
  const gated = abs.filter((p) => lufs(p) > rel);
  return lufs(mean(gated.length ? gated : abs));
}

/**
 * Concatenate decoded parts into the final track with an exact timeline.
 * gaps[i] = seconds of silence inserted right after part i (tafsir cards).
 * → { channels: [L, R], length, duration, timeline: [{ start, end, gapEnd }] }
 */
export function buildTrack(parts, gaps = []) {
  const lead = Math.round(LEAD_IN * RATE);
  const tail = Math.round(TAIL * RATE);
  const gapSamples = parts.map((_, i) => Math.max(0, Math.round((gaps[i] || 0) * RATE)));
  const total = lead + parts.reduce((s, p, i) => s + p.length + gapSamples[i], 0) + tail;
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const timeline = [];
  const speech = [];
  let cursor = lead;
  parts.forEach((p, i) => {
    L.set(p.channels[0].subarray(0, p.length), cursor);
    R.set((p.channels[1] || p.channels[0]).subarray(0, p.length), cursor);
    speech.push([cursor, cursor + p.length]);
    const start = cursor / RATE;
    cursor += p.length;
    const end = cursor / RATE;
    cursor += gapSamples[i];
    timeline.push({ start, end, gapEnd: cursor / RATE });
  });

  // Loudness of the recitation only (silence would skew it), then one linear gain
  // capped so the peak stays below -1.5 dBFS.
  let peak = 0;
  for (const ch of [L, R]) for (let i = 0; i < total; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  const spanStart = speech.length ? speech[0][0] : 0;
  const spanEnd = speech.length ? speech[speech.length - 1][1] : total;
  const loudness = integratedLoudness([L, R], spanStart, spanEnd);
  let gain = loudness > -69 ? 10 ** ((TARGET_LUFS - loudness) / 20) : 1;
  if (peak > 0) gain = Math.min(gain, PEAK_LIMIT / peak);
  gain = Math.min(gain, 8);

  const fadeIn = lead;
  const fadeOut = Math.round(1 * RATE);
  for (const ch of [L, R]) {
    for (let i = 0; i < total; i++) {
      let g = gain;
      if (i < fadeIn) g *= i / fadeIn;
      if (i >= total - fadeOut) g *= (total - i) / fadeOut;
      ch[i] *= g;
    }
  }
  return { channels: [L, R], length: total, duration: total / RATE, timeline, loudness, gain };
}
