// Fire-and-forget nudge to a Vercel cron-style drain endpoint. Each Lane
// A/B/C enqueue calls this so the row gets claimed within a couple of
// seconds instead of waiting for the next cron tick (worst case 60 s).
//
// Why a nudge instead of inline draining: the drain endpoints can take
// 30-300 s (Cloud Run render + multi-step generation), well beyond a
// Server Action's reasonable response budget. Triggering the drain over
// HTTP invokes it as a separate Vercel function, runs in its own budget,
// and our action returns immediately.
//
// In dev or when CRON_SECRET / a base URL aren't configured, the nudge
// silently no-ops — the cron tick (when present) picks up the row.

import "server-only";

const NUDGE_DISPATCH_TIMEOUT_MS = 1500;

function resolveBaseUrl(): string | null {
  // VERCEL_URL is set automatically on all Vercel deployments (preview
  // and production).
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  // Manual overrides for non-Vercel runs (CI, custom deploys).
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL;
  }
  if (process.env.NEXTAUTH_URL) {
    return process.env.NEXTAUTH_URL;
  }
  return null;
}

export type DrainPath = "/api/render_short" | "/api/drain_short_renders";

export async function nudgeDrain(path: DrainPath): Promise<void> {
  const baseUrl = resolveBaseUrl();
  const cronSecret = process.env.CRON_SECRET;
  if (!baseUrl || !cronSecret) {
    // No-op silently. The cron tick (every minute) will still pick the
    // row up; this nudge just shortens the wait when both pieces are
    // configured.
    return;
  }
  // AbortController dispatches the request quickly and bails after the
  // timeout. The remote function runs in its OWN Vercel function
  // invocation; the abort here just stops us waiting on its response.
  const ctrl = new AbortController();
  const timeout = setTimeout(
    () => ctrl.abort(),
    NUDGE_DISPATCH_TIMEOUT_MS,
  );
  try {
    await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: ctrl.signal,
    });
  } catch {
    // Includes the AbortError we trigger above + any network blip. The
    // drain still runs on its cron tick within the next minute either
    // way; this is best-effort.
  } finally {
    clearTimeout(timeout);
  }
}
