// Candidate search across providers. Every clip returned to a client is remembered so
// that /library/approve can use the server's own copy instead of trusting the client.
import { CATEGORIES, queryForPage } from './categories.js';
import { checkClip } from './filter.js';
import { safeStem, shuffle } from './util.js';
import * as pexels from './providers/pexels.js';
import * as pixabay from './providers/pixabay.js';
import * as nasa from './providers/nasa.js';

const STOCK_PER_PAGE = 15;
const NASA_PER_PAGE = 8;
const MAX_PAGE = 50;
const REMEMBER_MAX = 5000;

const known = new Map();
const byStem = new Map();

function remember(clips) {
  for (const clip of clips) {
    known.delete(clip.id);
    known.set(clip.id, clip);
    byStem.set(safeStem(clip.provider, clip.providerId), clip);
  }
  while (known.size > REMEMBER_MAX) {
    const [id, clip] = known.entries().next().value;
    known.delete(id);
    byStem.delete(safeStem(clip.provider, clip.providerId));
  }
}

/** A clip this server returned as a candidate (trusted), or undefined. */
export const knownClip = (id) => known.get(id);
export const knownClipByStem = (stem) => byStem.get(stem);

export const stockEnabled = () => pexels.enabled() || pixabay.enabled();

const ORIENTATION_RANK = {
  portrait: { portrait: 0, square: 1, landscape: 2 },
  landscape: { landscape: 0, square: 1, portrait: 2 },
  square: { square: 0, portrait: 1, landscape: 1 },
};

/** Stable sort: clips matching the output orientation first (others are center-cropped). */
export function preferOrientation(clips, orientation) {
  const rank = ORIENTATION_RANK[orientation];
  if (!rank) return clips;
  return clips.map((c, i) => [c, i]).sort((a, b) => (rank[a[0].orientation] ?? 1) - (rank[b[0].orientation] ?? 1) || a[1] - b[1]).map(([c]) => c);
}

function interleave(lists) {
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

/** Run provider searches in parallel; provider failures become warnings, never errors. */
async function runSearches(tasks) {
  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  const lists = [];
  const warnings = [];
  const more = {};
  settled.forEach((r, i) => {
    const { name } = tasks[i];
    if (r.status === 'fulfilled') {
      lists.push(r.value.clips);
      more[name] = r.value.hasMore;
    } else {
      warnings.push(`${name}: ${r.reason?.message || r.reason}`);
      console.warn(`[sources] ${name} search failed: ${r.reason?.message || r.reason}`);
    }
  });
  return { lists, warnings, more };
}

function stockTasks(category, page, orientation) {
  const { query, index, providerPage } = queryForPage(category, page);
  const tasks = [];
  if (pexels.enabled()) {
    tasks.push({ name: 'pexels', run: () => pexels.search({ category, query, providerPage, orientation, perPage: STOCK_PER_PAGE }) });
  }
  if (pixabay.enabled()) {
    tasks.push({ name: 'pixabay', run: () => pixabay.search({ category, query, index, providerPage, perPage: STOCK_PER_PAGE }) });
  }
  return tasks;
}

function usable(clips, category, exclude) {
  const seen = new Set();
  return clips.filter((c) => {
    if (seen.has(c.id) || exclude.has(c.id)) return false;
    seen.add(c.id);
    return checkClip(c, category).ok;
  });
}

/** One page of filtered candidates for the library review UI. */
export async function searchCandidates({ category, page = 1, orientation, exclude = new Set() }) {
  const tasks = stockTasks(category, page, orientation);
  if (category === 'space') tasks.push({ name: 'nasa', run: () => nasa.search({ category, page, perPage: NASA_PER_PAGE, exclude }) });
  const { lists, warnings, more } = await runSearches(tasks);
  const clips = preferOrientation(usable(interleave(lists), category, exclude), orientation);
  remember(clips);
  // Stock pages rotate through the category's queries, so a next page exists while the
  // rotation continues; NASA pages through its own fixed pool.
  const stockMore = stockEnabled() && (page < CATEGORIES[category].queries.length || more.pexels || more.pixabay);
  const hasMore = page < MAX_PAGE && Boolean(stockMore || more.nasa);
  return { clips, page, hasMore, ...(warnings.length ? { warnings } : {}) };
}

/** Live (unreviewed) clips for automatic picking: a couple of random query pages + NASA. */
export async function liveCandidates({ category, orientation, exclude = new Set(), pages = 2 }) {
  const queryCount = CATEGORIES[category].queries.length;
  const chosen = shuffle(Array.from({ length: queryCount }, (_, i) => i + 1)).slice(0, pages);
  const tasks = chosen.flatMap((page) => stockTasks(category, page, orientation));
  if (category === 'space') tasks.push({ name: 'nasa', run: async () => ({ clips: await nasa.loadPool(), hasMore: false }) });
  const { lists } = await runSearches(tasks);
  const clips = usable(shuffle(lists.flat()), category, exclude);
  remember(clips);
  return preferOrientation(clips, orientation);
}
