// Render videos directly (no server) through the same validation, inputs and pipeline as
// POST /api/render. Example:
//   node scripts/render-test.js --surah 1 --from 1 --to 7 --reciter Alafasy_128kbps \
//     --translation english_saheeh --aspect 9:16 --categories space
// Options: --mode perAyah, --quality 720, --translation none, --font scheherazade,
//   --position lower, --overlay 0.6, --scale 1.2, --no-bismillah, --approved-only,
//   --no-title, --no-reciter, --tafsir <key> (e.g. english_mokhtasar; tafsir cards between ayat),
//   --out <dir> (default tmp/render-test), --keep (keep work dir)
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { TMP_DIR, ensureDirs } from '../server/paths.js';
import { probe } from '../server/lib/ffmpeg.js';
import { normalizeRequest } from '../server/render/request.js';
import { buildSpec } from '../server/render/inputs.js';
import { renderVideo } from '../server/render/pipeline.js';
import { randomId } from '../server/render/util.js';

const { values: o } = parseArgs({
  options: {
    surah: { type: 'string', default: '1' },
    from: { type: 'string' },
    to: { type: 'string' },
    mode: { type: 'string', default: 'combined' },
    reciter: { type: 'string' },
    translation: { type: 'string' },
    tafsir: { type: 'string' },
    aspect: { type: 'string', default: '9:16' },
    quality: { type: 'string', default: '1080' },
    categories: { type: 'string', default: '' },
    font: { type: 'string', default: 'amiri' },
    position: { type: 'string', default: 'center' },
    overlay: { type: 'string', default: '0.45' },
    scale: { type: 'string', default: '1' },
    'no-bismillah': { type: 'boolean', default: false },
    'approved-only': { type: 'boolean', default: false },
    'no-title': { type: 'boolean', default: false },
    'no-reciter': { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(TMP_DIR, 'render-test') },
    keep: { type: 'boolean', default: false },
  },
});

ensureDirs();
const body = {
  items: [{ surah: o.surah, from: o.from, to: o.to }],
  mode: o.mode,
  reciter: o.reciter,
  ...(o.translation !== undefined ? { translation: o.translation } : {}),
  ...(o.tafsir !== undefined ? { tafsir: o.tafsir } : {}),
  categories: o.categories.split(',').filter(Boolean),
  aspect: o.aspect,
  quality: o.quality,
  bismillah: !o['no-bismillah'],
  approvedOnly: o['approved-only'],
  style: {
    arabicFont: o.font, textScale: o.scale, position: o.position, overlay: o.overlay,
    showSurahTitle: !o['no-title'], showReciter: !o['no-reciter'],
  },
};
const { common, videos } = await normalizeRequest(body);
fs.mkdirSync(o.out, { recursive: true });

for (const item of videos) {
  const id = randomId('t');
  const record = {
    id,
    request: { surah: item.surah.number, from: item.from, to: item.to, ...common, reciter: common.reciter.id, translation: common.translation?.key ?? null, tafsir: common.tafsir?.key ?? null },
    surah: item.surah,
    translation: common.translation,
    tafsir: common.tafsir,
  };
  const t0 = Date.now();
  let last = '';
  const show = (stage, p) => {
    const line = `${stage} ${Math.round(p * 100)}%`;
    if (line !== last) process.stdout.write(`\r${id} ${(last = line).padEnd(16)}`);
  };
  const spec = await buildSpec(record, { onProgress: (stage, f) => show(stage, f) });
  const name = `${item.surah.number}_${item.from}-${item.to}_${common.aspect.replace(':', 'x')}_${id}`;
  spec.outFile = path.join(o.out, `${name}.mp4`);
  spec.thumbFile = path.join(o.out, `${name}.jpg`);
  spec.keepWorkDir = o.keep;
  const fetchSecs = (Date.now() - t0) / 1000;
  const result = await renderVideo(spec, { onProgress: show });
  const secs = (Date.now() - t0) / 1000;
  const info = await probe(spec.outFile);
  console.log(`\r${name}.mp4  ${info.width}x${info.height}  ${info.duration.toFixed(2)} s  ${(result.sizeBytes / 1e6).toFixed(1)} MB  `
    + `clips: ${spec.clips.length}  fetch ${fetchSecs.toFixed(1)} s + render ${(secs - fetchSecs).toFixed(1)} s `
    + `(${((secs - fetchSecs) / info.duration).toFixed(2)}x realtime)`);
  console.log('  stages', Object.entries(result.timings).map(([k, v]) => `${k} ${v.toFixed(1)}s`).join(', '));
  if (result.cards?.length) console.log(`  tafsir cards: ${result.cards.length} (${result.cards.reduce((s, c) => s + c.end - c.start, 0).toFixed(1)} s)`);
  console.log(`  cues: ${result.cues.length}${result.credits.length ? `, credits: ${result.credits.map((c) => `${c.provider}/${c.author}`).join('; ')}` : ''}`);
  if (o.keep) console.log(`  work dir: ${spec.workDir}`);
}
