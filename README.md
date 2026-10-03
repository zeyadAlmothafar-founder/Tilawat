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

### Background footage

Out of the box the app includes a **starter library** of hand-picked Pixabay clips in both
vertical and horizontal formats (links and credits only — the clips download on first use),
plus NASA Earth-from-space footage. You can also upload your own clips under **Backgrounds**.

To search for more footage, copy `.env.example` to `.env` and add a free API key:

- `PIXABAY_API_KEY` — https://pixabay.com/api/docs/ (recommended)
- `PEXELS_API_KEY` — https://www.pexels.com/api/ (optional; Pexels may not be issuing new keys)

Then restart and review clips under **Backgrounds**: approved clips are used first, clips that
match the video's format (vertical or horizontal) are preferred, and you can choose "Only use my
approved clips" when creating videos.

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
  sources/          background footage: Pixabay, Pexels, NASA, uploads, filter, library
  render/           FFmpeg pipeline, subtitles, layout, fonts, job queue
  share.js          server info for share links, QR codes
public/             frontend (vanilla JS, no build step), i18n/*.json
assets/fonts/       bundled OFL fonts
docs/               architecture and API reference
scripts/            test and maintenance scripts (see below)
data/ cache/ output/ tmp/   runtime state (git-ignored)
```

Useful scripts:

```bash
npm test                                  # offline checks: content filter, provider parsing, all 12 UI translations
npm run test:online                       # Quran data, reciters and clip downloads (uses the network)
node scripts/render-test.js --surah 1 --from 1 --to 7 --reciter Alafasy_128kbps --translation english_saheeh --aspect 9:16 --categories space
node scripts/check-reciters.js            # re-verify the reciter audio folders
node scripts/fetch-fonts.js               # re-download the bundled fonts
node --env-file=.env scripts/build-starter-library.js collect   # refresh the starter footage list
```

Architecture, module interfaces and the REST API are documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR. When adding a UI
language, copy `public/i18n/en.json`, add the language to `public/i18n/languages.js`, and run
`node scripts/check-i18n.js <code> --strict`. Quran text must always come verbatim from QuranEnc.

## License & credits

The source code is MIT-licensed (see [LICENSE](LICENSE)).

- Quran text and translations: [QuranEnc.com](https://quranenc.com) — shown without modification, credited
  with the translation's version number, and refreshed when QuranEnc publishes a new version.
- Recitations: [EveryAyah.com](https://everyayah.com).
- Footage: [Pixabay](https://pixabay.com), [Pexels](https://www.pexels.com), [NASA](https://images.nasa.gov) — credited in each video.
  The repository never contains the footage itself, only links to it.
- Fonts (SIL Open Font License): Amiri Quran, Amiri, Scheherazade New, Noto Sans, Noto Naskh Arabic,
  Noto Nastaliq Urdu, Noto Sans Bengali.
