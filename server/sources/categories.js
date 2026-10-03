// Background footage categories and the curated search queries used for each.
// Candidate search rotates through the queries page by page so results stay varied.

export const CATEGORY_IDS = ['nature', 'space', 'mosque', 'islamic'];

export const CATEGORIES = {
  nature: {
    queries: [
      'ocean waves', 'waterfall', 'forest aerial', 'mountains clouds', 'clouds timelapse',
      'sunset sky', 'rain on leaves', 'desert dunes', 'river stream', 'flowers field',
      'misty lake', 'snowy mountains',
    ],
    pixabay: ['nature'],
  },
  space: {
    queries: [
      'galaxy', 'milky way timelapse', 'starry night sky', 'nebula', 'earth from space',
      'moon', 'stars timelapse', 'aurora borealis', 'planet earth rotating', 'night sky stars',
    ],
    pixabay: ['science', 'backgrounds'],
  },
  mosque: {
    queries: [
      'mosque', 'mosque dome', 'minaret', 'masjid interior', 'sheikh zayed mosque',
      'blue mosque istanbul', 'mosque at night', 'mosque sunset', 'mosque aerial', 'mosque architecture',
    ],
    pixabay: ['religion', 'places'],
  },
  islamic: {
    queries: [
      'kaaba', 'mecca', 'medina mosque', 'quran', 'ramadan lantern', 'crescent moon',
      'prayer beads', 'arabic calligraphy', 'islamic pattern', 'prayer mat', 'desert dunes sunset',
    ],
    pixabay: ['religion'],
  },
};

export function isCategory(id) {
  return CATEGORY_IDS.includes(id);
}

/** Query (and 1-based provider page) for a 1-based candidate page: rotate queries first. */
export function queryForPage(category, page) {
  const { queries } = CATEGORIES[category];
  const index = (page - 1) % queries.length;
  return { query: queries[index], index, providerPage: Math.floor((page - 1) / queries.length) + 1 };
}

export function listCategories() {
  return CATEGORY_IDS.map((id) => ({ id, queries: [...CATEGORIES[id].queries] }));
}
