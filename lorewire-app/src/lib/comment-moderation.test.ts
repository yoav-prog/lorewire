// Coverage for the moderator's pure decision logic — the parts that must be
// right regardless of what the APIs return. The two findings the Step 0 eval
// surfaced live here: Tier 1 routes severe categories to quarantine (not a
// silent delete), and the judge's "hold" is derived from confidence in code,
// because the model won't volunteer it. Network calls (moderateText, the judge)
// are exercised by the eval harness, not these unit tests.

import { describe, expect, it } from "vitest";

import {
  judgeVerdict,
  tier1Verdict,
  type JudgeOutput,
} from "./comment-moderation";
import type { ModerationSignals } from "./openai-moderation";

function signals(over: Partial<ModerationSignals>): ModerationSignals {
  return {
    flagged: false,
    maxTox: 0,
    maxQuarantine: 0,
    topCategory: "hate",
    topScore: 0,
    ...over,
  };
}

function judge(over: Partial<JudgeOutput>): JudgeOutput {
  return {
    decision: "publish",
    category: "clean",
    reason: "fine",
    confidence: 0.9,
    stance: "neutral",
    sentiment: "neutral",
    topic_tag: "general",
    ...over,
  };
}

describe("tier1Verdict", () => {
  it("quarantines a severe category, never an ordinary reject", () => {
    const v = tier1Verdict(signals({ maxQuarantine: 0.9, topCategory: "sexual/minors", topScore: 0.9 }));
    expect(v?.status).toBe("quarantined");
    expect(v?.source).toBe("tier1");
  });

  it("rejects clear toxicity via the flagged signal", () => {
    const v = tier1Verdict(signals({ flagged: true, maxTox: 0.7, topCategory: "hate", topScore: 0.7 }));
    expect(v?.status).toBe("rejected");
  });

  it("rejects when max toxicity crosses the threshold even if not flagged", () => {
    const v = tier1Verdict(signals({ flagged: false, maxTox: 0.6, topScore: 0.6 }));
    expect(v?.status).toBe("rejected");
  });

  it("defers to the judge (null) when clean enough", () => {
    expect(tier1Verdict(signals({ flagged: false, maxTox: 0.1, maxQuarantine: 0.05 }))).toBeNull();
  });
});

describe("judgeVerdict", () => {
  it("publishes a confident clean verdict", () => {
    const v = judgeVerdict(judge({ decision: "publish", confidence: 0.95 }));
    expect(v.status).toBe("published");
    expect(v.source).toBe("tier2");
  });

  it("rejects a confident violation", () => {
    const v = judgeVerdict(judge({ decision: "reject", category: "spam", confidence: 0.9 }));
    expect(v.status).toBe("rejected");
  });

  it("routes a LOW-confidence publish to hold (the model won't volunteer hold)", () => {
    const v = judgeVerdict(judge({ decision: "publish", confidence: 0.4 }));
    expect(v.status).toBe("held");
    expect(v.source).toBe("tier2_lowconf");
  });

  it("routes a low-confidence reject to hold as well", () => {
    const v = judgeVerdict(judge({ decision: "reject", confidence: 0.5 }));
    expect(v.status).toBe("held");
    expect(v.source).toBe("tier2_lowconf");
  });

  it("keeps an explicit hold as held and carries the editorial signal", () => {
    const v = judgeVerdict(
      judge({ decision: "hold", confidence: 0.55, stance: "disagree", sentiment: "negative", topic_tag: "ethics" }),
    );
    expect(v.status).toBe("held");
    expect(v.stance).toBe("disagree");
    expect(v.sentiment).toBe("negative");
    expect(v.topicTag).toBe("ethics");
  });
});
