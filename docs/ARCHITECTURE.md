# Architecture

The product name lives in `public/i18n/*.json` (`app.name`) and `server/lib/brand.js`.

A local web tool: the user picks surah + ayah ranges, a reciter, a translation, background
categories and a format; the server fetches verified Quran text (QuranEnc), per-ayah
recitation audio (EveryAyah), background footage (Pexels / Pixabay / NASA / user uploads),
and renders an MP4 with FFmpeg (Arabic text + translation burned in via ASS subtitles).
Users can render many videos at once, share them (Web Share API, WhatsApp, Telegram, X,
Facebook, email, link) and get a QR code to open the video on their phone.

Stack: Node 22 (ESM, `"type": "module"`), Express **5** (async handlers may throw — errors
propagate to the error handler), FFmpeg 6 on PATH (libass + fribidi + harfbuzz-capable),
vanilla HTML/CSS/JS frontend with **no build step and no frontend dependencies**.
Runtime npm dependencies: `express`, `qrcode`.

Run: `npm start` → http://localhost:4700 (PORT env). Keys come from `.env` (see `.env.example`).

## Directory layout

| Path | Contents |
|---|---|
| `server/index.js`, `server/paths.js`, `server/lib/*` | App entry, paths, shared helpers |
| `server/quran.js`, `server/reciters.js`, `server/data/*` | Quran text, translations, reciters |
| `server/sources/**` | Background footage providers, content filter, clip library |
| `server/render/**`, `assets/fonts/**` | FFmpeg render pipeline, job queue, fonts |
| `server/share.js`, `public/**` | Sharing endpoints, frontend, UI translations |
| `scripts/*.js` | Tests and maintenance scripts |
| `data/`, `cache/`, `output/`, `tmp/` | Runtime state (git-ignored) |

## Shared helpers

- `server/paths.js`: `ROOT, PUBLIC_DIR, FONTS_DIR, DATA_DIR, CACHE_DIR, QURAN_CACHE_DIR,
  AUDIO_CACHE_DIR, CLIP_CACHE_DIR, THUMB_CACHE_DIR, OUTPUT_DIR, TMP_DIR, ensureDirs()`
- `server/lib/http.js`: `fetchJson(url, { headers, timeoutMs, cacheFile, maxAgeMs })`,
  `download(url, dest, { headers, timeoutMs })` (atomic, de-duplicated, skips if cached)
- `server/lib/ffmpeg.js`: `FFMPEG, FFPROBE, probe(file) → {duration,width,height,hasVideo,hasAudio}`,
  `runFfmpeg(args, { cwd, signal, onProgress(seconds) })`
- `server/lib/errors.js`: `httpError(status, code, message)` → thrown errors become
  `{ "error": { "code": "...", "message": "..." } }` with that HTTP status.
- `server/lib/net.js`: `lanAddresses()` → best LAN IPv4 first (e.g. `['192.168.1.5', ...]`).

## Module loading

`server/index.js` dynamically imports, in order: `./quran.js`, `./reciters.js`,
`./sources/index.js`, `./render/index.js`, `./share.js`. Each may export:
- `router` — an `express.Router()` mounted at **`/api`** (so define routes like `router.get('/surahs', …)`)
- `init()` — optional async startup hook (keep it fast; no network calls that block startup).
A module that throws on import is skipped with a warning, so the server still boots.

Static: `/` → `public/`, `/output/*` → finished videos/thumbnails, `/fonts/*` → `assets/fonts/`,
`/v/:id` → `public/share.html` (mobile share page).

## JS interfaces between modules

### `server/quran.js`
```js
export async function getSurahs()
// → [{ number, nameAr: 'الفاتحة', nameEn: 'Al-Fatihah', meaningEn: 'The Opener',
//      meanings: { en, ar?, ur, fa, fr, tr, id, ms, bn, es, de, ru }, ayahCount, revelation: 'meccan'|'medinan' }]
export async function getSurah(number)            // one of the above, or throws httpError(404,'surah_not_found')
export async function getTranslations()           // → [{ key, languageIso, title, description, version }]
export function defaultTranslationFor(uiLang)     // → translation key or null (e.g. 'en' → 'english_saheeh', 'ar' → null)
export async function getAyahs(surah, from, to, translationKey /* string|null */)
// → [{ surah, ayah, arabic, translation /* footnote markers like [4] removed, or null */,
//      translationRaw /* exactly as QuranEnc returns it, or null */, footnotes /* string|null */ }]
// Arabic text is QuranEnc's `arabic_text`, verbatim. Validates ranges (httpError 400 'invalid_range').
export async function getBismillahText()          // → Arabic text of 1:1, verbatim from QuranEnc
```

### `server/reciters.js`
```js
export async function getReciters()               // → [{ id, nameEn, nameAr, style /* 'murattal'|'mujawwad'|'muallim'|null */, bitrate }]
export async function getReciter(id)              // → one, or throws httpError(404,'reciter_not_found')
export async function getAyahAudio(reciterId, surah, ayah)
// → { path /* absolute local mp3, cached in AUDIO_CACHE_DIR */, duration /* seconds */ }
// `id` is the EveryAyah folder name (e.g. 'Alafasy_128kbps'); only allow-listed ids are accepted.
```

### `server/sources/index.js`
```js
export const CATEGORY_IDS = ['nature', 'space', 'mosque', 'islamic'];
export async function pickClips({ categories, totalDuration, orientation /* 'portrait'|'landscape'|'square' */, approvedOnly = false })
// → [{ id /* 'pexels:123' */, path /* absolute local mp4, already downloaded */, duration, width, height,
//      provider, author, sourceUrl }]
// Approved library clips first (shuffled, no duplicates), then — unless approvedOnly — filtered live
// search results. Returns enough distinct clips to cover ~totalDuration at ~7s per clip when possible,
// fewer if not available, [] if nothing at all (renderer then uses a generated background).
// Never throws because a provider is unconfigured/down — it just uses what it can.
```

### `server/render/index.js`
```js
export async function init()                      // load data/videos.json, re-queue unfinished jobs
export const router
export function getVideo(id)                      // record or undefined
export function listVideos()                      // records, newest first
```

## REST API (all JSON unless noted; errors: `{ error: { code, message } }`)

### Quran
- `GET /api/surahs` → array from `getSurahs()`
- `GET /api/translations` → `{ defaults: { en: 'english_saheeh', ar: null, ... }, translations: [...] }`
- `GET /api/ayahs?surah=1&from=1&to=7&translation=english_saheeh` (translation optional / `none`)
  → `{ surah: {…getSurah}, from, to, translation: {key,languageIso,title}|null, ayahs: [...getAyahs] }`
  (max 300 ayat per request)
- `GET /api/reciters` → array from `getReciters()`
- `GET /api/reciters/:id/audio/:surah/:ayah` → `audio/mpeg` (the cached mp3; used for preview)

### Video sources & library
Clip object (candidate or library entry):
```json
{ "id": "pexels:123", "provider": "pexels|pixabay|nasa|upload", "providerId": "123",
  "category": "nature", "title": "Ocean waves at sunset", "tags": ["ocean","waves"],
  "author": "Jane Doe", "authorUrl": "https://…", "sourceUrl": "https://www.pexels.com/video/…",
  "thumbUrl": "https://… or /api/library/thumb/<file>", "previewUrl": "small mp4 URL for hover/preview",
  "width": 1920, "height": 1080, "duration": 15, "orientation": "landscape|portrait|square",
  "status": "approved|rejected (library only)", "addedAt": "ISO date" }
```
- `GET /api/categories` → `[{ id, queries: [...] }]`
- `GET /api/sources/status` → `{ providers: { pexels: { enabled }, pixabay: { enabled }, nasa: { enabled: true }, upload: { enabled: true } }, library: { nature: { approved: 3 }, space: {…}, mosque: {…}, islamic: {…} } }`
- `GET /api/library?category=nature` → approved clips (all categories if omitted)
- `GET /api/library/candidates?category=nature&page=1&orientation=portrait` → `{ clips: [...], page, hasMore }`
  (filtered, excludes already approved/rejected)
- `POST /api/library/approve` body = clip object → saved entry
- `POST /api/library/reject` body = `{ id, category }` → `{ ok: true }`
- `DELETE /api/library/:id` → `{ ok: true }` (id is URL-encoded, e.g. `pexels%3A123`)
- `POST /api/library/upload?category=nature` raw body (`Content-Type: video/mp4|video/webm|video/quicktime`,
  header `X-Filename`), max 500 MB → saved (approved) clip entry
- `GET /api/library/thumb/:file`, `GET /api/library/clip/:id` → local thumbnail / clip file for uploads

### Rendering & videos
Render request:
```json
{
  "items": [{ "surah": 1, "from": 1, "to": 7 }, { "surah": 112, "from": 1, "to": 4 }],
  "mode": "combined",            // "combined" = one video per item; "perAyah" = one video per ayah
  "reciter": "Alafasy_128kbps",
  "translation": "english_saheeh", // or null for Arabic only
  "categories": ["nature", "space"],
  "aspect": "9:16",              // "9:16" | "16:9" | "1:1"
  "quality": "1080",             // "1080" | "720"
  "bismillah": true,             // prepend Bismillah when an item starts at ayah 1 (not for surah 1 or 9)
  "approvedOnly": false,
  "style": {
    "arabicFont": "amiri",       // "amiri" | "scheherazade"
    "textScale": 1.0,            // 0.7 – 1.5
    "position": "center",        // "center" | "lower"
    "overlay": 0.45,             // background darkening 0 – 0.8
    "showSurahTitle": true,
    "showReciter": true
  }
}
```
Limits: ≤ 50 videos per request, ≤ 50 ayat per video. Unknown/missing fields get defaults.

Video record (one per output video; also used as the job status):
```json
{ "id": "v8f3k2a1", "batchId": "b1x9…", "status": "queued|running|done|error|canceled",
  "progress": 0.42, "stage": "queued|audio|text|clips|render|finalize|done",
  "error": null, "request": { "surah": 1, "from": 1, "to": 7, "…": "normalized options" },
  "surah": { "number": 1, "nameAr": "الفاتحة", "nameEn": "Al-Fatihah" }, "from": 1, "to": 7,
  "reciter": { "id": "Alafasy_128kbps", "nameEn": "Mishary Alafasy", "nameAr": "مشاري العفاسي" },
  "translation": { "key": "english_saheeh", "languageIso": "en", "title": "…" },
  "aspect": "9:16", "width": 1080, "height": 1920, "duration": 41.2, "sizeBytes": 5123456,
  "url": "/output/v8f3k2a1.mp4", "thumbUrl": "/output/v8f3k2a1.jpg",
  "credits": [{ "provider": "pexels", "author": "…", "sourceUrl": "…" }],
  "createdAt": "ISO", "finishedAt": "ISO|null" }
```
- `POST /api/render` → `{ batchId, videos: [record, …] }` (202)
- `GET /api/videos?status=done` → records newest first (status filter optional)
- `GET /api/videos/:id` → record
- `DELETE /api/videos/:id` → cancels if queued/running, deletes files → `{ ok: true }`

### Sharing
- `GET /api/server-info` → `{ port, lanUrls: ['http://192.168.1.5:4700'], publicBaseUrl: string|null, shareBaseUrl }`
  (`shareBaseUrl` = `PUBLIC_BASE_URL` || first LAN URL || `http://localhost:PORT`)
- `GET /api/qr.svg?text=<url>` → `image/svg+xml` QR code (text ≤ 1000 chars)
- Share page URL for a video: `${shareBaseUrl}/v/${id}`; file URL: `${shareBaseUrl}/output/${id}.mp4`

## Product rules
- Quran Arabic text is shown/burned **verbatim** from QuranEnc. Never generate, retype or "fix" it.
- Credit sources: QuranEnc.com (required by its terms), EveryAyah, and the footage provider/author.
- Background clips: nature, space, mosques, general Islamic imagery only. Strip clip audio. No music.
- UI languages (12): ar, ur, fa (RTL); en, fr, tr, id, ms, bn, es, de, ru (LTR).
