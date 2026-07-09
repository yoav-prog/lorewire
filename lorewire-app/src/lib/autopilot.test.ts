// Tests for Autopilot: the pull gates (mode, queue-empty, daily limit,
// headroom, min-strength selection, autonomous mode), the approve tick
// (safety hold, the human-approve path reuse, idempotent skip, the
// gate-refusal defer/hold ladder), the degenerate-story guard, and the
// circuit breaker.
// publishStoryIfReady, the LLM judge, and the alert email are mocked;
// everything else runs against the real store like the other scheduler
// tests.

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
import {
  AUTOPILOT_DEFAULTS,
  AUTOPILOT_REQUESTED_BY,
  AUTOPILOT_SETTING_KEYS,
  countAutopilotPullsToday,
  countHumanReviewDepth,
  detectDegenerateStory,
  getAutopilotDailyLimit,
  getAutopilotMinStrength,
  getAutopilotMode,
  runAutopilotApprove,
  runAutopilotPull,
  screenStoryForAutopilot,
} from "./autopilot";

const NOW = Date.UTC(2026, 6, 2, 12, 0);
const NOW_ISO = new Date(NOW).toISOString();

// Story-length body so fixtures clear the degenerate-generation guard
// (real LoreWire bodies are article-length; the guard holds anything
// under 250 stripped chars).
const STORY_BODY = `<p>${"A roommate borrowed the car without asking and returned it with a dent. ".repeat(8).trim()}</p>`;

async function clear() {
  await run("DELETE FROM stories", []);
  await run("DELETE FROM story_jobs", []);
  await run("DELETE FROM story_job_events", []);
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

async function insertSource(
  reddit_id: string,
  opts: { status?: string; strength?: string; comments?: number } = {},
) {
  await run(
    "INSERT INTO reddit_source (reddit_id, status, strength, comments, date_written, full_pipeline) " +
      "VALUES (?, ?, ?, ?, '2026-06-01T00:00:00+00:00', 0)",
    [reddit_id, opts.status ?? "imported", opts.strength ?? "strong", opts.comments ?? 10],
  );
}

async function insertReviewStory(
  id: string,
  opts: { redditId?: string | null; title?: string; body?: string } = {},
) {
  await run(
    "INSERT INTO stories (id, reddit_id, title, body, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 'review', ?, ?)",
    [id, opts.redditId ?? null, opts.title ?? "T", opts.body ?? STORY_BODY, NOW_ISO, NOW_ISO],
  );
}

async function insertJob(
  id: string,
  opts: { redditId?: string; storyId?: string | null; requestedBy?: string; requestedAt?: string } = {},
) {
  await run(
    "INSERT INTO story_jobs (id, reddit_id, status, story_id, requested_by, requested_at) " +
      "VALUES (?, ?, 'done', ?, ?, ?)",
    [
      id,
      opts.redditId ?? `r-${id}`,
      opts.storyId ?? null,
      opts.requestedBy ?? AUTOPILOT_REQUESTED_BY,
      opts.requestedAt ?? NOW_ISO,
    ],
  );
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

describe("setting readers", () => {
  beforeEach(clear);

  it("mode defaults off; parses autonomous; unknown values read as off", async () => {
    expect(await getAutopilotMode()).toBe("off");
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "shadow");
    expect(await getAutopilotMode()).toBe("shadow");
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "autonomous");
    expect(await getAutopilotMode()).toBe("autonomous");
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "banana");
    expect(await getAutopilotMode()).toBe("off");
  });

  it("daily limit defaults to 1 and rejects nonsense", async () => {
    expect(await getAutopilotDailyLimit()).toBe(AUTOPILOT_DEFAULTS.dailyLimit);
    await setSetting(AUTOPILOT_SETTING_KEYS.dailyLimit, "0");
    expect(await getAutopilotDailyLimit()).toBe(AUTOPILOT_DEFAULTS.dailyLimit);
    await setSetting(AUTOPILOT_SETTING_KEYS.dailyLimit, "5");
    expect(await getAutopilotDailyLimit()).toBe(5);
  });

  it("min_strength defaults to none (all); parses medium/strong; rejects nonsense", async () => {
    expect(await getAutopilotMinStrength()).toBe("none");
    await setSetting(AUTOPILOT_SETTING_KEYS.minStrength, "medium");
    expect(await getAutopilotMinStrength()).toBe("medium");
    await setSetting(AUTOPILOT_SETTING_KEYS.minStrength, "strong");
    expect(await getAutopilotMinStrength()).toBe("strong");
    await setSetting(AUTOPILOT_SETTING_KEYS.minStrength, "banana");
    expect(await getAutopilotMinStrength()).toBe("none");
  });
});

describe("countHumanReviewDepth", () => {
  beforeEach(clear);

  it("excludes autopilot-created stories from the human depth", async () => {
    await insertReviewStory("human-1");
    await insertReviewStory("auto-1");
    await insertJob("j1", { storyId: "auto-1" });
    expect(await countHumanReviewDepth()).toBe(1);
  });
});

describe("countAutopilotPullsToday", () => {
  beforeEach(clear);

  it("counts only autopilot jobs requested since UTC midnight", async () => {
    await insertJob("today", { requestedAt: new Date(NOW - 3_600_000).toISOString() });
    await insertJob("yesterday", {
      requestedAt: new Date(NOW - 36 * 3_600_000).toISOString(),
    });
    await insertJob("drip", {
      requestedBy: "render-scheduler",
      requestedAt: NOW_ISO,
    });
    expect(await countAutopilotPullsToday(NOW)).toBe(1);
  });
});

describe("runAutopilotPull", () => {
  beforeEach(clear);

  it("does nothing when off", async () => {
    await insertSource("s1");
    const r = await runAutopilotPull(NOW);
    expect(r.reason).toBe("off");
    expect(r.enqueued).toBe(0);
  });

  it("waits while a human review item exists", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "shadow");
    await insertReviewStory("human-1");
    await insertSource("s1");
    const r = await runAutopilotPull(NOW);
    expect(r.reason).toBe("queue_not_empty");
  });

  it("respects the daily limit", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "shadow");
    await insertJob("used", { requestedAt: NOW_ISO });
    await insertSource("s1");
    const r = await runAutopilotPull(NOW);
    expect(r.reason).toBe("daily_limit_reached");
  });

  it("respects review headroom, counting its own in-review items", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "shadow");
    await setSetting("render.review_queue_cap", "1");
    await setSetting(AUTOPILOT_SETTING_KEYS.dailyLimit, "5");
    await insertReviewStory("auto-1");
    await insertJob("j1", { storyId: "auto-1" });
    await insertSource("s1");
    const r = await runAutopilotPull(NOW);
    expect(r.reason).toBe("no_headroom");
  });

  it("honours a strong floor, pulling only strong sources, tagged as autopilot", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "live");
    await setSetting(AUTOPILOT_SETTING_KEYS.dailyLimit, "5");
    await setSetting(AUTOPILOT_SETTING_KEYS.minStrength, "strong");
    await insertSource("strong-1", { strength: "strong" });
    await insertSource("medium-1", { strength: "medium", comments: 9999 });
    const r = await runAutopilotPull(NOW);
    expect(r.reason).toBe("ok");
    expect(r.enqueued).toBe(1); // only one strong source exists
    const jobs = await all<{ reddit_id: string; requested_by: string }>(
      "SELECT reddit_id, requested_by FROM story_jobs",
      [],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].reddit_id).toBe("strong-1");
    expect(jobs[0].requested_by).toBe(AUTOPILOT_REQUESTED_BY);
  });

  it("reports no_candidates when nothing meets an explicit strong floor", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "shadow");
    await setSetting(AUTOPILOT_SETTING_KEYS.minStrength, "strong");
    await insertSource("medium-1", { strength: "medium" });
    const r = await runAutopilotPull(NOW);
    expect(r.reason).toBe("no_candidates");
  });

  it("default tier (none) pulls an unrated source that a strong floor would skip", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "shadow");
    await setSetting(AUTOPILOT_SETTING_KEYS.dailyLimit, "5");
    // No min_strength set -> default "none". An unrated source (the bulk of
    // a real pool) is now eligible; under the old "strong" default it was not.
    await insertSource("unrated-1", { strength: "none" });
    const r = await runAutopilotPull(NOW);
    expect(r.reason).toBe("ok");
    expect(r.enqueued).toBe(1);
  });

  it("min_strength widens the pool: medium is eligible when set to medium", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "live");
    await setSetting(AUTOPILOT_SETTING_KEYS.dailyLimit, "5");
    await setSetting(AUTOPILOT_SETTING_KEYS.minStrength, "medium");
    await insertSource("medium-1", { strength: "medium" });
    const r = await runAutopilotPull(NOW);
    expect(r.reason).toBe("ok");
    expect(r.enqueued).toBe(1);
    const jobs = await all<{ reddit_id: string }>(
      "SELECT reddit_id FROM story_jobs",
      [],
    );
    expect(jobs[0].reddit_id).toBe("medium-1");
  });

  it("autonomous pulls past a non-empty human review queue", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "autonomous");
    await setSetting(AUTOPILOT_SETTING_KEYS.dailyLimit, "5");
    // A manual (non-autopilot) story sits in review — this blocks shadow/live
    // with reason 'queue_not_empty' but must NOT block autonomous.
    await insertReviewStory("human-1");
    await insertSource("s1", { strength: "strong" });
    const r = await runAutopilotPull(NOW);
    expect(r.reason).toBe("ok");
    expect(r.enqueued).toBe(1);
  });

  it("autonomous headroom ignores a manual backlog over the cap", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "autonomous");
    await setSetting("render.review_queue_cap", "1");
    await setSetting(AUTOPILOT_SETTING_KEYS.dailyLimit, "5");
    // Two manual review items — total review (2) exceeds the cap (1), which
    // would trip 'no_headroom' in live. Autonomous scopes headroom to its
    // OWN footprint (zero here), so it still pulls.
    await insertReviewStory("human-1");
    await insertReviewStory("human-2");
    await insertSource("s1", { strength: "strong" });
    const r = await runAutopilotPull(NOW);
    expect(r.reason).toBe("ok");
    expect(r.enqueued).toBe(1);
  });

  it("autonomous still respects its OWN review cap (held/in-review footprint)", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "autonomous");
    await setSetting("render.review_queue_cap", "1");
    await setSetting(AUTOPILOT_SETTING_KEYS.dailyLimit, "5");
    // An autopilot-owned story already in review fills autopilot's own cap.
    await insertReviewStory("auto-1");
    await insertJob("j1", { storyId: "auto-1" });
    await insertSource("s1", { strength: "strong" });
    const r = await runAutopilotPull(NOW);
    expect(r.reason).toBe("no_headroom");
  });

  // The owner's exact ask (2026-07-08): fully hands-off, 10/day, all
  // sources, publishing past whatever sits in the manual review queue.
  it("owner scenario: autonomous + all tiers + 10/day pulls the whole pool past a manual backlog", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "autonomous");
    await setSetting(AUTOPILOT_SETTING_KEYS.dailyLimit, "10");
    await setSetting(AUTOPILOT_SETTING_KEYS.minStrength, "none"); // all tiers
    await insertReviewStory("human-backlog"); // would block live/shadow
    await insertSource("strong-1", { strength: "strong" });
    await insertSource("strong-2", { strength: "strong" });
    await insertSource("medium-1", { strength: "medium" });
    await insertSource("weak-1", { strength: "none" });
    const r = await runAutopilotPull(NOW);
    expect(r.reason).toBe("ok");
    expect(r.enqueued).toBe(4); // every eligible source, all tiers
    const jobs = await all<{ requested_by: string }>(
      "SELECT requested_by FROM story_jobs",
      [],
    );
    expect(jobs).toHaveLength(4);
    expect(jobs.every((j) => j.requested_by === AUTOPILOT_REQUESTED_BY)).toBe(true);
  });
});

describe("screenStoryForAutopilot", () => {
  beforeEach(clear);

  it("passes a confident publish verdict", async () => {
    judgeSays("publish", 0.9);
    const r = await screenStoryForAutopilot({ id: "s", title: "T", body: STORY_BODY });
    expect(r.safe).toBe(true);
  });

  it("holds on a hold verdict, low confidence, or judge outage", async () => {
    judgeSays("hold", 0.9);
    expect((await screenStoryForAutopilot({ id: "s", title: "T", body: STORY_BODY })).safe).toBe(false);
    judgeSays("publish", 0.4);
    expect((await screenStoryForAutopilot({ id: "s", title: "T", body: STORY_BODY })).safe).toBe(false);
    vi.mocked(chatCompletion).mockResolvedValue({
      ok: false,
      error: "down",
    } as Awaited<ReturnType<typeof chatCompletion>>);
    expect((await screenStoryForAutopilot({ id: "s", title: "T", body: STORY_BODY })).safe).toBe(false);
  });
});

describe("degenerate-story guard", () => {
  beforeEach(clear);

  it("detectDegenerateStory flags a too-short body and a NO STORY title", () => {
    // The 2026-07-09 production artifacts, verbatim shapes.
    expect(
      detectDegenerateStory({
        title: "NO STORY FOUND",
        body: "No story text was provided in the source, so there are no events, characters, outcomes, or quotes to retell.",
      }),
    ).toMatch(/too short/);
    expect(
      detectDegenerateStory({
        title: "NO STORY, ONLY INSTRUCTIONS",
        body: STORY_BODY, // long meta-body — the title is the tell
      }),
    ).toMatch(/no story/);
    expect(detectDegenerateStory({ title: null, body: null })).toMatch(/too short/);
    expect(detectDegenerateStory({ title: "T", body: STORY_BODY })).toBeNull();
  });

  it("screens a degenerate story as unsafe without spending a judge call", async () => {
    const r = await screenStoryForAutopilot({
      id: "s",
      title: "NO STORY FOUND",
      body: "No story text was provided.",
    });
    expect(r.safe).toBe(false);
    expect(r.category).toBe("not_a_story");
    expect(vi.mocked(chatCompletion)).not.toHaveBeenCalled();
  });

  it("approve tick holds a degenerate story: no publish, no judge, out of future ticks", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "autonomous");
    await insertSource("r-1", { strength: "strong" });
    await insertReviewStory("story-1", {
      redditId: "r-1",
      title: "NO STORY FOUND",
      body: "No story text was provided.",
    });
    await insertJob("job-1", { redditId: "r-1", storyId: "story-1" });
    const first = await runAutopilotApprove(NOW);
    expect(first.held).toBe(1);
    expect(vi.mocked(publishStoryIfReady)).not.toHaveBeenCalled();
    expect(vi.mocked(chatCompletion)).not.toHaveBeenCalled();
    const second = await runAutopilotApprove(NOW);
    expect(second.reason).toBe("no_candidates");
  });
});

describe("runAutopilotApprove", () => {
  beforeEach(clear);

  async function seedCandidate(n: number) {
    await insertSource(`r-${n}`, { strength: "strong" });
    await insertReviewStory(`story-${n}`, { redditId: `r-${n}` });
    await insertJob(`job-${n}`, { redditId: `r-${n}`, storyId: `story-${n}` });
  }

  it("does nothing in shadow/off mode", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "shadow");
    await seedCandidate(1);
    const r = await runAutopilotApprove(NOW);
    expect(r.reason).toBe("not_live");
    expect(vi.mocked(publishStoryIfReady)).not.toHaveBeenCalled();
  });

  it("publishes in autonomous mode too", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "autonomous");
    await seedCandidate(1);
    judgeSays("publish");
    publishSucceeds();
    const r = await runAutopilotApprove(NOW);
    expect(r.approved).toBe(1);
    expect(vi.mocked(publishStoryIfReady)).toHaveBeenCalledWith("r-1");
  });

  it("publishes a safe story through the human-approve path and logs it", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "live");
    await seedCandidate(1);
    judgeSays("publish");
    publishSucceeds();
    const r = await runAutopilotApprove(NOW);
    expect(r.approved).toBe(1);
    expect(vi.mocked(publishStoryIfReady)).toHaveBeenCalledWith("r-1");
    const decisions = await all<{ decision: string; decided_by: string }>(
      "SELECT decision, decided_by FROM scheduler_decisions WHERE story_id = 'story-1'",
      [],
    );
    expect(decisions).toEqual([
      { decision: "auto_approved", decided_by: AUTOPILOT_REQUESTED_BY },
    ]);
  });

  it("holds an unsafe story for a human and never retries it", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "live");
    await seedCandidate(1);
    judgeSays("hold");
    const first = await runAutopilotApprove(NOW);
    expect(first.held).toBe(1);
    expect(vi.mocked(publishStoryIfReady)).not.toHaveBeenCalled();
    const story = await all<{ status: string }>(
      "SELECT status FROM stories WHERE id = 'story-1'",
      [],
    );
    expect(story[0].status).toBe("review");
    // The auto_held decision keeps it out of the next tick entirely.
    const second = await runAutopilotApprove(NOW);
    expect(second.reason).toBe("no_candidates");
  });

  it("counts an already-published race as skipped, not failed", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "live");
    await seedCandidate(1);
    judgeSays("publish");
    vi.mocked(publishStoryIfReady).mockResolvedValue({
      ok: false,
      reason: "not_ready",
      missing: ["already_published"],
    });
    const r = await runAutopilotApprove(NOW);
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(0);
  });

  it("defers a gate refusal without touching the breaker; the next tick retries it", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "autonomous");
    await setSetting(AUTOPILOT_SETTING_KEYS.alertEmail, "admin@example.com");
    await seedCandidate(1);
    judgeSays("publish");
    vi.mocked(publishStoryIfReady).mockResolvedValue({
      ok: false,
      reason: "not_ready",
      missing: ["thumbnail_image"],
    });
    const r = await runAutopilotApprove(NOW);
    expect(r.deferred).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.tripped).toBe(false);
    expect(await getAutopilotMode()).toBe("autonomous");
    expect(vi.mocked(sendBrevoEmail)).not.toHaveBeenCalled();
    const failures = await all<{ value: string }>(
      "SELECT value FROM settings WHERE key = ?",
      [AUTOPILOT_SETTING_KEYS.consecutiveFailures],
    );
    expect(failures).toEqual([]); // never written — refusals bypass the breaker
    // Still a candidate: the next tick tries the gate again.
    const again = await runAutopilotApprove(NOW);
    expect(again.deferred).toBe(1);
  });

  it("holds a story for a human after the gate-refusal threshold, without tripping", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "autonomous");
    await seedCandidate(1);
    judgeSays("publish");
    vi.mocked(publishStoryIfReady).mockResolvedValue({
      ok: false,
      reason: "not_ready",
      missing: ["thumbnail_image"],
    });
    for (let tick = 1; tick < AUTOPILOT_DEFAULTS.gateRefusalHoldAfter; tick++) {
      const r = await runAutopilotApprove(NOW);
      expect(r.deferred).toBe(1);
      expect(r.held).toBe(0);
    }
    const final = await runAutopilotApprove(NOW);
    expect(final.held).toBe(1);
    expect(final.deferred).toBe(0);
    expect(final.tripped).toBe(false);
    expect(await getAutopilotMode()).toBe("autonomous");
    const decisions = await all<{ decision: string }>(
      "SELECT decision FROM scheduler_decisions WHERE story_id = 'story-1' ORDER BY decided_at",
      [],
    );
    expect(
      decisions.filter((d) => d.decision === "auto_gate_refused"),
    ).toHaveLength(AUTOPILOT_DEFAULTS.gateRefusalHoldAfter);
    expect(decisions.filter((d) => d.decision === "auto_held")).toHaveLength(1);
    // The hold removes it from every future tick.
    const after = await runAutopilotApprove(NOW);
    expect(after.reason).toBe("no_candidates");
  });

  it("trips the breaker after consecutive publish EXCEPTIONS: mode off + alert email", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "live");
    await setSetting(AUTOPILOT_SETTING_KEYS.alertEmail, "admin@example.com");
    for (let n = 1; n <= 3; n++) await seedCandidate(n);
    judgeSays("publish");
    vi.mocked(publishStoryIfReady).mockRejectedValue(new Error("db connection lost"));
    const r = await runAutopilotApprove(NOW);
    expect(r.failed).toBe(AUTOPILOT_DEFAULTS.breakerThreshold);
    expect(r.tripped).toBe(true);
    expect(await getAutopilotMode()).toBe("off");
    expect(vi.mocked(sendBrevoEmail)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendBrevoEmail).mock.calls[0][0].to).toBe("admin@example.com");
  });

  it("a success resets the failure streak", async () => {
    await setSetting(AUTOPILOT_SETTING_KEYS.mode, "live");
    await setSetting(AUTOPILOT_SETTING_KEYS.consecutiveFailures, "2");
    await seedCandidate(1);
    judgeSays("publish");
    publishSucceeds();
    await runAutopilotApprove(NOW);
    const raw = await all<{ value: string }>(
      "SELECT value FROM settings WHERE key = ?",
      [AUTOPILOT_SETTING_KEYS.consecutiveFailures],
    );
    expect(raw[0].value).toBe("0");
  });
});
