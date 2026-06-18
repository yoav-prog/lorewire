// Per-instance rate limiter for /api/polls/vote. Buckets votes by a
// SHA-256(ip || '\n' || user_agent) hash so a single browser can be
// throttled without ever storing IP or UA in plaintext. Memory-only
// per Vercel function instance — cross-instance buckets are Phase 5
// polish (Postgres-backed) and not load-bearing here because the
// cookie idempotency + 20-vote floor are the real anti-abuse
// primitives. The rate limit just stops the obvious "loop on one
// machine" attack from burning DB writes.
//
// Limits are admin-tunable via settings.polls.rate_limit.per_minute /
// _per_hour once that surface ships (Phase 5). Defaults match the
// plan §11 numbers.
//
// Plan: _plans/2026-06-17-engagement-polls.md (§9 security).

import "server-only";
import { createHash } from "node:crypto";

export const DEFAULT_PER_MINUTE = 10;
export const DEFAULT_PER_HOUR = 60;

const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

interface Bucket {
  // Sorted-newest-first list of vote timestamps (ms). We prune entries
  // older than the hour window on each check so the array stays bounded
  // by the per-hour cap.
  hits: number[];
}

// Module-level so the bucket survives across requests on a warm
// instance. A cold start clears it (acceptable — attacker gets one
// fresh window per cold start, well below the cookie idempotency
// guarantee). Map iteration order isn't load-bearing.
const buckets = new Map<string, Bucket>();

/** Mirrors the `ip_ua_hash` column stored on poll_votes — one-way
 *  hash never reversible to the source values. */
export function ipUaHash(ip: string | null, userAgent: string | null): string {
  const safeIp = (ip ?? "").trim() || "0.0.0.0";
  const safeUa = (userAgent ?? "").trim() || "unknown";
  return createHash("sha256").update(`${safeIp}\n${safeUa}`).digest("hex");
}

export interface RateLimitResult {
  ok: boolean;
  /** When `ok=false`, how many seconds until the smallest constraint
   *  releases — set as `Retry-After` on the 429 response. */
  retryAfterSec: number;
  /** Surfaced in the observability log for diagnosability. Not a
   *  privacy issue: a 1-minute count is far below the cookie-history
   *  signal we already hold. */
  inMinute: number;
  inHour: number;
}

export interface CheckOpts {
  perMinute?: number;
  perHour?: number;
  /** Injection seam for tests so we don't depend on wall clock. */
  now?: () => number;
}

/** Read-then-record. Returns `ok=false` without recording the hit
 *  when either window is already at the cap, so a denied request
 *  doesn't deepen the bucket. */
export function checkAndRecord(
  hash: string,
  opts: CheckOpts = {},
): RateLimitResult {
  const perMin = Math.max(1, opts.perMinute ?? DEFAULT_PER_MINUTE);
  const perHour = Math.max(perMin, opts.perHour ?? DEFAULT_PER_HOUR);
  const now = (opts.now ?? Date.now)();
  const bucket: Bucket = buckets.get(hash) ?? { hits: [] };
  const hourCut = now - ONE_HOUR_MS;
  const minCut = now - ONE_MINUTE_MS;
  // Drop expired entries first so the counts below are accurate.
  bucket.hits = bucket.hits.filter((t) => t >= hourCut);
  const inHour = bucket.hits.length;
  const inMinute = bucket.hits.filter((t) => t >= minCut).length;
  if (inMinute >= perMin) {
    const oldestInMin = bucket.hits[bucket.hits.length - inMinute];
    const releaseAt = (oldestInMin ?? now) + ONE_MINUTE_MS;
    buckets.set(hash, bucket);
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((releaseAt - now) / 1000)),
      inMinute,
      inHour,
    };
  }
  if (inHour >= perHour) {
    const releaseAt = (bucket.hits[bucket.hits.length - 1] ?? now) + ONE_HOUR_MS;
    buckets.set(hash, bucket);
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((releaseAt - now) / 1000)),
      inMinute,
      inHour,
    };
  }
  bucket.hits.push(now);
  buckets.set(hash, bucket);
  // Lazy GC: every Nth call, walk the Map and prune entries whose
  // hits all expired. Without this, every unique IP+UA hash creates a
  // Map entry that lives forever — fine on Vercel (cold-start resets)
  // but a real leak on any long-lived runtime (future Cloud Run
  // worker, dev server held open for days). The cost is O(map size)
  // every GC_INTERVAL calls; the bound on Map size is ~unique active
  // attackers, well under a thousand in realistic traffic.
  maybeGcExpiredBuckets(now);
  return { ok: true, retryAfterSec: 0, inMinute: inMinute + 1, inHour: inHour + 1 };
}

/** How many checkAndRecord calls between sweeps. Trades GC overhead
 *  for upper bound on stale-entry count: at 100 we GC every ~100
 *  votes (one second at peak). */
const GC_INTERVAL = 100;
let gcCounter = 0;

function maybeGcExpiredBuckets(now: number): void {
  gcCounter += 1;
  if (gcCounter < GC_INTERVAL) return;
  gcCounter = 0;
  const hourCut = now - ONE_HOUR_MS;
  for (const [hash, bucket] of buckets) {
    // A bucket is considered stale when EVERY hit is older than the
    // hourly window — at that point any future checkAndRecord on this
    // hash would behave identically with or without the prior bucket.
    if (bucket.hits.length === 0 || bucket.hits.every((t) => t < hourCut)) {
      buckets.delete(hash);
    }
  }
}

/** Test helper — resets the in-memory bucket so cases don't bleed. */
export function __resetForTests(): void {
  buckets.clear();
  gcCounter = 0;
}

/** Test-only inspection helper. Returns the current Map size so
 *  memory-leak regression tests can assert eviction works. */
export function __bucketCountForTests(): number {
  return buckets.size;
}
