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

// Pull the bare body duration_ms (ms, number | null) out of a
// short_renders.props JSON blob. Same defensiveness as
// shortDurationFromPropsJson but returns the raw ms so callers can sum it
// with intro/outro segment durations before formatting.
export function bodyDurationMsFromPropsJson(
  props: string | null | undefined,
): number | null {
  if (!props) return null;
  try {
    const parsed = JSON.parse(props) as { duration_ms?: unknown };
    const n = Number(parsed.duration_ms);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

// Shape of the stamp render_short/route.ts writes onto
// stories.short_config after a successful render. Records the intro/outro
// segment ids actually spliced into the assembled MP4 so the read side can
// re-derive the full duration without re-resolving the segment chain.
export interface LastRenderedSegments {
  intro_segment_id: string | null;
  outro_segment_id: string | null;
}

// Pull `_last_rendered_segments` out of a stories.short_config JSON blob.
// Returns null when the column is missing/empty, the JSON is malformed, or
// the stamp is absent — caller falls back to body-only in those cases.
export function parseLastRenderedSegments(
  shortConfig: string | null | undefined,
): LastRenderedSegments | null {
  if (!shortConfig) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(shortConfig);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const stamp = (parsed as Record<string, unknown>)._last_rendered_segments;
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) return null;
  const introRaw = (stamp as Record<string, unknown>).intro_segment_id;
  const outroRaw = (stamp as Record<string, unknown>).outro_segment_id;
  const intro_segment_id = typeof introRaw === "string" && introRaw ? introRaw : null;
  const outro_segment_id = typeof outroRaw === "string" && outroRaw ? outroRaw : null;
  if (!intro_segment_id && !outro_segment_id) return null;
  return { intro_segment_id, outro_segment_id };
}

// Sum body + intro + outro durations defensively. Any non-finite or
// negative input contributes 0 so a single bad row can't poison the sum
// (which would then format as "0:00" and surface as a worse badge than
// what we ship today).
export function fullDurationMsFromParts(
  bodyMs: number | null | undefined,
  introMs: number | null | undefined,
  outroMs: number | null | undefined,
): number {
  const safe = (n: number | null | undefined): number => {
    if (n === null || n === undefined) return 0;
    const x = Number(n);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  return safe(bodyMs) + safe(introMs) + safe(outroMs);
}
