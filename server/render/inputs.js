// Collects everything one video needs from the Quran, reciter and footage modules and
// turns a video record into a plain pipeline spec. Those modules are imported lazily so
// the render API still loads (and reports clear errors) if one of them is missing.
import path from 'node:path';
import { OUTPUT_DIR, TMP_DIR } from '../paths.js';
import { outputSize, orientationOf } from './layout.js';
import { LEAD_IN, TAIL } from './audio.js';
import { mapLimit } from './util.js';

const lazy = (file) => {
  let mod;
  return () => (mod ??= import(file));
};
export const quranModule = lazy('../quran.js');
export const recitersModule = lazy('../reciters.js');
export const sourcesModule = lazy('../sources/index.js');

/** Bismillah is recited before ayah 1 of every surah except Al-Fatihah (where it is ayah 1) and At-Tawbah. */
export const wantsBismillah = (req) => req.bismillah && req.from === 1 && req.surah !== 1 && req.surah !== 9;

/**
 * record → pipeline spec (see renderVideo). `onProgress(stage, fraction)` reports the
 * recitation downloads ('audio') and the footage lookup ('clips').
 */
export async function buildSpec(record, { signal, onProgress = () => {} } = {}) {
  const req = record.request;
  const quran = await quranModule();
  const reciters = await recitersModule();

  const [ayahRows, reciter] = await Promise.all([
    quran.getAyahs(req.surah, req.from, req.to, req.translation),
    reciters.getReciter(req.reciter),
  ]);
  let done = 0;
  const total = ayahRows.length + (wantsBismillah(req) ? 1 : 0);
  const fetchAudio = async (surah, ayah) => {
    signal?.throwIfAborted();
    const audio = await reciters.getAyahAudio(req.reciter, surah, ayah);
    onProgress('audio', ++done / total);
    return audio;
  };
  const audios = await mapLimit(ayahRows, 4, (row) => fetchAudio(row.surah, row.ayah));
  const ayahs = ayahRows.map((row, i) => ({ ayah: row.ayah, arabic: row.arabic, translation: row.translation, audio: audios[i] }));

  let bismillah = null;
  if (wantsBismillah(req)) {
    const [arabic, first, audio] = await Promise.all([
      quran.getBismillahText(),
      req.translation ? quran.getAyahs(1, 1, 1, req.translation) : null,
      fetchAudio(1, 1),
    ]);
    bismillah = { arabic, translation: first?.[0]?.translation ?? null, audio };
  }

  // Footage: never fatal — the renderer falls back to a generated background.
  const audioSeconds = [...ayahs, ...(bismillah ? [bismillah] : [])].reduce((s, a) => s + (a.audio.duration || 0), 0);
  let clips = [];
  onProgress('clips', 0);
  try {
    const sources = await sourcesModule();
    clips = await sources.pickClips({
      categories: req.categories,
      totalDuration: audioSeconds + LEAD_IN + TAIL,
      orientation: orientationOf(req.aspect),
      approvedOnly: req.approvedOnly,
    });
  } catch (err) {
    console.warn(`[render] no footage for ${record.id}: ${err.message}`);
  }
  signal?.throwIfAborted();

  const { width, height } = outputSize(req.aspect, req.quality);
  return {
    workDir: path.join(TMP_DIR, `render-${record.id}`),
    outFile: path.join(OUTPUT_DIR, `${record.id}.mp4`),
    thumbFile: path.join(OUTPUT_DIR, `${record.id}.jpg`),
    width,
    height,
    aspect: req.aspect,
    seed: parseInt(record.id.slice(1), 36) || 0,
    style: req.style,
    surah: record.surah,
    reciter: { nameEn: reciter.nameEn, nameAr: reciter.nameAr },
    translation: record.translation,
    ayahs,
    bismillah,
    clips: Array.isArray(clips) ? clips : [],
  };
}
