import { spawn } from 'node:child_process';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function run(bin, args, { cwd, signal, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true, signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (onStdout) onStdout(text);
      else stdout += text;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-10000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`${bin} exited with code ${code}: ${stderr.trim().split('\n').slice(-8).join('\n')}`);
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

/** Returns { duration, width, height, hasVideo, hasAudio } for a media file. */
export async function probe(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height,duration',
    '-of', 'json',
    file,
  ]);
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const duration = Number(info.format?.duration) || Number(video?.duration) || 0;
  return {
    duration,
    width: video?.width || 0,
    height: video?.height || 0,
    hasVideo: Boolean(video),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

/**
 * Run ffmpeg. `-y -hide_banner -loglevel error` are added for you.
 * With `onProgress(seconds)`, progress is reported as seconds of output written.
 * Rejects with the tail of stderr on failure. Pass `signal` (AbortSignal) to cancel.
 */
export async function runFfmpeg(args, { cwd, signal, onProgress } = {}) {
  const base = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (!onProgress) return run(FFMPEG, [...base, ...args], { cwd, signal });
  let buffer = '';
  return run(FFMPEG, [...base, '-progress', 'pipe:1', '-nostats', ...args], {
    cwd,
    signal,
    onStdout(text) {
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m) onProgress(Number(m[1]) / 1e6);
      }
    },
  });
}
