// "My Videos": batches of rendered videos, live progress polling, player, share, delete.
import * as api from './api.js';
import { t, fmtDuration, fmtBytes, fmtDate, fmtPercent, fmtNumber, onLanguageChange } from './i18n.js';
import { h, toast, showError, confirmDialog, openModal, stateBlock, loadingBlock, errorBlock, errorMessage } from './ui.js';
import { icon } from './icons.js';
import { openShareModal, openQrModal } from './share.js';
import { WEB_MODE } from './mode.js';
import { isActive, surahNames, rangeLabel, reciterName, videoTitle, videoFileName, videoFileUrl, tafsirBadge } from './video-meta.js';

const POLL_MS = 1500;

let root;
let live;
let badge;
let records = [];
let loaded = false;
let loadError = null;
let pollTimer = null;
let inflight = null;
let structureKey = '';
const cards = new Map(); // id -> { el, status, update(video) }

export function init(section) {
  root = section.querySelector('#videos-root');
  live = section.querySelector('#videos-live');
  badge = document.getElementById('jobs-badge');
  document.addEventListener('videos:changed', () => refresh());
  onLanguageChange(() => {
    cards.clear();
    structureKey = '';
    render();
    updateBadge();
  });
  refresh();
}

export function show() {
  refresh();
}

/** Fetch the list; keeps polling while any video is queued/running. */
export function refresh() {
  clearTimeout(pollTimer);
  inflight ??= api
    .getVideos()
    .then((list) => {
      announceTransitions(records, list);
      records = Array.isArray(list) ? list : [];
      loadError = null;
    })
    .catch((err) => { loadError = err; })
    .finally(() => {
      inflight = null;
      loaded = true;
      render();
      updateBadge();
      if (records.some(isActive)) pollTimer = setTimeout(refresh, POLL_MS);
    });
  return inflight;
}

function updateBadge() {
  if (!badge) return;
  const active = records.filter(isActive).length;
  badge.hidden = active === 0;
  badge.textContent = fmtNumber(active);
  badge.setAttribute('aria-label', t('nav.activeJobs', { count: active }));
  badge.title = t('nav.activeJobs', { count: active });
}

function announceTransitions(before, after) {
  if (!live || !before.length) return;
  const prev = new Map(before.map((v) => [v.id, v.status]));
  for (const v of after) {
    const was = prev.get(v.id);
    if (!was || was === v.status || !isActive({ status: was })) continue;
    if (v.status === 'done') live.textContent = t('videos.readyLive', { title: videoTitle(v) });
    else if (v.status === 'error') live.textContent = t('videos.failedLive', { title: videoTitle(v) });
  }
}

// ---------- rendering ----------

function groupByBatch(list) {
  const groups = new Map();
  for (const v of list) {
    const key = v.batchId || v.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  return [...groups.values()];
}

function render() {
  if (!root) return;
  if (!loaded) {
    root.replaceChildren(loadingBlock());
    structureKey = '';
    return;
  }
  if (!records.length) {
    cards.clear();
    structureKey = '';
    root.replaceChildren(
      loadError
        ? errorBlock(loadError, () => refresh(), t('videos.loadError'))
        : stateBlock({
            iconName: 'film',
            title: t('videos.empty.title'),
            text: t('videos.empty.text'),
            action: h('a', { class: 'btn btn-primary', href: '#create' }, icon('plus'), t('videos.empty.action')),
          }),
    );
    return;
  }

  // Update cards in place; rebuild the layout only when the set/order of videos changes
  // (so focus and hover state survive progress polling).
  for (const v of records) {
    const card = cards.get(v.id);
    if (card) card.update(v);
    else cards.set(v.id, createCard(v));
  }
  const ids = new Set(records.map((v) => v.id));
  for (const id of cards.keys()) if (!ids.has(id)) cards.delete(id);

  const groups = groupByBatch(records);
  const key = groups.map((g) => g.map((v) => v.id).join(',')).join('|') + `#${groups.map(doneCount).join(',')}`;
  if (key === structureKey) return;
  structureKey = key;
  root.replaceChildren(...groups.map(renderBatch));
}

const doneCount = (group) => group.filter((v) => v.status === 'done').length;

function renderBatch(group) {
  const done = group.filter((v) => v.status === 'done');
  const createdAt = group.map((v) => v.createdAt).filter(Boolean).sort()[0];
  const head = h(
    'div',
    { class: 'batch-head' },
    h(
      'h2',
      { class: 'batch-title' },
      h('span', { text: createdAt ? fmtDate(createdAt) : '' }),
      h('span', { class: 'batch-count', text: t('videos.count', { count: group.length }) }),
    ),
    done.length > 1 &&
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => downloadAll(done) }, icon('download'), t('videos.downloadAll')),
  );
  return h('section', { class: 'batch' }, head, h('div', { class: 'video-grid' }, group.map((v) => cards.get(v.id).el)));
}

function downloadAll(list) {
  list.forEach((v, i) => {
    setTimeout(() => {
      const a = h('a', { href: videoFileUrl(v), download: videoFileName(v), hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
    }, i * 600);
  });
}

// ---------- card ----------

function createCard(video) {
  const el = h('article', { class: 'video-card' });
  let status = null;
  let progressParts = null;

  function update(v) {
    video = v;
    if (v.status !== status) {
      status = v.status;
      el.dataset.status = status;
      progressParts = null;
      el.replaceChildren(mediaFor(v), bodyFor(v), actionsFor(v));
    }
    if (progressParts) updateProgress(progressParts, v);
  }

  function mediaFor(v) {
    if (v.status === 'done') {
      const btn = h(
        'button',
        { type: 'button', class: 'vc-media vc-thumb', 'aria-label': t('videos.play', { title: videoTitle(v) }), onclick: () => openPlayer(video) },
        v.thumbUrl && h('img', { src: v.thumbUrl, alt: '', loading: 'lazy' }),
        h('span', { class: 'vc-play' }, icon('play')),
        v.duration && h('span', { class: 'vc-duration', text: fmtDuration(v.duration) }),
        v.aspect && h('span', { class: 'vc-aspect', dir: 'ltr', text: v.aspect }),
      );
      if (v.thumbUrl) btn.style.setProperty('--thumb', `url("${v.thumbUrl}")`);
      return btn;
    }
    if (isActive(v)) {
      const stage = h('p', { class: 'vc-stage' });
      const percent = h('span', { class: 'vc-percent' });
      const fill = h('span', { class: 'progress-fill' });
      const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': t('videos.progressLabel') }, fill);
      progressParts = { stage, percent, fill, bar };
      updateProgress(progressParts, v);
      return h('div', { class: 'vc-media vc-progress' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), stage, bar, percent);
    }
    const failed = v.status === 'error';
    return h(
      'div',
      { class: `vc-media vc-ended ${failed ? 'is-error' : ''}` },
      icon(failed ? 'alert' : 'x'),
      h('p', { class: 'vc-stage', text: t(`videos.status.${v.status}`) }),
      failed && v.error && h('p', { class: 'vc-error-text', text: errorText(v.error) }),
    );
  }

  function bodyFor(v) {
    const { ar, latin } = surahNames(v);
    const meta = [reciterName(v), v.duration ? fmtDuration(v.duration) : null, v.sizeBytes ? fmtBytes(v.sizeBytes) : null].filter(Boolean);
    return h(
      'div',
      { class: 'vc-body' },
      h(
        'h3',
        { class: 'vc-title' },
        ar && h('span', { class: 'ar-name', lang: 'ar', dir: 'rtl', text: ar }),
        latin && h('span', { class: 'vc-latin', text: latin }),
      ),
      h(
        'p',
        { class: 'vc-range' },
        h('span', { text: rangeLabel(v) }),
        v.translation?.languageIso && h('span', { class: 'pill', text: v.translation.languageIso.toUpperCase() }),
        tafsirBadge(v),
      ),
      h('p', { class: 'vc-meta', text: meta.join(' · ') }),
      v.createdAt && h('p', { class: 'vc-date' }, h('time', { datetime: v.createdAt, text: fmtDate(v.createdAt) })),
    );
  }

  function actionsFor(v) {
    if (isActive(v)) {
      return h('div', { class: 'vc-actions' }, h('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: () => cancelVideo(video) }, icon('x'), t('videos.cancelJob')));
    }
    const del = h('button', { type: 'button', class: 'icon-btn btn-danger', 'aria-label': t('common.delete'), title: t('common.delete'), onclick: () => deleteVideo(video) }, icon('trash'));
    if (v.status !== 'done') return h('div', { class: 'vc-actions' }, h('span', { class: 'vc-spacer' }), del);
    return h(
      'div',
      { class: 'vc-actions' },
      h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => openShareModal(video).catch(showError) }, icon('share'), h('span', { class: 'btn-text', text: t('common.share') })),
      h('a', { class: 'icon-btn', href: videoFileUrl(v), download: videoFileName(v), 'aria-label': t('common.download'), title: t('common.download') }, icon('download')),
      !WEB_MODE && h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('common.qr'), title: t('common.qr'), onclick: () => openQrModal(video).catch(showError) }, icon('qr')),
      h('span', { class: 'vc-spacer' }),
      del,
    );
  }

  update(video);
  return { el, update };
}

/** Failure text on a card. The web version's errors have translated codes (e.g. "interrupted"). */
function errorText(error) {
  if (typeof error === 'string') return error;
  return WEB_MODE ? errorMessage(error) : error.message || '';
}

function updateProgress(parts, v) {
  const p = Math.max(0, Math.min(1, Number(v.progress) || 0));
  const stageKey = v.status === 'queued' ? 'queued' : v.stage || 'render';
  parts.stage.textContent = t(`videos.stage.${stageKey}`);
  parts.percent.textContent = fmtPercent(p);
  parts.fill.style.width = `${(p * 100).toFixed(1)}%`;
  parts.bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  parts.bar.setAttribute('aria-valuetext', `${t(`videos.stage.${stageKey}`)} ${fmtPercent(p)}`);
  parts.bar.classList.toggle('is-indeterminate', v.status === 'queued');
}

// ---------- actions ----------

function openPlayer(video) {
  const player = h('video', { class: 'player', src: videoFileUrl(video), poster: video.thumbUrl || null, controls: true, autoplay: true, playsInline: true, preload: 'metadata' });
  const { ar, latin } = surahNames(video);
  const modal = openModal({
    title: videoTitle(video),
    size: 'lg',
    className: 'player-modal',
    onClose: () => player.pause(),
    content: [
      h('div', { class: `player-wrap aspect-${(video.aspect || '16:9').replace(':', 'x')}` }, player),
      h(
        'div',
        { class: 'player-info' },
        h('p', { class: 'player-names' }, ar && h('span', { class: 'ar-name', lang: 'ar', dir: 'rtl', text: ar }), latin && h('span', { text: latin })),
        h('p', { class: 'muted small', text: [rangeLabel(video), reciterName(video), video.duration ? fmtDuration(video.duration) : ''].filter(Boolean).join(' · ') }),
      ),
      h(
        'div',
        { class: 'modal-actions' },
        h('a', { class: 'btn', href: videoFileUrl(video), download: videoFileName(video) }, icon('download'), t('common.download')),
        !WEB_MODE && h('button', { type: 'button', class: 'btn', onclick: () => { modal.close(); openQrModal(video).catch(showError); } }, icon('qr'), t('common.qr')),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { modal.close(); openShareModal(video).catch(showError); } }, icon('share'), t('common.share')),
      ),
    ],
  });
}

async function deleteVideo(video) {
  const ok = await confirmDialog({ title: t('videos.deleteTitle'), message: t('videos.deleteConfirm'), confirmText: t('common.delete'), danger: true });
  if (!ok) return;
  try {
    await api.deleteVideo(video.id);
    records = records.filter((v) => v.id !== video.id);
    render();
    updateBadge();
    toast(t('videos.deleted'), { type: 'success' });
  } catch (err) {
    showError(err);
  }
}

async function cancelVideo(video) {
  try {
    await api.deleteVideo(video.id);
    records = records.filter((v) => v.id !== video.id);
    render();
    updateBadge();
    toast(t('videos.canceled'));
  } catch (err) {
    showError(err);
  }
}
