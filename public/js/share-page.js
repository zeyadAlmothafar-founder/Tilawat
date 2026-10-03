// Mobile share page for /v/:id — watch, save and share one video.
// On a plain-http LAN address the Web Share API is unavailable, so Download,
// WhatsApp and Copy link are always offered as the dependable path.
import { initI18n, mountLanguageSelect, onLanguageChange, t, tNodes, fmtDuration, fmtPercent, getLocale } from './i18n.js';
import { initTheme } from './theme.js';
import { getVideo } from './api.js';
import { h, fill, stateBlock, loadingBlock, errorBlock, externalLink, showError } from './ui.js';
import { icon } from './icons.js';
import { linkTargets, canShareFiles, wireNativeShare, copyLinkWithToast } from './share-links.js';
import { isActive, surahNames, rangeLabel, reciterName, videoFileName, videoFileUrl, shareText, videoTitle, videoTafsir, tafsirBadge } from './video-meta.js';

const REFRESH_MS = 3000;
let root;
let video = null;
let error = null;
let loaded = false;
let timer = null;
let cleanupShare = () => {};

function videoId() {
  const param = new URLSearchParams(location.search).get('id');
  if (param) return param;
  const match = location.pathname.match(/\/v\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const pageUrl = () => `${location.origin}${location.pathname}`;

async function load() {
  clearTimeout(timer);
  const id = videoId();
  if (!id) {
    error = { code: 'not_found', status: 404 };
  } else {
    try {
      video = await getVideo(id);
      error = null;
    } catch (err) {
      error = err;
    }
  }
  loaded = true;
  render();
  const retry = error && error.status !== 404;
  if ((video && isActive(video)) || retry) timer = setTimeout(load, retry ? REFRESH_MS * 2 : REFRESH_MS);
}

function render() {
  cleanupShare();
  cleanupShare = () => {};
  if (!loaded) return root.replaceChildren(loadingBlock(t('sharePage.loading')));
  if (error?.status === 404 || (!video && error?.code === 'not_found')) {
    document.title = `${t('sharePage.notFound.title')} · ${t('app.name')}`;
    return root.replaceChildren(stateCard('alert', 'sharePage.notFound'));
  }
  if (!video) return root.replaceChildren(errorBlock(error, load, t('sharePage.loadError')));

  document.title = `${videoTitle(video)} · ${t('app.name')}`;
  if (isActive(video)) return root.replaceChildren(renderRendering(video));
  if (video.status !== 'done') return root.replaceChildren(stateCard('alert', video.status === 'canceled' ? 'sharePage.canceled' : 'sharePage.failed'));
  fill(root, renderDone(video));
}

function stateCard(iconName, base) {
  return h(
    'div',
    { class: 'card sp-card' },
    stateBlock({
      iconName,
      title: t(`${base}.title`),
      text: t(`${base}.text`),
      action: h('a', { class: 'btn btn-primary', href: '/' }, icon('sparkle'), t('sharePage.openStudio')),
    }),
  );
}

function titleBlock(v) {
  const { ar, latin } = surahNames(v);
  return h(
    'div',
    { class: 'sp-head' },
    h(
      'h1',
      { class: 'sp-title', tabindex: '-1' },
      ar && h('span', { class: 'ar-name sp-title-ar', lang: 'ar', dir: 'rtl', text: ar }),
      h('span', { class: 'sp-title-sub', text: [latin, rangeLabel(v)].filter(Boolean).join(' · ') }),
    ),
    h(
      'p',
      { class: 'muted sp-meta' },
      h('span', { text: [reciterName(v), v.duration ? fmtDuration(v.duration) : null].filter(Boolean).join(' · ') }),
      tafsirBadge(v),
    ),
  );
}

function renderRendering(v) {
  const p = Math.max(0, Math.min(1, Number(v.progress) || 0));
  const stage = t(`videos.stage.${v.status === 'queued' ? 'queued' : v.stage || 'render'}`);
  return h(
    'div',
    { class: 'card sp-card' },
    titleBlock(v),
    h(
      'div',
      { class: 'sp-rendering' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('p', { class: 'state-title', text: t('sharePage.rendering.title') }),
      h('p', { class: 'muted', text: `${stage} ${fmtPercent(p)}` }),
      h(
        'div',
        { class: `progress ${v.status === 'queued' ? 'is-indeterminate' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(p * 100)), 'aria-label': stage },
        h('span', { class: 'progress-fill', style: { width: `${(p * 100).toFixed(1)}%` } }),
      ),
      h('p', { class: 'muted small', text: t('sharePage.rendering.text') }),
    ),
  );
}

function renderDone(v) {
  const url = pageUrl();
  const fileUrl = videoFileUrl(v);
  const fileName = videoFileName(v);
  const text = shareText(v);
  const targets = Object.fromEntries(linkTargets({ url, text, subject: videoTitle(v) }).map((tg) => [tg.id, tg]));
  const nativeOk = canShareFiles();

  const nativeBtn = nativeOk
    ? h('button', { type: 'button', class: 'btn btn-xl btn-accent' }, icon('share'), h('span', { class: 'btn-label', text: t('share.native') }))
    : null;
  const brandBtn = (id) =>
    h('a', { class: `btn btn-xl btn-brand btn-${id}`, href: targets[id].href, target: '_blank', rel: 'noopener noreferrer' }, icon(targets[id].icon), h('span', { text: targets[id].label }));

  const card = h(
    'article',
    { class: 'card sp-card' },
    titleBlock(v),
    h(
      'div',
      { class: `player-wrap aspect-${(v.aspect || '16:9').replace(':', 'x')}` },
      h('video', { class: 'player', src: fileUrl, poster: v.thumbUrl || null, controls: true, playsInline: true, preload: 'metadata' }),
    ),
    h(
      'div',
      { class: 'sp-actions' },
      h('a', { class: 'btn btn-primary btn-xl', href: fileUrl, download: fileName }, icon('download'), h('span', { text: t('sharePage.save') })),
      nativeBtn,
      brandBtn('whatsapp'),
      brandBtn('telegram'),
      h('button', { type: 'button', class: 'btn btn-xl', onclick: () => copyLinkWithToast(url) }, icon('link'), h('span', { text: t('share.copyLink') })),
    ),
    h('p', { class: 'sp-hint muted small' }, icon('info'), h('span', { text: t('sharePage.saveHint') })),
    !nativeOk && !window.isSecureContext ? h('p', { class: 'sp-hint muted small' }, icon('info'), h('span', { text: t('sharePage.httpNote') })) : null,
    credits(v),
  );

  if (nativeBtn) {
    cleanupShare = wireNativeShare(nativeBtn, { url: fileUrl, fileName, title: videoTitle(v), text: `${text}\n${url}`, prefetch: false, onError: showError });
  }
  return [card, h('p', { class: 'sp-own' }, h('a', { class: 'btn btn-ghost', href: '/' }, icon('sparkle'), t('sharePage.openStudio')))];
}

function credits(v) {
  const seen = new Set();
  const footage = [];
  for (const c of v.credits || []) {
    const provider = c.provider ? t(`providers.${c.provider}`) : '';
    const label = [c.author, provider].filter(Boolean).join(' / ');
    if (!label || seen.has(label)) continue;
    seen.add(label);
    footage.push(c.sourceUrl ? externalLink(c.sourceUrl, label) : document.createTextNode(label));
  }
  // Localized list punctuation ("a, b and c" / "أ وب وج") with the links kept as nodes.
  const list = document.createDocumentFragment();
  try {
    const parts = new Intl.ListFormat(getLocale(), { type: 'conjunction' }).formatToParts(footage.map((_, i) => String(i)));
    for (const part of parts) list.append(part.type === 'element' ? footage[Number(part.value)] : part.value);
  } catch {
    footage.forEach((node, i) => list.append(i ? ', ' : '', node));
  }

  return h(
    'section',
    { class: 'sp-credits' },
    h('h2', { class: 'subhead', text: t('sharePage.credits') }),
    h(
      'ul',
      {},
      h('li', {}, tNodes('sharePage.creditQuran', { source: externalLink('https://quranenc.com', 'QuranEnc.com') })),
      v.translation?.title ? h('li', {}, tNodes('sharePage.creditTranslation', { title: h('span', { dir: 'auto', text: v.translation.title }) })) : null,
      videoTafsir(v)
        ? h('li', {}, tNodes('sharePage.creditTafsir', {
            title: h('span', { dir: 'auto', text: videoTafsir(v).title || videoTafsir(v).key }),
            source: externalLink('https://quranenc.com', 'QuranEnc.com'),
          }))
        : null,
      h('li', {}, tNodes('sharePage.creditAudio', { source: externalLink('https://everyayah.com', 'EveryAyah.com') })),
      footage.length ? h('li', {}, tNodes('sharePage.creditFootage', { list })) : null,
    ),
  );
}

async function boot() {
  root = document.getElementById('share-root');
  await initI18n();
  initTheme(document.getElementById('theme-toggle'));
  mountLanguageSelect(document.getElementById('lang-select'));
  onLanguageChange(render);
  render();
  document.body.classList.remove('is-booting');
  await load();
}

boot().catch((err) => {
  console.error(err);
  document.body.classList.remove('is-booting');
});
