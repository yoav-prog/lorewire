// Tests for the in-memory rate limiter that gates /api/polls/vote.
// Uses an injected `now` clock so timing-sensitive assertions don't
// depend on a real wall clock (and tests stay deterministic on
// slower CI runners).
//
// Plan: _plans/2026-06-17-engagement-polls.md (§9).

import { beforeEach, describe, expect, it } from "vitest";
import {
  __bucketCountForTests,
  __resetForTests,
  checkAndRecord,
  DEFAULT_PER_HOUR,
  DEFAULT_PER_MINUTE,
  ipUaHash,
} from "@/lib/poll-rate-limit";

beforeEach(() => {
  __resetForTests();
});

describe("ipUaHash", () => {
  it("is stable for the same inputs", () => {
    expect(ipUaHash("1.2.3.4", "Mozilla")).toBe(ipUaHash("1.2.3.4", "Mozilla"));
  });

  it("changes when IP or UA changes", () => {
    const a = ipUaHash("1.2.3.4", "Mozilla");
    expect(a).not.toBe(ipUaHash("1.2.3.5", "Mozilla"));
    expect(a).not.toBe(ipUaHash("1.2.3.4", "Chrome"));
  });

  it("never returns the raw IP or UA", () => {
    const h = ipUaHash("1.2.3.4", "secret-ua");
    expect(h).not.toContain("1.2.3.4");
    expect(h).not.toContain("secret-ua");
    expect(h).toHaveLength(64); // SHA-256 hex
  });

  it("handles nulls without throwing and returns a stable 64-char hex", () => {
    // The fallback values ARE ("0.0.0.0", "unknown") so a null-pair
    // collides with that exact literal pair by design — that's fine,
    // both buckets aggregate the same "unknown client" cohort and
    // both stay subject to the same per-minute / per-hour caps.
    expect(() => ipUaHash(null, null)).not.toThrow();
    const h = ipUaHash(null, null);
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("checkAndRecord (per-minute)", () => {
  it("accepts up to perMinute hits in a sliding window", () => {
    const now = () => 1_000;
    for (let i = 0; i < DEFAULT_PER_MINUTE; i++) {
      const r = checkAndRecord("h-1", { now });
      expect(r.ok).toBe(true);
    }
  });

  it("rejects the (perMinute+1)-th hit within the same minute", () => {
    const now = () => 1_000;
    for (let i = 0; i < DEFAULT_PER_MINUTE; i++) {
      checkAndRecord("h-2", { now });
    }
    const denied = checkAndRecord("h-2", { now });
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });

  it("releases after the minute window slides forward", () => {
    let t = 1_000;
    const now = () => t;
    for (let i = 0; i < DEFAULT_PER_MINUTE; i++) {
      checkAndRecord("h-3", { now });
    }
    t = 1_000 + 61_000; // 61 seconds later: the earliest hit aged out
    const r = checkAndRecord("h-3", { now });
    expect(r.ok).toBe(true);
  });

  it("does not record the denied hit (bucket stays at the cap)", () => {
    const now = () => 1_000;
    for (let i = 0; i < DEFAULT_PER_MINUTE; i++) {
      checkAndRecord("h-4", { now });
    }
    const denied = checkAndRecord("h-4", { now });
    expect(denied.ok).toBe(false);
    expect(denied.inMinute).toBe(DEFAULT_PER_MINUTE);
  });
});

describe("checkAndRecord (per-hour)", () => {
  it("caps at perHour even with the per-minute window clear", () => {
    let t = 0;
    const now = () => t;
    // Space hits 30s apart so every minute window holds ≤ 2 hits
    // (well under the per-minute cap), but all DEFAULT_PER_HOUR hits
    // fit comfortably inside ONE hour so the per-hour cap actually
    // bites on the next attempt. Spacing > 60s would push the
    // earliest hits out of the hour window and the per-hour count
    // would never reach the cap (which is what the original test
    // got wrong).
    const SPACING_MS = 30_000;
    for (let i = 0; i < DEFAULT_PER_HOUR; i++) {
      t = i * SPACING_MS;
      const r = checkAndRecord("h-5", { now });
      expect(r.ok).toBe(true);
    }
    t = DEFAULT_PER_HOUR * SPACING_MS + 1_000;
    const denied = checkAndRecord("h-5", { now });
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
  });
});

describe("checkAndRecord (isolation)", () => {
  it("buckets are independent across hashes", () => {
    const now = () => 1_000;
    for (let i = 0; i < DEFAULT_PER_MINUTE; i++) {
      checkAndRecord("h-iso-a", { now });
    }
    // h-iso-a is full; h-iso-b should still accept.
    const r = checkAndRecord("h-iso-b", { now });
    expect(r.ok).toBe(true);
  });
});

// 2026-06-18 QA pass: regression test for the unbounded-Map memory
// leak. Buckets whose hits all expired stay in the Map until the
// lazy GC sweep runs. On a long-lived runtime this leaked at the
// rate of "unique attacker fingerprints" — small per-request but
// unbounded over time.
describe("memory growth + lazy GC", () => {
  it("buckets accumulate until the GC interval fires, then expired ones get evicted", () => {
    let t = 1_000;
    const now = () => t;
    // GC fires every 100 calls (GC_INTERVAL). Fire 99 unique hashes
    // — none of the buckets get evicted yet because no GC sweep ran.
    for (let i = 0; i < 99; i++) {
      checkAndRecord(`h-leak-${i}`, { now });
    }
    expect(__bucketCountForTests()).toBe(99);
    // Now jump past the hour window so every existing bucket is
    // stale, and fire the 100th call — that triggers the sweep.
    t = 1_000 + 60 * 60 * 1000 + 1_000;
    checkAndRecord("h-leak-trigger", { now });
    // Sweep ran on the trigger call. All 99 old buckets had every
    // hit expired → evicted. Only the trigger's bucket remains.
    expect(__bucketCountForTests()).toBe(1);
  });

  it("active buckets survive the GC sweep", () => {
    let t = 1_000;
    const now = () => t;
    // Mix of stale (recorded at t=1000) and active (recorded just
    // before the sweep).
    for (let i = 0; i < 50; i++) {
      checkAndRecord(`h-stale-${i}`, { now });
    }
    // Advance past the hour window, then record fresh hits.
    t = 1_000 + 60 * 60 * 1000 + 1_000;
    for (let i = 0; i < 49; i++) {
      checkAndRecord(`h-fresh-${i}`, { now });
    }
    // The 100th call (49 fresh + 50 stale + 1 trigger) fires the
    // sweep. Stale buckets evicted; fresh buckets retained.
    checkAndRecord(`h-sweep-trigger`, { now });
    // 49 fresh + 1 trigger = 50 buckets. The 50 stale ones evicted.
    expect(__bucketCountForTests()).toBe(50);
  });
});
