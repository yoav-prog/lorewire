// Picker for the homepage "PLAY SOMETHING" button. Returns the id of a
// story that has a playable videoUrl, applied as a three-layer fallback
// so the button degrades gracefully when the catalog is thin:
//
//   1. Exclude the current hero + recently-shuffled ids. Best variety.
//   2. If layer 1 emptied the pool, drop the recents constraint and
//      only exclude the hero.
//   3. If layer 2 is still empty (the hero is the only playable story),
//      pick the hero — better to repeat than do nothing.
//
// Returns null only when no catalog entry has a videoUrl at all; the
// shell logs and the click no-ops in that case (today's "thin inventory"
// state — see /Top 10 / category-rail thresholds discussion).

export interface PlayableStory {
  id: string;
  videoUrl?: string;
}

export interface PickRandomPlayableArgs {
  catalog: ReadonlyArray<PlayableStory>;
  currentHeroId?: string | null;
  recentIds?: ReadonlyArray<string>;
  rng?: () => number;
}

export function pickRandomPlayable(args: PickRandomPlayableArgs): string | null {
  const { catalog, currentHeroId, recentIds = [], rng = Math.random } = args;
  const playable = catalog.filter((s) => !!s.videoUrl);
  if (playable.length === 0) return null;
  const recentSet = new Set(recentIds);
  const layer1 = playable.filter(
    (s) => s.id !== currentHeroId && !recentSet.has(s.id),
  );
  if (layer1.length > 0) return pickOne(layer1, rng).id;
  const layer2 = playable.filter((s) => s.id !== currentHeroId);
  if (layer2.length > 0) return pickOne(layer2, rng).id;
  return pickOne(playable, rng).id;
}

function pickOne<T>(arr: ReadonlyArray<T>, rng: () => number): T {
  const idx = Math.floor(rng() * arr.length);
  return arr[Math.min(idx, arr.length - 1)];
}

// sessionStorage-backed "recents" memory so consecutive clicks don't loop
// on the same two picks when inventory is thin. Lives in session (not
// localStorage) so opening a new tab feels fresh; capped at 3 entries so
// the pool stays usable when the catalog has 4–5 playable stories.
const SHUFFLE_RECENTS_KEY = "lw_shuffle_recents";
const SHUFFLE_RECENTS_MAX = 3;

export function readShuffleRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(SHUFFLE_RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string")
      .slice(0, SHUFFLE_RECENTS_MAX);
  } catch {
    return [];
  }
}

export function pushShuffleRecent(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const current = readShuffleRecents().filter((x) => x !== id);
    const next = [id, ...current].slice(0, SHUFFLE_RECENTS_MAX);
    window.sessionStorage.setItem(SHUFFLE_RECENTS_KEY, JSON.stringify(next));
  } catch {
    // sessionStorage can throw on quota or when disabled (private mode in
    // some browsers); the picker still works without persistence, just
    // without no-repeat memory across clicks.
  }
}
