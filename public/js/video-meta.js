// Display helpers for video records (shared by My Videos, the share modal and the share page).
import { t, isRtl } from './i18n.js';

export const isActive = (video) => video.status === 'queued' || video.status === 'running';

/** Surah name parts: Arabic, transliteration, and the one to lead with in this UI. */
export function surahNames(video) {
  const s = video.surah || {};
  const ar = s.nameAr || '';
  const latin = s.nameEn || (s.number ? `${s.number}` : '');
  return { ar, latin, primary: isRtl() ? ar || latin : latin || ar, number: s.number };
}

export function rangeLabel(video) {
  return video.from === video.to
    ? t('videos.ayahSingle', { ayah: video.from })
    : t('videos.ayahRange', { from: video.from, to: video.to });
}

export function reciterName(video) {
  const r = video.reciter || {};
  return (isRtl() ? r.nameAr || r.nameEn : r.nameEn || r.nameAr) || r.id || '';
}

/** One-line title, e.g. "Al-Fatihah · Ayat 1–7". */
export function videoTitle(video) {
  return `${surahNames(video).primary} · ${rangeLabel(video)}`;
}

/** Friendly ASCII download name, e.g. "quran-001-al-fatihah-1-7.mp4". */
export function videoFileName(video) {
  const n = String(video.surah?.number || 0).padStart(3, '0');
  const slug = (video.surah?.nameEn || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const range = video.from === video.to ? `${video.from}` : `${video.from}-${video.to}`;
  return `quran-${n}${slug ? `-${slug}` : ''}-${range}.mp4`;
}

/** Localized share message (without the link). */
export function shareText(video) {
  const { primary, number } = surahNames(video);
  const vars = { surah: primary, number: number ?? '', ayah: video.from, from: video.from, to: video.to, reciter: reciterName(video) };
  const text = t(video.from === video.to ? 'share.textSingle' : 'share.textRange', vars);
  // Videos without full on-screen credits carry their sources in the share text instead.
  const credits = video.request?.style?.credits;
  return credits && credits !== 'full' ? `${text}
${t('share.sources', { list: sourceList(video) })}` : text;
}

const PROVIDER_NAMES = { pixabay: 'Pixabay', pexels: 'Pexels', nasa: 'NASA' };

/** "QuranEnc.com · EveryAyah.com · Pixabay" for the sources a video used. */
function sourceList(video) {
  const footage = [...new Set((video.credits || []).map((c) => PROVIDER_NAMES[c.provider]).filter(Boolean))];
  return ['QuranEnc.com', 'EveryAyah.com', ...footage].join(' · ');
}

/** Tafsir edition burned into the video ({ key, title, languageIso, direction }) or null. */
export const videoTafsir = (video) => (video?.tafsir && typeof video.tafsir === 'object' && video.tafsir.key ? video.tafsir : null);

/** Small "Tafsir" pill for videos rendered with tafsir cards (null otherwise). */
export function tafsirBadge(video) {
  const tf = videoTafsir(video);
  if (!tf) return null;
  const el = document.createElement('span');
  el.className = 'pill pill-tafsir';
  el.textContent = t('videos.tafsirBadge');
  el.title = t('videos.tafsirTitle', { title: tf.title || tf.key });
  return el;
}

export const videoFileUrl =(video) => video.url || `/output/${encodeURIComponent(video.id)}.mp4`;
