// Tests for the safety judge's two generations behind the mode flag: the
// legacy path (gpt-5-nano + the >=0.7 confidence gate) stays byte-for-byte
// unchanged, v2 (gpt-5.4-mini) drops the gate and trusts the decision, shadow
// runs both without changing the verdict, and the degenerate + fail-closed
// guards hold regardless of mode.
//
// chatCompletion is mocked; the settings store is the real one, like the other
// scheduler tests.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "@/lib/db";

vi.mock("@/lib/llm", () => ({
  chatCompletion: vi.fn(),
}));

import { chatCompletion } from "@/lib/llm";
import {
  SAFETY_JUDGE_SETTING_KEYS,
  getSafetyJudgeMode,
  runJudgeVersion,
  screenStoryForAutopilot,
} from "./story-safety-judge";

const LEGACY_MODEL = "openai/gpt-5-nano";
const V2_MODEL = "openai/gpt-5.4-mini";

const STORY = {
  id: "s1",
  title: "AITA for eating my roommate's leftovers",
  body: `<p>${"My roommate labelled the food and I ate it anyway, then we had a screaming fight about it. ".repeat(6).trim()}</p>`,
};

type Verdict = {
  decision: "publish" | "hold";
  category: string;
  reason: string;
  confidence: number;
};

async function clear() {
  await run("DELETE FROM settings", []);
  vi.mocked(chatCompletion).mockReset();
}

async function setSetting(key: string, value: string) {
  await run(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

// Return a verdict chosen by which model the call used, so shadow (two calls)
// can give legacy and v2 different answers in one test.
function judgeByModel(byModel: Record<string, Verdict>) {
  vi.mocked(chatCompletion).mockImplementation((async (opts: { modelId: string }) => ({
    ok: true,
    content: JSON.stringify(byModel[opts.modelId]),
  })) as unknown as typeof chatCompletion);
}

function judgeAlways(v: Verdict) {
  vi.mocked(chatCompletion).mockResolvedValue({
    ok: true,
    content: JSON.stringify(v),
  } as Awaited<ReturnType<typeof chatCompletion>>);
}

describe("getSafetyJudgeMode", () => {
  beforeEach(clear);

  it("defaults to legacy; parses shadow/active; unknown reads as legacy", async () => {
    expect(await getSafetyJudgeMode()).toBe("legacy");
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "shadow");
    expect(await getSafetyJudgeMode()).toBe("shadow");
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "active");
    expect(await getSafetyJudgeMode()).toBe("active");
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "banana");
    expect(await getSafetyJudgeMode()).toBe("legacy");
  });
});

describe("screenStoryForAutopilot — legacy mode (default, unchanged behavior)", () => {
  beforeEach(clear);

  it("uses gpt-5-nano and applies the >=0.7 confidence gate", async () => {
    judgeAlways({ decision: "publish", category: "clean", reason: "ok", confidence: 0.6 });

    const r = await screenStoryForAutopilot(STORY);

    // publish @ 0.6 is BELOW the legacy gate -> held, exactly as before.
    expect(r.safe).toBe(false);
    expect(vi.mocked(chatCompletion)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chatCompletion).mock.calls[0][0].modelId).toBe(LEGACY_MODEL);
  });

  it("publishes when the legacy gate is cleared", async () => {
    judgeAlways({ decision: "publish", category: "clean", reason: "ok", confidence: 0.9 });
    expect((await screenStoryForAutopilot(STORY)).safe).toBe(true);
  });
});

describe("screenStoryForAutopilot — active mode (v2)", () => {
  beforeEach(clear);

  it("uses gpt-5.4-mini and drops the confidence gate", async () => {
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "active");
    // A hedged publish @ 0.5 would be held by legacy; v2 trusts the decision.
    judgeAlways({ decision: "publish", category: "clean", reason: "ordinary drama", confidence: 0.5 });

    const r = await screenStoryForAutopilot(STORY);

    expect(r.safe).toBe(true);
    expect(vi.mocked(chatCompletion)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chatCompletion).mock.calls[0][0].modelId).toBe(V2_MODEL);
  });

  it("still holds when v2 says hold", async () => {
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "active");
    judgeAlways({ decision: "hold", category: "real_person", reason: "named + damaging claim", confidence: 0.9 });

    const r = await screenStoryForAutopilot(STORY);
    expect(r.safe).toBe(false);
    expect(r.category).toBe("real_person");
  });

  it("fails closed on a judge outage", async () => {
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "active");
    vi.mocked(chatCompletion).mockResolvedValue({
      ok: false,
      error: "network down",
    } as Awaited<ReturnType<typeof chatCompletion>>);

    const r = await screenStoryForAutopilot(STORY);
    expect(r.safe).toBe(false);
    expect(r.category).toBe("judge_unavailable");
  });
});

describe("screenStoryForAutopilot — shadow mode", () => {
  beforeEach(clear);

  it("runs both judges but returns the legacy verdict", async () => {
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "shadow");
    // Legacy holds (low confidence); v2 would publish. Shadow must return the
    // legacy (authoritative) result and leave behavior unchanged.
    judgeByModel({
      [LEGACY_MODEL]: { decision: "publish", category: "clean", reason: "ok", confidence: 0.6 },
      [V2_MODEL]: { decision: "publish", category: "clean", reason: "ordinary drama", confidence: 0.5 },
    });

    const r = await screenStoryForAutopilot(STORY);

    expect(r.safe).toBe(false); // legacy authoritative -> held
    expect(vi.mocked(chatCompletion)).toHaveBeenCalledTimes(2); // both ran
    const models = vi.mocked(chatCompletion).mock.calls.map((c) => c[0].modelId);
    expect(models).toContain(LEGACY_MODEL);
    expect(models).toContain(V2_MODEL);
  });
});

describe("degenerate guard holds in every mode without a judge call", () => {
  beforeEach(clear);

  it("active mode: a too-short body is held deterministically", async () => {
    await setSetting(SAFETY_JUDGE_SETTING_KEYS.mode, "active");
    judgeAlways({ decision: "publish", category: "clean", reason: "ok", confidence: 0.9 });

    const r = await screenStoryForAutopilot({ id: "d", title: "T", body: "<p>too short</p>" });

    expect(r.safe).toBe(false);
    expect(r.category).toBe("not_a_story");
    expect(vi.mocked(chatCompletion)).not.toHaveBeenCalled();
  });
});

describe("runJudgeVersion", () => {
  beforeEach(clear);

  it("v2 publishes a low-confidence publish (no gate)", async () => {
    judgeAlways({ decision: "publish", category: "clean", reason: "ok", confidence: 0.4 });
    const r = await runJudgeVersion("v2", STORY);
    expect(r.safe).toBe(true);
    expect(vi.mocked(chatCompletion).mock.calls[0][0].modelId).toBe(V2_MODEL);
  });

  it("legacy holds the same low-confidence publish (gate applies)", async () => {
    judgeAlways({ decision: "publish", category: "clean", reason: "ok", confidence: 0.4 });
    const r = await runJudgeVersion("legacy", STORY);
    expect(r.safe).toBe(false);
    expect(vi.mocked(chatCompletion).mock.calls[0][0].modelId).toBe(LEGACY_MODEL);
  });
});
