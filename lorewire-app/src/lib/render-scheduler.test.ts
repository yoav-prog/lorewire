// Tests for the Render Scheduler backpressure gate (Phase 1). The pure
// evaluateRenderGate covers the decision matrix without a DB; the reader
// tests cover the review-queue reads and the end-to-end resolveRenderGate
// against the real store, mirroring story-jobs-budget.test.ts.

import { beforeEach, describe, expect, it } from "vitest";

import { all, run } from "@/lib/db";
import {
  RENDER_DEFAULTS,
  RENDER_SETTING_KEYS,
  countStoriesInReview,
  describeRenderGate,
  evaluateRenderGate,
  getEligibilityMinStrength,
  getOldestReviewAgeHours,
  getRenderEnabled,
  getRenderRatePerHour,
  getReviewQueueCap,
  getStaleHours,
  RENDER_SCHEDULER_REQUESTED_BY,
  expireStaleReviews,
  getFreshnessTtlDays,
  resolveRenderGate,
  runRenderDrip,
  selectRenderCandidates,
  type RenderGateInputs,
} from "./render-scheduler";

async function clear() {
  await run("DELETE FROM stories", []);
  await run("DELETE FROM story_jobs", []);
  await run("DELETE FROM story_job_events", []);
  await run("DELETE FROM reddit_source", []);
  await run("DELETE FROM settings", []);
}

async function insertSource(
  reddit_id: string,
  opts: {
    status?: string;
    strength?: string;
    comments?: number;
    date_written?: string;
    full_pipeline?: number;
  } = {},
) {
  await run(
    "INSERT INTO reddit_source (reddit_id, status, strength, comments, date_written, full_pipeline) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
    [
      reddit_id,
      opts.status ?? "imported",
      opts.strength ?? "medium",
      opts.comments ?? 0,
      opts.date_written ?? "2026-06-01T00:00:00+00:00",
      opts.full_pipeline ?? 0,
    ],
  );
}

async function setSetting(key: string, value: string) {
  await run(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

async function insertReviewStory(id: string, updatedAt: string) {
  await run(
    "INSERT INTO stories (id, status, updated_at, created_at) " +
      "VALUES (?, 'review', ?, ?)",
    [id, updatedAt, updatedAt],
  );
}

// A gate input with everything green; each test overrides one field so
// the failing condition under test is unambiguous.
function openInputs(over: Partial<RenderGateInputs> = {}): RenderGateInputs {
  return {
    enabled: true,
    reviewDepth: 0,
    reviewQueueCap: 20,
    oldestReviewAgeHours: null,
    staleHours: 48,
    budgetExhausted: false,
    ...over,
  };
}

describe("evaluateRenderGate", () => {
  it("opens when everything is green", () => {
    expect(evaluateRenderGate(openInputs())).toEqual({
      shouldRender: true,
      reason: "ok",
    });
  });

  it("is disabled when the kill switch is off, even with everything else green", () => {
    expect(evaluateRenderGate(openInputs({ enabled: false }))).toEqual({
      shouldRender: false,
      reason: "disabled",
    });
  });

  it("pauses on review backlog at or above the cap", () => {
    expect(
      evaluateRenderGate(openInputs({ reviewDepth: 20, reviewQueueCap: 20 })).reason,
    ).toBe("review_backlog");
    expect(
      evaluateRenderGate(openInputs({ reviewDepth: 21, reviewQueueCap: 20 })).reason,
    ).toBe("review_backlog");
  });

  it("does not pause on backlog just below the cap", () => {
    expect(
      evaluateRenderGate(openInputs({ reviewDepth: 19, reviewQueueCap: 20 })).shouldRender,
    ).toBe(true);
  });

  it("pauses on a stale oldest item once work is waiting", () => {
    expect(
      evaluateRenderGate(
        openInputs({ reviewDepth: 3, oldestReviewAgeHours: 50, staleHours: 48 }),
      ).reason,
    ).toBe("review_stale");
  });

  it("never trips the stale gate when the review queue is empty", () => {
    // depth 0 means nothing is waiting; a null age must not pause.
    expect(
      evaluateRenderGate(
        openInputs({ reviewDepth: 0, oldestReviewAgeHours: null, staleHours: 48 }),
      ).shouldRender,
    ).toBe(true);
  });

  it("pauses on exhausted budget when nothing else blocks", () => {
    expect(
      evaluateRenderGate(openInputs({ budgetExhausted: true })).reason,
    ).toBe("budget_exhausted");
  });

  it("reports backlog before budget when both are true", () => {
    // Ordering guarantee: the more actionable "go approve things" signal
    // wins the message over budget.
    expect(
      evaluateRenderGate(
        openInputs({ reviewDepth: 20, reviewQueueCap: 20, budgetExhausted: true }),
      ).reason,
    ).toBe("review_backlog");
  });
});

describe("setting readers", () => {
  beforeEach(clear);

  it("render enabled defaults off and only 1/true turn it on", async () => {
    expect(await getRenderEnabled()).toBe(false);
    for (const on of ["1", "true", "TRUE", " true "]) {
      await setSetting(RENDER_SETTING_KEYS.enabled, on);
      expect(await getRenderEnabled()).toBe(true);
    }
    for (const off of ["0", "false", "", "yes", "on"]) {
      await setSetting(RENDER_SETTING_KEYS.enabled, off);
      expect(await getRenderEnabled()).toBe(false);
    }
  });

  it("numeric settings fall back to defaults on blank / bad / non-positive", async () => {
    expect(await getReviewQueueCap()).toBe(RENDER_DEFAULTS.reviewQueueCap);
    expect(await getStaleHours()).toBe(RENDER_DEFAULTS.staleHours);
    expect(await getRenderRatePerHour()).toBe(RENDER_DEFAULTS.ratePerHour);
    for (const bad of ["", "  ", "0", "-3", "abc"]) {
      await setSetting(RENDER_SETTING_KEYS.reviewQueueCap, bad);
      expect(await getReviewQueueCap()).toBe(RENDER_DEFAULTS.reviewQueueCap);
    }
  });

  it("numeric settings read a valid stored value", async () => {
    await setSetting(RENDER_SETTING_KEYS.reviewQueueCap, "35");
    await setSetting(RENDER_SETTING_KEYS.staleHours, "12");
    await setSetting(RENDER_SETTING_KEYS.ratePerHour, "1.5");
    expect(await getReviewQueueCap()).toBe(35);
    expect(await getStaleHours()).toBe(12);
    expect(await getRenderRatePerHour()).toBe(1.5);
  });
});

describe("review-queue reads", () => {
  beforeEach(clear);

  it("counts only stories in review", async () => {
    await insertReviewStory("r1", "2026-07-01T00:00:00+00:00");
    await insertReviewStory("r2", "2026-07-01T00:00:00+00:00");
    await run(
      "INSERT INTO stories (id, status, updated_at, created_at) VALUES ('p', 'published', ?, ?)",
      ["2026-07-01T00:00:00+00:00", "2026-07-01T00:00:00+00:00"],
    );
    expect(await countStoriesInReview()).toBe(2);
  });

  it("oldest review age is null on an empty queue", async () => {
    expect(await getOldestReviewAgeHours()).toBeNull();
  });

  it("oldest review age measures from the earliest updated_at", async () => {
    const now = Date.parse("2026-07-01T12:00:00+00:00");
    await insertReviewStory("old", "2026-07-01T00:00:00+00:00"); // 12h ago
    await insertReviewStory("new", "2026-07-01T11:00:00+00:00"); // 1h ago
    const age = await getOldestReviewAgeHours(now);
    expect(age).toBeCloseTo(12, 5);
  });
});

describe("resolveRenderGate (end to end)", () => {
  beforeEach(clear);

  it("is disabled by default (nothing configured)", async () => {
    const s = await resolveRenderGate();
    expect(s.reason).toBe("disabled");
    expect(s.shouldRender).toBe(false);
  });

  it("opens once enabled with an empty review queue", async () => {
    await setSetting(RENDER_SETTING_KEYS.enabled, "1");
    const s = await resolveRenderGate();
    expect(s.shouldRender).toBe(true);
    expect(s.reason).toBe("ok");
    expect(s.reviewDepth).toBe(0);
  });

  it("pauses on backlog once review depth reaches the cap", async () => {
    await setSetting(RENDER_SETTING_KEYS.enabled, "1");
    await setSetting(RENDER_SETTING_KEYS.reviewQueueCap, "2");
    await insertReviewStory("a", "2026-07-01T00:00:00+00:00");
    await insertReviewStory("b", "2026-07-01T00:00:00+00:00");
    const s = await resolveRenderGate();
    expect(s.reason).toBe("review_backlog");
    expect(s.shouldRender).toBe(false);
  });

  it("pauses on stale once the oldest waiting item passes stale_hours", async () => {
    await setSetting(RENDER_SETTING_KEYS.enabled, "1");
    await setSetting(RENDER_SETTING_KEYS.staleHours, "6");
    const now = Date.parse("2026-07-01T12:00:00+00:00");
    await insertReviewStory("stale", "2026-07-01T00:00:00+00:00"); // 12h old
    const s = await resolveRenderGate(now);
    expect(s.reason).toBe("review_stale");
  });
});

describe("describeRenderGate", () => {
  it("gives a plain one-liner per reason", () => {
    const base = {
      enabled: true,
      reviewDepth: 20,
      reviewQueueCap: 20,
      oldestReviewAgeHours: 50,
      staleHours: 48,
      budgetExhausted: false,
    };
    expect(
      describeRenderGate({ ...base, shouldRender: true, reason: "ok" }),
    ).toMatch(/active/i);
    expect(
      describeRenderGate({ ...base, shouldRender: false, reason: "review_backlog" }),
    ).toContain("20/20");
    expect(
      describeRenderGate({ ...base, shouldRender: false, reason: "review_stale" }),
    ).toMatch(/50h/);
  });
});

// ---- Phase 2: eligibility + candidate selection ----------------------

describe("getEligibilityMinStrength", () => {
  beforeEach(clear);

  it("defaults to medium and rejects unknown values", async () => {
    expect(await getEligibilityMinStrength()).toBe("medium");
    await setSetting(RENDER_SETTING_KEYS.eligibilityMinStrength, "banana");
    expect(await getEligibilityMinStrength()).toBe("medium");
  });

  it("reads a valid stored tier", async () => {
    for (const t of ["none", "medium", "strong"]) {
      await setSetting(RENDER_SETTING_KEYS.eligibilityMinStrength, t);
      expect(await getEligibilityMinStrength()).toBe(t);
    }
  });
});

describe("selectRenderCandidates", () => {
  beforeEach(clear);

  it("orders strong before medium before none, tie-broken by comments then recency", async () => {
    await insertSource("medium-hi", { strength: "medium", comments: 500 });
    await insertSource("strong-lo", { strength: "strong", comments: 1 });
    await insertSource("strong-hi", { strength: "strong", comments: 900 });
    await insertSource("none-hi", { strength: "none", comments: 9999 });
    const ids = await selectRenderCandidates(10, "none");
    // Strong tier first (hi comments before lo), then medium, then none.
    expect(ids).toEqual(["strong-hi", "strong-lo", "medium-hi", "none-hi"]);
  });

  it("honours the minimum strength filter", async () => {
    await insertSource("s", { strength: "strong" });
    await insertSource("m", { strength: "medium" });
    await insertSource("n", { strength: "none" });
    expect(await selectRenderCandidates(10, "medium")).toEqual(["s", "m"]);
    expect(await selectRenderCandidates(10, "strong")).toEqual(["s"]);
  });

  it("excludes non-imported and full_pipeline sources", async () => {
    await insertSource("imported-ok", { strength: "strong" });
    await insertSource("already-used", { strength: "strong", status: "used" });
    await insertSource("full-pipe", { strength: "strong", full_pipeline: 1 });
    expect(await selectRenderCandidates(10, "none")).toEqual(["imported-ok"]);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await insertSource(`s${i}`, { strength: "strong", comments: 100 - i });
    }
    expect((await selectRenderCandidates(3, "none")).length).toBe(3);
  });
});

// ---- Phase 2: the rate-limited drip ----------------------------------

async function countQueuedJobs(): Promise<number> {
  const rows = await all<{ n: number | string }>(
    "SELECT count(*) AS n FROM story_jobs WHERE status = 'queued'",
    [],
  );
  return Number(rows[0]?.n ?? 0);
}

describe("runRenderDrip", () => {
  beforeEach(clear);

  async function enable(ratePerHour: string, cap = "20") {
    await setSetting(RENDER_SETTING_KEYS.enabled, "1");
    await setSetting(RENDER_SETTING_KEYS.ratePerHour, ratePerHour);
    await setSetting(RENDER_SETTING_KEYS.reviewQueueCap, cap);
    await setSetting(RENDER_SETTING_KEYS.eligibilityMinStrength, "none");
  }

  it("does nothing while the gate is closed (disabled)", async () => {
    const r = await runRenderDrip();
    expect(r.enqueued).toBe(0);
    expect(r.reason).toBe("gate_closed");
  });

  it("seeds the cursor and enqueues nothing on the very first tick", async () => {
    await enable("100"); // absurd rate, to prove the seed still spends 0
    await insertSource("a", { strength: "strong" });
    const r = await runRenderDrip();
    expect(r.reason).toBe("seeded");
    expect(r.enqueued).toBe(0);
    // The cursor is now set; a second immediate tick has ~0 elapsed.
    const r2 = await runRenderDrip();
    expect(r2.reason).toBe("no_allowance_yet");
  });

  it("enqueues whole credits once time has elapsed, highest priority first", async () => {
    await enable("2"); // 2/hour
    await insertSource("weak", { strength: "medium", comments: 1 });
    await insertSource("strong-a", { strength: "strong", comments: 50 });
    await insertSource("strong-b", { strength: "strong", comments: 10 });
    const now = Date.parse("2026-07-01T12:00:00+00:00");
    // Cursor one hour back → 1h * 2/hour = 2 whole credits.
    await setSetting(
      RENDER_SETTING_KEYS.lastEnqueueAt,
      new Date(now - 3_600_000).toISOString(),
    );
    const r = await runRenderDrip(now);
    expect(r.reason).toBe("ok");
    expect(r.enqueued).toBe(2);
    expect(await countQueuedJobs()).toBe(2);
    // The two strong sources should have been the ones picked.
    const queued = await all<{ reddit_id: string }>(
      "SELECT reddit_id FROM story_jobs ORDER BY reddit_id",
      [],
    );
    expect(queued.map((q) => q.reddit_id)).toEqual(["strong-a", "strong-b"]);
  });

  it("clamps to review headroom so a burst cannot overflow the cap", async () => {
    await enable("100", "3"); // cap 3
    // Two already in review → headroom is 3 - 2 - 0 = 1.
    await insertReviewStory("rev1", "2026-07-01T11:59:00+00:00");
    await insertReviewStory("rev2", "2026-07-01T11:59:00+00:00");
    for (let i = 0; i < 5; i++) {
      await insertSource(`s${i}`, { strength: "strong", comments: 100 - i });
    }
    const now = Date.parse("2026-07-01T12:00:00+00:00");
    await setSetting(
      RENDER_SETTING_KEYS.lastEnqueueAt,
      new Date(now - 3_600_000).toISOString(),
    );
    const r = await runRenderDrip(now);
    expect(r.headroom).toBe(1);
    expect(r.enqueued).toBe(1);
  });

  it("advances the cursor when nothing is eligible so allowance can't pile up", async () => {
    await enable("5");
    const now = Date.parse("2026-07-01T12:00:00+00:00");
    await setSetting(
      RENDER_SETTING_KEYS.lastEnqueueAt,
      new Date(now - 3_600_000).toISOString(),
    );
    const r = await runRenderDrip(now); // no sources inserted
    expect(r.reason).toBe("no_candidates");
    expect(r.enqueued).toBe(0);
    // Cursor advanced to now: an immediate re-tick has no allowance.
    const r2 = await runRenderDrip(now);
    expect(r2.reason).toBe("no_allowance_yet");
  });

  it("does not flood after a long pause: the cursor resets while backpressured", async () => {
    await enable("2", "5"); // rate 2/hr, cap 5
    const now = Date.parse("2026-07-01T12:00:00+00:00");
    // Cursor 10h back would bank ~20 credits if allowed to accrue.
    await setSetting(
      RENDER_SETTING_KEYS.lastEnqueueAt,
      new Date(now - 10 * 3_600_000).toISOString(),
    );
    // Fill the review queue to the cap so the gate is closed (backlog),
    // and stand up plenty of eligible sources so a flood would be visible.
    for (let i = 0; i < 5; i++) {
      await insertReviewStory(`rev${i}`, "2026-07-01T11:59:00+00:00");
    }
    for (let i = 0; i < 10; i++) {
      await insertSource(`s${i}`, { strength: "strong", comments: 100 - i });
    }
    const paused = await runRenderDrip(now);
    expect(paused.reason).toBe("gate_closed");
    expect(paused.enqueued).toBe(0);

    // Clear the review queue; the very next tick must NOT dump the banked
    // 20 — the cursor was reset to now while paused.
    await run("DELETE FROM stories", []);
    const resumed = await runRenderDrip(now);
    expect(resumed.reason).toBe("no_allowance_yet");
    expect(resumed.enqueued).toBe(0);
  });

  it("resets the cursor on no-headroom (in-flight fills the queue)", async () => {
    await enable("2", "2"); // cap 2
    const now = Date.parse("2026-07-01T12:00:00+00:00");
    await setSetting(
      RENDER_SETTING_KEYS.lastEnqueueAt,
      new Date(now - 10 * 3_600_000).toISOString(),
    );
    // 2 in-flight jobs already fill the cap -> headroom 0.
    await run(
      "INSERT INTO story_jobs (id, reddit_id, status, progress, with_media, requested_at) VALUES ('j1','a','queued',0,1,?)",
      [new Date(now).toISOString()],
    );
    await run(
      "INSERT INTO story_jobs (id, reddit_id, status, progress, with_media, requested_at) VALUES ('j2','b','processing',0,1,?)",
      [new Date(now).toISOString()],
    );
    await insertSource("s0", { strength: "strong" });
    const r = await runRenderDrip(now);
    expect(r.reason).toBe("no_headroom");
    expect(r.enqueued).toBe(0);
    expect(r.allowance).toBe(20); // 10h * 2/hr banked before the reset
    // Cursor reset to now: an immediate re-tick has drained the allowance.
    const r2 = await runRenderDrip(now);
    expect(r2.reason).toBe("no_allowance_yet");
    expect(r2.allowance).toBe(0);
  });
});

// ---- Phase 3: stale-review GC ----------------------------------------

// A scheduler-origin review story = a stories row in review + a story_jobs
// row that points at it and carries the scheduler's requested_by marker.
async function insertSchedulerReviewStory(id: string, updatedAt: string) {
  await run(
    "INSERT INTO stories (id, status, updated_at, created_at) VALUES (?, 'review', ?, ?)",
    [id, updatedAt, updatedAt],
  );
  await run(
    "INSERT INTO story_jobs (id, reddit_id, status, progress, with_media, requested_at, requested_by, story_id) " +
      "VALUES (?, ?, 'done', 100, 1, ?, ?, ?)",
    [`job-${id}`, `rid-${id}`, updatedAt, RENDER_SCHEDULER_REQUESTED_BY, id],
  );
}

describe("getFreshnessTtlDays", () => {
  beforeEach(clear);
  it("defaults to 7 and falls back on bad values", async () => {
    expect(await getFreshnessTtlDays()).toBe(7);
    await setSetting(RENDER_SETTING_KEYS.freshnessTtlDays, "-1");
    expect(await getFreshnessTtlDays()).toBe(7);
    await setSetting(RENDER_SETTING_KEYS.freshnessTtlDays, "3");
    expect(await getFreshnessTtlDays()).toBe(3);
  });
});

describe("expireStaleReviews", () => {
  beforeEach(clear);

  it("archives a scheduler-created review story older than the TTL", async () => {
    const now = Date.parse("2026-07-10T00:00:00+00:00");
    await setSetting(RENDER_SETTING_KEYS.freshnessTtlDays, "7");
    await insertSchedulerReviewStory("old", "2026-07-01T00:00:00+00:00"); // 9d old
    const r = await expireStaleReviews(now);
    expect(r.expired).toBe(1);
    const row = await all<{ status: string }>(
      "SELECT status FROM stories WHERE id = 'old'",
      [],
    );
    expect(row[0].status).toBe("archived");
  });

  it("leaves a scheduler story that is still fresh", async () => {
    const now = Date.parse("2026-07-10T00:00:00+00:00");
    await setSetting(RENDER_SETTING_KEYS.freshnessTtlDays, "7");
    await insertSchedulerReviewStory("fresh", "2026-07-08T00:00:00+00:00"); // 2d old
    const r = await expireStaleReviews(now);
    expect(r.expired).toBe(0);
  });

  it("never archives a manually-created review story, however old", async () => {
    const now = Date.parse("2026-07-10T00:00:00+00:00");
    await setSetting(RENDER_SETTING_KEYS.freshnessTtlDays, "7");
    // Manual: a review story with no scheduler-origin story_job.
    await run(
      "INSERT INTO stories (id, status, updated_at, created_at) VALUES ('manual', 'review', ?, ?)",
      ["2020-01-01T00:00:00+00:00", "2020-01-01T00:00:00+00:00"],
    );
    const r = await expireStaleReviews(now);
    expect(r.expired).toBe(0);
    const row = await all<{ status: string }>(
      "SELECT status FROM stories WHERE id = 'manual'",
      [],
    );
    expect(row[0].status).toBe("review");
  });

  it("ignores non-review stories even when scheduler-created and old", async () => {
    const now = Date.parse("2026-07-10T00:00:00+00:00");
    await insertSchedulerReviewStory("published-one", "2026-07-01T00:00:00+00:00");
    await run("UPDATE stories SET status = 'published' WHERE id = 'published-one'", []);
    const r = await expireStaleReviews(now);
    expect(r.expired).toBe(0);
  });
});
