// Renders a video from local fixtures (QuranEnc JSON + EveryAyah mp3 + generated clips)
// without the Quran/reciter/source modules. Fixtures live in tmp/c-fixtures/.
// Usage: node scripts/c-fixture-render.js --surah 1 --from 1 --to 7 --tr english_saheeh
//          [--aspect 9:16] [--quality 1080] [--clips] [--font scheherazade] [--position lower]
//          [--overlay 0.45] [--scale 1] [--no-bismillah] [--no-title] [--no-reciter] [--name out]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { TMP_DIR } from '../server/paths.js';
import { probe } from '../server/lib/ffmpeg.js';
import { download, fetchJson } from '../server/lib/http.js';
import { renderVideo } from '../server/render/pipeline.js';
import { outputSize } from '../server/render/layout.js';

const { values: o } = parseArgs({
  options: {
    surah: { type: 'string', default: '1' },
    from: { type: 'string', default: '1' },
    to: { type: 'string' },
    tr: { type: 'string' },
    aspect: { type: 'string', default: '9:16' },
    quality: { type: 'string', default: '1080' },
    clips: { type: 'boolean', default: false },
    font: { type: 'string', default: 'amiri' },
    position: { type: 'string', default: 'center' },
    overlay: { type: 'string', default: '0.45' },
    scale: { type: 'string', default: '1' },
    'no-bismillah': { type: 'boolean', default: false },
    'no-title': { type: 'boolean', default: false },
    'no-reciter': { type: 'boolean', default: false },
    name: { type: 'string' },
  },
});

const FIX = path.join(TMP_DIR, 'c-fixtures');
const NAMES = { 1: ['الفاتحة', 'Al-Fatihah'], 2: ['البقرة', 'Al-Baqarah'], 112: ['الإخلاص', 'Al-Ikhlas'], 113: ['الفلق', 'Al-Falaq'] };
const surah = Number(o.surah);
const from = Number(o.from);
const to = Number(o.to || o.from);
const pad = (n) => String(n).padStart(3, '0');

async function sura(key, s) {
  const file = path.join(FIX, `${key}_${s}.json`);
  return (await fetchJson(`https://quranenc.com/api/v1/translation/sura/${key}/${s}`, { cacheFile: file })).result;
}
async function audio(s, a) {
  const file = path.join(FIX, 'audio', `${pad(s)}${pad(a)}.mp3`);
  await download(`https://everyayah.com/data/Alafasy_128kbps/${pad(s)}${pad(a)}.mp3`, file);
  return { path: file, duration: (await probe(file)).duration };
}
const clean = (t) => (t ? t.replace(/\s*\[\d+\]/g, '').trim() : null);

const textKey = o.tr || 'english_saheeh';
const rows = (await sura(textKey, surah)).filter((r) => Number(r.aya) >= from && Number(r.aya) <= to);
const ayahs = [];
for (const r of rows) {
  ayahs.push({ ayah: Number(r.aya), arabic: r.arabic_text, translation: o.tr ? clean(r.translation) : null, audio: await audio(surah, Number(r.aya)) });
}
let bismillah = null;
if (!o['no-bismillah'] && from === 1 && surah !== 1 && surah !== 9) {
  const f = (await sura(textKey, 1))[0];
  bismillah = { arabic: f.arabic_text, translation: o.tr ? clean(f.translation) : null, audio: await audio(1, 1) };
}
let clips = [];
if (o.clips) {
  const dir = path.join(FIX, 'clips');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mp4'))) {
    // A corrupt clip gets fake metadata so the pipeline's own fallback is exercised.
    const info = await probe(path.join(dir, f)).catch(() => ({ duration: 10, width: 1920, height: 1080 }));
    clips.push({ id: `fixture:${f}`, path: path.join(dir, f), duration: info.duration, width: info.width, height: info.height, provider: 'nasa', author: 'Fixture', sourceUrl: 'local' });
  }
}

const { width, height } = outputSize(o.aspect, o.quality);
const name = o.name || `fx_${surah}_${from}-${to}_${o.aspect.replace(':', 'x')}`;
const outDir = path.join(TMP_DIR, 'c-out');
const lang = { english_saheeh: 'en', urdu_junagarhi: 'ur', persian_ih: 'fa', bengali_zakaria: 'bn', hindi_omari: 'hi', chinese_suliman: 'zh' }[o.tr];
const t0 = Date.now();
let last = '';
const result = await renderVideo(
  {
    workDir: path.join(TMP_DIR, `c-job-${name}`),
    outFile: path.join(outDir, `${name}.mp4`),
    thumbFile: path.join(outDir, `${name}.jpg`),
    width, height, aspect: o.aspect, seed: surah + from,
    style: {
      arabicFont: o.font, textScale: Number(o.scale), position: o.position, overlay: Number(o.overlay),
      showSurahTitle: !o['no-title'], showReciter: !o['no-reciter'],
    },
    surah: { number: surah, nameAr: NAMES[surah]?.[0] || '', nameEn: NAMES[surah]?.[1] || `Surah ${surah}` },
    reciter: { nameEn: 'Mishary Alafasy', nameAr: 'مشاري العفاسي' },
    translation: o.tr ? { languageIso: lang } : null,
    ayahs, bismillah, clips,
    keepWorkDir: true,
  },
  {
    onProgress(stage, p) {
      const line = `${stage} ${(p * 100).toFixed(0)}%`;
      if (line !== last) process.stdout.write(`\r${(last = line).padEnd(20)}`);
    },
  },
);
const secs = (Date.now() - t0) / 1000;
console.log(`\n${name}: ${result.duration.toFixed(2)} s video in ${secs.toFixed(1)} s (${(secs / result.duration).toFixed(2)}x realtime), ${(result.sizeBytes / 1e6).toFixed(1)} MB`);
console.log('timings', result.timings);
fs.writeFileSync(path.join(outDir, `${name}.cues.json`), JSON.stringify(result.cues, null, 1));
for (const c of result.cues) console.log(`${c.start.toFixed(2).padStart(7)} → ${c.end.toFixed(2).padStart(7)}  ayah ${c.ayah}  ${c.arabic.slice(0, 40)}`);
