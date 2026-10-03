import fsp from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg, probe } from '../lib/ffmpeg.js';
import { buildAudioTrack } from './audio.js';
import { planBackground, renderPieces, gradientInput, FPS } from './background.js';
import {
  ARABIC_FONTS, FONTS, translationFont, prepareJobFonts, missingChars, splitByCoverage, normalizePresentationForms,
} from './fonts.js';
import { buildLayout, chunkAyah, estimateBlockHeight } from './layout.js';
import { buildAss, quranDisplayText } from './subtitles.js';

// Fonts tried (in order) for translation characters the main translation font lacks.
const TRANSLATION_FALLBACKS = ['notoSans', 'naskh', 'amiri'];

// Share of overall progress per stage (background weight moves to "render" when there
// are no clips to prepare).
const WEIGHTS = { audio: 0.05, text: 0.02, clips: 0.38, render: 0.5, finalize: 0.05 };

const PROVIDERS = { pexels: 'Pexels', pixabay: 'Pixabay', nasa: 'NASA' };

/** "Pexels – Jane Doe, John Roe · NASA" from the clips actually used (uploads need no credit). */
export function footageCredit(clips) {
  const byProvider = new Map();
  for (const c of clips) {
    const label = PROVIDERS[c.provider];
    if (!label) continue;
    if (!byProvider.has(label)) byProvider.set(label, new Set());
    if (c.author) byProvider.get(label).add(c.author);
  }
  const parts = [...byProvider].map(([label, authors]) => {
    const list = [...authors];
    const names = list.slice(0, 3).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '');
    return names ? `${label} – ${names}` : label;
  });
  return parts.join(' · ');
}

function buildCues(items, timeline, layout, duration, withTranslation) {
  const cues = [];
  items.forEach((item, i) => {
    const { start, end } = timeline[i];
    const chunks = chunkAyah(layout, item.arabic, withTranslation ? item.translation : null, item.isBismillah ? 0 : 3);
    let t = start;
    chunks.forEach((c, j) => {
      const last = j === chunks.length - 1;
      const cEnd = last ? end : t + (end - start) * c.weight;
      // Safety net: a block that still overflows (very long translation of a very short
      // ayah) gets a smaller translation font.
      const height = estimateBlockHeight(layout, c.arabic, c.translation);
      const translationScale = height > layout.main.height ? Math.max(0.65, layout.main.height / height) : 1;
      cues.push({
        start: t,
        end: cEnd,
        arabic: c.arabic,
        translation: c.translation,
        translationScale,
        marker: last && !item.isBismillah ? item.ayah : null,
        ayah: item.isBismillah ? 0 : item.ayah,
      });
      t = cEnd;
    });
  });
  // Show the first text right away and keep the last one through the audio tail.
  if (cues.length) {
    cues[0].start = Math.min(cues[0].start, 0.15);
    cues[cues.length - 1].end = Math.max(cues[cues.length - 1].end, duration - 0.25);
  }
  return cues;
}

/**
 * Render one video from plain inputs.
 *
 * spec = {
 *   workDir, outFile, thumbFile, width, height, aspect, seed,
 *   style: { arabicFont, textScale, position, overlay, showSurahTitle, showReciter },
 *   surah: { number, nameAr, nameEn }, reciter: { nameEn, nameAr } | null,
 *   translation: { languageIso } | null,
 *   ayahs: [{ ayah, arabic, translation, audio: { path, duration } }],
 *   bismillah: { arabic, translation, audio } | null,
 *   clips: [{ id, path, duration, provider, author, sourceUrl }],
 *   keepWorkDir
 * }
 * onProgress(stage, overall 0..1). Resolves to { duration, sizeBytes, credits, timings, cues }.
 */
export async function renderVideo(spec, { signal, onProgress = () => {} } = {}) {
  const { workDir, width, height, style } = spec;
  const timings = {};
  let stageStart = Date.now();
  let base = 0;
  let current = 'audio';
  const weights = { ...WEIGHTS };
  const stage = (name) => {
    timings[current] = (Date.now() - stageStart) / 1000;
    base += weights[current];
    current = name;
    stageStart = Date.now();
    onProgress(name, base);
  };
  const progress = (fraction) => onProgress(current, base + weights[current] * Math.min(1, Math.max(0, fraction)));

  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(workDir, { recursive: true });
  onProgress('audio', 0);

  // 1. Audio: (Bismillah) + ayat, exact timeline.
  const items = [...(spec.bismillah ? [{ ...spec.bismillah, isBismillah: true }] : []), ...spec.ayahs];
  const audio = await buildAudioTrack(items.map((it) => it.audio), { cwd: workDir, signal });

  // 2. Text: fonts, layout, chunked cues → subs.ass
  stage('text');
  const arabicKey = await pickArabicFont(style.arabicFont, items);
  const sample = spec.ayahs.map((a) => a.translation || '').join(' ').trim();
  const trFont = spec.translation && sample ? translationFont(sample, spec.translation.languageIso) : null;
  await prepareJobFonts(
    [arabicKey, 'amiri', 'amiriBold', 'notoSans', 'notoSansMedium', ...TRANSLATION_FALLBACKS, ...(trFont ? [trFont.key] : [])],
    path.join(workDir, 'fonts'),
  );
  const showFooterReciter = style.showReciter && Boolean(spec.reciter);
  const layout = buildLayout({
    width, height, aspect: spec.aspect, style,
    fonts: { arabic: arabicKey, translation: trFont?.key || null },
    showHeader: style.showSurahTitle,
    showFooter: showFooterReciter,
  });
  const cues = buildCues(items, audio.timeline, layout, audio.duration, Boolean(trFont));
  if (trFont) {
    const rtl = spec.translation.direction ? spec.translation.direction === 'rtl' : trFont.rtl;
    await addTranslationRuns(cues, trFont.key, rtl);
  }

  // 3. Background pieces (clips) — drop clips that fail to decode and retry.
  stage('clips');
  let clips = spec.clips || [];
  let plan = null;
  let bgArgs;
  while (true) {
    plan = planBackground(clips, audio.duration);
    if (!plan) break;
    try {
      const list = await renderPieces(plan, {
        width, height, overlay: style.overlay, band: textBand(layout, cues, style), cwd: workDir, signal, onProgress: progress,
      });
      bgArgs = ['-f', 'concat', '-safe', '0', '-i', list];
      break;
    } catch (err) {
      if (signal?.aborted || !err.clips) throw err;
      const bad = await findBrokenClips(err.clips);
      if (!bad.length) throw err;
      console.warn(`[render] skipping undecodable clip(s): ${bad.map((c) => c.id || c.path).join(', ')}`);
      clips = clips.filter((c) => !bad.includes(c));
    }
  }
  const usedClips = plan ? plan.clips : [];
  if (!plan) {
    weights.render += weights.clips;
    weights.clips = 0;
    bgArgs = gradientInput({ width, height, duration: audio.duration + 0.5, seed: spec.seed, overlay: style.overlay });
  }

  const footage = footageCredit(usedClips);
  // QuranEnc's terms ask for the source and the translation's version number.
  const translationCredit = trFont && spec.translation.version ? ` (translation v${spec.translation.version})` : '';
  const credit = [
    `Quran text${trFont ? ' & translation' : ''}: QuranEnc.com${translationCredit}`,
    'Recitation: EveryAyah.com',
    ...(footage ? [`Footage: ${footage}`] : []),
  ].join('  ·  ');
  const header = style.showSurahTitle
    ? { nameAr: /^سورة/.test(spec.surah.nameAr) ? spec.surah.nameAr : `سورة ${spec.surah.nameAr}`, nameEn: spec.surah.nameEn }
    : null;
  const ass = buildAss({
    layout,
    fonts: {
      arabic: FONTS[arabicKey].family,
      translation: trFont?.family,
      arabicUi: 'Amiri',
      ui: 'Noto Sans',
      uiMedium: 'Noto Sans Medium',
    },
    position: style.position,
    cues,
    header,
    footer: { reciter: showFooterReciter ? spec.reciter : null, credit },
    duration: audio.duration,
  });
  await fsp.writeFile(path.join(workDir, 'subs.ass'), ass);
  await fsp.writeFile(path.join(workDir, 'cues.json'), JSON.stringify(cues, null, 1));

  // 4. Final pass: background + text + audio → H.264/AAC.
  stage('render');
  await runFfmpeg(
    [
      ...bgArgs,
      '-i', path.basename(audio.file),
      '-filter_complex', '[0:v]ass=subs.ass:fontsdir=fonts:shaping=complex,format=yuv420p[v]',
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      // Capped CRF keeps busy footage share-friendly (≈ 8 Mb/s at 1080p, 5 Mb/s at 720p).
      ...(Math.min(width, height) >= 1000 ? ['-maxrate', '8M', '-bufsize', '16M'] : ['-maxrate', '5M', '-bufsize', '10M']),
      '-r', String(FPS), '-g', String(FPS * 2),
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
      '-t', audio.duration.toFixed(3), '-shortest', '-movflags', '+faststart',
      'out.mp4',
    ],
    { cwd: workDir, signal, onProgress: (s) => progress(s / audio.duration) },
  );

  // 5. Verify, thumbnail, move into place.
  stage('finalize');
  const out = path.join(workDir, 'out.mp4');
  const info = await probe(out);
  if (!info.hasVideo || !info.hasAudio || Math.abs(info.duration - audio.duration) > 0.5) {
    throw new Error(`Output check failed: ${JSON.stringify(info)} (expected ${audio.duration.toFixed(2)} s)`);
  }
  const firstAyahCue = cues.find((c) => c.ayah > 0) || cues[0];
  const thumbAt = firstAyahCue ? (firstAyahCue.start + firstAyahCue.end) / 2 : audio.duration / 2;
  await runFfmpeg(
    ['-ss', thumbAt.toFixed(2), '-i', 'out.mp4', '-frames:v', '1', '-vf', `scale=${Math.round(width / 2)}:-2`, '-q:v', '3', 'thumb.jpg'],
    { cwd: workDir, signal },
  );
  await fsp.mkdir(path.dirname(spec.outFile), { recursive: true });
  await fsp.rename(out, spec.outFile);
  await fsp.rename(path.join(workDir, 'thumb.jpg'), spec.thumbFile);
  const { size } = await fsp.stat(spec.outFile);
  stage('done');
  if (!spec.keepWorkDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});

  const credits = [];
  const seen = new Set();
  for (const c of usedClips) {
    if (c.provider === 'upload') continue; // the user's own footage needs no credit
    const key = `${c.provider}|${c.author}|${c.sourceUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    credits.push({ provider: c.provider, author: c.author || null, sourceUrl: c.sourceUrl || null });
  }
  return { duration: info.duration, sizeBytes: size, credits, timings, cues };
}

/**
 * Extra-dark band behind the tallest text block, so text stays legible over bright
 * footage (sky, snow, clouds). Strength follows the user's overlay setting.
 */
function textBand(layout, cues, style) {
  if (style.overlay <= 0) return null;
  const tallest = Math.max(...cues.map((c) => estimateBlockHeight(layout, c.arabic, c.translation)));
  const pad = layout.height * 0.03;
  const half = Math.min(tallest, layout.main.height) / 2 + pad;
  const [top, bottom] = style.position === 'lower'
    ? [layout.main.bottom - 2 * half + pad, layout.main.bottom + pad]
    : [layout.main.centerY - half, layout.main.centerY + half];
  return { top, bottom, feather: layout.height * 0.09, strength: 0.15 + 0.35 * style.overlay };
}

/** The requested Quran font, or the other one if the requested font lacks a glyph. */
async function pickArabicFont(choice, items) {
  const wanted = ARABIC_FONTS[choice] || ARABIC_FONTS.amiri;
  const text = items.map((it) => quranDisplayText(it.arabic)).join(' ');
  const missing = await missingChars(wanted, text);
  if (!missing.length) return wanted;
  const other = Object.values(ARABIC_FONTS).find((k) => k !== wanted);
  if (!(await missingChars(other, text)).length) {
    console.warn(`[render] ${FONTS[wanted].family} lacks ${missing.join(' ')} — using ${FONTS[other].family}`);
    return other;
  }
  return wanted;
}

/**
 * Translation text → font runs: presentation forms normalized, glyphs missing from the
 * translation font routed to a fallback font, and a direction mark so libass picks the
 * right paragraph direction.
 */
async function addTranslationRuns(cues, fontKey, rtl) {
  const fallbacks = TRANSLATION_FALLBACKS.filter((k) => k !== fontKey);
  const mark = rtl ? '\u200F' : '\u200E';
  for (const cue of cues) {
    if (!cue.translation) continue;
    const runs = await splitByCoverage(mark + normalizePresentationForms(cue.translation), fontKey, fallbacks);
    cue.translationRuns = runs.map((r) => ({ text: r.text, family: r.key ? FONTS[r.key].family : null }));
  }
}

async function findBrokenClips(clips) {
  const bad = [];
  for (const clip of clips) {
    try {
      const info = await probe(clip.path);
      if (!info.hasVideo || !(info.duration > 0)) bad.push(clip);
    } catch {
      bad.push(clip);
    }
  }
  return bad;
}
