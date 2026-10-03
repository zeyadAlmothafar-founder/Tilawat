// Live preview: a device-frame mock approximating the rendered video (same header, footer,
// ayah ornament and safe areas as server/render), and the scrollable "check the text" list.
import { t, fmtNumber, isRtl } from './i18n.js';
import { h, fill } from './ui.js';
import { icon } from './icons.js';
import { quranDisplayText } from './quran-text.js';

/**
 * Map ayah number → tafsir entry. An entry may explain a group of ayat
 * (groupStart..groupEnd); every ayah of the group maps to the same entry object.
 */
export function indexTafsir(entries = []) {
  const map = new Map();
  for (const e of entries) {
    if (!e || typeof e.text !== 'string' || !e.text.trim()) continue;
    const start = Number.isInteger(e.groupStart) ? e.groupStart : e.ayah;
    const end = Number.isInteger(e.groupEnd) && e.groupEnd >= start ? e.groupEnd : start;
    for (let a = start; a <= end; a++) if (!map.has(a)) map.set(a, e);
    if (Number.isInteger(e.ayah) && !map.has(e.ayah)) map.set(e.ayah, e);
  }
  return map;
}

const groupRange = (e) => {
  const from = Number.isInteger(e.groupStart) ? e.groupStart : e.ayah;
  const to = Number.isInteger(e.groupEnd) ? e.groupEnd : from;
  return { from, to };
};

/** Collapsed tafsir blocks in the "check the text" list survive re-renders. */
const collapsedTafsir = new Set();

const FONT_STACKS = {
  amiri: 'var(--font-quran)',
  scheherazade: 'var(--font-scheherazade)',
};
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toArabicDigits = (n) => String(n).replace(/\d/g, (d) => ARABIC_DIGITS[d]);
/** End-of-ayah ornament with the number inside (as burned into the video). */
const ayahMarker = (n) => `۝${toArabicDigits(n)}`;

/** Shrink long ayat so they roughly fit; the renderer splits them into several screens. */
function lengthFactor(arabic = '', translation = '') {
  const weight = arabic.length + translation.length * 0.45;
  return Math.max(0.5, Math.min(1, Math.sqrt(170 / Math.max(weight, 1))));
}

/**
 * @param {HTMLElement} frame  .device-frame element (contains the .pv-* nodes)
 * @param {object} m           view model built by create.js
 */
export function renderDevicePreview(frame, m) {
  const $ = (sel) => frame.querySelector(sel);
  frame.dataset.aspect = m.aspect;
  frame.dataset.position = m.style.position;
  frame.classList.toggle('has-translation', Boolean(m.translationIso));
  frame.style.setProperty('--pv-overlay', String(m.style.overlay));
  frame.style.setProperty('--pv-font', FONT_STACKS[m.style.arabicFont] || FONT_STACKS.amiri);

  const bg = $('.pv-bg');
  bg.dataset.cat = m.category || 'nature';
  bg.style.backgroundImage = m.backgroundUrl ? `url("${m.backgroundUrl}")` : '';
  bg.classList.toggle('has-image', Boolean(m.backgroundUrl));

  const title = $('.pv-title');
  title.hidden = !m.style.showSurahTitle || !m.surah;
  if (m.surah) {
    const nameAr = /^سورة/.test(m.surah.nameAr) ? m.surah.nameAr : `سورة ${m.surah.nameAr}`;
    fill(
      title,
      h('span', { class: 'pv-title-ar', lang: 'ar', dir: 'rtl', text: nameAr }),
      m.surah.nameEn && h('span', { class: 'pv-title-en', dir: 'ltr', text: m.surah.nameEn.toUpperCase() }),
    );
  }

  const ayah = m.ayah;
  const arabicEl = $('.pv-arabic');
  const trEl = $('.pv-translation');
  const bismillahEl = $('.pv-bismillah');
  const placeholder = $('.pv-placeholder');

  placeholder.hidden = Boolean(ayah) || m.loading;
  placeholder.textContent = m.error ? t('create.preview.textError') : t('create.preview.placeholder');
  frame.classList.toggle('is-loading', Boolean(m.loading && !ayah));

  arabicEl.hidden = !ayah;
  fill(arabicEl, ayah && quranDisplayText(ayah.arabic), ayah && ' ', ayah && h('span', { class: 'pv-marker', text: ayahMarker(ayah.ayah) }));
  const translation = (m.translationIso && ayah?.translation) || '';
  trEl.textContent = translation;
  trEl.hidden = !translation;
  trEl.setAttribute('dir', m.translationDir || 'auto');
  if (m.translationIso) trEl.lang = m.translationIso;
  else trEl.removeAttribute('lang');

  bismillahEl.textContent = quranDisplayText(m.bismillahText || '');
  bismillahEl.hidden = !(ayah && m.showBismillah && m.bismillahText);

  frame.style.setProperty('--pv-scale', String(m.style.textScale * lengthFactor(ayah?.arabic, translation)));

  // Tafsir card view: gold label + explanation, replacing the ayah screen.
  const tafsirEl = $('.pv-tafsir');
  const tf = m.view === 'tafsir' && m.tafsir ? m.tafsir : null;
  frame.classList.toggle('is-tafsir', Boolean(tf));
  tafsirEl.hidden = true;
  if (tf) {
    const ready = Boolean(tf.status === 'ready' && tf.text);
    const loading = !ready && (tf.status === 'loading' || m.loading);
    arabicEl.hidden = true;
    trEl.hidden = true;
    bismillahEl.hidden = true;
    placeholder.hidden = ready || loading;
    placeholder.textContent = t(tf.status === 'error' ? 'create.tafsir.error' : tf.status === 'ready' ? 'create.tafsir.empty' : 'create.preview.placeholder');
    frame.classList.toggle('is-loading', loading);
    tafsirEl.hidden = !ready;
    const label = tafsirEl.querySelector('.pv-tafsir-label');
    const text = tafsirEl.querySelector('.pv-tafsir-text');
    label.textContent = [tf.title, tf.ref].filter(Boolean).join(' · ');
    label.setAttribute('dir', 'auto');
    text.textContent = ready ? tf.text : '';
    text.setAttribute('dir', tf.dir || 'auto');
    if (tf.iso) text.lang = tf.iso;
    else text.removeAttribute('lang');
    const fit = Math.max(0.55, Math.min(1, Math.sqrt(480 / Math.max((tf.text || '').length, 1))));
    frame.style.setProperty('--pv-scale', String(m.style.textScale * fit));
  }

  const reciterEl = $('.pv-reciter');
  reciterEl.hidden = !m.style.showReciter || !m.reciter;
  if (m.reciter) {
    fill(
      reciterEl,
      m.reciter.nameEn && h('span', { dir: 'ltr', text: m.reciter.nameEn }),
      m.reciter.nameEn && m.reciter.nameAr && '  ·  ',
      m.reciter.nameAr && h('span', { class: 'pv-reciter-ar', lang: 'ar', dir: 'rtl', text: m.reciter.nameAr }),
    );
  }
}

/** One collapsible tafsir block (label = edition title), shown after the last ayah it explains. */
function tafsirBlock(g, entry, tafsir) {
  const { from, to } = groupRange(entry);
  const id = `${tafsir.key}:${g.surahNumber}:${from}-${to}`;
  return h(
    'details',
    {
      class: 'al-tafsir',
      open: !collapsedTafsir.has(id),
      ontoggle: (e) => {
        if (e.currentTarget.open) collapsedTafsir.delete(id);
        else collapsedTafsir.add(id);
      },
    },
    h(
      'summary',
      { class: 'al-tafsir-head' },
      icon('book', 'al-tafsir-icon'),
      h('span', { class: 'al-tafsir-label', text: t('create.tafsir.blockLabel') }),
      tafsir.title && h('span', { class: 'al-tafsir-title', dir: 'auto', text: tafsir.title }),
      icon('chevronDown', 'al-tafsir-chevron'),
    ),
    to > from && h('p', { class: 'al-tafsir-note', text: t('create.tafsir.covers', { from, to }) }),
    h('p', { class: 'al-tafsir-text', lang: tafsir.iso || null, dir: tafsir.dir || 'auto', text: entry.text.trim() }),
  );
}

/** Loading / error line for a selection's tafsir. */
function tafsirStatus(g, state, tafsir) {
  if (state?.status === 'loading') {
    return h('p', { class: 'al-status al-tafsir-status muted' }, h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), t('create.tafsir.loadingText'));
  }
  if (state?.status === 'error') {
    return h(
      'p',
      { class: 'al-status al-tafsir-status al-error' },
      h('span', { text: t('create.tafsir.error') }),
      tafsir.onRetry && h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => tafsir.onRetry(g) }, icon('refresh'), t('common.retry')),
    );
  }
  return null;
}

/**
 * groups: [{ surah, surahNumber, from, to, status: 'loading'|'error'|'ready', ayahs, translationIso, translationDir }]
 * tafsir (optional): { key, title, iso, dir, stateFor(group) → { status, entries } | null, onRetry(group) }
 */
export function renderAyahList(container, groups, { maxAyat = 300, tafsir = null } = {}) {
  let shown = 0;
  const nodes = groups.map((g) => {
    const head = h(
      'div',
      { class: 'al-head' },
      h(
        'span',
        { class: 'al-name' },
        g.surah && h('span', { class: 'ar-name', lang: 'ar', dir: 'rtl', text: g.surah.nameAr }),
        g.surah && !isRtl() && h('span', { class: 'al-latin', text: g.surah.nameEn }),
      ),
      h('span', { class: 'al-ref', text: `${fmtNumber(g.surahNumber)}:${fmtNumber(g.from)}${g.to !== g.from ? `–${fmtNumber(g.to)}` : ''}` }),
    );
    let body;
    if (g.status === 'loading') {
      body = h('p', { class: 'al-status muted' }, h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), t('create.preview.loadingText'));
    } else if (g.status === 'error') {
      body = h('p', { class: 'al-status al-error', text: t('create.preview.textError') });
    } else {
      const visible = g.ayahs.slice(0, Math.max(0, maxAyat - shown));
      shown += visible.length;
      const tState = tafsir ? tafsir.stateFor(g) : null;
      const index = tState?.status === 'ready' ? indexTafsir(tState.entries) : null;
      const items = visible.map((a, i) => {
        const entry = index?.get(a.ayah);
        // A grouped explanation is shown once, after the last listed ayah of its group.
        const showTafsir = entry && index.get(visible[i + 1]?.ayah) !== entry;
        return h(
          'li',
          { class: 'al-item' },
          h('span', { class: 'al-num', text: fmtNumber(a.ayah) }),
          h(
            'div',
            { class: 'al-texts' },
            h('p', { class: 'al-arabic quran', lang: 'ar', dir: 'rtl', text: quranDisplayText(a.arabic) }),
            a.translation && g.translationIso
              ? h('p', { class: 'al-translation', lang: g.translationIso, dir: g.translationDir || 'auto', text: a.translation })
              : null,
            showTafsir ? tafsirBlock(g, entry, tafsir) : null,
          ),
        );
      });
      const notShown = g.to - g.from + 1 - items.length;
      body = [
        h('ol', { class: 'al-items' }, items),
        tafsir && tafsirStatus(g, tState, tafsir),
        notShown > 0 && h('p', { class: 'al-more muted small', text: t('create.preview.more', { count: notShown }) }),
      ];
    }
    return h('section', { class: 'al-group' }, head, body);
  });
  fill(container, nodes);
}
