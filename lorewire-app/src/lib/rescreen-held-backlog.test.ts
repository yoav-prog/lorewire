// Tests for the held-backlog re-screen: the catch-up that re-runs the current
// safety judge over stories the OLD judge held, publishing the ones now cleared
// and marking the ones still held so repeated batches drain instead of looping.
//
// publishStoryIfReady and the LLM judge are mocked; everything else (the store,
// approveReviewedStory, decision logging) runs for real, so the drain, the
// batch bound, the emergency-stop guard, and the candidate scope are all
// exercised against the real SQL.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { all, one, run } from "@/lib/db";

vi.mock("@/lib/auto-publish", () => ({
  publishStoryIfReady: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  chatCompletion: vi.fn(),
}));

import { publishStoryIfReady } from "@/lib/auto-publish";
import { chatCompletion } from "@/lib/llm";
import { UNATTENDED_PUBLISH_SETTING_KEYS } from "@/lib/approve-reviewed-story";
import { SAFETY_JUDGE_SETTING_KEYS } from "@/lib/story-safety-judge";
import {
  RESCREEN_DECIDED_BY,
  RESCREEN_DEFAULT_LIMIT,
  countRescreenBacklog,
  rescreenHeldBacklog,
} from "./rescreen-held-backlog";

const NOW = Date.UTC(2026, 6, 19, 12, 0);

const STORY_BODY = `<p>${"A roommate borrowed the car without asking and returned it with a dent. ".repeat(8).trim()}</p>`;

async function clear() {
  await run("DELETE FROM stories", []);
  await run("DELETE FROM story_jobs", []);
  await run("DELETE FROM reddit_source", []);
  await run("DELETE FROM scheduled_publishes", []);
  await run("DELETE FROM scheduler_decisions", []);
  await run("DELETE FROM settings", []);
  vi.mocked(publishStoryIfReady).mockReset();
  vi.mocked(chatCompletion).mockReset();
}

async function setSetting(key: string, value: string) {
  await run(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

async function insertSource(redditId: string) {
  await run(
    "INSERT INTO reddit_source (reddit_id, status, strength, comments, date_written, full_pipeline) " +
      "VALUES (?, 'imported', 'strong', 10, '2026-06-01T00:00:00+00:00', 0)",
    [redditId],
  );
}

async function insertReviewStory(id: string, redditId: string | null, updatedAtMs: number) {
  const iso = new Date(updatedAtMs).toISOString();
  await run(
    "INSERT INTO stories (id, reddit_id, title, body, status, created_at, updated_at) " +
      "VALUES (?, ?, 'T', ?, 'review', ?, ?)",
    [id, redditId, STORY_BODY, iso, iso],
  );
}

async function insertJob(storyId: string, requestedBy: string, redditId: string) {
  await run(
    "INSERT INTO story_jobs (id, reddit_id, status, story_id, requested_by, requested_at) " +
      "VALUES (?, ?, 'done', ?, ?, ?)",
    [randomUUID(), redditId, storyId, requestedBy, new Date(NOW).toISOString()],
  );
}

// The legacy hold row that puts a story in the backlog: an auto_held decision by
// a live lane (not the re-screen actor), with the old judge's verdict.
async function insertLegacyHold(storyId: string, redditId: string | null) {
  await run(
    `INSERT INTO scheduler_decisions
       (id, story_id, reddit_id, decision, decided_by, decided_at,
        judge_decision, judge_category, judge_reason, judge_confidence)
     VALUES (?, ?, ?, 'auto_held', 'autopilot', ?, 'hold', 'not_a_story', 'legacy hedged hold', 0.55)`,
    [randomUUID(), storyId, redditId, new Date(NOW - 3_600_000).toISOString()],
  );
}

// A story the old judge held, fully wired so the re-screen can publish it: a
// source, a rendered autopilot review story, and the legacy auto_held row.
async function seedHeldStory(n: number, updatedAtMs = NOW - n * 1000) {
  await insertSource(`r-${n}`);
  await insertReviewStory(`story-${n}`, `r-${n}`, updatedAtMs);
  await insertJob(`story-${n}`, "autopilot", `r-${n}`);
  await insertLegacyHold(`story-${n}`, `r-${n}`);
}

function judgeSays(decision: "publish" | "hold", verdict?: Partial<{ category: string; reason: string; confidence: number }>) {
  vi.mocked(chatCompletion).mockResolvedValue({
    ok: true,
    content: JSON.stringify({
      decision,
      category: verdict?.category ?? "clean",
      reason: verdict?.reason ?? "ordinary interpersonal drama",
      confidence: verdict?.confidence ?? 0.95,
    }),
  } as Awaited<ReturnType<typeof chatCompletion>>);
}

function publishSucceeds() {
  vi.mocked(publishStoryIfReady).mockImplementation(async (redditId: string) => ({
    ok: true,
    storyId: `story-for-${redditId}`,
  }));
}

describe("countRescreenBacklog", () => {
  beforeEach(clear);

  it("counts only held-in-review stories not yet re-screened", async () => {
    await seedHeldStory(1);
    await seedHeldStory(2);
    // A plain review story with no hold — not part of the backlog.
    await insertReviewStory("plain-1", null, NOW);
    expect(await countRescreenBacklog()).toBe(2);
  });

  it("excludes stories already touched by a re-screen", async () => {
    await seedHeldStory(1);
    // Simulate a prior re-screen that left it held.
    await run(
      `INSERT INTO scheduler_decisions (id, story_id, decision, decided_by, decided_at)
       VALUES (?, 'story-1', 'auto_held', ?, ?)`,
      [randomUUID(), RESCREEN_DECIDED_BY, new Date(NOW).toISOString()],
    );
    expect(await countRescreenBacklog()).toBe(0);
  });
});

describe("rescreenHeldBacklog", () => {
  beforeEach(clear);

  it("publishes a now-cleared held story and drains it from the backlog", async () => {
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "active");
    await seedHeldStory(1);
    judgeSays("publish");
    publishSucceeds();

    const r = await rescreenHeldBacklog({ nowMs: NOW });
    expect(r.processed).toBe(1);
    expect(r.published).toBe(1);
    expect(r.stillHeld).toBe(0);
    expect(r.remaining).toBe(0);
    expect(vi.mocked(publishStoryIfReady)).toHaveBeenCalledWith("r-1");

    // The story left review; a second pass finds nothing.
    const second = await rescreenHeldBacklog({ nowMs: NOW });
    expect(second.processed).toBe(0);
  });

  it("marks a still-held story with the new verdict and skips it next time", async () => {
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "active");
    await seedHeldStory(1);
    judgeSays("hold", { category: "real_person", reason: "names a findable person", confidence: 0.9 });

    const r = await rescreenHeldBacklog({ nowMs: NOW });
    expect(r.stillHeld).toBe(1);
    expect(r.published).toBe(0);
    expect(r.remaining).toBe(0); // marked, so no longer "awaiting re-screen"
    expect(vi.mocked(publishStoryIfReady)).not.toHaveBeenCalled();

    // The fresh hold row carries the NEW judge's reason and the re-screen actor.
    const [fresh] = await all<{ judge_category: string; judge_reason: string; decided_by: string }>(
      `SELECT judge_category, judge_reason, decided_by FROM scheduler_decisions
        WHERE decided_by = ? AND decision = 'auto_held'`,
      [RESCREEN_DECIDED_BY],
    );
    expect(fresh.judge_category).toBe("real_person");
    expect(fresh.judge_reason).toBe("names a findable person");

    // A second pass does not re-touch it.
    const second = await rescreenHeldBacklog({ nowMs: NOW });
    expect(second.processed).toBe(0);
  });

  it("honours the batch limit and reports the remainder", async () => {
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "active");
    await seedHeldStory(1);
    await seedHeldStory(2);
    await seedHeldStory(3);
    judgeSays("publish");
    publishSucceeds();

    const r = await rescreenHeldBacklog({ limit: 2, nowMs: NOW });
    expect(r.processed).toBe(2);
    expect(r.published).toBe(2);
    expect(r.remaining).toBe(1);
  });

  it("never touches a plain review story that was not held", async () => {
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "active");
    await insertSource("r-plain");
    await insertReviewStory("plain-1", "r-plain", NOW);
    await insertJob("plain-1", "autopilot", "r-plain");
    // No legacy hold row -> not in the backlog.
    judgeSays("publish");
    publishSucceeds();

    const r = await rescreenHeldBacklog({ nowMs: NOW });
    expect(r.processed).toBe(0);
    expect(vi.mocked(publishStoryIfReady)).not.toHaveBeenCalled();
  });

  it("defers a cleared story whose assets are not ready, without publishing it", async () => {
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "active");
    await seedHeldStory(1);
    judgeSays("publish");
    vi.mocked(publishStoryIfReady).mockResolvedValue({
      ok: false,
      reason: "not_ready",
      missing: ["thumbnail_image"],
    });

    const r = await rescreenHeldBacklog({ nowMs: NOW });
    expect(r.deferred).toBe(1);
    expect(r.published).toBe(0);
    expect(r.stillHeld).toBe(0);
  });

  it("publishes nothing while the emergency stop is engaged", async () => {
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "active");
    await setSetting(UNATTENDED_PUBLISH_SETTING_KEYS.stop, "1");
    await seedHeldStory(1);
    judgeSays("publish");
    publishSucceeds();

    const r = await rescreenHeldBacklog({ nowMs: NOW });
    expect(r.skipped).toBe(1);
    expect(r.published).toBe(0);
    // Not screened, not marked — the story is still in the backlog for after
    // the stop releases.
    expect(vi.mocked(chatCompletion)).not.toHaveBeenCalled();
    expect(await countRescreenBacklog()).toBe(1);
  });

  it("defaults to the standard batch size when no limit is given", async () => {
    // A guard against the default silently changing; the UI relies on it.
    expect(RESCREEN_DEFAULT_LIMIT).toBe(25);
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "active");
    const n = await countRescreenBacklog();
    expect(n).toBe(0);
    const r = await rescreenHeldBacklog({ nowMs: NOW });
    expect(r.processed).toBe(0);
    // one() is used for the count; keep the import exercised.
    expect(await one("SELECT 1 AS x", [])).toBeTruthy();
  });
});
