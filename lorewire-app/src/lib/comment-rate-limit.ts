// DB-backed velocity limit for comment submission. Unlike the poll vote
// limiter (src/lib/poll-rate-limit.ts), which is per-instance memory, this
// counts rows in the comments table so the limit holds across serverless
// instances and cold starts. That matters here because guests are the main
// abuse surface, and an in-memory cap resets on every cold start.
//
// Buckets by ip_ua_hash (and, for guests, also by cookie token). Guests get a
// tighter ceiling than signed-in users. Limits are intentionally generous for
// honest use and only bite on flooding; a CAPTCHA on the guest path (Step 6)
// backs this up.

import "server-only";
import { recentCommentTimes } from "@/lib/comments";

interface Limits {
  perMinute: number;
  perHour: number;
  perDay: number;
}

const GUEST_LIMITS: Limits = { perMinute: 2, perHour: 8, perDay: 20 };
const USER_LIMITS: Limits = { perMinute: 4, perHour: 20, perDay: 80 };

export interface VelocityResult {
  ok: boolean;
  /** Seconds until the tightest tripped window releases; set as Retry-After. */
  retryAfterSec: number;
  /** Which window tripped, for the observability log. */
  window?: "minute" | "hour" | "day";
}

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

function countSince(times: number[], cutoff: number): number {
  return times.filter((t) => t >= cutoff).length;
}

export async function checkCommentVelocity(opts: {
  ipUaHash: string;
  cookieToken: string;
  isGuest: boolean;
  now?: number;
}): Promise<VelocityResult> {
  const limits = opts.isGuest ? GUEST_LIMITS : USER_LIMITS;
  const now = opts.now ?? Date.now();
  const dayCutoff = new Date(now - DAY_MS).toISOString();

  // One query per bucket over the widest (day) window; per-window counts are
  // derived in memory. Guests are limited by the stricter of their two buckets.
  const buckets: string[][] = [
    await recentCommentTimes("ip_ua_hash", opts.ipUaHash, dayCutoff),
  ];
  if (opts.isGuest && opts.cookieToken) {
    buckets.push(await recentCommentTimes("cookie_token", opts.cookieToken, dayCutoff));
  }

  for (const iso of buckets) {
    const times = iso.map((s) => Date.parse(s)).filter((n) => !Number.isNaN(n));
    if (countSince(times, now - MIN_MS) >= limits.perMinute) {
      return { ok: false, retryAfterSec: 60, window: "minute" };
    }
    if (countSince(times, now - HOUR_MS) >= limits.perHour) {
      return { ok: false, retryAfterSec: 600, window: "hour" };
    }
    if (times.length >= limits.perDay) {
      return { ok: false, retryAfterSec: 3600, window: "day" };
    }
  }
  return { ok: true, retryAfterSec: 0 };
}
