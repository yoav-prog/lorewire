// Tests for the render-scheduler auto-publish lane: the toggle gate, the
// strict render-scheduler-only candidate scope (never a human or autopilot
// review story), the publish path, and the lane's OWN circuit breaker (which
// flips render.auto_publish off, not autopilot.mode).
//
// publishStoryIfReady, the LLM judge, and the alert email are mocked;
// everything else runs against the real store.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { all, run } from "@/lib/db";

vi.mock("@/lib/auto-publish", () => ({
  publishStoryIfReady: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  chatCompletion: vi.fn(),
}));
vi.mock("@/lib/email", () => ({
  sendBrevoEmail: vi.fn(async () => ({ ok: true, messageId: "m" })),
}));

import { publishStoryIfReady } from "@/lib/auto-publish";
import { chatCompletion } from "@/lib/llm";
import { sendBrevoEmail } from "@/lib/email";
import { AUTOPILOT_DEFAULTS, AUTOPILOT_SETTING_KEYS, getAutopilotMode } from "@/lib/autopilot";
import {
  RENDER_SCHEDULER_REQUESTED_BY,
  RENDER_SETTING_KEYS,
  getRenderAutoPublish,
} from "@/lib/render-scheduler";
import {
  RENDER_AUTOPUBLISH_SETTING_KEYS,
  getRenderAutoPublishStatus,
  runRenderSchedulerAutoPublish,
} from "./render-auto-publish";

const NOW = Date.UTC(2026, 6, 12, 12, 0);
const NOW_ISO = new Date(NOW).toISOString();

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
  vi.mocked(sendBrevoEmail).mockClear();
}

async function setSetting(key: string, value: string) {
  await run(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

async function insertSource(reddit_id: string) {
  await run(
    "INSERT INTO reddit_source (reddit_id, status, strength, comments, date_written, full_pipeline) " +
      "VALUES (?, 'imported', 'strong', 10, '2026-06-01T00:00:00+00:00', 0)",
    [reddit_id],
  );
}

async function insertReviewStory(id: string, redditId: string | null) {
  await run(
    "INSERT INTO stories (id, reddit_id, title, body, status, created_at, updated_at) " +
      "VALUES (?, ?, 'T', ?, 'review', ?, ?)",
    [id, redditId, STORY_BODY, NOW_ISO, NOW_ISO],
  );
}

async function insertJob(id: string, storyId: string, requestedBy: string, redditId: string) {
  await run(
    "INSERT INTO story_jobs (id, reddit_id, status, story_id, requested_by, requested_at) " +
      "VALUES (?, ?, 'done', ?, ?, ?)",
    [id, redditId, storyId, requestedBy, NOW_ISO],
  );
}

// A render-scheduler story fully wired for the approve path.
async function seedDripCandidate(n: number) {
  await insertSource(`r-${n}`);
  await insertReviewStory(`story-${n}`, `r-${n}`);
  await insertJob(`job-${n}`, `story-${n}`, RENDER_SCHEDULER_REQUESTED_BY, `r-${n}`);
}

function judgeSays(decision: "publish" | "hold", confidence = 0.95) {
  vi.mocked(chatCompletion).mockResolvedValue({
    ok: true,
    content: JSON.stringify({ decision, category: "clean", reason: "r", confidence }),
  } as Awaited<ReturnType<typeof chatCompletion>>);
}

function publishSucceeds() {
  vi.mocked(publishStoryIfReady).mockImplementation(async (redditId: string) => ({
    ok: true,
    storyId: `story-for-${redditId}`,
  }));
}

describe("getRenderAutoPublish", () => {
  beforeEach(clear);

  it("defaults off; only 1/true turn it on", async () => {
    expect(await getRenderAutoPublish()).toBe(false);
    await setSetting(RENDER_SETTING_KEYS.autoPublish, "1");
    expect(await getRenderAutoPublish()).toBe(true);
    await setSetting(RENDER_SETTING_KEYS.autoPublish, "banana");
    expect(await getRenderAutoPublish()).toBe(false);
  });
});

describe("runRenderSchedulerAutoPublish", () => {
  beforeEach(clear);

  it("does nothing while the toggle is off", async () => {
    await seedDripCandidate(1);
    judgeSays("publish");
    publishSucceeds();
    const r = await runRenderSchedulerAutoPublish(NOW);
    expect(r.reason).toBe("disabled");
    expect(vi.mocked(publishStoryIfReady)).not.toHaveBeenCalled();
  });

  it("reports no_candidates when on but nothing render-scheduler waits", async () => {
    await setSetting(RENDER_SETTING_KEYS.autoPublish, "1");
    const r = await runRenderSchedulerAutoPublish(NOW);
    expect(r.reason).toBe("no_candidates");
  });

  it("publishes a render-scheduler story but never a human or autopilot one", async () => {
    await setSetting(RENDER_SETTING_KEYS.autoPublish, "1");
    // The drip story — eligible.
    await seedDripCandidate(1);
    // A human review story — no job at all.
    await insertReviewStory("human-1", null);
    // An autopilot story — wrong requested_by.
    await insertSource("r-auto");
    await insertReviewStory("auto-1", "r-auto");
    await insertJob("job-auto", "auto-1", "autopilot", "r-auto");

    judgeSays("publish");
    publishSucceeds();
    const r = await runRenderSchedulerAutoPublish(NOW);

    expect(r.reason).toBe("ok");
    expect(r.approved).toBe(1);
    // Only the drip story went through the gate.
    expect(vi.mocked(publishStoryIfReady)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(publishStoryIfReady)).toHaveBeenCalledWith("r-1");
    // Only the drip story got a decision row, tagged as the render lane.
    const decisions = await all<{ story_id: string; decision: string; decided_by: string }>(
      "SELECT story_id, decision, decided_by FROM scheduler_decisions",
      [],
    );
    expect(decisions).toEqual([
      { story_id: "story-1", decision: "auto_approved", decided_by: RENDER_SCHEDULER_REQUESTED_BY },
    ]);
  });

  it("holds an unsafe drip story and keeps it out of the next tick", async () => {
    await setSetting(RENDER_SETTING_KEYS.autoPublish, "1");
    await seedDripCandidate(1);
    judgeSays("hold");

    const first = await runRenderSchedulerAutoPublish(NOW);
    expect(first.held).toBe(1);
    expect(vi.mocked(publishStoryIfReady)).not.toHaveBeenCalled();

    const second = await runRenderSchedulerAutoPublish(NOW);
    expect(second.reason).toBe("no_candidates");
  });

  it("its OWN breaker trips render.auto_publish off, not autopilot, and alerts", async () => {
    await setSetting(RENDER_SETTING_KEYS.autoPublish, "1");
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "autonomous"); // must be untouched
    await setSetting(AUTOPILOT_SETTING_KEYS.alertEmail, "admin@example.com");
    for (let n = 1; n <= AUTOPILOT_DEFAULTS.breakerThreshold; n++) await seedDripCandidate(n);
    judgeSays("publish");
    vi.mocked(publishStoryIfReady).mockRejectedValue(new Error("db connection lost"));

    const r = await runRenderSchedulerAutoPublish(NOW);

    expect(r.failed).toBe(AUTOPILOT_DEFAULTS.breakerThreshold);
    expect(r.tripped).toBe(true);
    // The render lane switched itself off.
    expect(await getRenderAutoPublish()).toBe(false);
    // Autopilot is entirely untouched.
    expect(await getAutopilotMode()).toBe("autonomous");
    // One alert, to the shared owner mailbox.
    expect(vi.mocked(sendBrevoEmail)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendBrevoEmail).mock.calls[0][0].to).toBe("admin@example.com");
    // The trip is visible to the admin banner.
    const status = await getRenderAutoPublishStatus();
    expect(status.enabled).toBe(false);
    expect(status.trippedAt).not.toBeNull();
  });

  it("a gate refusal defers without feeding the render breaker", async () => {
    await setSetting(RENDER_SETTING_KEYS.autoPublish, "1");
    await seedDripCandidate(1);
    judgeSays("publish");
    vi.mocked(publishStoryIfReady).mockResolvedValue({
      ok: false,
      reason: "not_ready",
      missing: ["thumbnail_image"],
    });

    const r = await runRenderSchedulerAutoPublish(NOW);
    expect(r.deferred).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.tripped).toBe(false);
    expect(await getRenderAutoPublish()).toBe(true); // still on
    const failures = await all<{ value: string }>(
      "SELECT value FROM settings WHERE key = ?",
      [RENDER_AUTOPUBLISH_SETTING_KEYS.consecutiveFailures],
    );
    expect(failures).toEqual([]); // never written — refusals bypass the breaker
  });
});
