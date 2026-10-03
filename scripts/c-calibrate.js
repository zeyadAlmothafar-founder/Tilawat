// Measures rendered text metrics with libass (one sample per frame, bbox filter) so the
// layout estimator in server/render/layout.js can use real numbers.
// Usage: node scripts/c-calibrate.js
import fs from 'node:fs';
import path from 'node:path';
import { runFfmpeg } from '../server/lib/ffmpeg.js';
import { TMP_DIR } from '../server/paths.js';
import { FONTS, prepareJobFonts } from '../server/render/fonts.js';
import { assTime as toTime } from '../server/render/subtitles.js';

const FIX = path.join(TMP_DIR, 'c-fixtures');
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')).result;
const en2 = read('english_saheeh_2.json');
const ur2 = read('urdu_junagarhi_2.json');
const words = (s, a, b) => s.split(/\s+/).slice(a, b).join(' ');
const SIZE = 50;
const DIR = path.join(TMP_DIR, 'c-calib');

const samples = [];
const add = (font, text) => samples.push({ font, text });
for (const font of ['amiriQuran', 'scheherazade', 'naskh']) {
  for (const i of [1, 4, 6, 254, 281]) add(font, words(en2[i].arabic_text, 0, 9));
}
for (const font of ['notoSansMedium']) for (const i of [1, 4, 6, 254, 281]) add(font, words(en2[i].translation, 0, 12));
for (const font of ['nastaliq', 'naskh']) for (const i of [1, 4, 6, 254, 281]) add(font, words(ur2[i].translation, 0, 12));

// Line-height probes: same glyphs on 1 and 2 lines.
const lh = [];
for (const font of ['amiriQuran', 'scheherazade', 'notoSansMedium', 'nastaliq', 'naskh', 'bengali']) {
  const t = font === 'notoSansMedium' ? 'Hg' : font === 'bengali' ? 'আল্লাহ' : 'بِسۡمِ';
  lh.push({ font, text: t }, { font, text: `${t}\\N${t}` });
}
const all = [...samples, ...lh];

fs.mkdirSync(DIR, { recursive: true });
await prepareJobFonts(Object.keys(FONTS).filter((k) => FONTS[k].base), path.join(DIR, 'fonts'));
const styles = Object.keys(FONTS)
  .filter((k) => FONTS[k].base)
  .map((k) => `Style: ${k},${FONTS[k].family},${SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,${FONTS[k].bold ? -1 : 0},0,0,0,100,100,0,0,1,0,0,5,0,0,0,-1`);
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 4000
PlayResY: 600
WrapStyle: 2
ScaledBorderAndShadow: yes
Kerning: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${all.map((s, i) => `Dialogue: 0,${toTime(i)},${toTime(i + 1)},${s.font},,0,0,0,,{\\pos(2000,300)}${s.text}`).join('\n')}
`;
fs.writeFileSync(path.join(DIR, 'calib.ass'), ass);
await runFfmpeg(['-f', 'lavfi', '-i', `color=c=black:s=4000x600:r=1:d=${all.length}`, '-vf',
  'ass=calib.ass:fontsdir=fonts:shaping=complex,format=gray,bbox=min_val=30,metadata=mode=print:file=bbox.txt', '-f', 'null', '-'], { cwd: DIR });

const boxes = [];
let cur = null;
for (const line of fs.readFileSync(path.join(DIR, 'bbox.txt'), 'utf8').split('\n')) {
  if (line.startsWith('frame:')) boxes.push((cur = {}));
  const m = line.match(/lavfi\.bbox\.(w|h)=(\d+)/);
  if (m && cur) cur[m[1]] = Number(m[2]);
}
const base = (t) => [...t.replace(/\\N/g, '')].filter((c) => !/\p{M}/u.test(c)).length;
const perFont = {};
samples.forEach((s, i) => {
  const b = boxes[i];
  (perFont[s.font] ??= []).push(b.w / base(s.text) / SIZE);
});
for (const [font, v] of Object.entries(perFont)) {
  console.log(`${font.padEnd(16)} em/char avg ${(v.reduce((a, b) => a + b) / v.length).toFixed(3)}  [${v.map((x) => x.toFixed(3)).join(', ')}]`);
}
for (let i = 0; i < lh.length; i += 2) {
  const one = boxes[samples.length + i];
  const two = boxes[samples.length + i + 1];
  console.log(`${lh[i].font.padEnd(16)} line advance ${((two.h - one.h) / SIZE).toFixed(3)} em, glyph h ${(one.h / SIZE).toFixed(2)} em`);
}
