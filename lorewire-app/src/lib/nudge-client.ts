// Cross-device sign-in nudge: snooze + first-save detection helpers.
//
// The nudge fires the first time a still-anonymous browser saves a
// story. "Maybe later" snoozes it for SNOOZE_DAYS days; after that,
// the next save fires it again. Signing in dismisses it forever
// (the trigger checks session presence before firing).
//
// Plan: _plans/2026-06-19-anonymous-first-auth.md §Locked decision §3.

const SNOOZE_KEY = "lw.prompt_snooze.v1";
const SNOOZED_BEFORE_KEY = "lw.prompt_snoozed_before.v1";
export const SNOOZE_DAYS = 7;

const SNOOZE_MS = SNOOZE_DAYS * 24 * 60 * 60 * 1000;

/** True when "Maybe later" has been clicked recently enough that the
 *  nudge should stay quiet. Reads localStorage; returns false on the
 *  server, in private mode, or when the stored value is malformed. */
export function isNudgeSnoozed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(SNOOZE_KEY);
    if (!raw) return false;
    const until = Number(raw);
    if (!Number.isFinite(until)) return false;
    return Date.now() < until;
  } catch {
    return false;
  }
}

/** True when the user has snoozed the nudge at least once in this
 *  browser's lifetime. The first-save trigger uses this to drop the
 *  "first save fires the nudge" rule for return visits — we don't
 *  want a snoozer to hit the nudge again on their first save after
 *  the snooze expires; the persistent "Save across devices" header
 *  link is the surface for them instead. */
export function hasEverSnoozed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SNOOZED_BEFORE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist a snooze: SNOOZE_DAYS into the future. Also stamps the
 *  "has ever snoozed" flag so future return visits prefer the header
 *  link over the modal trigger. */
export function snoozeNudge(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SNOOZE_KEY,
      String(Date.now() + SNOOZE_MS),
    );
    window.localStorage.setItem(SNOOZED_BEFORE_KEY, "1");
  } catch {
    // Best-effort; in-memory dismissal still works for this session.
  }
  console.info("[auth ui nudge snoozed]", { days: SNOOZE_DAYS });
}

/** Clear the snooze. Used when the user explicitly opens the sign-in
 *  flow (clicking "Save across devices" link) so we don't fight them. */
export function clearSnooze(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(SNOOZE_KEY);
  } catch {
    /* ignore */
  }
}
