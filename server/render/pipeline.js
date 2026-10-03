import fsp from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg, probe } from '../lib/ffmpeg.js';
import { buildAudioTrack } from './audio.js';
import { planBackground, renderPieces, gradientInput, FPS } from './background.js';
import {
  ARABIC_FONTS, FONTS, translationFont, prepareJobFonts, missingChars, splitByCoverage, normalizePresentationForms,
} from './fonts.js';
import { buildLayout, chunkAyah, estimateBlockHeight, tafsirCardHeight, wrapTafsirText, wrapTranslationText } from './layout.js';
import { buildAss, quranDisplayText } from './subtitles.js';
import { planCards, gapSeconds, placeCards } from './cards.js';

// Fonts tried (in order) for translation characters the main translation font lacks.
const TRANSLATION_FALLBACKS = ['notoSans', 'naskh', 'amiri'];

// Share of overall progress per stage (background weight moves to "render" when there
// are no clips to prepare).
const WEIGHTS = { audio: 0.05, text: 0.02, clips: 0.38, render: 0.5, finalize: 0.05 };

const PROVIDERS = { pexels: 'Pexels', pixabay: 'Pixabay', nasa: 'NASA' };

// File-size presets. The footage is darkened and the text is static, so higher CRF values
// stay clean; a light denoise on the background (before the text is drawn) and a bitrate cap
// keep busy clips (waves, clouds) from ballooning.
const ENCODE = {
  small: { preset: 'medium', crf: 30, maxrate: ['1.5M', '1M'], audio: '96k', gop: 4, denoise: 'hqdn3d=3:3:8:8,' },
  balanced: { preset: 'medium', crf: 26, maxrate: ['3M', '2M'], audio: '128k', gop: 4, denoise: 'hqdn3d=2:2:6:6,' },
  high: { preset: 'veryfast', crf: 21, maxrate: ['8M', '5M'], audio: '192k', gop: 2, denoise: '' },
};

function encodeArgs(fileSize, hd) {
  const e = ENCODE[fileSize] || ENCODE.balanced;
  const maxrate = e.maxrate[hd ? 0 : 1];
  return [
    '-c:v', 'libx264', '-preset', e.preset, '-crf', String(e.crf), '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-maxrate', maxrate, '-bufsize', `${parseFloat(maxrate) * 2}M`,
    '-r', String(FPS), '-g', String(FPS * e.gop),
    '-c:a', 'aac', '-b:a', e.audio, '-ar', '44100',
  ];
}

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

function buildCues(items, timeline, layout, duration, withTranslation, endsWithCard = false) {
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
        translation: wrapTranslationText(layout, c.translation, translationScale),
        translationScale,
        marker: last && !item.isBismillah ? item.ayah : null,
        ayah: item.isBismillah ? 0 : item.ayah,
      });
      t = cEnd;
    });
  });
  // Show the first text right away and keep the last one through the audio tail (unless
  // a tafsir card follows the last ayah — then the card stays through the tail).
  if (cues.length) {
    cues[0].start = Math.min(cues[0].start, 0.15);
    if (!endsWithCard) cues[cues.length - 1].end = Math.max(cues[cues.length - 1].end, duration - 0.25);
  }
  return cues;
}

const EASTERN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const DIGITS_BY_LANGUAGE = { ar: ARABIC_DIGITS, ku: ARABIC_DIGITS, fa: EASTERN_DIGITS, ur: EASTERN_DIGITS, ps: EASTERN_DIGITS, prs: EASTERN_DIGITS };

/** "AT-TAFSIR AL-MUYASSAR · 2:255" / "التفسير الميسر (٢٥٥)" — the label above a card. */
function cardLabel(tafsir, surah, from, to, arabicScript) {
  const range = from === to ? String(from) : `${from}–${to}`;
  if (!arabicScript) return `${tafsir.label.toUpperCase()}  ·  ${surah}:${range}`;
  const digits = DIGITS_BY_LANGUAGE[tafsir.languageIso];
  const local = digits ? range.replace(/\d/g, (d) => digits[d]) : range;
  return `${tafsir.label} (${local})`;
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

  // 1. Fonts and layout first: the tafsir cards' reading time decides the silent pauses
  // in the audio track.
  const items = [...(spec.bismillah ? [{ ...spec.bismillah, isBismillah: true }] : []), ...spec.ayahs];
  const arabicKey = await pickArabicFont(style.arabicFont, items);
  const sample = spec.ayahs.map((a) => a.translation || '').join(' ').trim();
  const trFont = spec.translation && sample ? translationFont(sample, spec.translation.languageIso) : null;
  const tafsirSample = spec.ayahs.map((a) => a.tafsir?.text || '').join(' ').trim();
  const tafsirOn = Boolean(spec.tafsir && tafsirSample);
  const tafFont = tafsirOn ? translationFont(tafsirSample, spec.tafsir.languageIso) : null;
  const labelArabic = tafsirOn && tafFont.script === 'arabic';
  let labelFont = null;
  if (tafsirOn) {
    if (!labelArabic) labelFont = { key: 'notoSansSemiBold', bold: false };
    else if ((await missingChars('amiriBold', spec.tafsir.label)).length) labelFont = { key: 'naskh', bold: false };
    else labelFont = { key: 'amiriBold', bold: true };
  }
  await prepareJobFonts(
    [
      arabicKey, 'amiri', 'amiriBold', 'notoSans', 'notoSansMedium', ...TRANSLATION_FALLBACKS,
      ...(trFont ? [trFont.key] : []), ...(tafFont ? [tafFont.key, labelFont.key] : []),
    ],
    path.join(workDir, 'fonts'),
  );
  const showFooterReciter = style.showReciter && Boolean(spec.reciter);
  const layout = buildLayout({
    width, height, aspect: spec.aspect, style,
    fonts: { arabic: arabicKey, translation: trFont?.key || null, tafsir: tafFont?.key || null, tafsirLabelArabic: labelArabic },
    showHeader: style.showSurahTitle,
    showFooter: showFooterReciter,
    // Full credits: the tafsir credit gets its own line; on narrow 9:16 the main credit usually wraps too.
    creditLines: { none: 0, minimal: 1 }[style.credits] ?? (tafsirOn ? (spec.aspect === '9:16' ? 3 : 2) : 1),
  });
  for (const item of items) item.cards = tafsirOn && item.tafsir ? planCards(layout, item.tafsir.text) : [];

  // 2. Audio: (Bismillah) + ayat (+ silence while tafsir cards show), exact timeline.
  const audio = await buildAudioTrack(items.map((it) => it.audio), {
    cwd: workDir, signal, gaps: items.map((it) => gapSeconds(it.cards)),
  });

  // 3. Text: chunked cues + tafsir cards → subs.ass
  stage('text');
  const endsWithCard = items[items.length - 1].cards.length > 0;
  const cues = buildCues(items, audio.timeline, layout, audio.duration, Boolean(trFont), endsWithCard);
  if (trFont) {
    const rtl = spec.translation.direction ? spec.translation.direction === 'rtl' : trFont.rtl;
    await addTranslationRuns(cues, trFont.key, rtl);
  }
  const cards = [];
  items.forEach((item, i) => {
    if (!item.cards.length) return;
    const label = cardLabel(spec.tafsir, spec.surah.number, item.tafsir.groupStart, item.tafsir.groupEnd, labelArabic);
    for (const c of placeCards(item.cards, audio.timeline[i].end)) cards.push({ ...c, text: wrapTafsirText(layout, c.text), ayah: item.ayah, label });
  });
  if (endsWithCard) cards[cards.length - 1].end = Math.max(cards[cards.length - 1].end, audio.duration - 0.25);
  if (tafsirOn) {
    const rtl = spec.tafsir.direction ? spec.tafsir.direction === 'rtl' : tafFont.rtl;
    await addTranslationRuns(cards, tafFont.key, rtl, 'text');
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
        width, height, overlay: style.overlay, band: textBand(layout, cues, cards, style), cwd: workDir, signal, onProgress: progress,
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
  let credit = '';
  if (style.credits === 'full') {
    credit = [
      `Quran text${trFont ? ' & translation' : ''}: QuranEnc.com${translationCredit}`,
      'Recitation: EveryAyah.com',
      ...(footage ? [`Footage: ${footage}`] : []),
    ].join('  ·  ');
    if (tafsirOn) credit += `\nTafsir: ${spec.tafsir.title} (QuranEnc.com)`;
  } else if (style.credits === 'minimal') {
    credit = [
      'QuranEnc.com',
      ...(trFont && spec.translation.version ? [`translation v${spec.translation.version}`] : []),
      ...(tafsirOn ? [`tafsir: ${spec.tafsir.title.split(' — ')[0]}`] : []),
    ].join('  ·  ');
  }
  const header = style.showSurahTitle
    ? { nameAr: /^سورة/.test(spec.surah.nameAr) ? spec.surah.nameAr : `سورة ${spec.surah.nameAr}`, nameEn: spec.surah.nameEn }
    : null;
  const ass = buildAss({
    layout,
    fonts: {
      arabic: FONTS[arabicKey].family,
      translation: trFont?.family,
      tafsir: tafFont?.family,
      tafsirLabel: labelFont && FONTS[labelFont.key].family,
      tafsirLabelBold: Boolean(labelFont?.bold),
      arabicUi: 'Amiri',
      ui: 'Noto Sans',
      uiMedium: 'Noto Sans Medium',
    },
    position: style.position,
    cues,
    cards,
    header,
    footer: { reciter: showFooterReciter ? spec.reciter : null, credit },
    duration: audio.duration,
  });
  await fsp.writeFile(path.join(workDir, 'subs.ass'), ass);
  await fsp.writeFile(path.join(workDir, 'cues.json'), JSON.stringify(cues, null, 1));
  if (cards.length) await fsp.writeFile(path.join(workDir, 'cards.json'), JSON.stringify(cards, null, 1));

  // 4. Final pass: background + text + audio → H.264/AAC.
  stage('render');
  await runFfmpeg(
    [
      ...bgArgs,
      '-i', path.basename(audio.file),
      '-filter_complex', `[0:v]${(ENCODE[spec.fileSize] || ENCODE.balanced).denoise}ass=subs.ass:fontsdir=fonts:shaping=complex,format=yuv420p[v]`,
      '-map', '[v]', '-map', '1:a',
      ...encodeArgs(spec.fileSize, Math.min(width, height) >= 1000),
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
  return { duration: info.duration, sizeBytes: size, credits, timings, cues, cards };
}

/**
 * Extra-dark band behind the tallest text block, so text stays legible over bright
 * footage (sky, snow, clouds). Strength follows the user's overlay setting.
 */
function textBand(layout, cues, cards, style) {
  if (style.overlay <= 0) return null;
  const tallest = Math.max(
    ...cues.map((c) => estimateBlockHeight(layout, c.arabic, c.translation)),
    ...cards.map((c) => tafsirCardHeight(layout, c.text)),
  );
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
async function addTranslationRuns(cues, fontKey, rtl, field = 'translation') {
  const fallbacks = TRANSLATION_FALLBACKS.filter((k) => k !== fontKey);
  const mark = rtl ? '\u200F' : '\u200E';
  for (const cue of cues) {
    if (!cue[field]) continue;
    // libass resolves direction per line ("\N"), so every line gets the mark.
    const text = mark + normalizePresentationForms(cue[field]).replace(/\n/g, `\n${mark}`);
    const runs = await splitByCoverage(text, fontKey, fallbacks);
    cue[`${field}Runs`] = runs.map((r) => ({ text: r.text, family: r.key ? FONTS[r.key].family : null }));
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
