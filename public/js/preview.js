// Live preview: a device-frame mock approximating the rendered video (same header, footer,
// ayah ornament and safe areas as server/render), and the scrollable "check the text" list.
import { t, fmtNumber, isRtl } from './i18n.js';
import { h, fill } from './ui.js';
import { quranDisplayText } from './quran-text.js';

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

/**
 * groups: [{ surah, surahNumber, from, to, status: 'loading'|'error'|'ready', ayahs, translationIso, translationDir }]
 */
export function renderAyahList(container, groups, { maxAyat = 300 } = {}) {
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
      const items = [];
      for (const a of g.ayahs) {
        if (shown >= maxAyat) break;
        shown++;
        items.push(
          h(
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
            ),
          ),
        );
      }
      const notShown = g.to - g.from + 1 - items.length;
      body = [h('ol', { class: 'al-items' }, items), notShown > 0 && h('p', { class: 'al-more muted small', text: t('create.preview.more', { count: notShown }) })];
    }
    return h('section', { class: 'al-group' }, head, body);
  });
  fill(container, nodes);
}
