# Quran Video Studio

*(working title — rename in `public/i18n/*.json` → `app.name` and `server/lib/brand.js`)*

Make short Quran recitation videos: verified Arabic text and a translation, synced ayah by ayah
with a reciter, over calm nature, space, mosque and Islamic footage. Create many videos at once,
then share them to WhatsApp and other apps, or scan a QR code to open them on your phone.

## Requirements

- Node.js 22.9 or newer
- FFmpeg 6+ on your PATH (or set `FFMPEG_PATH` / `FFPROBE_PATH` in `.env`)

## Run

```bash
npm install
npm start
```

Open http://localhost:4700. The terminal also prints a `Network:` address that phones on the
same Wi-Fi can open (Windows may ask to allow Node through the firewall the first time).

### Background footage keys (free, optional)

Space footage (NASA) and your own uploaded clips work without any keys. For nature, mosque and
Islamic footage, copy `.env.example` to `.env` and add:

- `PEXELS_API_KEY` — https://www.pexels.com/api/
- `PIXABAY_API_KEY` — https://pixabay.com/api/docs/

Then restart. Review clips under **Backgrounds**: approved clips are used first, and you can
choose "Only use my approved clips" when creating videos.

## Features

- **12 interface languages** with right-to-left (Arabic, Urdu, Persian) and left-to-right layouts.
- **Many videos at once** — add several passages, or split a range into one video per ayah.
- **29 reciters** (EveryAyah), **~115 translations** in dozens of languages (QuranEnc), or Arabic only.
- **Formats** 9:16 (Reels/TikTok/Shorts/Status), 16:9 (YouTube), 1:1 (feed); 1080p or 720p.
- **Styling** — Amiri Quran or Scheherazade New, text size, position, background darkness,
  surah title, reciter name, optional Bismillah.
- **Sharing** — native share of the video file (Chrome/Edge/Safari on phones and desktop), WhatsApp,
  Telegram, X, Facebook, email, copy link, download, and a QR code that opens a phone-friendly
  share page (`/v/<id>`).

Share links and QR codes use your LAN address, so they only work for devices on the same network.
If you deploy the app publicly, set `PUBLIC_BASE_URL` in `.env` so links work for everyone.

## How a video is made

1. Arabic text and translation come from QuranEnc.com, verbatim. The only change is display-level:
   QuranEnc's KFGQPC encoding of the open tanween is mapped to the standard Unicode characters so
   regular fonts draw it correctly.
2. Each ayah's recitation is downloaded from EveryAyah.com, silence-trimmed and joined; the text
   timing comes from the real audio durations, so every ayah appears exactly while it is recited.
3. Background clips are cut into ~7 s segments with crossfades, cropped to the format, silenced,
   darkened and vignetted. With no clips available, an animated gradient is used.
4. FFmpeg burns in the text (libass with complex shaping) and encodes H.264/AAC MP4.

## Project layout

```
server/
  index.js          app entry (Express)
  quran.js          surahs, translations, ayah text (QuranEnc)
  reciters.js       reciter list and per-ayah audio (EveryAyah)
  sources/          background footage: Pexels, Pixabay, NASA, uploads, filter, library
  render/           FFmpeg pipeline, subtitles, layout, fonts, job queue
  share.js          server info for share links, QR codes
public/             frontend (vanilla JS, no build step), i18n/*.json
assets/fonts/       bundled OFL fonts
scripts/            test and maintenance scripts (see below)
data/ cache/ output/ tmp/   runtime state (git-ignored)
```

Useful scripts:

```bash
node scripts/render-test.js --surah 1 --from 1 --to 7 --reciter Alafasy_128kbps --translation english_saheeh --aspect 9:16 --categories space
node scripts/d-i18n-check.js --strict      # verify all 12 translation files
node scripts/a-check-reciters.js           # re-verify reciter audio folders
```

## Credits & licenses

- Quran text and translations: [QuranEnc.com](https://quranenc.com) — shown without modification, with attribution.
- Recitations: [EveryAyah.com](https://everyayah.com).
- Footage: [Pexels](https://www.pexels.com), [Pixabay](https://pixabay.com), [NASA](https://images.nasa.gov) — credited in each video.
- Fonts (SIL Open Font License): Amiri Quran, Amiri, Scheherazade New, Noto Sans, Noto Naskh Arabic,
  Noto Nastaliq Urdu, Noto Sans Bengali.
