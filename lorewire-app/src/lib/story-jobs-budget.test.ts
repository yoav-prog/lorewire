// Round-trip tests for the Phase 7 daily-budget cap. The Python worker
// gate is the load-bearing piece (see pipeline/tests/test_story_jobs.py
// :: BudgetGateTests); these tests cover the TS surface the admin UI
// reads from and the read parity with the Python helper.

import { beforeEach, describe, expect, it } from "vitest";

import { all, run } from "@/lib/db";
import {
  DAILY_BUDGET_CAP_SETTING_KEY,
  ESTIMATED_JOB_COST_CENTS,
  formatCents,
  getBudgetSummary,
  getDailyBudgetCapCents,
  getTodayStoryJobsEstimate,
} from "./story-jobs-budget";

async function clear() {
  await run("DELETE FROM story_jobs", []);
  await run("DELETE FROM settings", []);
}

// Seed a story_jobs row directly so we don't have to also stand up a
// reddit_source row + the active-check gate in bulkEnqueue.
async function seedJob(
  id: string,
  reddit_id: string,
  status: string,
  finished_at: string | null = null,
) {
  await run(
    "INSERT INTO story_jobs (id, reddit_id, status, progress, with_media, requested_at, finished_at) " +
      "VALUES (?, ?, ?, 0, 1, '2026-06-14T00:00:00+00:00', ?)",
    [id, reddit_id, status, finished_at],
  );
}

async function setCap(value: string) {
  await run(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [DAILY_BUDGET_CAP_SETTING_KEY, value],
  );
}

describe("getDailyBudgetCapCents", () => {
  beforeEach(clear);

  it("returns null when unset", async () => {
    expect(await getDailyBudgetCapCents()).toBeNull();
  });

  it("returns the integer cents when set", async () => {
    await setCap("1500");
    expect(await getDailyBudgetCapCents()).toBe(1500);
  });

  it("treats blank / zero / negative / non-numeric as unset (no passive halt)", async () => {
    for (const bad of ["", "  ", "0", "-50", "abc"]) {
      await setCap(bad);
      expect(await getDailyBudgetCapCents()).toBeNull();
    }
  });
});

describe("getTodayStoryJobsEstimate", () => {
  beforeEach(clear);

  it("returns 0 jobs / 0 cents on an empty queue", async () => {
    const r = await getTodayStoryJobsEstimate();
    expect(r).toEqual({ count: 0, estimatedSpendCents: 0 });
  });

  it("counts done-today + active, excludes done-not-today", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await seedJob("done-today", "a", "done", `${today}T12:00:00+00:00`);
    await seedJob("queued", "b", "queued", null);
    await seedJob("processing", "c", "processing", null);
    // An ancient finished row that must NOT count.
    await seedJob("ancient", "d", "done", "2020-01-01T00:00:00+00:00");

    const r = await getTodayStoryJobsEstimate();
    expect(r.count).toBe(3);
    expect(r.estimatedSpendCents).toBe(3 * ESTIMATED_JOB_COST_CENTS);
  });
});

describe("getBudgetSummary", () => {
  beforeEach(clear);

  it("computes fraction and exhausted flags correctly", async () => {
    // 4 active = 200c projected.
    for (let i = 0; i < 4; i++) {
      await seedJob(`j${i}`, `r${i}`, "queued", null);
    }
    await setCap("300"); // $3.00 cap; projected $2.00; next job would bring
                         // it to $2.50, still under $3.00 → not exhausted.
    const r = await getBudgetSummary();
    expect(r.capCents).toBe(300);
    expect(r.spentCents).toBe(4 * ESTIMATED_JOB_COST_CENTS);
    expect(r.jobCount).toBe(4);
    expect(r.fraction).toBeCloseTo(200 / 300, 3);
    expect(r.exhausted).toBe(false);
  });

  it("marks exhausted when the next job would breach the cap", async () => {
    for (let i = 0; i < 5; i++) {
      await seedJob(`j${i}`, `r${i}`, "queued", null);
    }
    // 5 × 50c = 250c projected. Cap 280c. Next job → 300c > 280c.
    await setCap("280");
    const r = await getBudgetSummary();
    expect(r.exhausted).toBe(true);
  });

  it("returns fraction=0 and exhausted=false when no cap is set", async () => {
    for (let i = 0; i < 100; i++) {
      await seedJob(`j${i}`, `r${i}`, "queued", null);
    }
    const r = await getBudgetSummary();
    expect(r.capCents).toBeNull();
    expect(r.fraction).toBe(0);
    expect(r.exhausted).toBe(false);
  });

  // Parity guard: the Python ESTIMATED_JOB_COST_CENTS and the TS one
  // must read the same number. If they drift, the worker would block
  // while the admin UI says "you have headroom" — exactly the kind of
  // bug that erodes trust in the cap.
  it("ESTIMATED_JOB_COST_CENTS is the documented 50¢", async () => {
    expect(ESTIMATED_JOB_COST_CENTS).toBe(50);
  });
});

describe("formatCents", () => {
  it("formats whole dollars", () => {
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(0)).toBe("$0.00");
  });
  it("formats fractional cents", () => {
    expect(formatCents(150)).toBe("$1.50");
    expect(formatCents(199)).toBe("$1.99");
  });
});

// Sanity: the row-count of the settings table is correct after each
// suite (catches a setup that doesn't actually wipe state).
describe("setup", () => {
  it("clear() actually empties the settings table", async () => {
    await setCap("999");
    await clear();
    const rows = await all(`SELECT count(*) AS n FROM settings`, []);
    expect((rows[0] as { n: number | string }).n).toBe(0);
  });
});
