// Live test of pickClips(): node scripts/b-pick-test.js
// Downloads real clips (NASA needs no key) and checks they are playable local mp4s.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pickClips, CATEGORY_IDS } from '../server/sources/index.js';
import { probe } from '../server/lib/ffmpeg.js';
import { CLIP_CACHE_DIR } from '../server/paths.js';

async function run(label, options, check) {
  const t = Date.now();
  const clips = await pickClips(options);
  console.log(`\n${label}: ${clips.length} clip(s) in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  for (const c of clips) {
    const size = fs.statSync(c.path).size;
    const info = await probe(c.path);
    console.log(`  ${c.id}\n    ${path.basename(c.path)}  ${c.width}x${c.height}  ${c.duration}s  ${(size / 1e6).toFixed(1)} MB  [${c.provider}, ${c.author}]`);
    assert.ok(path.isAbsolute(c.path) && c.path.startsWith(CLIP_CACHE_DIR), 'absolute path in the clip cache');
    assert.ok(info.hasVideo && info.duration >= 1, 'playable');
    assert.ok(Math.abs(info.duration - c.duration) < 0.5, 'duration matches probe');
    assert.ok(c.width > 0 && c.height > 0);
    for (const key of ['id', 'path', 'duration', 'width', 'height', 'provider', 'author', 'sourceUrl']) assert.ok(key in c, `has ${key}`);
  }
  assert.equal(new Set(clips.map((c) => c.id)).size, clips.length, 'no duplicates');
  check?.(clips);
  return clips;
}

assert.deepEqual(CATEGORY_IDS, ['nature', 'space', 'mosque', 'islamic']);

await run('space, 40s, portrait', { categories: ['space'], totalDuration: 40, orientation: 'portrait' }, (clips) => {
  assert.equal(clips.length, 6, 'ceil(40 / 7) = 6 clips');
  assert.ok(clips.every((c) => c.duration >= 5 && c.duration <= 60), 'sane durations');
});

await run('space, approved only, 100s', { categories: ['space'], totalDuration: 100, orientation: 'landscape', approvedOnly: true }, (clips) => {
  assert.ok(clips.length >= 1 && clips.every((c) => c.provider === 'nasa'));
});

await run('mosque, no provider keys, approved only', { categories: ['mosque'], totalDuration: 30, approvedOnly: true }, (clips) => {
  assert.ok(Array.isArray(clips), 'returns an array, never throws');
});

await run('invalid input', { categories: ['music'], totalDuration: 'abc', orientation: 'diagonal', approvedOnly: true }, (clips) => {
  assert.ok(Array.isArray(clips));
});

console.log('\npickClips test passed.');
