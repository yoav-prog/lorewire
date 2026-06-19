// localStorage wrapper for the global admin search bar's "Recent" panel
// (plan: _plans/2026-06-19-global-admin-search.md).
//
// We persist PICKS (things the user actually clicked on), not queries.
// Why: a query that returned nothing is a dead end the user wouldn't
// want to re-run; a pick is a destination they've been to before.
//
// Schema kept minimal so a future feature (e.g. cross-device sync via
// settings) can re-encode without a migration:
//   { kind: "reddit" | "story", id: string, label: string, ts: number }
//
// Security (rule 13): no body/summary persisted — only the visible label
// the user already saw in the dropdown. Nothing leaves the browser.
//
// SSR-safe: every access is guarded by `typeof window`. The bar mounts
// inside a client component so the guards are belt-and-suspenders.

export type RecentKind = "reddit" | "story";

export interface RecentPick {
  kind: RecentKind;
  id: string;
  label: string;
  ts: number;
}

const STORAGE_KEY = "lorewire.admin.search.recent";
const MAX_DEFAULT = 6;

/** Read picks newest-first. Returns [] on SSR or if storage is empty /
 * unreadable / parses to the wrong shape. Caller can pass `max` to slice
 * (default 6 matches the recommended display cap). */
export function readRecent(max = MAX_DEFAULT): RecentPick[] {
  if (typeof window === "undefined") return [];
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage access can throw in incognito + strict-privacy contexts.
    // Returning [] keeps the bar usable; we just don't get recents.
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const cleaned: RecentPick[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Partial<RecentPick>;
    if (e.kind !== "reddit" && e.kind !== "story") continue;
    if (typeof e.id !== "string" || !e.id) continue;
    if (typeof e.label !== "string") continue;
    if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) continue;
    cleaned.push({ kind: e.kind, id: e.id, label: e.label, ts: e.ts });
  }
  return cleaned
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(0, Math.trunc(max)));
}

/** Add a pick (or refresh its timestamp if already present), dropping
 * the oldest entries so the list stays at `max` items. Same (kind, id)
 * pair is treated as one entry — a re-pick floats it to the top. */
export function addRecent(
  pick: Omit<RecentPick, "ts">,
  max = MAX_DEFAULT,
): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  const existing = readRecent(Number.POSITIVE_INFINITY).filter(
    (p) => !(p.kind === pick.kind && p.id === pick.id),
  );
  const next: RecentPick[] = [{ ...pick, ts: now }, ...existing].slice(
    0,
    Math.max(0, Math.trunc(max)),
  );
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Same incognito / quota failure mode as read. Best-effort: the bar
    // will keep working, just without "Recent" memory.
  }
}

/** Remove a single pick. The "x" affordance on each recent row calls
 * this. Idempotent: removing something not present is a no-op. */
export function removeRecent(kind: RecentKind, id: string): void {
  if (typeof window === "undefined") return;
  const next = readRecent(Number.POSITIVE_INFINITY).filter(
    (p) => !(p.kind === kind && p.id === id),
  );
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

/** Wipe all picks. Used by the "Clear all" affordance below the Recent
 * list when it has 1+ entries. */
export function clearRecent(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
