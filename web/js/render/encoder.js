// MP4 output: H.264 High (WebCodecs via Mediabunny CanvasSource) + AAC-LC 44.1 kHz stereo,
// fast-start (moov first), built in memory. When the browser has no native AAC encoder
// (Firefox, some Safari versions), Mediabunny's official WASM AAC encoder extension
// (@mediabunny/aac-encoder, FFmpeg's AAC encoder) is registered instead.

import {
  Output, Mp4OutputFormat, BufferTarget, VideoSampleSource, VideoSample, AudioSampleSource, AudioSample, Quality,
  canEncodeAudio, canEncodeVideo,
} from '../../../vendor/mediabunny.mjs';

// bits/s by file size: [1080p, 720p]
export const VIDEO_BITRATE = { small: [1.2e6, 0.8e6], balanced: [2.2e6, 1.4e6], high: [5e6, 3e6] };
export const AUDIO_BITRATE = { small: 96e3, balanced: 128e3, high: 160e3 };
export const KEYFRAME_SECONDS = 4;

let aacMode = null; // 'native' | 'wasm'

/** Make sure AAC can be encoded; registers the WASM encoder if needed. → 'native' | 'wasm' */
export async function ensureAac({ forceWasm = false } = {}) {
  if (aacMode) return aacMode;
  if (!forceWasm && await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 44100, bitrate: 128e3 }).catch(() => false)) {
    aacMode = 'native';
  } else {
    const { registerAacEncoder } = await import('../../../vendor/mediabunny-aac-encoder.mjs');
    registerAacEncoder();
    aacMode = 'wasm';
  }
  return aacMode;
}

export function videoBitrate(fileSize, width, height) {
  const preset = VIDEO_BITRATE[fileSize] || VIDEO_BITRATE.balanced;
  return Math.min(width, height) >= 1000 ? preset[0] : preset[1];
}

export async function canEncodeH264(width, height, bitrate = 2.2e6) {
  return canEncodeVideo('avc', { width, height, bitrate }).catch(() => false);
}

/**
 * Create the MP4 output. → { output, addFrame(canvas, t, dur), addAudio(channels, from, to), finalize(), cancel() }
 */
export async function createEncoder({ width, height, fileSize, fps = 30, forceWasmAac = false }) {
  await ensureAac({ forceWasm: forceWasmAac });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  // Frames come from whichever canvas the engine composes on (it may switch between a
  // GPU- and a CPU-backed canvas mid-render), so samples are created explicitly.
  const video = new VideoSampleSource({
    codec: 'avc',
    quality: new Quality({ bitrate: videoBitrate(fileSize, width, height) }),
    keyFrameInterval: KEYFRAME_SECONDS,
    latencyMode: 'quality',
  });
  const audio = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: AUDIO_BITRATE[fileSize] || AUDIO_BITRATE.balanced }) });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(audio);
  await output.start();

  /** Add samples [from, to) of the planar stereo track. */
  const addAudio = async (channels, from, to, rate = 44100) => {
    const n = to - from;
    if (n <= 0) return;
    const data = new Float32Array(n * 2);
    data.set(channels[0].subarray(from, to), 0);
    data.set(channels[1].subarray(from, to), n);
    const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: rate, timestamp: from / rate });
    await audio.add(sample);
    sample.close();
  };
  /** Encode the current content of `canvas` as the frame at t seconds. */
  const addFrame = async (canvas, t, duration) => {
    const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(duration * 1e6) });
    const sample = new VideoSample(frame);
    try {
      await video.add(sample);
    } finally {
      sample.close();
      frame.close();
    }
  };
  return {
    output,
    addFrame,
    video,
    audio,
    addAudio,
    aac: aacMode,
    async finalize() {
      await output.finalize();
      return new Blob([output.target.buffer], { type: 'video/mp4' });
    },
    async cancel() {
      try {
        await output.cancel();
      } catch {
        /* already finished */
      }
    },
  };
}
