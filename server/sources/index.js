// Background footage: providers (Pexels, Pixabay, NASA, uploads), the reviewed clip
// library and pickClips() for the renderer. Routes are mounted at /api.
import path from 'node:path';
import express from 'express';
import { CLIP_CACHE_DIR } from '../paths.js';
import { httpError } from '../lib/errors.js';
import { CATEGORY_IDS, listCategories } from './categories.js';
import { approve, counts, getEntry, listApproved, loadLibrary, reject, remove, reviewedIds } from './library.js';
import { searchCandidates, knownClip } from './search.js';
import { thumbPath } from './clips.js';
import { clipForApproval, parseClipId, requireCategory } from './validate.js';
import * as pexels from './providers/pexels.js';
import * as pixabay from './providers/pixabay.js';
import { UPLOAD_FILE_RE, deleteUploadFiles, saveUpload } from './providers/upload.js';

export { CATEGORY_IDS };
export { pickClips } from './pick.js';

export async function init() {
  const n = loadLibrary().size;
  if (n) console.log(`[sources] library: ${n} reviewed clip(s)`);
}

export const router = express.Router();

router.get('/categories', (req, res) => {
  res.json(listCategories());
});

router.get('/sources/status', (req, res) => {
  res.json({
    providers: {
      pexels: { enabled: pexels.enabled() },
      pixabay: { enabled: pixabay.enabled() },
      nasa: { enabled: true },
      upload: { enabled: true },
    },
    library: counts(),
  });
});

router.get('/library', (req, res) => {
  const category = req.query.category ? requireCategory(req.query.category) : undefined;
  res.json(listApproved(category));
});

router.get('/library/candidates', async (req, res) => {
  const category = requireCategory(req.query.category);
  const page = Math.min(50, Math.max(1, Math.floor(Number(req.query.page)) || 1));
  const orientation = ['portrait', 'landscape', 'square'].includes(req.query.orientation) ? req.query.orientation : undefined;
  res.json(await searchCandidates({ category, page, orientation, exclude: reviewedIds() }));
});

router.post('/library/approve', async (req, res) => {
  res.json(await approve(clipForApproval(req.body)));
});

router.post('/library/reject', async (req, res) => {
  const { id, provider, providerId } = parseClipId(req.body?.id);
  const category = requireCategory(req.body?.category);
  const base = knownClip(id) || getEntry(id) || { id, provider, providerId };
  await reject({ ...base, category });
  res.json({ ok: true });
});

router.delete('/library/:id', async (req, res) => {
  const { id } = parseClipId(req.params.id);
  const entry = await remove(id);
  if (!entry) throw httpError(404, 'clip_not_found', 'That clip is not in the library');
  if (entry.provider === 'upload') await deleteUploadFiles(entry);
  res.json({ ok: true });
});

router.post('/library/upload', async (req, res) => {
  const category = requireCategory(req.query.category);
  const entry = await saveUpload(req, category);
  res.status(201).json(await approve(entry));
});

router.get('/library/thumb/:file', async (req, res) => {
  const file = await thumbPath(req.params.file).catch((err) => {
    console.warn(`[sources] thumbnail ${req.params.file} failed: ${err.message}`);
    return null;
  });
  if (!file) throw httpError(404, 'not_found', 'Thumbnail not found');
  res.sendFile(file, { maxAge: '7d' });
});

router.get('/library/clip/:id', (req, res) => {
  const { id, provider } = parseClipId(req.params.id);
  const entry = getEntry(id);
  if (provider !== 'upload' || !entry || !UPLOAD_FILE_RE.test(String(entry.file))) {
    throw httpError(404, 'clip_not_found', 'Clip not found');
  }
  res.sendFile(path.join(CLIP_CACHE_DIR, entry.file), { maxAge: '1h' });
});
