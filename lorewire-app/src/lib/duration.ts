// Format a millisecond duration as "M:SS" for the public rail thumbnail
// badge. Used on both the reader path (lib/homepage-data backfill from
// short_renders) and the writer path (lib/short-render-queue.applyShortToStory
// persisting onto stories.duration when a short is auto-applied as the story
// video). Returns null for missing / non-positive / non-finite input so the
// caller can skip the write or fall through to whatever stale value the
// stories row already carries.

export function formatDurationMs(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const seconds = n / 1000;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  // Handle the round-up edge case (e.g. 59.6s -> "0:60") so the badge
  // never ships a malformed M:SS.
  if (s === 60) return `${m + 1}:00`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Parse a JSON-encoded short_renders.props blob and pull duration_ms out
// formatted as "M:SS". The props column is TEXT on both the SQLite and
// Postgres drivers, and may be NULL on a queued / errored row, so a
// missing/unparseable blob returns null silently.
export function shortDurationFromPropsJson(
  props: string | null | undefined,
): string | null {
  if (!props) return null;
  try {
    const parsed = JSON.parse(props) as { duration_ms?: unknown };
    return formatDurationMs(Number(parsed.duration_ms));
  } catch {
    return null;
  }
}
