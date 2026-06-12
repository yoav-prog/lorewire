// Tests for lib/frame-session-spend.ts — Phase 4 of the video editor
// overhaul. Verifies the cap setting falls back safely on missing/invalid
// values, the SQL aggregator counts the right rows (own user, this story,
// only frame:* assets, since session start), and the cap-check accepts
// or rejects based on total spend + this-request estimate.
//
// Tests run against the per-process SQLite DB the Vitest setup spins up
// (see tests/setup.ts), so SQL paths get exercised end-to-end. No
// network. No mocks.

import { describe, expect, it, beforeEach } from "vitest";
import { run } from "@/lib/db";
import { setSetting } from "@/lib/repo";
import {
  canQueueFrameRegenForSession,
  DEFAULT_FRAME_REGEN_SESSION_CAP_CENTS,
  FRAME_REGEN_SESSION_CAP_SETTING_KEY,
  getFrameRegenSessionCapCents,
  getSessionSpendCents,
} from "@/lib/frame-session-spend";

const STORY_ID = "story-spend-test";
const USER_ID = "admin-1";
const SESSION_START = "2026-06-12T10:00:00.000Z";

async function insertRender(opts: {
  id: string;
  owner_kind?: string;
  owner_id?: string;
  asset?: string;
  status?: "queued" | "generating" | "done" | "error";
  cost_cents?: number | null;
  requested_by?: string;
  requested_at?: string;
}) {
  await run(
    `INSERT INTO image_renders
      (id, owner_kind, owner_id, asset, prompt_hash, status, progress, error,
       output_url, cost_cents, requested_by, requested_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, NULL, ?, 0, NULL, NULL, ?, ?, ?, NULL, NULL)`,
    [
      opts.id,
      opts.owner_kind ?? "story",
      opts.owner_id ?? STORY_ID,
      opts.asset ?? "frame:f1",
      opts.status ?? "done",
      opts.cost_cents ?? null,
      opts.requested_by ?? USER_ID,
      opts.requested_at ?? "2026-06-12T11:00:00.000Z",
    ],
  );
}

async function clearImageRenders() {
  await run(`DELETE FROM image_renders`);
}

// ─── getFrameRegenSessionCapCents ────────────────────────────────────────────

describe("getFrameRegenSessionCapCents", () => {
  beforeEach(async () => {
    // Clear any setting persisted by a sibling test.
    await setSetting(FRAME_REGEN_SESSION_CAP_SETTING_KEY, "");
  });

  it("returns the default when the setting is unset", async () => {
    const cap = await getFrameRegenSessionCapCents();
    expect(cap).toBe(DEFAULT_FRAME_REGEN_SESSION_CAP_CENTS);
  });

  it("returns the parsed integer when the setting is a valid number", async () => {
    await setSetting(FRAME_REGEN_SESSION_CAP_SETTING_KEY, "1200");
    expect(await getFrameRegenSessionCapCents()).toBe(1200);
  });

  it("falls back to default when the setting is garbage", async () => {
    await setSetting(FRAME_REGEN_SESSION_CAP_SETTING_KEY, "nonsense");
    expect(await getFrameRegenSessionCapCents()).toBe(
      DEFAULT_FRAME_REGEN_SESSION_CAP_CENTS,
    );
  });

  it("falls back to default on zero or negative (defensive)", async () => {
    await setSetting(FRAME_REGEN_SESSION_CAP_SETTING_KEY, "0");
    expect(await getFrameRegenSessionCapCents()).toBe(
      DEFAULT_FRAME_REGEN_SESSION_CAP_CENTS,
    );
    await setSetting(FRAME_REGEN_SESSION_CAP_SETTING_KEY, "-50");
    expect(await getFrameRegenSessionCapCents()).toBe(
      DEFAULT_FRAME_REGEN_SESSION_CAP_CENTS,
    );
  });
});

// ─── getSessionSpendCents ────────────────────────────────────────────────────

describe("getSessionSpendCents", () => {
  beforeEach(clearImageRenders);

  it("returns zero when no rows match", async () => {
    const s = await getSessionSpendCents(STORY_ID, USER_ID, SESSION_START);
    expect(s.completedCents).toBe(0);
    expect(s.pendingCount).toBe(0);
    expect(s.totalCents).toBe(0);
  });

  it("sums cost_cents on completed rows", async () => {
    await insertRender({ id: "r1", status: "done", cost_cents: 10 });
    await insertRender({ id: "r2", status: "done", cost_cents: 15 });
    const s = await getSessionSpendCents(STORY_ID, USER_ID, SESSION_START);
    expect(s.completedCents).toBe(25);
    expect(s.pendingCount).toBe(0);
  });

  it("counts queued + generating rows separately as pending", async () => {
    await insertRender({ id: "r1", status: "queued", cost_cents: null });
    await insertRender({ id: "r2", status: "generating", cost_cents: null });
    const s = await getSessionSpendCents(STORY_ID, USER_ID, SESSION_START);
    expect(s.completedCents).toBe(0);
    expect(s.pendingCount).toBe(2);
    // total = 0 + 2 * estimate. Estimate is whatever the active image
    // model's per-image rate is. Just assert it's non-zero so the cap
    // accounting is real.
    expect(s.totalCents).toBeGreaterThan(0);
  });

  it("excludes other users' rows", async () => {
    await insertRender({
      id: "mine",
      status: "done",
      cost_cents: 50,
      requested_by: USER_ID,
    });
    await insertRender({
      id: "theirs",
      status: "done",
      cost_cents: 100,
      requested_by: "another-admin",
    });
    const s = await getSessionSpendCents(STORY_ID, USER_ID, SESSION_START);
    expect(s.completedCents).toBe(50);
  });

  it("excludes other stories' rows", async () => {
    await insertRender({
      id: "thisstory",
      status: "done",
      cost_cents: 50,
      owner_id: STORY_ID,
    });
    await insertRender({
      id: "otherstory",
      status: "done",
      cost_cents: 100,
      owner_id: "another-story",
    });
    const s = await getSessionSpendCents(STORY_ID, USER_ID, SESSION_START);
    expect(s.completedCents).toBe(50);
  });

  it("excludes non-frame assets (scene/prop/hero etc.)", async () => {
    await insertRender({
      id: "frame",
      status: "done",
      cost_cents: 50,
      asset: "frame:f1",
    });
    await insertRender({
      id: "scene",
      status: "done",
      cost_cents: 100,
      asset: "scene:0",
    });
    await insertRender({
      id: "hero",
      status: "done",
      cost_cents: 200,
      asset: "hero",
    });
    const s = await getSessionSpendCents(STORY_ID, USER_ID, SESSION_START);
    expect(s.completedCents).toBe(50);
  });

  it("excludes rows before session start", async () => {
    await insertRender({
      id: "old",
      status: "done",
      cost_cents: 50,
      requested_at: "2026-06-12T09:00:00.000Z", // before session start
    });
    await insertRender({
      id: "new",
      status: "done",
      cost_cents: 25,
      requested_at: "2026-06-12T11:00:00.000Z",
    });
    const s = await getSessionSpendCents(STORY_ID, USER_ID, SESSION_START);
    expect(s.completedCents).toBe(25);
  });
});

// ─── canQueueFrameRegenForSession ────────────────────────────────────────────

describe("canQueueFrameRegenForSession", () => {
  beforeEach(async () => {
    await clearImageRenders();
    await setSetting(FRAME_REGEN_SESSION_CAP_SETTING_KEY, "500");
  });

  it("accepts when there's plenty of headroom", async () => {
    const r = await canQueueFrameRegenForSession({
      storyId: STORY_ID,
      userId: USER_ID,
      sessionStartedAt: SESSION_START,
    });
    expect(r.ok).toBe(true);
    expect(r.capCents).toBe(500);
    expect(r.spentCents).toBe(0);
  });

  it("rejects when adding the estimate would breach the cap", async () => {
    // Burn down the budget to cap - 1 cent.
    await setSetting(FRAME_REGEN_SESSION_CAP_SETTING_KEY, "10");
    await insertRender({ id: "r1", status: "done", cost_cents: 9 });
    const r = await canQueueFrameRegenForSession({
      storyId: STORY_ID,
      userId: USER_ID,
      sessionStartedAt: SESSION_START,
    });
    expect(r.ok).toBe(false);
    expect(r.spentCents).toBe(9);
    expect(r.capCents).toBe(10);
    expect(r.estimateCents).toBeGreaterThan(0);
  });

  it("accepts when the running total exactly equals the cap (boundary)", async () => {
    // Pick numbers where completed + estimate is exactly the cap.
    // The cap check is total + estimate <= cap, so 0 spent + estimate <=
    // estimate (cap) is allowed.
    const estimate = (
      await canQueueFrameRegenForSession({
        storyId: STORY_ID,
        userId: USER_ID,
        sessionStartedAt: SESSION_START,
      })
    ).estimateCents;
    await setSetting(FRAME_REGEN_SESSION_CAP_SETTING_KEY, String(estimate));
    const r = await canQueueFrameRegenForSession({
      storyId: STORY_ID,
      userId: USER_ID,
      sessionStartedAt: SESSION_START,
    });
    expect(r.ok).toBe(true);
    expect(r.spentCents + r.estimateCents).toBe(r.capCents);
  });
});
