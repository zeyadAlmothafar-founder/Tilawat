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
 * timeline: parts [{ path }] → { file, duration, timeline: [{ start, end }] }.
 */
export async function buildAudioTrack(parts, { cwd, signal, out = 'audio.flac' }) {
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
