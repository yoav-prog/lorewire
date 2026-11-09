// Tests for the shared per-story approve step used by every unattended-
// publish lane (autopilot + render-scheduler auto-publish): safety hold, the
// publish path + decision log, the already-published skip, the gate-refusal
// defer->hold ladder, and the injected-breaker exception path.
//
// publishStoryIfReady and the LLM judge are mocked; the breaker is a spy so a
// test can assert exactly when it fires. Everything else runs against the real
// store like the other scheduler tests.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { all, run } from "@/lib/db";

vi.mock("@/lib/auto-publish", () => ({
  publishStoryIfReady: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  chatCompletion: vi.fn(),
}));

import { publishStoryIfReady } from "@/lib/auto-publish";
import { chatCompletion } from "@/lib/llm";
import {
  approveReviewedStory,
  countGateRefusals,
  type ApproveBreaker,
  type ApproveCandidate,
} from "./approve-reviewed-story";

const NOW = Date.UTC(2026, 6, 12, 12, 0);

// Article-length body so fixtures clear the degenerate-generation guard.
const STORY_BODY = `<p>${"A roommate borrowed the car without asking and returned it with a dent. ".repeat(8).trim()}</p>`;

async function clear() {
  await run("DELETE FROM stories", []);
  await run("DELETE FROM reddit_source", []);
  await run("DELETE FROM scheduled_publishes", []);
  await run("DELETE FROM scheduler_decisions", []);
  await run("DELETE FROM settings", []);
  vi.mocked(publishStoryIfReady).mockReset();
  vi.mocked(chatCompletion).mockReset();
}

async function insertSource(reddit_id: string) {
  await run(
    "INSERT INTO reddit_source (reddit_id, status, strength, comments, date_written, full_pipeline) " +
      "VALUES (?, 'imported', 'strong', 10, '2026-06-01T00:00:00+00:00', 0)",
    [reddit_id],
  );
}

function candidate(overrides: Partial<ApproveCandidate> = {}): ApproveCandidate {
  return {
    id: "story-1",
    reddit_id: "r-1",
    title: "T",
    body: STORY_BODY,
    ...overrides,
  };
}

function judgeSays(decision: "publish" | "hold", confidence = 0.95) {
  vi.mocked(chatCompletion).mockResolvedValue({
    ok: true,
    content: JSON.stringify({ decision, category: "clean", reason: "r", confidence }),
  } as Awaited<ReturnType<typeof chatCompletion>>);
}

function spyBreaker(tripsOnFailure = false): ApproveBreaker & {
  recordFailure: ReturnType<typeof vi.fn>;
  resetFailures: ReturnType<typeof vi.fn>;
} {
  return {
    recordFailure: vi.fn(async () => tripsOnFailure),
    resetFailures: vi.fn(async () => {}),
  };
}

function opts(breaker: ApproveBreaker, gateRefusalHoldAfter = 2) {
  return {
    decidedBy: "test-lane",
    gateRefusalHoldAfter,
    breaker,
    logLabel: "test-lane",
    nowMs: NOW,
  };
}

describe("approveReviewedStory", () => {
  beforeEach(clear);

  it("publishes a safe, ready story: approved, breaker reset, decision logged", async () => {
    await insertSource("r-1");
    judgeSays("publish");
    vi.mocked(publishStoryIfReady).mockResolvedValue({ ok: true, storyId: "story-1" });
    const breaker = spyBreaker();

    const r = await approveReviewedStory(candidate(), opts(breaker));

    expect(r.outcome).toBe("approved");
    expect(r.tripped).toBe(false);
    expect(vi.mocked(publishStoryIfReady)).toHaveBeenCalledWith("r-1");
    expect(breaker.resetFailures).toHaveBeenCalledTimes(1);
    const decisions = await all<{ decision: string; decided_by: string }>(
      "SELECT decision, decided_by FROM scheduler_decisions WHERE story_id = 'story-1'",
      [],
    );
    expect(decisions).toEqual([{ decision: "auto_approved", decided_by: "test-lane" }]);
  });

  it("holds an unsafe story: no publish, auto_held logged", async () => {
    judgeSays("hold");
    const breaker = spyBreaker();

    const r = await approveReviewedStory(candidate(), opts(breaker));

    expect(r.outcome).toBe("held");
    expect(vi.mocked(publishStoryIfReady)).not.toHaveBeenCalled();
    const decisions = await all<{ decision: string }>(
      "SELECT decision FROM scheduler_decisions WHERE story_id = 'story-1'",
      [],
    );
    expect(decisions).toEqual([{ decision: "auto_held" }]);
  });

  it("holds a story with no source link rather than failing forever", async () => {
    judgeSays("publish");
    const breaker = spyBreaker();

    const r = await approveReviewedStory(candidate({ reddit_id: null }), opts(breaker));

    expect(r.outcome).toBe("held");
    expect(vi.mocked(publishStoryIfReady)).not.toHaveBeenCalled();
  });

  it("counts an already-published race as skipped, not failed", async () => {
    judgeSays("publish");
    vi.mocked(publishStoryIfReady).mockResolvedValue({
      ok: false,
      reason: "not_ready",
      missing: ["already_published"],
    });
    const breaker = spyBreaker();

    const r = await approveReviewedStory(candidate(), opts(breaker));

    expect(r.outcome).toBe("skipped");
    expect(breaker.recordFailure).not.toHaveBeenCalled();
  });

  it("defers then holds a gate refusal without ever touching the breaker", async () => {
    judgeSays("publish");
    vi.mocked(publishStoryIfReady).mockResolvedValue({
      ok: false,
      reason: "not_ready",
      missing: ["thumbnail_image"],
    });
    const breaker = spyBreaker();
    const o = opts(breaker, 2); // hold on the 2nd refusal

    const first = await approveReviewedStory(candidate(), o);
    expect(first.outcome).toBe("deferred");
    expect(await countGateRefusals("story-1")).toBe(1);

    const second = await approveReviewedStory(candidate(), o);
    expect(second.outcome).toBe("held");
    expect(breaker.recordFailure).not.toHaveBeenCalled();

    const decisions = await all<{ decision: string }>(
      "SELECT decision FROM scheduler_decisions WHERE story_id = 'story-1' ORDER BY decided_at",
      [],
    );
    expect(decisions.filter((d) => d.decision === "auto_gate_refused")).toHaveLength(2);
    expect(decisions.filter((d) => d.decision === "auto_held")).toHaveLength(1);
  });

  it("routes a thrown publish exception to the breaker and returns its trip verdict", async () => {
    judgeSays("publish");
    vi.mocked(publishStoryIfReady).mockRejectedValue(new Error("db connection lost"));
    const breaker = spyBreaker(true); // this failure trips

    const r = await approveReviewedStory(candidate(), opts(breaker));

    expect(r.outcome).toBe("failed");
    expect(r.tripped).toBe(true);
    expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
    expect(breaker.recordFailure.mock.calls[0][0]).toBe("story-1");
  });
});
