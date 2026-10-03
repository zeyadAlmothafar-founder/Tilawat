import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const FONTS_DIR = path.join(ROOT, 'assets', 'fonts');

// Persistent app state (library.json, videos.json, ...)
export const DATA_DIR = path.join(ROOT, 'data');

// Re-downloadable caches
export const CACHE_DIR = path.join(ROOT, 'cache');
export const QURAN_CACHE_DIR = path.join(CACHE_DIR, 'quran');
export const AUDIO_CACHE_DIR = path.join(CACHE_DIR, 'audio');
export const CLIP_CACHE_DIR = path.join(CACHE_DIR, 'clips');
export const THUMB_CACHE_DIR = path.join(CACHE_DIR, 'thumbs');

// Finished videos (served at /output) and per-job scratch space
export const OUTPUT_DIR = path.join(ROOT, 'output');
export const TMP_DIR = path.join(ROOT, 'tmp');

export function ensureDirs() {
  for (const dir of [FONTS_DIR, DATA_DIR, QURAN_CACHE_DIR, AUDIO_CACHE_DIR, CLIP_CACHE_DIR, THUMB_CACHE_DIR, OUTPUT_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
