// Content filter for background footage. Blocks people, inappropriate content and
// other-religion imagery by matching whole words in a clip's title, tags and source URL
// slug (plus a short list of unambiguous words in its description, if any). Category-aware:
// crowds and pilgrims are fine for Kaaba / Hajj footage.

export const MIN_DURATION = 5;
export const MIN_SHORT_SIDE = 720;

const PEOPLE = [
  'people', 'person', 'persons', 'human', 'humans', 'man', 'men', 'woman', 'women', 'lady', 'ladies',
  'guy', 'guys', 'girl', 'boy', 'child', 'children', 'kid', 'baby', 'babies', 'toddler', 'teen',
  'teenager', 'couple', 'family', 'families', 'friends', 'male', 'female', 'crowd', 'model',
  'portrait', 'selfie', 'face', 'dance', 'dancer', 'dancing', 'tourist', 'traveler', 'traveller',
  'hiker', 'surfer', 'surfing', 'swimmer', 'skier', 'photographer', 'athlete', 'worker',
  'businessman', 'businesswoman', 'student', 'bride', 'groom', 'astronaut', 'cosmonaut', 'crew', 'praying', 'worshipper', 'pilgrim', 'hijab', 'niqab',
];

const INAPPROPRIATE = [
  'party', 'parties', 'club', 'nightclub', 'concert', 'music', 'musician', 'singer', 'singing',
  'guitar', 'piano', 'dj', 'festival', 'bikini', 'swimsuit', 'swimwear', 'lingerie', 'underwear',
  'sexy', 'sensual', 'nude', 'naked', 'erotic', 'wine', 'beer', 'alcohol', 'alcoholic', 'cocktail',
  'champagne', 'whiskey', 'whisky', 'vodka', 'liquor', 'bar', 'pub', 'drunk', 'smoking', 'smoker',
  'cigarette', 'cigar', 'vape', 'hookah', 'shisha', 'kiss', 'kissing', 'romance', 'romantic',
  'wedding', 'casino', 'gambling', 'poker', 'tattoo', 'halloween', 'pig', 'pork', 'dog', 'puppy',
  'ufo', 'alien', 'zombie', 'horror', 'skull', 'ghost', 'demon', 'devil', 'witch', 'blood', 'gun',
  'weapon', 'soldier', 'military', 'army', 'war', 'spaceship', 'starship', 'star trek', 'star wars',
  'starwars', 'death star', 'science fiction', 'sci fi', 'meditation', 'mindfulness', 'yoga', 'chakra',
  'eiffel', 'castle', 'logo', 'intro', 'typography', 'inscription',
];

const OTHER_RELIGION = [
  'church', 'cathedral', 'chapel', 'christmas', 'xmas', 'cross', 'crucifix', 'jesus', 'christ',
  'christian', 'bible', 'rosary', 'nun', 'priest', 'pope', 'monk', 'monastery', 'angel', 'saint',
  'temple', 'buddha', 'buddhist', 'buddhism', 'hindu', 'hinduism', 'ganesh', 'ganesha', 'shiva',
  'krishna', 'diwali', 'synagogue', 'menorah', 'hanukkah', 'pagoda', 'torii', 'shinto', 'statue',
  'idol', 'sculpture', 'easter', 'santa', 'zodiac', 'astrology', 'horoscope', 'tarot', 'pentagram',
  'mary', 'virgin mary', 'mother mary', 'madonna', 'holy spirit', 'shrine',
];

// Free-text descriptions (NASA) mention music credits, "cross sections", "third party"
// etc., so only unambiguous content words are matched there.
const DESCRIPTION_BLOCK = [
  'nightclub', 'concert', 'bikini', 'swimsuit', 'lingerie', 'nude', 'naked', 'erotic', 'sexy', 'wine', 'beer',
  'alcohol', 'cocktail', 'champagne', 'whiskey', 'vodka', 'liquor', 'drunk', 'smoking', 'cigarette', 'cigar',
  'kissing', 'romance', 'wedding', 'casino', 'gambling', 'halloween', 'pork', 'zombie', 'horror', 'church',
  'cathedral', 'chapel', 'christmas', 'crucifix', 'jesus', 'bible', 'buddha', 'buddhist', 'hindu', 'synagogue',
  'pagoda', 'easter', 'santa claus', 'zodiac', 'astrology', 'horoscope', 'tarot',
];

// Phrases removed before matching because they negate or don't mean the blocked word.
const NEUTRAL_PHRASES = [
  'no music', 'without music', 'music free', 'no people', 'without people', 'temple mount', 'angel falls',
];

// Context in which crowds / pilgrims are expected (Masjid al-Haram, Hajj, Umrah).
const PILGRIMAGE = ['kaaba', 'kabah', 'mecca', 'makkah', 'hajj', 'umrah', 'tawaf', 'masjid al haram', 'al haram'];

const CATEGORY_ALLOW = {
  islamic: { always: ['crowd', 'pilgrim'], inPilgrimage: ['people', 'person', 'worshipper', 'praying'] },
  mosque: { always: [], inPilgrimage: ['crowd', 'pilgrim', 'people', 'worshipper', 'praying'] },
};

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeText(text) {
  return ` ${String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@&]+/g, ' ')
    .trim()} `;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a whole-word matcher for a term list (multi-word terms allowed). Plural
 * "s"/"es" endings match too. Returns (text) => first matched term or null.
 */
export function makeMatcher(terms) {
  const list = [...new Set(terms.map((t) => normalizeText(t).trim()).filter(Boolean))];
  if (!list.length) return () => null;
  const re = new RegExp(`(?<![a-z0-9])(${list.map(escape).join('|')})(?:e?s)?(?![a-z0-9])`);
  return (text) => {
    const m = re.exec(text);
    return m ? m[1] : null;
  };
}

const neutralRe = new RegExp(NEUTRAL_PHRASES.map((p) => escape(normalizeText(p).trim())).join('|'), 'g');
const matchPilgrimage = makeMatcher(PILGRIMAGE);
const matchDescription = makeMatcher(DESCRIPTION_BLOCK);
const matcherCache = new Map();

function matcherFor(category, pilgrimage) {
  const key = `${category}:${pilgrimage}`;
  if (!matcherCache.has(key)) {
    const allow = CATEGORY_ALLOW[category] || { always: [], inPilgrimage: [] };
    const allowed = new Set([...allow.always, ...(pilgrimage ? allow.inPilgrimage : [])]);
    const people = PEOPLE.filter((t) => !allowed.has(t));
    matcherCache.set(key, makeMatcher([...people, ...INAPPROPRIATE, ...OTHER_RELIGION]));
  }
  return matcherCache.get(key);
}

/** Words of a source URL path, e.g. pexels.com/video/aerial-view-of-waves-123/ → "aerial view of waves 123". */
export function urlSlug(url) {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[/_-]+/g, ' ');
  } catch {
    return '';
  }
}

function clean(text) {
  return normalizeText(text).replace(neutralRe, ' ');
}

/**
 * Check a clip ({ title, tags, description?, sourceUrl, duration, width, height }) for a
 * category. Returns { ok: true } or { ok: false, reason }. Unknown duration/size pass.
 */
export function checkClip(clip, category = clip.category) {
  const main = clean([clip.title, ...(clip.tags || []), urlSlug(clip.sourceUrl)].join(' | '));
  const description = clean(clip.description);
  const pilgrimage = Boolean(matchPilgrimage(main) || matchPilgrimage(description));
  const word = matcherFor(category, pilgrimage)(main) || matchDescription(description);
  if (word) return { ok: false, reason: `blocked word "${word}"` };
  const duration = Number(clip.duration);
  if (duration && duration < MIN_DURATION) return { ok: false, reason: `too short (${duration}s)` };
  const { width, height } = clip;
  if (width && height && Math.min(width, height) < MIN_SHORT_SIDE) {
    return { ok: false, reason: `low resolution (${width}x${height})` };
  }
  return { ok: true };
}

