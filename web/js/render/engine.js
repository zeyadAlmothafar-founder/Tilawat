// The render itself (runs inside the Worker, or on the main thread as a fallback):
// fonts → layout → audio timeline → cues/cards → footage → frames → MP4.
// Input: the render job (docs/WEB.md) + decoded recitation parts from audio.js.

import { ARABIC_FONTS, TRANSLATION_FALLBACKS, translationFont, detectScript, loadFonts, normalizePresentationForms } from './fonts.js';
import {
  buildLayout, createMeasurer, chunkAyah, layoutBlock, splitTafsir, layoutCard, baseLength,
} from './layout.js';
import {
  cueSprite, cardSprite, headerSprite, footerSprite, creditLines, ayahMarker, quranDisplayText, makeCanvas, ctx2d, setCanvasMode,
} from './text.js';
import { buildTrack, RATE } from './audio.js';
import { openClips, FootageBackground, GradientBackground, lookOverlay, FPS } from './compositor.js';
import { createEncoder } from './encoder.js';

const TEXT_FADE = 0.3;
const CARD_FADE = 0.4;
const HEADER_FADE = [0.9, 0.7];

// Tafsir cards (server/render/cards.js)
const MIN_CARD_SECONDS = 4;
const CARD_LEAD = 0.15;
const CARD_TRAIL = 0.3;

function wordCount(text) {
  const script = detectScript(text);
  if (script === 'han' || script === 'kana') return baseLength(text) / 1.5;
  if (['thai', 'khmer', 'lao', 'myanmar'].includes(script)) return baseLength(text) / 5;
  return String(text).split(/\s+/).filter(Boolean).length;
}
export const readingSeconds = (text) => Math.max(MIN_CARD_SECONDS, wordCount(text) / 2.8 + 1.5);

const EASTERN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const DIGITS_BY_LANGUAGE = { ar: ARABIC_DIGITS, ku: ARABIC_DIGITS, fa: EASTERN_DIGITS, ur: EASTERN_DIGITS, ps: EASTERN_DIGITS, prs: EASTERN_DIGITS };

function cardLabel(tafsir, surah, from, to, arabicScript) {
  const range = from === to ? String(from) : `${from}–${to}`;
  const label = tafsir.label || tafsir.title || 'Tafsir';
  if (!arabicScript) return `${label.toUpperCase()}  ·  ${surah}:${range}`;
  const digits = DIGITS_BY_LANGUAGE[tafsir.languageIso];
  return `${label} (${digits ? range.replace(/\d/g, (d) => digits[d]) : range})`;
}

const abortError = () => new DOMException('Render canceled', 'AbortError');
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const fade = (t, start, end, fin, fout) => clamp01(Math.min((t - start) / fin, (end - t) / fout));

function hashSeed(id) {
  let h = 0;
  for (const ch of String(id || '')) h = (h * 31 + ch.codePointAt(0)) | 0;
  return Math.abs(h);
}

/**
 * Render a job. `parts` = decoded recitations (one per job.items entry).
 * onProgress(stage, overall 0..1) — this function covers [range[0], 1].
 */
export async function runRender(job, parts, { onProgress = () => {}, signal, range = [0.1, 1] } = {}) {
  const t0 = performance.now();
  const timings = {};
  const [p0] = range;
  const W = { clips: 0.15, render: 0.72, finalize: 0.03 };
  const scaleW = (1 - p0) / (W.clips + W.render + W.finalize);
  const stageBase = { clips: p0, render: p0 + W.clips * scaleW, finalize: p0 + (W.clips + W.render) * scaleW };
  const report = (stage, f) => onProgress(stage, Math.min(1, stageBase[stage] + W[stage] * scaleW * clamp01(f)));
  const check = () => {
    if (signal?.aborted) throw abortError();
  };

  const { width, height } = job;
  const style = { textScale: 1, position: 'center', overlay: 0.45, showSurahTitle: true, showReciter: true, ...(job.style || {}) };
  const items = job.items.map((it) => ({
    ...it,
    arabic: quranDisplayText(it.arabic),
    translation: it.translation ? normalizePresentationForms(it.translation).trim() : null,
    tafsirText: it.tafsirText ? normalizePresentationForms(it.tafsirText).trim() : null,
    isBismillah: it.kind === 'bismillah',
  }));

  // 1. Fonts
  const arabicKey = ARABIC_FONTS[style.arabicFont] || 'amiriQuran';
  const trSample = items.map((it) => it.translation || '').join(' ').trim();
  const trFont = job.translation && trSample ? translationFont(trSample, job.translation.languageIso) : null;
  const trRtl = trFont ? (job.translation.direction ? job.translation.direction === 'rtl' : trFont.rtl) : false;
  const tafSample = items.map((it) => it.tafsirText || '').join(' ').trim();
  const tafsirOn = Boolean(job.tafsir && tafSample);
  const tafFont = tafsirOn ? translationFont(tafSample, job.tafsir.languageIso) : null;
  const tafRtl = tafsirOn ? (job.tafsir.direction ? job.tafsir.direction === 'rtl' : tafFont.rtl) : false;
  const labelArabic = tafsirOn && tafFont.script === 'arabic';
  const labelFont = tafsirOn ? (labelArabic ? 'amiriBold' : 'notoSansSemiBold') : null;
  const texts = {};
  if (trFont) texts[trFont.key] = trSample;
  if (tafFont) texts[tafFont.key] = (texts[tafFont.key] || '') + tafSample;
  const failedFonts = await loadFonts(
    [arabicKey, 'amiriQuran', 'amiri', 'amiriBold', 'notoSans', 'notoSansMedium', ...TRANSLATION_FALLBACKS, trFont?.key, tafFont?.key, labelFont],
    { texts, signal },
  );
  check();
  timings.fonts = (performance.now() - t0) / 1000;

  // 2. Layout
  const m = createMeasurer(makeCanvas(16, 16).getContext('2d'));
  const showFooterReciter = Boolean(style.showReciter && job.reciter);
  const fontsSpec = {
    arabic: arabicKey,
    translation: trFont?.key || null,
    translationRtl: trRtl,
    tafsir: tafFont?.key || null,
    tafsirRtl: tafRtl,
    tafsirLabel: labelFont,
    tafsirLabelArabic: labelArabic,
  };
  let layout = buildLayout({ width, height, aspect: job.aspect, style, fonts: fontsSpec, showHeader: style.showSurahTitle, showFooter: showFooterReciter });
  const credit = String(job.credit || '');
  const nCredit = creditLines(m, layout, credit).length;
  layout = buildLayout({ width, height, aspect: job.aspect, style, fonts: fontsSpec, showHeader: style.showSurahTitle, showFooter: showFooterReciter, creditLines: nCredit });

  // 3. Tafsir cards decide the silent gaps
  for (const it of items) {
    it.cards = tafsirOn && it.tafsirText
      ? splitTafsir(m, layout, it.tafsirText).map((text) => ({ text, duration: Math.round(readingSeconds(text) * 100) / 100 }))
      : [];
  }
  const gaps = items.map((it) => (it.cards.length ? CARD_LEAD + it.cards.reduce((s, c) => s + c.duration, 0) + CARD_TRAIL : 0));

  // 4. Audio track + timeline
  const audio = buildTrack(parts, gaps);
  const duration = audio.duration;
  check();

  // 5. Cues (chunked ayat) and cards
  const withTranslation = Boolean(trFont);
  const cues = [];
  items.forEach((item, i) => {
    const { start, end } = audio.timeline[i];
    const marker = item.isBismillah || item.ayah == null ? null : ayahMarker(item.ayah);
    const chunks = chunkAyah(m, layout, item.arabic, withTranslation ? item.translation : null, marker);
    let t = start;
    chunks.forEach((c, j) => {
      const last = j === chunks.length - 1;
      const cEnd = last ? end : t + (end - start) * c.weight;
      cues.push({
        start: t,
        end: cEnd,
        block: layoutBlock(m, layout, c.words, last ? marker : null, withTranslation ? c.translation : null),
        marker: last && marker ? item.ayah : null,
        ayah: item.isBismillah ? 0 : item.ayah,
      });
      t = cEnd;
    });
  });
  const endsWithCard = items[items.length - 1]?.cards.length > 0;
  if (cues.length) {
    cues[0].start = Math.min(cues[0].start, 0.15);
    if (!endsWithCard) cues[cues.length - 1].end = Math.max(cues[cues.length - 1].end, duration - 0.25);
  }
  const cards = [];
  items.forEach((item, i) => {
    if (!item.cards.length) return;
    const from = item.tafsirFrom ?? item.ayah;
    const to = item.tafsirTo ?? item.ayah;
    const label = cardLabel(job.tafsir, job.surah.number, from, to, labelArabic);
    let t = audio.timeline[i].end + CARD_LEAD;
    for (const c of item.cards) {
      cards.push({ start: t, end: t + c.duration, text: c.text, label, block: layoutCard(m, layout, c.text) });
      t += c.duration;
    }
  });
  if (endsWithCard) cards[cards.length - 1].end = Math.max(cards[cards.length - 1].end, duration - 0.25);
  timings.layout = (performance.now() - t0) / 1000 - timings.fonts;

  // 6. Footage
  report('clips', 0);
  const totalFrames = Math.max(1, Math.ceil(duration * FPS));
  let background;
  const clips = await openClips(job.clips || [], { signal, onProgress: (f) => report('clips', f) });
  check();
  if (clips.length) background = new FootageBackground(clips, totalFrames + 1, width, height);
  else background = new GradientBackground(width, height, hashSeed(job.id));
  report('clips', 1);
  timings.clips = (performance.now() - t0) / 1000 - timings.fonts - timings.layout;

  // 7. Look: overlay with a darker band behind the tallest text block
  let band = null;
  const overlay = Number(style.overlay ?? 0.45);
  if (clips.length && overlay > 0) {
    const tallest = Math.max(0, ...cues.map((c) => c.block.height), ...cards.map((c) => c.block.height));
    const pad = height * 0.03;
    const half = Math.min(tallest, layout.main.height) / 2 + pad;
    const [top, bottom] = layout.position === 'lower'
      ? [layout.main.bottom - 2 * half + pad, layout.main.bottom + pad]
      : [layout.main.centerY - half, layout.main.centerY + half];
    band = { top, bottom, feather: height * 0.09, strength: 0.15 + 0.35 * overlay };
  }
  const lookOptions = { overlay: clips.length ? overlay : Math.max(0, overlay - 0.45) * 0.6, band };
  const headerInfo = style.showSurahTitle && job.surah
    ? { nameAr: /^سورة/.test(job.surah.nameAr || '') ? job.surah.nameAr : `سورة ${job.surah.nameAr || ''}`.trim(), nameEn: job.surah.nameEn }
    : null;

  // A "surface" = the frame canvas plus everything composited onto it, all with the same
  // backing ('gpu' or 'cpu'): mixing them would force a readback per draw.
  const surfaces = {};
  const useSurface = (mode) => {
    setCanvasMode(mode);
    if (!surfaces[mode]) {
      const canvas = makeCanvas(width, height);
      surfaces[mode] = {
        mode,
        canvas,
        ctx: ctx2d(canvas, { alpha: false }),
        look: lookOverlay(width, height, lookOptions),
        header: headerInfo ? headerSprite(m, layout, headerInfo) : null,
        footer: footerSprite(m, layout, { reciter: showFooterReciter ? job.reciter : null, credit }),
        sprites: new Map(),
      };
    }
    return surfaces[mode];
  };
  // Encoding reads each frame back from the canvas. On most machines a GPU canvas is
  // fastest (zero-copy into the hardware encoder), but where GPU readback is slow a CPU
  // canvas wins by far — so in 'auto' mode both are timed on real frames and the faster
  // one is kept.
  const forcedMode = job.debug?.canvasMode;
  let surface = useSurface(forcedMode === 'cpu' ? 'cpu' : 'gpu');
  const tuner = { auto: !forcedMode, phase: 'gpu', start: 0, gpu: 0, cpu: 0, frames: 0 };
  const TUNE_WARMUP = 15;
  const TUNE_WINDOW = 45;
  const SLOW_MS = 22;

  // 8. Frames
  const enc = await createEncoder({ width, height, fileSize: job.fileSize, fps: FPS, forceWasmAac: Boolean(job.debug?.forceWasmAac) });
  report('render', 0);
  const firstAyahCue = cues.find((c) => c.ayah > 0) || cues[0];
  const thumbAt = firstAyahCue ? Math.max(firstAyahCue.start + 0.4, firstAyahCue.start + (firstAyahCue.end - firstAyahCue.start) / 3) : duration / 2;
  const thumbFrame = Math.min(totalFrames - 1, Math.round(thumbAt * FPS));
  let thumbBlob = null;
  const spriteFor = (obj, make) => {
    let s = surface.sprites.get(obj);
    if (!s) {
      s = make();
      surface.sprites.set(obj, s);
    }
    return s;
  };
  const audioChunk = RATE; // 1 s
  let audioPos = 0;
  const tRender = performance.now();
  const prof = { background: 0, encode: 0 };
  let lastReport = 0;
  try {
    for (let f = 0; f < totalFrames; f++) {
      if (signal?.aborted) throw abortError();
      const t = f / FPS;
      const { ctx, canvas, look, header, footer, sprites } = surface;
      let tp = performance.now();
      await background.draw(ctx, f);
      prof.background += performance.now() - tp;
      ctx.drawImage(look, 0, 0);
      const hf = fade(t, 0, duration, HEADER_FADE[0], HEADER_FADE[1]);
      if (header && hf > 0) {
        ctx.globalAlpha = hf;
        ctx.drawImage(header.canvas, 0, layout.header.y - header.pad);
      }
      if (footer && hf > 0) {
        ctx.globalAlpha = hf;
        ctx.drawImage(footer.canvas, 0, layout.footer.y - footer.height - footer.pad);
      }
      for (const cue of cues) {
        if (t < cue.start || t >= cue.end) {
          if (t >= cue.end && sprites.has(cue)) sprites.delete(cue);
          continue;
        }
        const s = spriteFor(cue, () => cueSprite(m, layout, cue));
        const top = layout.position === 'lower' ? layout.main.bottom - s.height : layout.main.centerY - s.height / 2;
        ctx.globalAlpha = fade(t, cue.start, cue.end, TEXT_FADE, TEXT_FADE);
        ctx.drawImage(s.canvas, 0, Math.round(top - s.pad));
      }
      for (const card of cards) {
        if (t < card.start || t >= card.end) {
          if (t >= card.end && sprites.has(card)) sprites.delete(card);
          continue;
        }
        const s = spriteFor(card, () => cardSprite(m, layout, card));
        const top = layout.position === 'lower' ? layout.main.bottom - s.height : layout.main.centerY - s.height / 2;
        ctx.globalAlpha = fade(t, card.start, card.end, CARD_FADE, CARD_FADE);
        ctx.drawImage(s.canvas, 0, Math.round(top - s.pad));
      }
      ctx.globalAlpha = 1;

      if (f === thumbFrame) {
        const tc = makeCanvas(Math.round(width / 2), Math.round(height / 2));
        const tctx = ctx2d(tc);
        tctx.imageSmoothingQuality = 'high';
        tctx.drawImage(canvas, 0, 0, tc.width, tc.height);
        thumbBlob = tc.convertToBlob
          ? await tc.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
          : await new Promise((r) => tc.toBlob(r, 'image/jpeg', 0.85));
      }

      // Keep audio roughly in step with video (bounded muxer buffering).
      const audioTarget = Math.min(audio.length, Math.ceil((t + 1) * RATE));
      while (audioPos < audioTarget) {
        const to = Math.min(audio.length, audioPos + audioChunk);
        await enc.addAudio(audio.channels, audioPos, to);
        audioPos = to;
      }
      tp = performance.now();
      await enc.addFrame(canvas, t, 1 / FPS);
      prof.encode += performance.now() - tp;

      if (tuner.auto) {
        // Time frames TUNE_WARMUP..+TUNE_WINDOW on the GPU surface; if slow, try the CPU
        // surface for a window and keep whichever was faster.
        const now = performance.now();
        if (f === TUNE_WARMUP || f === tuner.cpuFrom) tuner.start = now;
        if (f === TUNE_WARMUP + TUNE_WINDOW) {
          tuner.gpu = (now - tuner.start) / TUNE_WINDOW;
          if (tuner.gpu > SLOW_MS) {
            surface = useSurface('cpu');
            tuner.cpuFrom = f + 5; // let the new surface warm up
          } else tuner.auto = false;
        } else if (tuner.cpuFrom && f === tuner.cpuFrom + TUNE_WINDOW) {
          tuner.cpu = (now - tuner.start) / TUNE_WINDOW;
          if (tuner.cpu > tuner.gpu * 0.85) surface = useSurface('gpu');
          tuner.auto = false;
        }
      }
      if (f - lastReport >= 10) {
        lastReport = f;
        report('render', f / totalFrames);
      }
    }
    while (audioPos < audio.length) {
      const to = Math.min(audio.length, audioPos + audioChunk);
      await enc.addAudio(audio.channels, audioPos, to);
      audioPos = to;
    }
    check();
    timings.render = (performance.now() - tRender) / 1000;
    timings.backgroundDraw = prof.background / 1000;
    timings.encodeWait = prof.encode / 1000;
    timings.canvas = { final: surface.mode, gpuMsPerFrame: +tuner.gpu.toFixed(1), cpuMsPerFrame: +tuner.cpu.toFixed(1) };
    report('finalize', 0);
    const blob = await enc.finalize();
    report('finalize', 1);
    timings.total = (performance.now() - t0) / 1000;
    return {
      blob,
      thumbBlob,
      duration,
      width,
      height,
      sizeBytes: blob.size,
      // Extras (diagnostics)
      timings,
      speed: duration / timings.total,
      aac: enc.aac,
      clipsUsed: background.usedClips.map((c) => ({ url: c.url, provider: c.provider, author: c.author })),
      cues: cues.map((c) => ({ start: c.start, end: c.end, ayah: c.ayah, lines: c.block.arLines.length, trLines: c.block.trLines.length, trScale: c.block.trScale })),
      cards: cards.map((c) => ({ start: c.start, end: c.end, lines: c.block.lines.length, scale: c.block.scale })),
      timeline: audio.timeline,
      loudness: audio.loudness,
      failedFonts,
    };
  } catch (err) {
    await enc.cancel();
    throw err;
  } finally {
    background.close();
    setCanvasMode('gpu');
  }
}
