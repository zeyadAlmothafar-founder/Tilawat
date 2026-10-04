// Encoder throughput micro-benchmark (runs in a module worker). Used to diagnose why
// canvas-only frames encode slower than frames with decoded video drawn in.
import * as MB from '../../vendor/mediabunny.mjs';

self.onmessage = async (e) => {
  const { clipUrl, n = 150 } = e.data;
  const blob = await (await fetch(clipUrl)).blob();
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const sink = new MB.VideoSampleSink(track);
  const sample = await sink.getSample(1);
  const bench = async (name, draw, opts = {}) => {
    const c = new OffscreenCanvas(1080, 1920);
    const ctx = c.getContext('2d', { alpha: false });
    const out = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
    const vs = new MB.CanvasSource(c, { codec: 'avc', quality: new MB.Quality({ bitrate: 1.2e6 }), keyFrameInterval: 4, ...opts });
    out.addVideoTrack(vs, { frameRate: 30 });
    await out.start();
    const t = performance.now();
    for (let f = 0; f < n; f++) {
      await draw(ctx, f);
      await vs.add(f / 30, 1 / 30);
    }
    await out.finalize();
    return [name, +((performance.now() - t) / n).toFixed(2)];
  };
  const res = [];
  res.push(await bench('fill', (ctx, f) => { ctx.fillStyle = `rgb(${f % 255},40,60)`; ctx.fillRect(0, 0, 1080, 1920); }));
  res.push(await bench('video+fill', (ctx, f) => { sample.draw(ctx, 0, 0, 1080, 1920); ctx.fillStyle = `rgba(${f % 255},40,60,0.5)`; ctx.fillRect(0, 0, 1080, 1920); }));
  res.push(await bench('fill+timeout', async (ctx, f) => { ctx.fillStyle = `rgb(${f % 255},40,60)`; ctx.fillRect(0, 0, 1080, 1920); await new Promise((r) => setTimeout(r, 0)); }));
  res.push(await bench('fill+getImageData1px', (ctx, f) => { ctx.fillStyle = `rgb(${f % 255},40,60)`; ctx.fillRect(0, 0, 1080, 1920); }, {}));
  res.push(await bench('fill prefer-hardware', (ctx, f) => { ctx.fillStyle = `rgb(${f % 255},40,60)`; ctx.fillRect(0, 0, 1080, 1920); }, { hardwareAcceleration: 'prefer-hardware' }));
  res.push(await bench('fill prefer-software', (ctx, f) => { ctx.fillStyle = `rgb(${f % 255},40,60)`; ctx.fillRect(0, 0, 1080, 1920); }, { hardwareAcceleration: 'prefer-software' }));
  sample.close();
  self.postMessage(res);
};
