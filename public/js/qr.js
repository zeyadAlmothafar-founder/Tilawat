// QR code block: server-rendered SVG + caption + the URL itself (copyable).
import { qrUrl } from './api.js';
import { t } from './i18n.js';
import { h } from './ui.js';
import { icon } from './icons.js';
import { copyLinkWithToast } from './share-links.js';

const isLocalhost = (url) => /^https?:\/\/(localhost|127\.|\[::1\])/i.test(url);

/**
 * @param {object} o
 * @param {string} o.url        URL encoded in the QR code
 * @param {string} o.caption    explanation shown next to the code
 * @param {string} [o.title]    optional heading
 */
export function qrBlock({ url, caption, title }) {
  const img = h('img', { class: 'qr-img', src: qrUrl(url), alt: t('share.qr.alt', { url }), width: 176, height: 176, loading: 'lazy' });
  img.addEventListener('error', () => img.closest('.qr-block')?.classList.add('qr-failed'), { once: true });
  return h(
    'figure',
    { class: 'qr-block' },
    h('div', { class: 'qr-code' }, img),
    h(
      'figcaption',
      { class: 'qr-caption' },
      title && h('p', { class: 'qr-title' }, icon('phone'), h('span', { text: title })),
      h('p', { class: 'qr-text', text: caption }),
      isLocalhost(url) && h('p', { class: 'qr-warning' }, icon('alert'), h('span', { text: t('share.localhostWarning') })),
      urlField(url),
    ),
  );
}

/** Read-only URL with a copy button. */
export function urlField(url) {
  const input = h('input', { class: 'input url-input', type: 'text', value: url, readonly: true, dir: 'ltr', 'aria-label': t('share.linkLabel') });
  input.addEventListener('focus', () => input.select());
  return h(
    'div',
    { class: 'url-field' },
    input,
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => copyLinkWithToast(url) }, icon('copy'), h('span', { text: t('common.copy') })),
  );
}

/** Caption for a share-page QR depending on whether the URL is LAN-only. */
export function qrCaption(serverInfo) {
  return serverInfo?.publicBaseUrl ? t('share.qr.captionPublic') : t('share.qr.captionLan');
}
