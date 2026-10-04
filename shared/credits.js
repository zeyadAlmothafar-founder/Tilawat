// The footer credit line burned into videos (server renderer and web build) and per-clip
// credits for video records. Pure, dependency-free ESM (Node + browser).

const PROVIDERS = { pexels: 'Pexels', pixabay: 'Pixabay', nasa: 'NASA' };

/**
 * The one credit QuranEnc's terms ask for: the source, plus the translation's version.
 * "Translation & tafsir: QuranEnc.com (v1.1.2)", "Translation: …", "Tafsir: …" or "Quran text: …".
 * Mirrored in public/js/create.js (previewCredit) for the live preview.
 */
export function minimalCredit(translation, tafsirOn) {
  const label = translation && tafsirOn ? 'Translation & tafsir' : translation ? 'Translation' : tafsirOn ? 'Tafsir' : 'Quran text';
  const version = translation?.version ? ` (v${translation.version})` : '';
  return `${label}: QuranEnc.com${version}`;
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

/**
 * Footer credit for `credits` ('minimal' | 'full' | 'none'). `translation` must be null unless
 * translation text is actually shown; `tafsir` ({ title }) null unless tafsir cards are shown.
 */
export function creditLine({ credits, translation, tafsir, clips = [] }) {
  if (credits === 'full') {
    const footage = footageCredit(clips);
    // QuranEnc's terms ask for the source and the translation's version number.
    const translationCredit = translation && translation.version ? ` (translation v${translation.version})` : '';
    let credit = [
      `Quran text${translation ? ' & translation' : ''}: QuranEnc.com${translationCredit}`,
      'Recitation: EveryAyah.com',
      ...(footage ? [`Footage: ${footage}`] : []),
    ].join('  ·  ');
    if (tafsir) credit += `\nTafsir: ${tafsir.title} (QuranEnc.com)`;
    return credit;
  }
  if (credits === 'minimal') return minimalCredit(translation, Boolean(tafsir));
  return '';
}

/** Per-clip credits for a video record (deduplicated; the user's own uploads need none). */
export function clipCredits(clips) {
  const credits = [];
  const seen = new Set();
  for (const c of clips) {
    if (c.provider === 'upload') continue;
    const key = `${c.provider}|${c.author}|${c.sourceUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    credits.push({ provider: c.provider, author: c.author || null, sourceUrl: c.sourceUrl || null });
  }
  return credits;
}
