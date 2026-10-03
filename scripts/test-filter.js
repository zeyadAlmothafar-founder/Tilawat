// Unit test for the background-footage content filter: node scripts/test-filter.js
import assert from 'node:assert/strict';
import { checkClip } from '../server/sources/filter.js';
import { screenItem } from '../server/sources/providers/nasa.js';

const ok = { width: 1920, height: 1080, duration: 12 };
const clip = (title, extra = {}) => ({ ...ok, title, tags: [], ...extra });
const slug = (s) => clip('', { sourceUrl: `https://www.pexels.com/video/${s}/` });

// [clip, category, expected ok?, note]
const cases = [
  [clip('Aerial view of ocean waves'), 'nature', true, '"aerial" must not match "man"'],
  [clip('Mother Mary in a garden', { tags: ['mother mary', 'faith'] }), 'islamic', false, 'other religion (found in Pixabay results)'],
  [clip('Spaceship over clouds', { tags: ['star trek', 'science fiction'] }), 'space', false, 'sci-fi footage'],
  [clip('Eiffel tower by the river'), 'mosque', false, 'landmark returned for "minaret"'],
  [clip('Allah calligraphy', { tags: ['logo', 'background'] }), 'islamic', false, 'animated logo would clash with Quran text'],
  [clip('Milky way over mountains', { tags: ['night', 'sky', 'stars'] }), 'space', true, ''],
  [clip('Church dome at sunset'), 'mosque', false, 'other religion'],
  [clip('Woman praying in mosque'), 'mosque', false, 'person'],
  [clip('Men praying in mosque'), 'mosque', false, 'plural people'],
  [clip('Mosque minaret at sunset'), 'mosque', true, ''],
  [clip('Sheikh Zayed Grand Mosque at night'), 'mosque', true, ''],
  [clip('Manhattan skyline'), 'nature', true, '"man" only as a whole word'],
  [clip('Mother nature waterfall'), 'nature', true, 'no family words'],
  [clip('Kaaba crowd during tawaf'), 'islamic', true, 'crowd ok for Kaaba footage'],
  [clip('Pilgrims around the Kaaba in Mecca'), 'islamic', true, ''],
  [clip('People circling the Kaaba', { tags: ['hajj', 'people'] }), 'islamic', true, 'people ok in pilgrimage context'],
  [clip('People walking in a market'), 'islamic', false, 'people outside pilgrimage context'],
  [clip('Crowd at a beach'), 'nature', false, 'crowd blocked outside islamic'],
  [clip('Crowd at concert'), 'islamic', false, 'concert'],
  [clip('Buddha statue in temple'), 'nature', false, ''],
  [clip('Dome of the Rock on the Temple Mount'), 'islamic', true, '"temple mount" is neutral'],
  [clip('Christmas lights'), 'nature', false, ''],
  [clip('Crosses on a hill'), 'nature', false, 'plural "es"'],
  [clip('Crossing the desert dunes'), 'nature', true, '"crossing" is not "cross"'],
  [clip('Beach party with cocktails'), 'nature', false, ''],
  [clip('Red wine glass'), 'nature', false, ''],
  [clip('Dog running in a field'), 'nature', false, ''],
  [clip('Girl in a flower field'), 'nature', false, ''],
  [clip('Surfer riding ocean waves'), 'nature', false, ''],
  [clip('Ramadan lantern glowing'), 'islamic', true, ''],
  [clip('Prayer beads in hand'), 'islamic', true, 'hands are fine'],
  [clip('Rosary beads'), 'islamic', false, 'Christian prayer beads'],
  [clip('Angel Falls Venezuela'), 'nature', true, '"angel falls" is neutral'],
  [clip('Earth Views from the ISS - No Music'), 'space', true, '"no music" is neutral'],
  [clip('Galaxy with zodiac signs'), 'space', false, 'astrology'],
  [clip('Nebula', { description: 'Music: Universal Production Music' }), 'space', true, 'music credit in description ok'],
  [clip('Sky timelapse', { description: 'A church tower in the foreground' }), 'nature', false, 'church in description'],
  [slug('aerial-view-of-ocean-waves-1234567'), 'nature', true, 'slug'],
  [slug('woman-walking-on-the-beach-857195'), 'nature', false, 'slug with person'],
  [slug('close-up-of-a-church-dome-2034'), 'mosque', false, 'slug church'],
  [clip('Short clip', { duration: 3 }), 'nature', false, 'too short'],
  [clip('Low res', { width: 960, height: 540 }), 'nature', false, 'short side < 720'],
  [clip('Vertical 720p waterfall', { width: 720, height: 1280 }), 'nature', true, 'short side = 720'],
  [clip('Unknown size', { width: null, height: null, duration: null }), 'nature', true, 'unknown passes'],
];

let failed = 0;
for (const [c, category, expected, note] of cases) {
  const result = checkClip(c, category);
  const label = c.title || c.sourceUrl;
  if (result.ok === expected) {
    console.log(`  ok   ${expected ? 'allow' : 'block'} [${category}] ${label}${result.reason ? ` (${result.reason})` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL expected ${expected ? 'allow' : 'block'} [${category}] ${label} → ${JSON.stringify(result)} ${note}`);
  }
}

// NASA first-pass screen: only Earth-view reels, no talk formats.
const nasa = [
  [{ title: 'Earth Views from the International Space Station', keywords: ['HDEV'] }, true],
  [{ title: 'Earth from Space in 4K – Expedition 65 Edition', keywords: ['earthviews'] }, true],
  [{ title: 'Safe Return to Earth from the Space Station on This Week @NASA', keywords: [] }, false],
  [{ title: 'Down to Earth - Enjoy the View', keywords: ['Earth views'], description: 'astronaut shares how' }, false],
  [{ title: 'Dust and Drama in the Orion Nebula', keywords: ['nebula'] }, false],
  [{ title: 'Orion Camera Views of Artemis II Apogee Raise Burn', keywords: ['Earth views'] }, false],
];
for (const [data, expected] of nasa) {
  const result = screenItem(data);
  if (result.ok === expected) console.log(`  ok   nasa ${expected ? 'allow' : 'block'} ${data.title}`);
  else {
    failed++;
    console.log(`  FAIL nasa expected ${expected ? 'allow' : 'block'} ${data.title} → ${JSON.stringify(result)}`);
  }
}

assert.equal(failed, 0, `${failed} filter case(s) failed`);
console.log(`\nAll ${cases.length + nasa.length} filter cases passed.`);
