import path from 'node:path';
import { runFfmpeg, probe } from '../lib/ffmpeg.js';
import { mapLimit } from './util.js';

const RATE = 44100;
export const LEAD_IN = 0.4;
export const TAIL = 1.2;
const THRESHOLD = '-42dB';
const KEEP_START = 0.12; // silence kept before the voice
const KEEP_END = 0.3; // ... and after it (natural pause between ayat)

/**
 * Decode one recitation file to 44.1 kHz stereo WAV with leading/trailing silence trimmed
 * (some reciters' files start with seconds of silence). WAV gives an exact sample count,
 * so the subtitle timeline cannot drift. Resolves to { file, duration }.
 */
async function prepareClip(input, index, { cwd, signal }) {
  const out = `ayah_${String(index).padStart(3, '0')}.wav`;
  const norm = `asetpts=PTS-STARTPTS,aresample=${RATE},aformat=sample_fmts=s16:channel_layouts=stereo`;
  const trim = (keep) => `silenceremove=start_periods=1:start_threshold=${THRESHOLD}:start_silence=${keep}`;
  await runFfmpeg(['-i', input, '-af', `${norm},${trim(KEEP_START)},areverse,${trim(KEEP_END)},areverse`, '-c:a', 'pcm_s16le', out], { cwd, signal });
  let { duration } = await probe(path.join(cwd, out)).catch(() => ({ duration: 0 }));
  if (duration < 0.3) {
    // Nothing above the threshold (very quiet file): keep it untrimmed.
    await runFfmpeg(['-i', input, '-af', norm, '-c:a', 'pcm_s16le', out], { cwd, signal });
    ({ duration } = await probe(path.join(cwd, out)));
  }
  return { file: out, duration };
}

/**
 * Concatenate recitation files into one loudness-normalized track and return the exact
 * timeline: parts [{ path }] → { file, duration, timeline: [{ start, end, gapEnd }] }.
 * `gaps[i]` (seconds, optional) inserts that much silence right after part i (tafsir
 * cards); the silence spans [end, gapEnd] in the timeline.
 */
export async function buildAudioTrack(parts, { cwd, signal, out = 'audio.flac', gaps = [] }) {
  if (!gaps.some((g) => g > 0)) return buildSpeechTrack(parts, { cwd, signal, out });
  // Normalize the recitation alone (silence would skew loudnorm's gain), then splice the
  // pauses in at exact sample positions.
  const speech = await buildSpeechTrack(parts, { cwd, signal, out: 'speech.flac' });
  const cutAt = (seconds) => Math.round(seconds * RATE);
  const totalSpeech = cutAt(speech.duration);
  const chains = [];
  const labels = [];
  const segments = [];
  let prev = 0;
  speech.timeline.forEach((t, i) => {
    const gap = Math.round((gaps[i] || 0) * RATE);
    if (gap <= 0) return;
    segments.push([prev, cutAt(t.end)]);
    segments.push(gap);
    prev = cutAt(t.end);
  });
  segments.push([prev, totalSpeech]);
  const speechParts = segments.filter((s) => Array.isArray(s)).length;
  chains.push(`[0:a]asplit=${speechParts}${Array.from({ length: speechParts }, (_, k) => `[s${k}]`).join('')}`);
  let k = 0;
  segments.forEach((seg, j) => {
    if (Array.isArray(seg)) {
      chains.push(`[s${k++}]atrim=start_sample=${seg[0]}:end_sample=${seg[1]},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo[p${j}]`);
    } else {
      chains.push(`anullsrc=r=${RATE}:cl=stereo,atrim=end_sample=${seg},aformat=sample_fmts=fltp:channel_layouts=stereo[p${j}]`);
    }
    labels.push(`[p${j}]`);
  });
  const total = totalSpeech + segments.reduce((s, seg) => s + (Array.isArray(seg) ? 0 : seg), 0);
  chains.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1,apad=whole_len=${total},atrim=end_sample=${total}[out]`);
  await runFfmpeg(['-i', path.basename(speech.file), '-filter_complex', chains.join(';'), '-map', '[out]', '-c:a', 'flac', out], { cwd, signal });

  let shift = 0;
  const timeline = speech.timeline.map((t, i) => {
    const gap = Math.round((gaps[i] || 0) * RATE) / RATE;
    const entry = { start: t.start + shift, end: t.end + shift, gapEnd: t.end + shift + gap };
    shift += gap;
    return entry;
  });
  return { file: path.join(cwd, out), duration: total / RATE, timeline };
}

async function buildSpeechTrack(parts, { cwd, signal, out }) {
  const clips = await mapLimit(parts, 4, (part, i) => prepareClip(part.path, i, { cwd, signal }));
  const lead = Math.round(LEAD_IN * RATE);
  const tail = Math.round(TAIL * RATE);
  const timeline = [];
  let cursor = lead;
  const inputs = [];
  const chains = [];
  clips.forEach((clip, i) => {
    const samples = Math.max(1, Math.round(clip.duration * RATE));
    timeline.push({ start: cursor / RATE, end: (cursor + samples) / RATE });
    cursor += samples;
    inputs.push('-i', clip.file);
    chains.push(`[${i}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_len=${samples},atrim=end_sample=${samples}[a${i}]`);
  });
  const total = cursor + tail;
  const duration = total / RATE;
  chains.push(`anullsrc=r=${RATE}:cl=stereo,atrim=end_sample=${lead},aformat=sample_fmts=fltp[lead]`);
  chains.push(
    `[lead]${clips.map((_, i) => `[a${i}]`).join('')}concat=n=${clips.length + 1}:v=0:a=1,` +
      `apad=whole_len=${total},atrim=end_sample=${total},` +
      `loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
      `afade=t=in:st=0:d=${LEAD_IN},afade=t=out:st=${(duration - 1).toFixed(3)}:d=1,` +
      `atrim=end_sample=${total}[out]`,
  );
  await runFfmpeg([...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-c:a', 'flac', out], { cwd, signal });
  return { file: path.join(cwd, out), duration, timeline };
}
