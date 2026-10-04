// Offline checks for the web build's data adapter and job builder (web/js/data.js, jobs.js):
// translation clean-up parity with the server, tafsir grouping, request limits, the render
// job (Bismillah, tafsir cards, credit line, display mapping), clip picking from the
// manifest, and the queue with a stub render engine. QuranEnc is faked with fixtures.
// Usage: node scripts/test-web-api.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as data from '../web/js/data.js';
import * as jobs from '../web/js/jobs.js';
import * as store from '../web/js/store.js';
import { cleanTranslation as serverClean } from '../server/quran.js';
import { getTafsirs as serverTafsirs, defaultTafsirFor as serverDefaultTafsir } from '../server/tafsir.js';
import { minimalCredit } from '../server/render/pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://quranenc.com/api/v1';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${String(err.stack || err.message).split('\n').slice(0, 6).join('\n     ')}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures (synthetic texts — only the clean-up and structure matter here)

const SURAHS = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/data/surahs.json'), 'utf8'));
const ayahCount = (s) => SURAHS[s - 1].ayahCount;

const TRANSLATIONS = {
  translations: [
    { key: 'english_saheeh', direction: 'ltr', language_iso_code: 'en', version: '1.1.2', title: 'English - Saheeh International', description: 'x' },
    { key: 'urdu_junagarhi', direction: 'rtl', language_iso_code: 'ur', version: '1.0.3', title: 'Urdu - Junagarhi', description: 'x' },
    { key: 'russian_rwwad', direction: 'ltr', language_iso_code: 'ru', version: '1.0.0', title: 'Russian - Rowwad', description: 'x' },
    { key: 'english_mokhtasar', direction: 'ltr', language_iso_code: 'en', version: '1.0.0', title: 'Mukhtasar (tafsir)', description: 'x' },
    { key: 'english_waleed', direction: 'ltr', language_iso_code: 'en', version: '1.0.0', title: 'Unsuitable', description: 'x' },
    { key: 'german_wip', direction: 'ltr', language_iso_code: 'de', version: '1.0.0', title: 'German (in progress)', description: 'x' },
  ],
};

// Raw translation rows [raw, footnotes] keyed by `${key}/${surah}/${ayah}`.
const RAW = {
  'english_saheeh/1/1': ['In the name of Allāh,[1] the Entirely Merciful, the Especially Merciful.[2]', '[1] a\n[2] b'],
  'english_saheeh/1/2': ['[All] praise is [due] to Allāh, Lord[3] of the worlds -', '[3] ...'],
  'urdu_junagarhi/1/1': ['شروع کرتا ہوں اللہ تعالیٰ کے نام سے(1)', '(1) حاشیہ'],
  'urdu_junagarhi/1/2': ['سب تعریف اللہ تعالیٰ کے لئے ہے[1] جو تمام جہانوں کا پالنے واﻻ ہے۔[2]', '[1] a\n[2] b'],
  'russian_rwwad/2/104': ['сказали: «Уделяй нам внимание [3]!» – а', '[3] x'],
  'english_saheeh/112/1': ['Say, "He is Allāh, [who is] One,[1]', '[1] note'],
  'english_saheeh/112/2': ['2. Allāh, the Eternal Refuge.', null],
};
const arabicOf = (surah, ayah) => `ARABIC ${surah}:${ayah} ٖٗٞ`; // open tanween code points

function suraResponse(key, surah) {
  const result = [];
  for (let aya = 1; aya <= ayahCount(surah); aya++) {
    const [raw, footnotes] = RAW[`${key}/${surah}/${aya}`] || [`${key} ${surah}:${aya}`, null];
    result.push({ id: String(aya), sura: String(surah), aya: String(aya), arabic_text: arabicOf(surah, aya), translation: raw, footnotes: footnotes || '' });
  }
  return { result };
}

// Tafsir for surah 2: ayat 3–4 explained together (repeated text), 6–7 with an empty 7th row.
function tafsirResponse(surah) {
  const result = [];
  for (let aya = 1; aya <= ayahCount(surah); aya++) {
    let text = `${aya}. Commentary on ayah ${aya}.[1]`;
    if (aya === 3 || aya === 4) text = '3-4. Commentary on ayat 3 and 4.';
    if (aya === 6) text = 'Commentary on ayat 6 and 7.';
    if (aya === 7) text = '';
    result.push({ id: String(aya), sura: String(surah), aya: String(aya), arabic_text: arabicOf(surah, aya), translation: text, footnotes: '[1] fn' });
  }
  return { result };
}

let fetchCount = 0;
async function fakeFetch(url) {
  fetchCount++;
  const u = String(url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (u === `${API}/translations/list?all=1`) return json(TRANSLATIONS);
  const m = /\/translation\/sura\/([^/]+)\/(\d+)$/.exec(u);
  if (m) {
    const [, key, surah] = [m[0], decodeURIComponent(m[1]), Number(m[2])];
    if (key.endsWith('_mokhtasar')) return json(tafsirResponse(surah));
    return json(suraResponse(key, surah));
  }
  return json({ error: 'not found' }, 404);
}

const MANIFEST = {
  version: 1,
  mode: 'r2',
  base: 'https://clips.example.r2.dev',
  clips: [
    { id: 'pixabay:1', provider: 'pixabay', category: 'nature', orientation: 'portrait', author: 'Ann', sourceUrl: 'https://pixabay.com/videos/id-1/', thumb: 'thumbs/1.jpg',
      segments: [
        { res: '1080', part: 'a', url: 'segments/1-a-1080.mp4', width: 1080, height: 1920, duration: 8 },
        { res: '720', part: 'a', url: 'segments/1-a-720.mp4', width: 720, height: 1280, duration: 8 },
        { res: '1080', part: 'b', url: 'segments/1-b-1080.mp4', width: 1080, height: 1920, duration: 8 },
        { res: '720', part: 'b', url: 'segments/1-b-720.mp4', width: 720, height: 1280, duration: 8 },
      ] },
    { id: 'pixabay:2', provider: 'pixabay', category: 'nature', orientation: 'landscape', author: 'Bob', sourceUrl: 'https://pixabay.com/videos/id-2/', thumb: 'thumbs/2.jpg',
      segments: [
        { res: '1080', part: 'a', url: 'segments/2-a-1080.mp4', width: 1920, height: 1080, duration: 8 },
        { res: '720', part: 'a', url: 'segments/2-a-720.mp4', width: 1280, height: 720, duration: 8 },
      ] },
    { id: 'pixabay:3', provider: 'pixabay', category: 'space', orientation: 'portrait', author: 'Cy', sourceUrl: 'https://pixabay.com/videos/id-3/', thumb: 'https://cdn.pixabay.com/3.jpg',
      segments: [
        { res: '1080', url: 'https://cdn.pixabay.com/3_small.mp4', width: 360, height: 640, duration: 15 }, // direct mode: real size
        { res: '720', url: 'https://cdn.pixabay.com/3_tiny.mp4', width: 540, height: 960, duration: 15 },
      ] },
    { id: 'pixabay:4', provider: 'pixabay', category: 'mosque', orientation: 'landscape', author: 'Di', thumb: 'thumbs/4.jpg',
      segments: [{ res: '1080', part: 'a', url: 'segments/4-a-1080.mp4', width: 1920, height: 1080, duration: 8 }] },
  ],
};

const STATIC = {
  'surahs.json': SURAHS,
  'reciters.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'server/data/reciters.json'), 'utf8')),
  'tafsirs.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'server/data/tafsirs.json'), 'utf8')),
  'clips.json': MANIFEST,
};

let seed = 1;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

data.configure({
  fetch: fakeFetch,
  loadStatic: async (name) => structuredClone(STATIC[name] ?? null),
  cache: async () => null,
  random,
});

// Stub engine (the real one is web/js/render/index.js, browser only).
const rendered = [];
let engineDelay = 0;
const stubEngine = {
  canRender: () => ({ ok: true, maxQuality: '1080' }),
  renderVideo: async (job, { onProgress, signal }) => {
    rendered.push(job);
    for (const [stage, overall] of [['audio', 0.05], ['clips', 0.2], ['render', 0.6], ['finalize', 0.97]]) {
      onProgress(stage, overall);
      if (engineDelay) await new Promise((r) => setTimeout(r, engineDelay));
      signal?.throwIfAborted();
    }
    return { blob: new Blob(['mp4']), thumbBlob: new Blob(['jpg']), duration: 12.345, width: job.width, height: job.height, sizeBytes: 3 };
  },
};
jobs.configureJobs({ loadEngine: async () => stubEngine });

// ---------------------------------------------------------------------------

await check('translations: same filtering and defaults as the server', async () => {
  const { translations, defaults } = await data.getTranslations();
  assert.deepEqual(translations.map((t) => t.key), ['english_saheeh', 'urdu_junagarhi', 'russian_rwwad']);
  assert.equal(translations[1].direction, 'rtl');
  assert.equal(defaults.en, 'english_saheeh');
  assert.equal(defaults.ar, null);
  assert.equal(defaults.de, null, 'german_bubenheim is not in the fixture list and there is no other German edition');
});

await check('getAyahs: clean-up parity with the server (English, Urdu, Russian)', async () => {
  for (const [key, surah, from, to] of [['english_saheeh', 1, 1, 2], ['urdu_junagarhi', 1, 1, 2], ['russian_rwwad', 2, 104, 104], ['english_saheeh', 112, 1, 2]]) {
    const res = await data.getAyahs({ surah, from, to, translation: key });
    assert.equal(res.translation.key, key);
    assert.equal(res.ayahs.length, to - from + 1);
    for (const a of res.ayahs) {
      const [raw, fn] = RAW[`${key}/${surah}/${a.ayah}`];
      assert.equal(a.translation, serverClean(raw, fn, a.ayah, surah), `${key} ${surah}:${a.ayah}`);
      assert.equal(a.translationRaw, raw);
      assert.equal(a.arabic, arabicOf(surah, a.ayah), 'Arabic is verbatim (no display mapping in getAyahs)');
    }
  }
  const ur = await data.getAyahs({ surah: 1, from: 1, to: 2, translation: 'urdu_junagarhi' });
  assert.equal(ur.ayahs[1].translation, 'سب تعریف اللہ تعالیٰ کے لئے ہے جو تمام جہانوں کا پالنے واﻻ ہے۔');
  const ru = await data.getAyahs({ surah: 2, from: 104, to: 104, translation: 'russian_rwwad' });
  assert.equal(ru.ayahs[0].translation, 'сказали: «Уделяй нам внимание!» – а');
  const en = await data.getAyahs({ surah: 112, from: 2, to: 2, translation: 'english_saheeh' });
  assert.equal(en.ayahs[0].translation, 'Allāh, the Eternal Refuge.');
});

await check('getAyahs: Arabic only, errors with the server codes', async () => {
  const res = await data.getAyahs({ surah: 112, from: 1, to: 4, translation: null });
  assert.equal(res.translation, null);
  assert.ok(res.ayahs.every((a) => a.translation === null));
  await assert.rejects(data.getAyahs({ surah: 115 }), { code: 'invalid_range' });
  await assert.rejects(data.getAyahs({ surah: 1, from: 3, to: 2 }), { code: 'invalid_range' });
  await assert.rejects(data.getAyahs({ surah: 1, from: 1, to: 1, translation: 'nope' }), { code: 'unknown_translation' });
});

await check('tafsirs: labels and defaults match the server', async () => {
  const { tafsirs, defaults } = await data.getTafsirs();
  const server = await serverTafsirs();
  assert.deepEqual(tafsirs.map((t) => [t.key, t.label]), server.map((t) => [t.key, t.label]));
  for (const lang of ['ar', 'en', 'ur', 'fa', 'de']) assert.equal(defaults[lang], serverDefaultTafsir(lang), lang);
});

await check('getTafsir: groups (repeated / empty rows), numbers and markers removed', async () => {
  const res = await data.getTafsir({ surah: 2, from: 1, to: 8, edition: 'english_mokhtasar' });
  assert.equal(res.edition.label, 'Al-Mukhtasar');
  const by = Object.fromEntries(res.ayahs.map((a) => [a.ayah, a]));
  assert.equal(by[1].text, 'Commentary on ayah 1.');
  assert.deepEqual([by[3].groupStart, by[3].groupEnd, by[4].groupStart], [3, 4, 3]);
  assert.equal(by[3].text, 'Commentary on ayat 3 and 4.');
  assert.deepEqual([by[6].groupStart, by[6].groupEnd, by[7].groupEnd], [6, 7, 7]);
  assert.equal(by[7].text, by[6].text);
  await assert.rejects(data.getTafsir({ surah: 2, edition: 'nope' }), { code: 'unknown_tafsir' });
});

await check('audioUrl → EveryAyah', () => {
  assert.equal(data.audioUrl('Alafasy_128kbps', 2, 255), 'https://everyayah.com/data/Alafasy_128kbps/002255.mp3');
});

await check('normalizeRequest: web limits and server error codes', async () => {
  const ok = await jobs.normalizeRequest({ items: [{ surah: 2, from: 1, to: 20 }], style: { textScale: 9 } });
  assert.equal(ok.videos.length, 1);
  assert.equal(ok.common.style.textScale, 1.5);
  assert.equal(ok.common.translation.key, 'english_saheeh');
  assert.deepEqual(ok.common.categories, ['nature', 'space']);
  await assert.rejects(jobs.normalizeRequest({ items: [{ surah: 2, from: 1, to: 21 }] }), { code: 'too_many_ayahs' });
  await assert.rejects(jobs.normalizeRequest({ items: Array.from({ length: 6 }, () => ({ surah: 112, from: 1, to: 1 })) }), { code: 'too_many_videos' });
  await assert.rejects(jobs.normalizeRequest({ items: [{ surah: 2, from: 1, to: 6 }], mode: 'perAyah' }), { code: 'too_many_videos' });
  await assert.rejects(jobs.normalizeRequest({ items: [{ surah: 1, from: 1, to: 9 }] }), { code: 'invalid_range' });
  await assert.rejects(jobs.normalizeRequest({ items: [{ surah: 1 }], reciter: 'nobody' }), { code: 'invalid_reciter' });
  await assert.rejects(jobs.normalizeRequest({ items: [{ surah: 1 }], tafsir: 'nope' }), { code: 'invalid_tafsir' });
  const capped = await jobs.normalizeRequest({ items: [{ surah: 1 }], quality: '1080' }, { maxQuality: '720' });
  assert.equal(capped.common.quality, '720');
});

const recordFor = async (body) => {
  const { common, videos } = await jobs.normalizeRequest(body);
  const v = videos[0];
  return {
    id: 'vtest001',
    request: { surah: v.surah.number, from: v.from, to: v.to, ...common, reciter: common.reciter.id, translation: common.translation?.key ?? null, tafsir: common.tafsir?.key ?? null },
    surah: v.surah, from: v.from, to: v.to, reciter: common.reciter, translation: common.translation, tafsir: common.tafsir,
  };
};

await check('buildJob: Bismillah first, display-mapped Arabic, translation, credit', async () => {
  const job = await jobs.buildJob(await recordFor({ items: [{ surah: 112, from: 1, to: 2 }], aspect: '9:16', quality: '720', categories: ['nature'] }));
  assert.deepEqual([job.width, job.height, job.fps, job.aspect], [720, 1280, 30, '9:16']);
  assert.equal(job.items.length, 3);
  assert.equal(job.items[0].kind, 'bismillah');
  assert.equal(job.items[0].ayah, null);
  assert.equal(job.items[0].arabic, 'ARABIC 1:1 ࣰࣱࣲ');
  assert.equal(job.items[0].translation, 'In the name of Allāh, the Entirely Merciful, the Especially Merciful.');
  assert.equal(job.items[0].audioUrl, 'https://everyayah.com/data/Alafasy_128kbps/001001.mp3');
  assert.equal(job.items[1].arabic, 'ARABIC 112:1 ࣰࣱࣲ');
  assert.equal(job.items[2].translation, 'Allāh, the Eternal Refuge.');
  assert.equal(job.items[2].audioUrl, 'https://everyayah.com/data/Alafasy_128kbps/112002.mp3');
  assert.ok(job.items.every((it) => it.tafsirText === null));
  assert.equal(job.tafsir, null);
  assert.equal(job.translation.version, '1.1.2');
  assert.equal(job.credit, minimalCredit({ version: '1.1.2' }, false));
  assert.equal(job.credit, 'Translation: QuranEnc.com (v1.1.2)');
  assert.ok(job.clips.length >= 1 && job.clips.every((c) => c.url.startsWith('https://')));
});

await check('buildJob: no Bismillah for surah 1 / 9, from > 1, or when off', async () => {
  for (const body of [{ items: [{ surah: 1, from: 1, to: 2 }] }, { items: [{ surah: 9, from: 1, to: 1 }] }, { items: [{ surah: 112, from: 2, to: 3 }] }, { items: [{ surah: 112, from: 1, to: 1 }], bismillah: false }]) {
    const job = await jobs.buildJob(await recordFor(body));
    assert.ok(job.items.every((it) => it.kind === 'ayah'), JSON.stringify(body));
  }
});

await check('buildJob: tafsir cards grouped (after the last ayah of a group, clipped to the video)', async () => {
  const job = await jobs.buildJob(await recordFor({ items: [{ surah: 2, from: 2, to: 6 }], translation: null, tafsir: 'english_mokhtasar', style: { credits: 'full' } }));
  const byAyah = Object.fromEntries(job.items.map((it) => [it.ayah, it]));
  assert.equal(byAyah[2].tafsirText, 'Commentary on ayah 2.');
  assert.equal(byAyah[3].tafsirText, null, 'group 3–4 is shown once, after ayah 4');
  assert.equal(byAyah[4].tafsirText, 'Commentary on ayat 3 and 4.');
  assert.deepEqual([byAyah[4].tafsirFrom, byAyah[4].tafsirTo], [3, 4]);
  assert.equal(byAyah[6].tafsirText, 'Commentary on ayat 6 and 7.', 'group 6–7 runs past the video: shown after its last ayah');
  assert.deepEqual([byAyah[6].tafsirFrom, byAyah[6].tafsirTo], [6, 6]);
  assert.equal(job.tafsir.label, 'Al-Mukhtasar');
  assert.equal(job.translation, null);
  assert.ok(job.items.every((it) => it.translation === null));
  assert.match(job.credit, /^Quran text: QuranEnc\.com {2}· {2}Recitation: EveryAyah\.com {2}· {2}Footage: Pixabay – /);
  assert.match(job.credit, /\nTafsir: .+ \(QuranEnc\.com\)$/);
  const none = await jobs.buildJob(await recordFor({ items: [{ surah: 2, from: 2, to: 3 }], style: { credits: 'none' } }));
  assert.equal(none.credit, '');
});

await check('pickClips: orientation first, resolution, URLs resolved against base', async () => {
  const portrait = await data.pickClips({ categories: ['nature'], totalDuration: 30, orientation: 'portrait', quality: '1080' });
  assert.equal(portrait[0].id, 'pixabay:1', 'portrait clip first for 9:16');
  assert.ok(portrait[0].url.startsWith('https://clips.example.r2.dev/segments/1-'), portrait[0].url);
  assert.ok(portrait[0].url.endsWith('-1080.mp4'));
  // One segment per clip before reusing a clip's other part.
  assert.deepEqual(portrait.map((c) => c.id), ['pixabay:1', 'pixabay:2', 'pixabay:1']);
  const landscape = await data.pickClips({ categories: ['nature'], totalDuration: 10, orientation: 'landscape', quality: '720' });
  assert.deepEqual([landscape[0].id, landscape[0].url], ['pixabay:2', 'https://clips.example.r2.dev/segments/2-a-720.mp4']);
  const mixed = await data.pickClips({ categories: ['nature', 'space'], totalDuration: 20, orientation: 'portrait', quality: '1080' });
  assert.deepEqual(mixed.slice(0, 2).map((c) => c.id), ['pixabay:1', 'pixabay:3'], 'round-robin across categories');
  assert.equal(mixed[1].url, 'https://cdn.pixabay.com/3_small.mp4', 'absolute URLs kept; res match preferred');
  const only1080 = await data.pickClips({ categories: ['mosque'], totalDuration: 5, orientation: 'landscape', quality: '720' });
  assert.equal(only1080[0].url, 'https://clips.example.r2.dev/segments/4-a-1080.mp4', 'falls back to the available rendition');
  assert.equal(data.targetCount(1000), 20);
  const lib = await data.getLibrary('nature');
  assert.equal(lib.length, 2);
  assert.equal(lib[0].thumbUrl, 'https://clips.example.r2.dev/thumbs/1.jpg');
  assert.equal(lib[0].previewUrl, 'https://clips.example.r2.dev/segments/1-a-720.mp4');
  assert.equal(lib[0].status, 'approved');
});

await check('pickClips: the real web/clips.json (if present) gives clips for every category', async () => {
  const file = path.join(ROOT, 'web/clips.json');
  if (!fs.existsSync(file)) return;
  const real = JSON.parse(fs.readFileSync(file, 'utf8'));
  STATIC['clips.json'] = real;
  data.configure({ fetch: fakeFetch, loadStatic: async (name) => structuredClone(STATIC[name] ?? null), cache: async () => null, random });
  for (const cat of ['nature', 'space', 'mosque', 'islamic']) {
    for (const orientation of ['portrait', 'landscape', 'square']) {
      const clips = await data.pickClips({ categories: [cat], totalDuration: 40, orientation, quality: '1080' });
      assert.ok(clips.length > 0, `${cat}/${orientation}`);
      assert.ok(clips.every((c) => /^https:\/\//.test(c.url) && c.width > 0 && c.height > 0 && c.duration > 0), `${cat}/${orientation}`);
    }
  }
  STATIC['clips.json'] = MANIFEST;
  data.configure({ fetch: fakeFetch, loadStatic: async (name) => structuredClone(STATIC[name] ?? null), cache: async () => null, random });
});

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
};

await check('queue: createBatch → records → stub engine → done (stored files, credits)', async () => {
  const { batchId, videos } = await jobs.createBatch({ items: [{ surah: 112, from: 1, to: 4 }, { surah: 113, from: 1, to: 2 }], quality: '720' });
  assert.equal(videos.length, 2);
  assert.ok(videos.every((v) => v.batchId === batchId && v.status === 'queued' && v.width === 720 && v.request.reciter === 'Alafasy_128kbps'));
  const list = await waitFor(async () => {
    const l = await jobs.listRecords();
    return l.filter((v) => v.batchId === batchId).every((v) => v.status === 'done') && l;
  });
  const done = list.filter((v) => v.batchId === batchId);
  assert.equal(done[0].id, videos[1].id, 'newest first');
  assert.equal(done[0].duration, 12.35);
  assert.equal(done[0].progress, 1);
  assert.ok(done[0].credits.length > 0 && done[0].credits.every((c) => c.provider === 'pixabay'));
  assert.ok((await store.getFiles(videos[0].id)).video instanceof Blob);
  assert.deepEqual(await jobs.removeVideo(videos[0].id), { ok: true });
  assert.equal(await store.getFiles(videos[0].id), null);
  await assert.rejects(jobs.removeVideo(videos[0].id), { code: 'video_not_found' });
});

await check('queue: cancel a running video (record kept as canceled)', async () => {
  engineDelay = 30;
  const { videos } = await jobs.createBatch({ items: [{ surah: 112, from: 1, to: 1 }] });
  await waitFor(async () => (await jobs.getRecord(videos[0].id))?.status === 'running');
  await jobs.removeVideo(videos[0].id);
  await new Promise((r) => setTimeout(r, 200));
  const r = await jobs.getRecord(videos[0].id);
  assert.equal(r.status, 'canceled');
  assert.equal(await store.getFiles(videos[0].id), null);
  engineDelay = 0;
});

await check('queue: videos of a closed tab become "interrupted" errors', async () => {
  await store.putRecord({ id: 'vorphan1', status: 'running', progress: 0.4, ownerTab: 'tclosed', order: 1, createdAt: new Date().toISOString() });
  const r = (await jobs.listRecords()).find((v) => v.id === 'vorphan1');
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'interrupted');
});

await check('createBatch: unsupported browser → unsupported_browser', async () => {
  jobs.configureJobs({ loadEngine: async () => ({ canRender: () => ({ ok: false, reason: 'no WebCodecs' }) }) });
  await assert.rejects(jobs.createBatch({ items: [{ surah: 1 }] }), { code: 'unsupported_browser' });
  jobs.configureJobs({ loadEngine: async () => { throw new Error('missing'); } });
  assert.equal((await jobs.renderSupport()).ok, false);
  jobs.configureJobs({ loadEngine: async () => stubEngine });
});

await check('progress: engine overall fraction → record progress after the text fetch', () => {
  assert.ok(Math.abs(jobs.overallProgress('audio', 0) - 0.04) < 1e-9);
  assert.ok(Math.abs(jobs.overallProgress('render', 0.5) - 0.52) < 1e-9);
  assert.ok(Math.abs(jobs.overallProgress('finalize', 1) - 1) < 1e-9);
  assert.equal(jobs.overallProgress('render', 7), 1);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll web adapter checks passed');
process.exit(failures ? 1 : 0);
