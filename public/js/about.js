// "About" page: static text (data-i18n in index.html) plus a QR code to open the studio on a phone.
import { getServerInfo } from './api.js';
import { t, onLanguageChange } from './i18n.js';
import { h } from './ui.js';
import { icon } from './icons.js';
import { qrBlock } from './qr.js';
import { WEB_MODE } from './mode.js';

let slot;
let info;

export function init(section) {
  slot = section.querySelector('#about-phone');
  onLanguageChange(render);
}

export function show() {
  if (WEB_MODE) return; // no LAN / QR in the web version (index.html shows a privacy note instead)
  getServerInfo()
    .then((i) => { info = i; })
    .catch(() => { info = null; })
    .finally(render);
}

function render() {
  if (!slot || info === undefined) return;
  const url = info?.publicBaseUrl || info?.lanUrls?.[0];
  if (!url) {
    slot.replaceChildren(h('p', { class: 'callout' }, icon('info'), h('span', { text: t('about.phoneNone') })));
    return;
  }
  slot.replaceChildren(qrBlock({ url: `${url}/`, caption: t(info.publicBaseUrl ? 'about.phonePublic' : 'about.phoneText') }));
}
