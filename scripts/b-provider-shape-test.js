// Offline test of provider response parsing against hand-written samples that follow the
// documented response shapes: node scripts/b-provider-shape-test.js
import assert from 'node:assert/strict';
import * as pexels from '../server/sources/providers/pexels.js';
import * as pixabay from '../server/sources/providers/pixabay.js';
import * as nasa from '../server/sources/providers/nasa.js';
import { checkClip } from '../server/sources/filter.js';
import { queryForPage } from '../server/sources/categories.js';
import { isAllowedUrl, DOWNLOAD_HOSTS, safeStem, titleFromSlug } from '../server/sources/util.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok   ${name}`);
}

// --- Pexels: GET /v1/videos/search ---------------------------------------------------
const vimeo = (id, profile) => `https://player.vimeo.com/external/${id}.hd.mp4?s=abc&profile_id=${profile}`;
const pexelsSample = {
  page: 1,
  per_page: 2,
  total_results: 20475,
  url: 'https://www.pexels.com/search/videos/ocean%20waves/',
  next_page: 'https://api.pexels.com/v1/videos/search/?page=2&per_page=2&query=ocean+waves',
  videos: [
    {
      id: 1448735,
      width: 4096,
      height: 2160,
      duration: 32,
      full_res: null,
      tags: [],
      url: 'https://www.pexels.com/video/aerial-view-of-ocean-waves-1448735/',
      image: 'https://images.pexels.com/videos/1448735/free-video-1448735.jpg?fit=crop&w=1200&h=630&auto=compress&cs=tinysrgb',
      avg_color: null,
      user: { id: 574687, name: 'Ruvim Miksanskiy', url: 'https://www.pexels.com/@digitech' },
      video_files: [
        { id: 1, quality: 'sd', file_type: 'video/mp4', width: 640, height: 338, fps: 25, link: vimeo(291648067, 164) },
        { id: 2, quality: 'hd', file_type: 'video/mp4', width: 4096, height: 2160, fps: 25, link: vimeo(291648067, 172) },
        { id: 3, quality: 'hd', file_type: 'video/mp4', width: 2048, height: 1080, fps: 25, link: vimeo(291648067, 175) },
        { id: 4, quality: 'hd', file_type: 'video/mp4', width: 1366, height: 720, fps: 25, link: vimeo(291648067, 174) },
        { id: 5, quality: 'sd', file_type: 'video/mp4', width: 960, height: 506, fps: 25, link: vimeo(291648067, 165) },
        { id: 6, quality: null, file_type: 'video/mp4', width: null, height: null, fps: null, link: 'https://player.vimeo.com/external/291648067.m3u8' },
      ],
      video_pictures: [{ id: 133236, picture: 'https://static-videos.pexels.com/videos/1448735/pictures/preview-0.jpg', nr: 0 }],
    },
    {
      id: 857195,
      width: 1080,
      height: 1920,
      duration: 14,
      tags: ['beach'],
      url: 'https://www.pexels.com/video/woman-walking-on-the-beach-857195/',
      image: 'https://images.pexels.com/videos/857195/free-video-857195.jpg',
      user: { id: 1, name: 'Someone', url: 'https://www.pexels.com/@someone' },
      video_files: [
        { id: 7, quality: 'hd', file_type: 'video/mp4', width: 1080, height: 1920, fps: 30, link: 'https://videos.pexels.com/video-files/857195/857195-hd_1080_1920_30fps.mp4' },
        { id: 8, quality: 'sd', file_type: 'video/mp4', width: 360, height: 640, fps: 30, link: 'https://videos.pexels.com/video-files/857195/857195-sd_360_640_30fps.mp4' },
      ],
      video_pictures: [],
    },
    {
      id: 999,
      width: 1920,
      height: 1080,
      duration: 10,
      url: 'https://www.pexels.com/video/evil-host-999/',
      image: 'https://images.pexels.com/videos/999/x.jpg',
      user: { name: 'x', url: 'https://www.pexels.com/@x' },
      video_files: [{ quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, link: 'https://evil.example.com/a.mp4' }],
    },
  ],
};

test('pexels: parse response, skip clips without an allowed mp4', () => {
  const { clips, hasMore } = pexels.parseResponse(pexelsSample, 'nature');
  assert.equal(hasMore, true);
  assert.equal(clips.length, 2);
  const [a, b] = clips;
  assert.equal(a.id, 'pexels:1448735');
  assert.equal(a.providerId, '1448735');
  assert.equal(a.title, 'Aerial view of ocean waves');
  assert.equal(a.author, 'Ruvim Miksanskiy');
  assert.equal(a.authorUrl, 'https://www.pexels.com/@digitech');
  assert.equal(a.sourceUrl, 'https://www.pexels.com/video/aerial-view-of-ocean-waves-1448735/');
  assert.equal(a.downloadUrl, vimeo(291648067, 175), 'smallest file with short side ≥ 1080');
  assert.equal(a.width, 2048);
  assert.equal(a.height, 1080);
  assert.equal(a.previewUrl, vimeo(291648067, 165), 'smallest ≥ 360p preview (640x338 is below 360p)');
  assert.equal(a.orientation, 'landscape');
  assert.equal(a.duration, 32);
  assert.ok(a.thumbUrl.startsWith('https://images.pexels.com/'));
  assert.equal(b.orientation, 'portrait');
  assert.equal(b.downloadUrl, 'https://videos.pexels.com/video-files/857195/857195-hd_1080_1920_30fps.mp4');
  assert.equal(checkClip(a, 'nature').ok, true);
  assert.equal(checkClip(b, 'nature').ok, false, 'woman in slug is filtered');
});

test('pexels: falls back to the largest file when nothing is ≥ 1080', () => {
  const files = [
    { file_type: 'video/mp4', width: 1280, height: 720, link: 'https://videos.pexels.com/video-files/1/a.mp4' },
    { file_type: 'video/mp4', width: 960, height: 540, link: 'https://videos.pexels.com/video-files/1/b.mp4' },
  ];
  assert.equal(pexels.pickDownloadFile(files).width, 1280);
  assert.equal(pexels.pickDownloadFile([]), null);
  assert.equal(pexels.parseResponse({}, 'nature').clips.length, 0);
});

// --- Pixabay: GET /api/videos/ ---------------------------------------------------------
const px = (stem, size, w, h) => ({
  url: `https://cdn.pixabay.com/video/2015/08/08/${stem}_${size}.mp4`,
  width: w,
  height: h,
  size: 1000,
  thumbnail: `https://cdn.pixabay.com/video/2015/08/08/${stem}_${size}.jpg`,
});
const pixabaySample = {
  total: 4692,
  totalHits: 500,
  hits: [
    {
      id: 125,
      pageURL: 'https://pixabay.com/videos/id-125/',
      type: 'film',
      tags: 'waterfall, nature, river',
      duration: 12,
      videos: {
        large: px('125-135736646', 'large', 3840, 2160),
        medium: px('125-135736646', 'medium', 1920, 1080),
        small: px('125-135736646', 'small', 1280, 720),
        tiny: px('125-135736646', 'tiny', 960, 540),
      },
      views: 4462,
      downloads: 1464,
      likes: 18,
      comments: 0,
      user_id: 1281706,
      user: 'Coverr-Free-Footage',
      userImageURL: 'https://cdn.pixabay.com/user/2015/10/16/09-28-45-303_250x250.png',
    },
    {
      id: 200,
      pageURL: 'https://pixabay.com/videos/mosque-dome-minaret-200/',
      tags: 'mosque, dome, minaret',
      duration: 20,
      videos: {
        large: { url: '', width: 0, height: 0, size: 0, thumbnail: '' },
        medium: px('200-1', 'medium', 1280, 720),
        small: px('200-1', 'small', 640, 360),
        tiny: px('200-1', 'tiny', 480, 270),
      },
      user_id: 42,
      user: 'Some User',
    },
    {
      id: 300,
      pageURL: 'https://pixabay.com/videos/id-300/',
      tags: 'church, bells',
      duration: 15,
      videos: { medium: px('300-1', 'medium', 1920, 1080), tiny: px('300-1', 'tiny', 960, 540) },
      user_id: 1,
      user: 'u',
    },
  ],
};

test('pixabay: parse response', () => {
  const { clips, hasMore } = pixabay.parseResponse(pixabaySample, 'nature', { page: 1, perPage: 15 });
  assert.equal(hasMore, true);
  assert.equal(clips.length, 3);
  const [a, b, c] = clips;
  assert.equal(a.id, 'pixabay:125');
  assert.equal(a.title, 'Waterfall, nature, river', 'id-style pageURL → title from tags');
  assert.deepEqual(a.tags, ['waterfall', 'nature', 'river']);
  assert.equal(a.downloadUrl, pixabaySample.hits[0].videos.medium.url, 'medium (1080p) preferred over 4K large');
  assert.equal(a.previewUrl, pixabaySample.hits[0].videos.tiny.url);
  assert.equal(a.thumbUrl, pixabaySample.hits[0].videos.medium.thumbnail);
  assert.equal(a.author, 'Coverr-Free-Footage');
  assert.equal(a.authorUrl, 'https://pixabay.com/users/Coverr-Free-Footage-1281706/');
  assert.equal(a.sourceUrl, 'https://pixabay.com/videos/id-125/');
  assert.equal(a.width, 1920);
  assert.equal(a.duration, 12);
  assert.equal(b.title, 'Mosque dome minaret', 'title from slug');
  assert.equal(b.width, 1280, 'old video: 720p medium, no large');
  assert.equal(b.authorUrl, 'https://pixabay.com/users/Some%20User-42/');
  assert.equal(checkClip(a, 'nature').ok, true);
  assert.equal(checkClip(b, 'mosque').ok, true);
  assert.equal(checkClip(c, 'mosque').ok, false, 'church tag is filtered');
  assert.equal(pixabay.parseResponse({ totalHits: 10, hits: [] }, 'nature', { page: 1, perPage: 15 }).hasMore, false);
});

test('pixabay: 720p medium + 1080p large → large', () => {
  const v = { large: px('9', 'large', 1920, 1080), medium: px('9', 'medium', 1280, 720) };
  assert.equal(pixabay.pickRendition(v).width, 1920);
  assert.equal(pixabay.pickRendition({ medium: { ...px('9', 'medium', 1920, 1080), url: 'https://evil.example/x.mp4' } }), null);
});

test('pixabay: category mapping rotates', () => {
  assert.equal(pixabay.pixabayCategory('nature', 0), 'nature');
  assert.equal(pixabay.pixabayCategory('space', 0), 'science');
  assert.equal(pixabay.pixabayCategory('mosque', 0), 'religion');
  assert.equal(pixabay.pixabayCategory('mosque', 1), 'places');
  assert.equal(pixabay.pixabayCategory('islamic', 3), 'religion');
});

// --- NASA (shapes copied from the live API) ---------------------------------------------
const base = 'http://images-assets.nasa.gov/video/Earth Views from the ISS/Earth Views from the ISS';
const nasaItem = {
  href: 'https://images-assets.nasa.gov/video/Earth Views from the ISS/collection.json',
  data: [{
    nasa_id: 'Earth Views from the ISS',
    title: 'Earth Views from the ISS',
    keywords: ['Earth Views', 'EarthViews'],
    description: 'Earth Views from the ISS',
    center: 'HQ',
    media_type: 'video',
    date_created: '2019-06-26T00:00:00Z',
  }],
  links: [
    { href: 'https://images-assets.nasa.gov/video/Earth Views from the ISS/Earth Views from the ISS~large.jpg', rel: 'alternate', render: 'image', width: 800 },
    { href: 'https://images-assets.nasa.gov/video/Earth Views from the ISS/Earth Views from the ISS~thumb.jpg', rel: 'preview', render: 'image', width: 300 },
  ],
};
const manifest = [
  `${base}~orig.mp4`, `${base}.srt`, `${base}~large.mp4`, `${base}~medium.mp4`, `${base}~mobile.mp4`,
  `${base}~preview.mp4`, `${base}~small.mp4`, 'http://images-assets.nasa.gov/video/Earth Views from the ISS/metadata.json',
  `${base}~thumb_1.jpg`,
];
const meta = { 'QuickTime:Duration': '0:44:00', 'QuickTime:ImageWidth': 1280, 'QuickTime:ImageHeight': 720, 'Composite:ImageSize': '1280x720' };

test('nasa: asset URLs are re-encoded as https and host-checked', () => {
  const assets = nasa.pickAssets(manifest);
  assert.equal(assets.download, 'https://images-assets.nasa.gov/video/Earth%20Views%20from%20the%20ISS/Earth%20Views%20from%20the%20ISS~large.mp4');
  assert.ok(assets.preview.endsWith('~preview.mp4'));
  assert.ok(assets.metadata.endsWith('/metadata.json'));
  assert.ok(isAllowedUrl(assets.download, DOWNLOAD_HOSTS.nasa));
  assert.equal(nasa.assetUrl('http://evil.example.com/video/a~large.mp4'), null);
  assert.equal(nasa.assetUrl('https://images-assets.nasa.gov/video/a%20b/c.mp4'), 'https://images-assets.nasa.gov/video/a%20b/c.mp4');
});

test('nasa: metadata parsing and rendition size', () => {
  assert.equal(nasa.parseDuration('0:03:20'), 200);
  assert.equal(nasa.parseDuration('1:00:00.5'), 3600.5);
  assert.equal(nasa.parseDuration('12.5 s'), 12.5);
  assert.equal(nasa.parseDuration(undefined), null);
  assert.deepEqual(nasa.parseMetadata(meta, 'x~large.mp4'), { duration: 2640, width: 1280, height: 720 });
  assert.deepEqual(nasa.parseMetadata({ 'Composite:ImageSize': '4096x2160', 'QuickTime:Duration': '0:50:00' }, 'x~large.mp4'),
    { duration: 3000, width: 1920, height: 1012 });
  assert.deepEqual(nasa.parseMetadata({ 'Composite:ImageSize': '3840x2160' }, 'x~medium.mp4'), { duration: null, width: 1280, height: 720 });
  assert.deepEqual(nasa.parseMetadata({ 'Composite:ImageSize': '5760x3840' }, 'x~large.mp4'), { duration: null, width: 1620, height: 1080 },
    'a 3:2 source fits the 1920x1080 box (verified live: 1620x1080)');
});

test('nasa: long videos become several 30s segments', () => {
  assert.deepEqual(nasa.segmentStarts(null), [null]);
  assert.deepEqual(nasa.segmentStarts(40), [null]);
  assert.deepEqual(nasa.segmentStarts(200), [60]);
  const starts = nasa.segmentStarts(2640);
  assert.equal(starts.length, 8);
  assert.ok(starts.every((s, i) => s >= 264 && s + 30 <= 2640 * 0.9 + 1 && (i === 0 || s > starts[i - 1])));
  const clips = nasa.buildClips(nasaItem, manifest, meta);
  assert.equal(clips.length, 8);
  const c = clips[0];
  assert.equal(c.id, `nasa:Earth Views from the ISS@${starts[0]}`);
  assert.equal(nasa.segmentStart(c.providerId), starts[0]);
  assert.equal(c.duration, 30);
  assert.equal(c.width, 1280);
  assert.equal(c.author, 'NASA HQ');
  assert.equal(c.sourceUrl, 'https://images.nasa.gov/details/Earth%20Views%20from%20the%20ISS');
  assert.ok(c.previewUrl.endsWith(`~preview.mp4#t=${starts[0]},${starts[0] + 30}`));
  assert.equal(c.thumbUrl, `/api/library/thumb/${safeStem('nasa', c.providerId)}.jpg`);
  assert.match(c.thumbUrl, /^\/api\/library\/thumb\/[A-Za-z0-9_-]+\.jpg$/);
  assert.equal(checkClip(c, 'space').ok, true);
});

// --- helpers -------------------------------------------------------------------------
test('query rotation and helpers', () => {
  assert.deepEqual(queryForPage('nature', 1), { query: 'ocean waves', index: 0, providerPage: 1 });
  const n = queryForPage('nature', 13);
  assert.equal(n.index, 0);
  assert.equal(n.providerPage, 2);
  assert.equal(safeStem('pexels', '123'), 'pexels-123');
  assert.match(safeStem('nasa', 'a b/../c@5'), /^nasa-a_b_c_5-[0-9a-f]{8}$/);
  assert.equal(titleFromSlug('https://pixabay.com/videos/id-125/'), '');
  assert.equal(isAllowedUrl('http://videos.pexels.com/x.mp4', DOWNLOAD_HOSTS.pexels), false, 'https only');
  assert.equal(isAllowedUrl('https://videos.pexels.com.evil.com/x.mp4', DOWNLOAD_HOSTS.pexels), false);
});

console.log(`\nAll ${passed} provider shape tests passed.`);
