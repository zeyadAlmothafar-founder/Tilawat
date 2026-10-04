// Module worker: runs the whole render with an OffscreenCanvas, so background tabs don't
// throttle it. Protocol (see index.js):
//   → { type: 'probe' }                         ← { type: 'probe', ok, reason }
//   → { type: 'render', job, parts, range }     ← { type: 'progress', stage, fraction } … { type: 'done', result } | { type: 'error', error }
//   → { type: 'cancel' }

let controller = null;

function probe() {
  if (typeof OffscreenCanvas === 'undefined') return { ok: false, reason: 'no_offscreen_canvas' };
  if (!self.fonts || typeof FontFace === 'undefined') return { ok: false, reason: 'no_worker_fonts' };
  if (typeof VideoEncoder === 'undefined') return { ok: false, reason: 'no_webcodecs_in_worker' };
  try {
    const c = new OffscreenCanvas(8, 8);
    const ctx = c.getContext('2d');
    ctx.font = '10px sans-serif';
    ctx.measureText('a');
  } catch {
    return { ok: false, reason: 'no_offscreen_2d' };
  }
  return { ok: true };
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === 'probe') {
    self.postMessage({ type: 'probe', ...probe() });
    return;
  }
  if (msg.type === 'cancel') {
    controller?.abort();
    return;
  }
  if (msg.type !== 'render') return;
  controller = new AbortController();
  try {
    const { runRender } = await import('./engine.js');
    const result = await runRender(msg.job, msg.parts, {
      signal: controller.signal,
      range: msg.range,
      onProgress: (stage, fraction) => self.postMessage({ type: 'progress', stage, fraction }),
    });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', error: { name: err?.name || 'Error', message: String(err?.message || err), stack: String(err?.stack || '') } });
  } finally {
    controller = null;
  }
};
