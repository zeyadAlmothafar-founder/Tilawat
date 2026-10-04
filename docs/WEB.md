# Tilawat Web — build contract (option B)

The public site at `*.netlify.app`: the **same UI** as the self-hosted app (`public/`), but every
video is made **in the visitor's browser** (WebCodecs + Canvas, MP4 muxing with Mediabunny).
No server renders anything. Quran text/translations/tafsir come straight from QuranEnc, recitation
from EveryAyah, background footage from pre-cut clip segments (Cloudflare R2; before R2 exists,
directly from Pixabay's CDN). All three send `Access-Control-Allow-Origin: *` (verified).

Verified feasible on 2026-10-04 in Chromium 152: QuranEnc + EveryAyah + Pixabay fetch, Arabic
Quran text drawn on canvas with Amiri Quran (correct shaping), H.264 1080×1920 + AAC encoded at
5.3× realtime, valid fast-start MP4 (spike: `tmp/browser-spike.html`, local only).

## Layout

| Path | Owner | What |
|---|---|---|
| `web/js/render/**`, `web/vendor/**`, `web/test/**`, `scripts/web-test-server.js` | **W1 (renderer)** | Browser render engine, vendored Mediabunny, test harness |
| `web/build.js`, `web/js/*.js` (api, store, data, jobs), `netlify.toml`, `shared/**`, small web-mode tweaks in `public/**`, new i18n keys | **W2 (web app)** | Data/back-end adapter, IndexedDB, build to `dist/`, Netlify config |
| `scripts/build-web-clips.js`, `scripts/upload-r2.js`, `web/clips.json`, `web/workers/clips-worker.js` | **W3 (clips)** | Clip segments, R2 upload, manifest, optional R2-serving Worker |
| everything else | lead | — |

The self-hosted server version must keep working unchanged (`npm start`, `npm test`).
No new runtime npm dependencies for the server. Mediabunny (MPL-2.0) is vendored as a file under
`web/vendor/` with its license. Don't `git commit` (the lead commits).

## Build

`node web/build.js` → `dist/` (no network, no FFmpeg needed; runs on Netlify with Node 22):
- copy `public/**` → `dist/` (except `share.html`), then overlay `web/js/api.js` onto `dist/js/api.js`
- copy `web/js/**` → `dist/js/web/**`, `web/vendor/**` → `dist/vendor/**`
- copy `server/data/{surahs,reciters,tafsirs}.json` → `dist/data/`, `web/clips.json` → `dist/data/clips.json`
- copy `assets/fonts/**` → `dist/fonts/`
- set `<html data-mode="web">` in `dist/index.html`

`netlify.toml`: `command = "node web/build.js"`, `publish = "dist"`, `NODE_VERSION = "22"`, long cache
headers for `/fonts/*`, `/vendor/*`, `/data/*.json` (short), security headers.

## Render job (W2 builds it, W1 renders it)

```js
// web/js/render/index.js
export function canRender() // → Promise<{ ok, reason?, hardware?, aac: 'native'|'wasm', maxQuality: '1080'|'720' }> (also carries quick sync ok/reason)
export async function renderVideo(job, { onProgress /* (stage, fraction) */, signal }) // → { blob, thumbBlob, duration, width, height, sizeBytes }

job = {
  id, aspect: '9:16'|'16:9'|'1:1', width, height, fps: 30,
  fileSize: 'small'|'balanced'|'high',
  style: { arabicFont: 'amiri'|'scheherazade', textScale, position: 'center'|'lower', overlay,
           showSurahTitle, showReciter, credits: 'minimal'|'full'|'none' },
  surah: { number, nameAr, nameEn },
  reciter: { id, nameEn, nameAr },
  translation: { key, languageIso, direction, version, title } | null,
  tafsir: { key, languageIso, direction, title, label } | null,
  items: [   // playback order; a Bismillah item first when used
    { kind: 'bismillah'|'ayah', ayah: number|null, arabic, translation: string|null,
      tafsirFrom?, tafsirTo?,  // ayah range a grouped tafsir card explains
      audioUrl,                // EveryAyah mp3
      tafsirText: string|null  // card(s) shown after this item (already grouped), only when job.tafsir
    }],
  clips: [{ url, width, height, duration, provider, author }],  // chosen + ordered; cycle if short
  credit: string,              // footer credit line, '' = none
}
```
Stages for progress: `audio`, `clips`, `render`, `finalize`. Must support cancel via `signal`.

**Look**: match the self-hosted renderer (`server/render/layout.js`, `subtitles.js`, `pipeline.js`,
frames in `docs/images/`): header (gold `سورة …` + spaced Latin name), Arabic in Amiri Quran /
Scheherazade with the `U+06DD` + Arabic-Indic digits ayah ornament, translation below (RTL for
Urdu/Persian, explicit wrapping for CJK), footer reciter + credit, 0.3 s text fades, ~7 s clip
segments with 0.8 s crossfades, darkening per `style.overlay`, vignette, long ayat split into
timed chunks (pause marks first), tafsir cards (label + text, silent audio, max(4 s, words/2.8+1.5 s)).
Quran text arrives already display-mapped (open tanween → U+08F0–08F2); never alter letters.

**Encoding** (Mediabunny `CanvasSource` + `AudioBufferSource`, `fastStart: 'in-memory'`):
H.264 High, AAC LC 44.1 kHz stereo. Video bitrate by size × resolution:
small 1.2 / 0.8 Mb/s, balanced 2.2 / 1.4, high 5 / 3 (1080p / 720p); audio 96 / 128 / 160 kb/s.
Render in a Worker with `OffscreenCanvas` (not throttled in background tabs).

## Clip manifest (W3 writes, W2 reads) — `web/clips.json`

```json
{ "version": 1, "mode": "r2" | "pixabay-direct", "base": "https://<public clip host>" | null,
  "clips": [ { "id": "pixabay:123", "category": "nature", "orientation": "portrait",
               "title": "…", "author": "…", "sourceUrl": "https://pixabay.com/videos/…",
               "thumb": "thumbs/123.jpg",
               "segments": [ { "res": "1080", "url": "segments/123-a-1080.mp4", "width": 1080, "height": 1920, "duration": 8 },
                             { "res": "720",  "url": "segments/123-a-720.mp4",  "width": 720,  "height": 1280, "duration": 8 } ] } ] }
```
Relative `url`/`thumb` resolve against `base`. In `pixabay-direct` mode (prototype, before R2),
`url`s are absolute Pixabay CDN renditions (`tiny` → 720, `small` → 1080) with their full duration.

## Web-mode feature differences

Hidden/disabled in web mode: live footage search, approve/reject, server uploads, LAN QR codes,
`/v/:id` share pages, hosted share links. Kept: everything in Create, My Videos (stored in
IndexedDB on the visitor's device), Download, Web Share of the file, all 12 languages, tafsir.
Free-tier limits: ≤ 20 ayat per video, ≤ 5 videos per batch.

## Test ports
Self-hosted app 4700 (leave it running) · W1 4710 · W2 4711 · W3 none needed.
Only **W1** uses the built-in browser pane; others use headless Edge
(`"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --screenshot=… --virtual-time-budget=…`).
