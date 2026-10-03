import fsp from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg } from '../lib/ffmpeg.js';

// Background video. Clips are cut into ~7 s segments and chained with crossfades.
// Instead of one huge filtergraph with dozens of decoders, the timeline is split into
// "pieces": piece k = segment k (minus the part already shown in the previous crossfade)
// + the crossfade into segment k+1. Pieces render independently (in parallel) and are
// joined losslessly with the concat demuxer in the final pass.

export const FPS = 30;
const FADE = 24; // crossfade length in frames (0.8 s)
const TARGET = 7 * FPS; // segment length in frames

/**
 * Plan segments covering `duration` seconds from `clips` (reused cyclically).
 * → { totalFrames, pieces: [{ index, frames, main: {clip,start,loop,skip}, next|null }] } or null
 */
export function planBackground(clips, duration) {
  const usable = clips.filter((c) => c?.path && Number(c.duration) > 0.5);
  if (!usable.length) return null;
  const totalFrames = Math.ceil(duration * FPS) + 1;
  const count = Math.max(1, Math.ceil((totalFrames - FADE) / (TARGET - FADE)));
  const base = Math.floor((totalFrames + (count - 1) * FADE) / count);
  const segments = [];
  let assigned = 0;
  for (let i = 0; i < count; i++) {
    const frames = i === count - 1 ? totalFrames + (count - 1) * FADE - assigned : base;
    assigned += frames;
    const clip = usable[i % usable.length];
    const use = Math.floor(i / usable.length);
    segments.push({ clip, frames, ...pickWindow(clip.duration, frames / FPS, use) });
  }
  const pieces = segments.map((seg, k) => {
    const skip = k === 0 ? 0 : FADE; // frames already shown during the incoming crossfade
    const next = segments[k + 1];
    return {
      index: k,
      frames: seg.frames - skip,
      main: { clip: seg.clip, start: seg.start + skip / FPS, loop: seg.loop },
      next: next ? { clip: next.clip, start: next.start, loop: next.loop } : null,
    };
  });
  return { totalFrames, pieces, clips: [...new Set(segments.map((s) => s.clip))] };
}

/** Where to cut a segment: around the clip's middle, shifted for each reuse; loop short clips. */
function pickWindow(clipDuration, length, use) {
  const room = clipDuration - length - 0.2;
  if (room < 0) return { start: 0, loop: true };
  const lo = Math.min(0.3, room / 2);
  const hi = room;
  const pos = (0.5 + use * 0.37) % 1;
  return { start: lo + (hi - lo) * pos, loop: false };
}

function normalize(width, height, frames) {
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bicubic,crop=${width}:${height},` +
    `setsar=1,fps=${FPS},format=yuv420p,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=${FPS},trim=end_frame=${frames}`
  );
}

/** Darken by factor k (1 = unchanged) in YUV with a LUT — cheap. */
function darken(k) {
  const kc = Math.sqrt(k).toFixed(3);
  return `lutyuv=y=16+(val-16)*${k.toFixed(3)}:u=128+(val-128)*${kc}:v=128+(val-128)*${kc}`;
}

/** The overall look, as a plain filter chain: uniform darkening + soft vignette. */
export function lookFilter(overlay) {
  return `${darken(1 - overlay)},vignette=angle=0.6`;
}

/**
 * Filtergraph fragment [input] → [output] applying the look plus an extra darkened
 * horizontal band behind the text (band = { top, bottom, feather, strength } in px),
 * blended with a smoothstep mask. Much cheaper here (parallel pieces, threaded
 * maskedmerge) than as a big blurred shape in the single-threaded ass filter.
 */
function lookGraph(input, output, { overlay, band, width, height }) {
  const k = 1 - overlay;
  if (!band || band.strength <= 0) return `[${input}]${lookFilter(overlay)}[${output}]`;
  const f = band.feather / height;
  const a = band.top / height - f;
  const b = band.bottom / height + f;
  const s = `st(0,clip(min((Y/H-${a.toFixed(4)})/${f.toFixed(4)},(${b.toFixed(4)}-Y/H)/${f.toFixed(4)}),0,1));255*ld(0)*ld(0)*(3-2*ld(0))`;
  return (
    `color=c=black:s=${width}x${height}:r=${FPS}:d=0.04,format=yuv420p,geq=lum='${s}':cb='${s}':cr='${s}',loop=loop=-1:size=1[mask];` +
    `[${input}]split[p][q];[p]${darken(k)}[l];[q]${darken(k * (1 - band.strength))}[d];` +
    `[l][d][mask]maskedmerge,vignette=angle=0.6[${output}]`
  );
}

function clipInput(src, seconds) {
  return [...(src.loop ? ['-stream_loop', '-1'] : []), '-ss', src.start.toFixed(3), '-t', (seconds + 1).toFixed(3), '-i', src.clip.path];
}

async function renderPiece(piece, { width, height, overlay, band, cwd, signal, onFrames }) {
  const out = `piece_${String(piece.index).padStart(3, '0')}.mp4`;
  const args = [...clipInput(piece.main, piece.frames / FPS)];
  const look = { overlay, band, width, height };
  let graph;
  if (piece.next) {
    args.push(...clipInput(piece.next, FADE / FPS));
    const offset = ((piece.frames - FADE) / FPS).toFixed(4);
    graph =
      `[0:v]${normalize(width, height, piece.frames)}[a];[1:v]${normalize(width, height, FADE)}[b];` +
      `[a][b]xfade=transition=fade:duration=${(FADE / FPS).toFixed(4)}:offset=${offset}[x];${lookGraph('x', 'v', look)}`;
  } else {
    graph = `[0:v]${normalize(width, height, piece.frames)}[x];${lookGraph('x', 'v', look)}`;
  }
  args.push(
    '-filter_complex', graph, '-map', '[v]', '-frames:v', String(piece.frames), '-an',
    '-c:v', 'libx264', '-preset', 'superfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), out,
  );
  try {
    await runFfmpeg(args, { cwd, signal, onProgress: (s) => onFrames(Math.min(piece.frames, s * FPS)) });
  } catch (err) {
    if (!signal?.aborted) err.clips = [piece.main.clip, piece.next?.clip].filter(Boolean);
    throw err;
  }
  return out;
}

/**
 * Render all pieces (a few at a time) and write the concat list; resolves to its name.
 * A failing piece rejects with `err.clips` = the clips it used.
 */
export async function renderPieces(plan, { width, height, overlay, band, cwd, signal, onProgress, concurrency = 3 }) {
  const done = new Array(plan.pieces.length).fill(0);
  const report = () => onProgress?.(done.reduce((a, b) => a + b, 0) / plan.totalFrames);
  const files = new Array(plan.pieces.length);
  const queue = [...plan.pieces];
  // Stop sibling ffmpeg processes as soon as one piece fails (or the job is canceled).
  const local = new AbortController();
  const both = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  const worker = async () => {
    while (queue.length && !both.aborted) {
      const piece = queue.shift();
      files[piece.index] = await renderPiece(piece, {
        width, height, overlay, band, cwd, signal: both,
        onFrames: (f) => {
          done[piece.index] = f;
          report();
        },
      });
      done[piece.index] = piece.frames;
      report();
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () =>
    worker().catch((err) => {
      local.abort();
      throw err;
    }),
  );
  const results = await Promise.allSettled(workers);
  const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
  if (failed.length) throw failed.find((e) => e.clips) || failed[0];
  const listFile = 'pieces.txt';
  await fsp.writeFile(path.join(cwd, listFile), files.map((f) => `file '${f}'`).join('\n') + '\n');
  return listFile;
}

// Elegant generated fallback: slow drifting gradients (emerald / midnight navy / muted gold).
const PALETTES = [
  ['0x0f3b2f', '0x08142a', '0x0d2f3a', '0x4a3b1c'],
  ['0x0a1a3a', '0x050b1a', '0x123a3a', '0x3d3218'],
  ['0x06261f', '0x0b1530', '0x1d3b4f', '0x5a4622'],
];

/** ffmpeg input args for a generated background of `duration` seconds. */
export function gradientInput({ width, height, duration, seed = 0, overlay = 0.45 }) {
  const p = PALETTES[Math.abs(seed) % PALETTES.length];
  const w = Math.round(width / 4 / 2) * 2;
  const h = Math.round(height / 4 / 2) * 2;
  const dim = Math.max(0, overlay - 0.45) * 0.6; // these colours are already dark
  const src =
    `gradients=s=${w}x${h}:r=${FPS}:d=${duration.toFixed(3)}:c0=${p[0]}:c1=${p[1]}:c2=${p[2]}:c3=${p[3]}:` +
    `nb_colors=4:speed=0.006:type=linear:seed=${Math.abs(seed) % 1000},` +
    `scale=${width}:${height}:flags=bicubic,format=yuv420p,noise=alls=3:allf=t,${lookFilter(dim)}`;
  return ['-f', 'lavfi', '-i', src];
}
