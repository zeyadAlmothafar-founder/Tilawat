// pickClips(): choose and download background clips for one video.
import { CATEGORY_IDS, isCategory } from './categories.js';
import { listApproved, reviewedIds } from './library.js';
import { liveCandidates } from './search.js';
import { fetchClip } from './clips.js';
import { shuffle } from './util.js';

const SECONDS_PER_CLIP = 7;
const MAX_CLIPS = 20;
const CONCURRENCY = 3;

function roundRobin(lists) {
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

/** Download/probe clips from `list` in order (≤ 3 at a time) until `need` succeed. */
async function fetchSome(list, need) {
  const got = [];
  let next = 0;
  let active = 0;
  const worker = async () => {
    while (got.length + active < need && next < list.length) {
      const index = next++;
      active++;
      try {
        got.push({ index, clip: await fetchClip(list[index]) });
      } catch (err) {
        console.warn(`[sources] skipped ${list[index].id}: ${err.message}`);
      } finally {
        active--;
      }
    }
  };
  // Re-run while failures leave room and candidates remain.
  while (got.length < need && next < list.length) {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }
  return got.sort((a, b) => a.index - b.index).map((g) => g.clip);
}

/** Shuffled, with clips matching the output orientation first (square output takes any). */
function byOrientation(list, orientation) {
  if (orientation === 'square') return shuffle(list);
  const fits = (c) => (c.orientation || (c.height > c.width ? 'portrait' : 'landscape')) === orientation;
  return [...shuffle(list.filter(fits)), ...shuffle(list.filter((c) => !fits(c)))];
}

export function targetCount(totalDuration) {
  const n = Math.ceil((Number(totalDuration) || 0) / SECONDS_PER_CLIP);
  return Math.min(MAX_CLIPS, Math.max(1, n));
}

/**
 * Approved library clips first (shuffled, round-robin across categories), then — unless
 * approvedOnly — filtered live candidates. Never throws; resolves to [] if nothing works.
 */
export async function pickClips({ categories, totalDuration, orientation = 'landscape', approvedOnly = false } = {}) {
  const started = Date.now();
  const cats = [...new Set((Array.isArray(categories) ? categories : [categories]).filter(isCategory))];
  if (!cats.length) cats.push(...CATEGORY_IDS);
  const need = targetCount(totalDuration);
  const chosen = [];
  let fromLibrary = 0;
  try {
    const approved = roundRobin(cats.map((c) => byOrientation(listApproved(c), orientation)));
    chosen.push(...(await fetchSome(approved, need)));
    fromLibrary = chosen.length;
    if (chosen.length < need && !approvedOnly) {
      const exclude = reviewedIds();
      const perCategory = await Promise.all(cats.map((category) => liveCandidates({ category, orientation, exclude })
        .catch((err) => {
          console.warn(`[sources] live candidates for ${category} failed: ${err.message}`);
          return [];
        })));
      chosen.push(...(await fetchSome(roundRobin(perCategory), need - chosen.length)));
    }
  } catch (err) {
    console.warn(`[sources] pickClips error: ${err.message}`);
  }
  console.log(`[sources] pickClips(${cats.join(',')}, ${Math.round(Number(totalDuration) || 0)}s, ${orientation}${approvedOnly ? ', approved only' : ''}): `
    + `${chosen.length}/${need} clips (${fromLibrary} approved, ${chosen.length - fromLibrary} live) in ${Date.now() - started}ms`
    + (chosen.length ? `: ${chosen.map((c) => c.id).join(' | ')}` : ''));
  return chosen;
}
