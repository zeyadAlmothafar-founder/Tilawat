// Small DOM helpers: element builder, toasts, modal dialogs, state blocks.
import { t, has } from './i18n.js';
import { icon } from './icons.js';

/**
 * h('button', { class: 'btn', onclick: fn, 'aria-label': '…' }, child, …)
 * Props: class, text, dataset, style (object), on<event> handlers, DOM properties
 * (value, checked, disabled, hidden, …) or attributes. null/false props are skipped.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && !key.includes('-') && typeof value !== 'string') el[key] = value;
    else if (['value', 'checked', 'disabled', 'hidden', 'selected'].includes(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
}

/** Replace el's children; accepts nested arrays and skips null/false. */
export function fill(el, ...children) {
  el.replaceChildren();
  appendChildren(el, children);
  return el;
}

export const debounce = (fn, ms) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

let uid = 0;
export const nextId = (prefix = 'id') => `${prefix}-${++uid}`;

// ---------- toasts ----------

function toastRegion() {
  // Inside an open modal the page behind is inert, so toasts must live in the dialog.
  const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
  let region = host.querySelector(':scope > .toasts');
  if (!region) {
    region = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    host.append(region);
  }
  return region;
}

export function toast(message, { type = 'info', timeout = 4500 } = {}) {
  const iconName = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info';
  const el = h('div', { class: `toast toast-${type}` }, icon(iconName), h('span', { class: 'toast-text', text: message }));
  toastRegion().append(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

/** Localized message for an API error (errors.<code>) falling back to the server text. */
export function errorMessage(err) {
  if (!err) return t('errors.generic');
  const key = `errors.${err.code}`;
  if (err.code && has(key)) return t(key);
  return err.message || t('errors.generic');
}

export function showError(err) {
  if (err?.name === 'AbortError') return;
  console.warn(err);
  toast(errorMessage(err), { type: 'error', timeout: 6000 });
}

// ---------- modal dialogs ----------

/**
 * Opens a native modal <dialog> (focus is contained, Esc closes, background inert).
 * Returns { dialog, body, close }.
 */
export function openModal({ title, content, size = 'md', className = '', onClose } = {}) {
  const titleId = nextId('modal-title');
  const opener = document.activeElement;
  const closeBtn = h('button', { type: 'button', class: 'icon-btn modal-close', 'aria-label': t('common.close'), title: t('common.close') }, icon('x'));
  const body = h('div', { class: 'modal-body' }, content);
  const dialog = h(
    'dialog',
    { class: `modal modal-${size} ${className}`.trim(), 'aria-labelledby': titleId },
    h('div', { class: 'modal-head' }, h('h2', { id: titleId, class: 'modal-title', text: title }), closeBtn),
    body,
  );

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    onClose?.();
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
  };

  closeBtn.addEventListener('click', close);
  dialog.addEventListener('close', close);
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  // Click on the backdrop (outside the dialog box) closes.
  dialog.addEventListener('pointerdown', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) close();
  });

  document.body.append(dialog);
  dialog.showModal();
  const firstFocusable = body.querySelector('[autofocus], button:not([disabled]), a[href], input, select, textarea');
  (firstFocusable || closeBtn).focus({ preventScroll: true });
  return { dialog, body, close };
}

/** Promise<boolean> confirmation dialog. */
export function confirmDialog({ title, message, confirmText = t('common.confirm'), danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const confirmBtn = h('button', { type: 'button', class: `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}` }, confirmText);
    const cancelBtn = h('button', { type: 'button', class: 'btn', autofocus: true }, t('common.cancel'));
    const modal = openModal({
      title,
      size: 'sm',
      content: [h('p', { class: 'confirm-text', text: message }), h('div', { class: 'modal-actions' }, cancelBtn, confirmBtn)],
      onClose: () => resolve(result),
    });
    cancelBtn.addEventListener('click', modal.close);
    confirmBtn.addEventListener('click', () => { result = true; modal.close(); });
  });
}

// ---------- state blocks ----------

export function stateBlock({ iconName = 'info', title, text, action, tone = '' } = {}) {
  return h(
    'div',
    { class: `state ${tone ? `state-${tone}` : ''}`.trim() },
    h('span', { class: 'state-icon' }, icon(iconName)),
    title && h('p', { class: 'state-title', text: title }),
    text && h('p', { class: 'state-text', text }),
    action,
  );
}

export function loadingBlock(text = t('common.loading')) {
  return h('div', { class: 'state state-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { class: 'state-text', text }));
}

export function errorBlock(err, onRetry, text) {
  return stateBlock({
    iconName: 'alert',
    tone: 'error',
    title: text || errorMessage(err),
    text: text ? errorMessage(err) : null,
    action: onRetry && h('button', { type: 'button', class: 'btn', onclick: onRetry }, icon('refresh'), t('common.retry')),
  });
}

/** <a target=_blank> with an accessible "opens in new tab" hint. */
export function externalLink(href, label, className = '') {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: className }, label, h('span', { class: 'visually-hidden', text: ` ${t('common.newTab')}` }));
}
