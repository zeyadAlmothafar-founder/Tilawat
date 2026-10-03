// Verifies the curated EveryAyah reciter candidates and writes the allow-list to
// server/data/reciters.json (only folders whose sample files all return 200 audio/mpeg).
// Usage: node scripts/check-reciters.js            → check + write reciters.json
//        node scripts/check-reciters.js --bismillah → also compare ayah-1 durations
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../server/paths.js';
import { fetchJson } from '../server/lib/http.js';
import { FFMPEG } from '../server/lib/ffmpeg.js';

const OUT_FILE = path.join(ROOT, 'server', 'data', 'reciters.json');
const BASE = 'https://everyayah.com/data';
const SAMPLES = ['001001', '002255', '114006'];

// Display order = list order. Folder names come from https://everyayah.com/data/recitations.js
// (highest available bitrate per reciter/style). Deliberately not used (checked with --bismillah):
//   Ahmed_ibn_Ali_al-Ajamy_128kbps_ketaballah.net — its ayah-1 files include the Bismillah
//   Ali_Jaber_64kbps — its 001001.mp3 is Ta'awwudh + Bismillah
//   Ibrahim_Akhdar_64kbps — listed but returns 404 (the 32 kbps folder works)
const CANDIDATES = [
  ['Alafasy_128kbps', 'Mishary Rashid Alafasy', 'مشاري راشد العفاسي', 'murattal'],
  ['Abdul_Basit_Murattal_192kbps', 'Abdul Basit Abdul Samad', 'عبد الباسط عبد الصمد', 'murattal'],
  ['Abdul_Basit_Mujawwad_128kbps', 'Abdul Basit Abdul Samad', 'عبد الباسط عبد الصمد', 'mujawwad'],
  ['Husary_128kbps', 'Mahmoud Khalil Al-Husary', 'محمود خليل الحصري', 'murattal'],
  ['Husary_128kbps_Mujawwad', 'Mahmoud Khalil Al-Husary', 'محمود خليل الحصري', 'mujawwad'],
  ['Husary_Muallim_128kbps', 'Mahmoud Khalil Al-Husary', 'محمود خليل الحصري', 'muallim'],
  ['Minshawy_Murattal_128kbps', 'Mohamed Siddiq Al-Minshawi', 'محمد صديق المنشاوي', 'murattal'],
  ['Minshawy_Mujawwad_192kbps', 'Mohamed Siddiq Al-Minshawi', 'محمد صديق المنشاوي', 'mujawwad'],
  ['Abdurrahmaan_As-Sudais_192kbps', 'Abdul Rahman Al-Sudais', 'عبد الرحمن السديس', 'murattal'],
  ['Saood_ash-Shuraym_128kbps', 'Saud Al-Shuraim', 'سعود الشريم', 'murattal'],
  ['MaherAlMuaiqly128kbps', 'Maher Al-Muaiqly', 'ماهر المعيقلي', 'murattal'],
  ['Yasser_Ad-Dussary_128kbps', 'Yasser Al-Dosari', 'ياسر الدوسري', 'murattal'],
  ['Ghamadi_40kbps', 'Saad Al-Ghamdi', 'سعد الغامدي', 'murattal'],
  ['Abu_Bakr_Ash-Shaatree_128kbps', 'Abu Bakr Al-Shatri', 'أبو بكر الشاطري', 'murattal'],
  ['Hani_Rifai_192kbps', 'Hani Ar-Rifai', 'هاني الرفاعي', 'murattal'],
  ['Nasser_Alqatami_128kbps', 'Nasser Al-Qatami', 'ناصر القطامي', 'murattal'],
  ['ahmed_ibn_ali_al_ajamy_128kbps', 'Ahmed Al-Ajmi', 'أحمد بن علي العجمي', 'murattal'],
  ['Muhammad_Ayyoub_128kbps', 'Muhammad Ayyub', 'محمد أيوب', 'murattal'],
  ['Abdullah_Basfar_192kbps', 'Abdullah Basfar', 'عبد الله بصفر', 'murattal'],
  ['Hudhaify_128kbps', 'Ali Al-Hudhaifi', 'علي الحذيفي', 'murattal'],
  ['Fares_Abbad_64kbps', 'Fares Abbad', 'فارس عباد', 'murattal'],
  ['Muhammad_Jibreel_128kbps', 'Muhammad Jibreel', 'محمد جبريل', 'murattal'],
  ['Khaalid_Abdullaah_al-Qahtaanee_192kbps', 'Khalid Al-Qahtani', 'خالد القحطاني', 'murattal'],
  ['Ibrahim_Akhdar_32kbps', 'Ibrahim Al-Akhdar', 'إبراهيم الأخضر', 'murattal'],
  ['Salaah_AbdulRahman_Bukhatir_128kbps', 'Salah Bukhatir', 'صلاح بو خاطر', 'murattal'],
  ['Salah_Al_Budair_128kbps', 'Salah Al-Budair', 'صلاح البدير', 'murattal'],
  ['Abdullaah_3awwaad_Al-Juhaynee_128kbps', 'Abdullah Awad Al-Juhani', 'عبد الله عواد الجهني', 'murattal'],
  ['Mohammad_al_Tablaway_128kbps', 'Mohammad Al-Tablawi', 'محمد محمود الطبلاوي', 'murattal'],
  ['Muhsin_Al_Qasim_192kbps', 'Abdul Muhsin Al-Qasim', 'عبد المحسن القاسم', 'murattal'],
];

/** Returns null if the file is a reachable MP3, otherwise a short reason. */
async function checkFile(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
    const type = res.headers.get('content-type') || '';
    if (res.status !== 200) return `HTTP ${res.status}`;
    if (!type.startsWith('audio/mpeg')) return `content-type ${type}`;
    return null;
  } catch (err) {
    return err.message;
  }
}

async function checkReciter([id, nameEn, nameAr, style], known) {
  const meta = known.get(id);
  if (!meta) return { id, error: 'not in recitations.js' };
  const failures = [];
  for (const file of SAMPLES) {
    const reason = await checkFile(`${BASE}/${id}/${file}.mp3`);
    if (reason) failures.push(`${file}: ${reason}`);
  }
  if (failures.length) return { id, error: failures.join(', ') };
  return { id, nameEn, nameAr, style, bitrate: parseInt(meta.bitrate, 10) || null };
}

/** Lengths (s) of the voiced parts of a remote mp3, split on pauses ≥ 0.3 s. */
function speechSegments(url) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-i', url, '-af', 'silencedetect=noise=-38dB:d=0.3', '-f', 'null', '-'];
    const child = spawn(FFMPEG, args, { windowsHide: true });
    let log = '';
    child.stderr.on('data', (chunk) => (log += chunk));
    child.on('error', reject);
    child.on('close', () => {
      const [h, m, s] = (log.match(/Duration: (\d+):(\d+):([\d.]+)/) || []).slice(1).map(Number);
      const total = h * 3600 + m * 60 + s;
      const voiced = [];
      let cursor = 0;
      let silent = false;
      for (const [, kind, at] of log.matchAll(/silence_(start|end): ([\d.]+)/g)) {
        const t = Number(at);
        if (kind === 'start') {
          if (t - cursor > 0.25) voiced.push(t - cursor);
          silent = true;
        } else {
          cursor = t;
          silent = false;
        }
      }
      if (!silent && total - cursor > 0.25) voiced.push(total - cursor);
      resolve({ total, voiced });
    });
  });
}

/**
 * The renderer prepends 001001.mp3 as the Bismillah, so ayah-1 files of other surahs must not
 * contain it, and 001001 must contain nothing else. A Bismillah prefix shows up as an extra
 * voiced segment roughly as long as 1:1 (Ya-Sin 36:1 and Al-Ikhlas 112:1 are short single phrases).
 */
async function bismillahReport(reciters) {
  const files = ['001001', '036001', '112001', '002001'];
  console.log(`\nVoiced segments per file (s): ${files.join(', ')}`);
  for (const r of reciters) {
    const parts = await Promise.all(files.map((f) => speechSegments(`${BASE}/${r.id}/${f}.mp3`)));
    const flag = parts.some((p) => p.voiced.length > 1) ? '  <-- listen' : '';
    const text = parts.map((p, i) => `${files[i]} ${p.total.toFixed(1)} [${p.voiced.map((v) => v.toFixed(1)).join('+')}]`);
    console.log(`${r.id.padEnd(40)} ${text.join('  ')}${flag}`);
  }
}

async function main() {
  const index = await fetchJson(`${BASE}/recitations.js`, { timeoutMs: 30000 });
  const known = new Map(Object.values(index).filter((v) => v?.subfolder).map((v) => [v.subfolder, v]));

  const results = [];
  for (let i = 0; i < CANDIDATES.length; i += 6) {
    results.push(...(await Promise.all(CANDIDATES.slice(i, i + 6).map((c) => checkReciter(c, known)))));
  }
  const ok = results.filter((r) => !r.error);
  for (const r of results) console.log(`${r.error ? 'FAIL' : ' ok '}  ${r.id}${r.error ? `  (${r.error})` : `  ${r.bitrate}kbps`}`);

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  await fs.writeFile(OUT_FILE, `${JSON.stringify(ok, null, 2)}\n`);
  console.log(`\n${ok.length}/${results.length} reciters verified → ${path.relative(ROOT, OUT_FILE)}`);

  if (process.argv.includes('--bismillah')) await bismillahReport(ok);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
