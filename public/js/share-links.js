// Share targets, clipboard and Web Share (file) helpers — used by the studio and the share page.
import { t } from './i18n.js';
import { h, toast } from './ui.js';
import { icon } from './icons.js';

const enc = encodeURIComponent;

/** Link-based share targets. Instagram/TikTok/Snapchat have no web share URL. */
export function linkTargets({ url, text, subject }) {
  return [
    { id: 'whatsapp', icon: 'whatsapp', label: t('share.whatsapp'), href: `https://wa.me/?text=${enc(`${text}\n${url}`)}` },
    { id: 'telegram', icon: 'telegram', label: t('share.telegram'), href: `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}` },
    { id: 'x', icon: 'xBrand', label: t('share.x'), href: `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}` },
    { id: 'facebook', icon: 'facebook', label: t('share.facebook'), href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}` },
    { id: 'email', icon: 'mail', label: t('share.email'), href: `mailto:?subject=${enc(subject)}&body=${enc(`${text}\n\n${url}`)}` },
  ];
}

/** Brand-coloured tile linking to a share target (opens in a new tab). */
export function targetTile(target) {
  const external = !target.href.startsWith('mailto:');
  return h(
    'a',
    {
      class: `share-target share-${target.id}`,
      href: target.href,
      target: external ? '_blank' : null,
      rel: external ? 'noopener noreferrer' : null,
    },
    h('span', { class: 'share-target-icon' }, icon(target.icon)),
    h('span', { class: 'share-target-label', text: target.label }),
  );
}

/** Copy text; falls back to execCommand for plain-http pages (no Clipboard API). */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  const area = h('textarea', { readonly: true, style: { position: 'fixed', top: '-1000px', opacity: '0' } });
  area.value = text;
  (document.querySelector('dialog[open]') || document.body).append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

export async function copyLinkWithToast(url) {
  const ok = await copyText(url);
  toast(ok ? t('share.linkCopied') : t('share.copyFailed'), { type: ok ? 'success' : 'error' });
  return ok;
}

/** True when this browser can hand a video *file* to the OS share sheet. */
export function canShareFiles() {
  try {
    if (!window.isSecureContext || !navigator.share || !navigator.canShare) return false;
    return navigator.canShare({ files: [new File([new Uint8Array(1)], 'video.mp4', { type: 'video/mp4' })] });
  } catch {
    return false;
  }
}

export async function fetchVideoFile(url, name, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'download_failed' });
  const blob = await res.blob();
  return new File([blob], name, { type: 'video/mp4' });
}

/**
 * Wire a "Share video…" button. The file is fetched up front when `prefetch` is set so the
 * share call still has the user's tap activation; if activation expired while the file was
 * downloading, the button asks for one more tap.
 * Returns a cleanup function (aborts the download).
 */
export function wireNativeShare(button, { url, fileName, title, text, prefetch = true, onError }) {
  const controller = new AbortController();
  const labelEl = button.querySelector('.btn-label') || button;
  const idleLabel = labelEl.textContent;
  let file = null;
  let pending = null;

  const load = () => {
    pending ??= fetchVideoFile(url, fileName, controller.signal).then((f) => (file = f));
    return pending;
  };
  if (prefetch) load().catch(() => { pending = null; });

  const setBusy = (busy, label = idleLabel) => {
    button.disabled = busy;
    button.classList.toggle('is-busy', busy);
    labelEl.textContent = label;
  };

  button.addEventListener('click', async () => {
    const hadFile = Boolean(file);
    try {
      if (!hadFile) {
        setBusy(true, t('share.preparing'));
        await load();
        setBusy(false);
      }
      if (!navigator.canShare({ files: [file] })) throw Object.assign(new Error('cannot share'), { code: 'share_failed' });
      await navigator.share({ files: [file], title, text });
    } catch (err) {
      setBusy(false);
      pending = file ? pending : null;
      if (err.name === 'AbortError') return;
      if (err.name === 'NotAllowedError' && !hadFile && file) {
        labelEl.textContent = t('share.tapAgain');
        return;
      }
      onError?.(Object.assign(err, { code: err.code || 'share_failed' }));
    }
  });

  return () => controller.abort();
}
