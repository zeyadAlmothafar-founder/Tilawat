// Share modal and QR modal for a finished video.
import { getServerInfo } from './api.js';
import { t } from './i18n.js';
import { h, openModal, showError, toast } from './ui.js';
import { icon } from './icons.js';
import { linkTargets, targetTile, canShareFiles, wireNativeShare, copyLinkWithToast, copyText } from './share-links.js';
import { qrBlock, qrCaption } from './qr.js';
import { WEB_MODE } from './mode.js';
import { surahNames, rangeLabel, reciterName, videoFileName, shareText, videoFileUrl } from './video-meta.js';

async function serverInfo() {
  try {
    return await getServerInfo();
  } catch {
    return { shareBaseUrl: location.origin, publicBaseUrl: null, lanUrls: [] };
  }
}

export const sharePageUrl = (info, video) => `${info.shareBaseUrl}/v/${encodeURIComponent(video.id)}`;

function videoHeader(video) {
  const { ar, latin } = surahNames(video);
  return h(
    'div',
    { class: 'share-video' },
    video.thumbUrl && h('img', { class: 'share-thumb', src: video.thumbUrl, alt: '' }),
    h(
      'div',
      { class: 'share-video-text' },
      h('p', { class: 'share-video-title' }, h('span', { class: 'ar-name', lang: 'ar', dir: 'rtl', text: ar }), ar && latin ? ' · ' : '', h('span', { text: latin })),
      h('p', { class: 'muted small', text: [rangeLabel(video), reciterName(video)].filter(Boolean).join(' · ') }),
    ),
  );
}

export async function openShareModal(video) {
  if (WEB_MODE) return openWebShareModal(video);
  const info = await serverInfo();
  const url = sharePageUrl(info, video);
  const text = shareText(video);
  const fileName = videoFileName(video);
  const fileUrl = videoFileUrl(video);
  const subject = t('share.emailSubject', { surah: surahNames(video).primary, app: t('app.name') });
  const nativeSupported = canShareFiles();

  const nativeBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block' }, icon('share'), h('span', { class: 'btn-label', text: t('share.native') }));
  const nativeSection = nativeSupported
    ? h('div', { class: 'share-native' }, nativeBtn, h('p', { class: 'muted small', text: t('share.nativeHint') }))
    : h('p', { class: 'callout' }, icon('info'), h('span', { text: t('share.unsupported') }));

  const tiles = linkTargets({ url, text, subject }).map(targetTile);
  const copyTile = h(
    'button',
    { type: 'button', class: 'share-target share-copy', onclick: () => copyLinkWithToast(url) },
    h('span', { class: 'share-target-icon' }, icon('link')),
    h('span', { class: 'share-target-label', text: t('share.copyLink') }),
  );
  const downloadTile = h(
    'a',
    { class: 'share-target share-download', href: fileUrl, download: fileName },
    h('span', { class: 'share-target-icon' }, icon('download')),
    h('span', { class: 'share-target-label', text: t('common.download') }),
  );

  let cleanup = () => {};
  openModal({
    title: t('share.title'),
    className: 'share-modal',
    onClose: () => cleanup(),
    content: [
      videoHeader(video),
      nativeSection,
      h('h3', { class: 'subhead', text: t('share.linksTitle') }),
      h('div', { class: 'share-grid' }, tiles, copyTile, downloadTile),
      h('p', { class: 'muted small share-note' }, icon('info'), h('span', { text: t('share.socialNote') })),
      h('h3', { class: 'subhead', text: t('share.qr.title') }),
      qrBlock({ url, caption: qrCaption(info) }),
    ],
  });

  if (nativeSupported) {
    cleanup = wireNativeShare(nativeBtn, { url: fileUrl, fileName, title: subject, text: `${text}\n${url}`, onError: showError });
  }
}

/**
 * Web version: the video only exists in this browser, so there are no links or QR codes —
 * share the file itself, download it, or copy the caption to paste next to it.
 */
function openWebShareModal(video) {
  const text = shareText(video);
  const fileName = videoFileName(video);
  const fileUrl = videoFileUrl(video);
  const subject = t('share.emailSubject', { surah: surahNames(video).primary, app: t('app.name') });
  const nativeSupported = canShareFiles();
  const nativeBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block' }, icon('share'), h('span', { class: 'btn-label', text: t('share.native') }));
  const nativeSection = nativeSupported
    ? h('div', { class: 'share-native' }, nativeBtn, h('p', { class: 'muted small', text: t('share.nativeHint') }))
    : h('p', { class: 'callout' }, icon('info'), h('span', { text: t('share.unsupportedWeb') }));
  const downloadTile = h(
    'a',
    { class: 'share-target share-download', href: fileUrl, download: fileName },
    h('span', { class: 'share-target-icon' }, icon('download')),
    h('span', { class: 'share-target-label', text: t('common.download') }),
  );
  const captionTile = h(
    'button',
    {
      type: 'button',
      class: 'share-target share-copy',
      onclick: async () => {
        const ok = await copyText(text);
        toast(ok ? t('share.captionCopied') : t('share.copyFailed'), { type: ok ? 'success' : 'error' });
      },
    },
    h('span', { class: 'share-target-icon' }, icon('copy')),
    h('span', { class: 'share-target-label', text: t('share.copyCaption') }),
  );

  let cleanup = () => {};
  openModal({
    title: t('share.title'),
    className: 'share-modal',
    onClose: () => cleanup(),
    content: [
      videoHeader(video),
      nativeSection,
      h('h3', { class: 'subhead', text: t('share.moreTitle') }),
      h('div', { class: 'share-grid' }, downloadTile, captionTile),
      h('p', { class: 'share-caption muted small', dir: 'auto', text }),
    ],
  });
  if (nativeSupported) {
    cleanup = wireNativeShare(nativeBtn, { url: fileUrl, fileName, title: subject, text, onError: showError });
  }
}

export async function openQrModal(video) {
  const info = await serverInfo();
  const url = sharePageUrl(info, video);
  openModal({
    title: t('share.qr.title'),
    size: 'sm',
    className: 'qr-modal',
    content: [videoHeader(video), qrBlock({ url, caption: qrCaption(info) })],
  });
}
