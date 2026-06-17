// Pure publish-domain helpers shared by the social publish routes.
//
// Kept dependency-free and side-effect-free so they unit-test in isolation and
// can run unchanged on either the Vercel route handler (Phase 1) or a queue
// worker (Phase 4). Plan: _plans/2026-06-16-multi-platform-shorts-publisher.md.

export type SocialPlatform = "youtube" | "tiktok" | "instagram" | "facebook";

// Provenance of the short's audio track. Only the first four are publishable;
// anything else is treated as unknown provenance and blocked (section 3.F9). A
// rendered Lorewire short is normally `tts` (the synthesized voiceover) or
// `silence`.
export type AudioSource =
  | "silence"
  | "tts"
  | "platform_library"
  | "rights_attested"
  | "consumer_library"
  | "unknown";

export type AudioClearanceVerdict =
  | "silence"
  | "tts"
  | "platform_library"
  | "rights_attested"
  | "blocked";

export interface AudioClearance {
  allowed: boolean;
  verdict: AudioClearanceVerdict;
  reason?: string;
}

const PUBLISHABLE_SOURCES: ReadonlySet<AudioSource> = new Set<AudioSource>([
  "silence",
  "tts",
  "platform_library",
  "rights_attested",
]);

// The F9 gate: no publish fires unless the audio provenance is one we can stand
// behind. Music licensing and Content ID strikes are fatal for an autoposter,
// so unknown-provenance audio is refused before any bytes leave the building.
export function audioClearanceGate(input: {
  source: AudioSource;
  platform: SocialPlatform;
}): AudioClearance {
  const { source, platform } = input;

  if (PUBLISHABLE_SOURCES.has(source)) {
    return { allowed: true, verdict: source as AudioClearanceVerdict };
  }

  // Consumer-app music is the classic strike magnet. Call out the TikTok case
  // explicitly (a business-classified account using a consumer-library track is
  // a TOS violation, section 7.2), but it is blocked on every platform anyway.
  if (source === "consumer_library") {
    return {
      allowed: false,
      verdict: "blocked",
      reason:
        platform === "tiktok"
          ? "consumer-library audio violates TikTok business TOS; use the Commercial Sound Library"
          : "consumer-library audio is not cleared for automated publishing",
    };
  }

  return {
    allowed: false,
    verdict: "blocked",
    reason: "unknown audio provenance",
  };
}

// Exponential backoff for a failed publish attempt. `attempt` is the 1-based
// number of the attempt that just failed. Returns the delay in ms before the
// next attempt, or null once the attempt cap is reached (give up). A
// platform-supplied Retry-After acts as a floor: we never retry sooner than the
// platform asked, even when our own backoff would. No jitter, so the result is
// deterministic and testable; add jitter at the scheduler if thundering-herd
// ever becomes real (at single-operator volume it will not for a long while).
export function nextRetryDelayMs(
  attempt: number,
  opts: {
    retryAfterMs?: number | null;
    maxAttempts?: number;
    baseMs?: number;
    capMs?: number;
  } = {},
): number | null {
  const maxAttempts = opts.maxAttempts ?? 6;
  const baseMs = opts.baseMs ?? 1000;
  const capMs = opts.capMs ?? 60 * 60 * 1000; // 1 hour

  if (attempt < 1 || attempt >= maxAttempts) return null;

  const computed = Math.min(baseMs * 2 ** (attempt - 1), capMs);
  const retryAfter = opts.retryAfterMs ?? 0;
  return Math.max(computed, retryAfter > 0 ? retryAfter : 0);
}
