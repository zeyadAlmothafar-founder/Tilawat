import express from 'express';
import path from 'node:path';
import { PUBLIC_DIR, OUTPUT_DIR, FONTS_DIR, ensureDirs } from './paths.js';
import { errorHandler } from './lib/errors.js';
import { lanAddresses } from './lib/net.js';
import { APP_NAME } from './lib/brand.js';

ensureDirs();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Each feature module exports an express `router` (mounted at /api) and optionally
// an async `init()`. A module that fails to load is logged and skipped so the rest
// of the app keeps working.
const MODULES = ['./quran.js', './tafsir.js', './reciters.js', './sources/index.js', './render/index.js', './share.js'];
for (const file of MODULES) {
  try {
    const mod = await import(file);
    if (typeof mod.init === 'function') await mod.init();
    if (mod.router) app.use('/api', mod.router);
  } catch (err) {
    console.warn(`[server] skipped ${file}: ${err.message}`);
  }
}

app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown API route' } }));
app.use('/output', express.static(OUTPUT_DIR, { maxAge: '1h' }));
app.use('/fonts', express.static(FONTS_DIR, { maxAge: '30d' }));
app.get('/v/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'share.html')));
app.use(express.static(PUBLIC_DIR));
app.use(errorHandler);

const PORT = Number(process.env.PORT) || 4700;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`${APP_NAME} running:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Network: http://${ip}:${PORT}`);
});
