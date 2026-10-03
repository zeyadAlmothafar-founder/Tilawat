// Module-level checks for server/quran.js and server/reciters.js (uses the network on first run).
// Usage: node scripts/a-test-quran.js
import assert from 'node:assert/strict';
import {
  getSurahs, getSurah, getTranslations, defaultTranslationFor, getAyahs, getBismillahText, cleanTranslation,
} from '../server/quran.js';
import { getReciters, getAyahAudio } from '../server/reciters.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${err.message.split('\n').join('\n     ')}`);
  }
}

async function rejectsWith(promise, status, code) {
  await assert.rejects(promise, (err) => err.status === status && err.code === code);
}

const CLEANING = [
  // [raw, footnotes, ayah, expected]
  ['[All] praise is [due] to Allāh, Lord[4] of the worlds -', '[4] ...', 2, '[All] praise is [due] to Allāh, Lord of the worlds -'],
  ['In the name of Allāh,[2] the Entirely Merciful, the Especially Merciful.[3]', '[2] a\n[3] b', 1, 'In the name of Allāh, the Entirely Merciful, the Especially Merciful.'],
  ['2. All the praises and thanks be to Allâh, the Lord[1] of the ‘Âlamîn.[2]', '[1] a\n[2] b', 2, 'All the praises and thanks be to Allâh, the Lord of the ‘Âlamîn.'],
  ['7. text that starts with another number', null, 3, '7. text that starts with another number'],
  ['1.Dengan nama Allah Yang Maha Pengasih, Maha Penyayang.', null, 1, 'Dengan nama Allah Yang Maha Pengasih, Maha Penyayang.'],
  ['२.  सर्व स्तुति - प्रशंसा', null, 2, 'सर्व स्तुति - प्रशंसा'],
  ['сказали: «Уделяй нам внимание [3]!» – а', '[3] x', 104, 'сказали: «Уделяй нам внимание!» – а'],
  ['سب تعریف اللہ تعالیٰ کے لئے ہے[1] جو تمام جہانوں کا پالنے واﻻ ہے۔[2]', '[1] a\n[2] b', 2, 'سب تعریف اللہ تعالیٰ کے لئے ہے جو تمام جہانوں کا پالنے واﻻ ہے۔'],
  ['সকল ‘হাম্‌দ’ [১] আল্লাহ্‌র [২] , যিনি সৃষ্টিকুলের [৩] রব [৪],', '[১] a\n[২] b', 2, 'সকল ‘হাম্‌দ’ আল্লাহ্‌র, যিনি সৃষ্টিকুলের রব,'],
  ['কিছু মূর্খ- নির্বোধরা (২) বলবে: কীসে', '(২) অর্থাৎ', 142, 'কিছু মূর্খ- নির্বোধরা বলবে: কীসে'],
  ['a list (2) item without footnotes', null, 5, 'a list (2) item without footnotes'],
  ['私たちを、まっすぐな道[1]へとお導きください。', '[1] x', 6, '私たちを、まっすぐな道へとお導きください。'],
  ['ئاللاھنىڭ ئىسمى بىلەن باشلايمەن(1).', null, 1, 'ئاللاھنىڭ ئىسمى بىلەن باشلايمەن.'],
  ['  spaced \n  out  text ', null, 1, 'spaced out text'],
  ['(2) Gratitude be to Allah the Lord of all beings;', null, 2, 'Gratitude be to Allah the Lord of all beings;'],
  [' 1-2 ټول (د كمال) صفتونه', null, 2, 'ټول (د كمال) صفتونه'], // "surah-ayah" prefix (surah 1)
  ['3-2 not this surah', null, 2, '3-2 not this surah'],
];

await check('cleanTranslation cases', () => {
  for (const [raw, fn, ayah, expected] of CLEANING) assert.equal(cleanTranslation(raw, fn, ayah, 1), expected);
});

await check('surahs: 114, 6236 ayat, names', async () => {
  const surahs = await getSurahs();
  assert.equal(surahs.length, 114);
  assert.equal(surahs.reduce((n, s) => n + s.ayahCount, 0), 6236);
  assert.deepEqual([surahs[0].nameAr, surahs[0].nameEn, surahs[0].meaningEn], ['الفاتحة', 'Al-Fatihah', 'The Opener']);
  assert.equal((await getSurah(114)).nameAr, 'الناس');
  await rejectsWith(getSurah(115), 404, 'surah_not_found');
});

await check('defaults exist in the translations list', async () => {
  const keys = new Set((await getTranslations()).map((t) => t.key));
  for (const lang of ['en', 'ur', 'fa', 'fr', 'tr', 'id', 'ms', 'bn', 'es', 'de', 'ru']) {
    assert.ok(keys.has(defaultTranslationFor(lang)), `${lang} → ${defaultTranslationFor(lang)}`);
  }
  assert.equal(defaultTranslationFor('ar'), null);
  assert.equal(defaultTranslationFor('xx'), null);
  assert.equal(defaultTranslationFor('en-GB'), 'english_saheeh');
});

await check('Al-Fatihah with Saheeh International', async () => {
  const ayahs = await getAyahs(1, 1, 7, 'english_saheeh');
  assert.equal(ayahs.length, 7);
  assert.equal(ayahs[0].arabic, await getBismillahText());
  assert.equal(ayahs[1].translation, '[All] praise is [due] to Allāh, Lord of the worlds -');
  assert.match(ayahs[1].translationRaw, /Lord\[\d+\] of/);
  for (const a of ayahs) assert.doesNotMatch(a.translation, /\[\d+\]/);
});

await check('Arabic only + identical Arabic across translations', async () => {
  const plain = await getAyahs(2, 1, 5, null);
  assert.ok(plain.every((a) => a.arabic && a.translation === null && a.translationRaw === null && a.footnotes === null));
  for (const key of ['urdu_junagarhi', 'russian_rwwad', 'bengali_zakaria']) {
    const other = await getAyahs(2, 1, 5, key);
    assert.deepEqual(other.map((a) => a.arabic), plain.map((a) => a.arabic), key);
    assert.ok(other.every((a) => a.translation && !/\[[0-9০-৯]+\]/.test(a.translation)), key);
  }
});

await check('validation errors', async () => {
  await rejectsWith(getAyahs(0, 1, 1, null), 400, 'invalid_range');
  await rejectsWith(getAyahs(1, 0, 3, null), 400, 'invalid_range');
  await rejectsWith(getAyahs(1, 5, 3, null), 400, 'invalid_range');
  await rejectsWith(getAyahs(1, 1, 8, null), 400, 'invalid_range');
  await rejectsWith(getAyahs(1, 1, 7, 'klingon_x'), 400, 'unknown_translation');
});

await check('reciters + audio for 1:2 (Alafasy)', async () => {
  const reciters = await getReciters();
  assert.ok(reciters.length >= 20 && reciters.every((r) => r.id && r.nameEn && r.nameAr && r.bitrate));
  const audio = await getAyahAudio('Alafasy_128kbps', 1, 2);
  assert.ok(audio.duration > 3 && audio.duration < 12, `duration ${audio.duration}`);
  const again = await getAyahAudio('Alafasy_128kbps', '1', '2');
  assert.deepEqual(again, audio);
  await rejectsWith(getAyahAudio('nope', 1, 1), 404, 'reciter_not_found');
  await rejectsWith(getAyahAudio('Alafasy_128kbps', 1, 8), 400, 'invalid_range');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
