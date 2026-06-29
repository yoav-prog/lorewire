// Routing logic for the submission moderator (Phase 2). Covers the pure decision
// helpers without network: Tier 1 quarantine/reject/pass, and the judge mapping
// where, in the human pilot, only clear violations auto-reject and everything else
// (clean, ambiguous, low-confidence) routes to a person. The real-person gate is
// the load-bearing case.

import { describe, expect, it } from "vitest";

import type { ModerationSignals } from "@/lib/openai-moderation";
import {
  judgeVerdict,
  tier1Verdict,
  type SubmissionJudgeOutput,
} from "@/lib/submission-moderation";

function signals(over: Partial<ModerationSignals>): ModerationSignals {
  return { flagged: false, maxTox: 0, maxQuarantine: 0, topCategory: "", topScore: 0, ...over };
}

function judge(over: Partial<SubmissionJudgeOutput>): SubmissionJudgeOutput {
  return {
    decision: "approve",
    category: "clean",
    identifies_real_person: false,
    real_person_kind: "none",
    reason: "",
    confidence: 0.9,
    ...over,
  };
}

describe("tier1Verdict", () => {
  it("quarantines a severe category", () => {
    const v = tier1Verdict(signals({ maxQuarantine: 0.8, topCategory: "self-harm/intent", topScore: 0.8 }));
    expect(v?.status).toBe("quarantined");
    expect(v?.source).toBe("tier1");
  });

  it("rejects clear toxicity", () => {
    const v = tier1Verdict(signals({ flagged: true, maxTox: 0.7, topCategory: "harassment", topScore: 0.7 }));
    expect(v?.status).toBe("rejected");
    expect(v?.source).toBe("tier1");
  });

  it("passes clean text to the judge (null)", () => {
    expect(tier1Verdict(signals({ maxTox: 0.1, topScore: 0.1 }))).toBeNull();
  });
});

describe("judgeVerdict — the real-person gate", () => {
  it("auto-rejects a high-confidence identifiable real person", () => {
    const v = judgeVerdict(
      judge({ decision: "reject", category: "real_person", identifies_real_person: true, real_person_kind: "private_identifiable", confidence: 0.9 }),
    );
    expect(v.status).toBe("rejected");
    expect(v.category).toBe("real_person");
  });

  it("sends a low-confidence real-person identification to a human, never auto-reject", () => {
    const v = judgeVerdict(
      judge({ decision: "reject", category: "real_person", identifies_real_person: true, real_person_kind: "public_figure", confidence: 0.4 }),
    );
    expect(v.status).toBe("pending_review");
    expect(v.source).toBe("tier2_lowconf");
  });

  it("holds an ambiguous real-person mention for a human", () => {
    const v = judgeVerdict(judge({ decision: "approve", category: "real_person_ambiguous", real_person_kind: "ambiguous" }));
    expect(v.status).toBe("pending_review");
    expect(v.category).toBe("real_person_ambiguous");
  });
});

describe("judgeVerdict — general routing", () => {
  it("quarantines a threat / self-harm category", () => {
    const v = judgeVerdict(judge({ decision: "reject", category: "threat_self_harm", confidence: 0.9 }));
    expect(v.status).toBe("quarantined");
    expect(v.category).toBe("quarantine");
  });

  it("auto-rejects a high-confidence spam/hate reject", () => {
    const v = judgeVerdict(judge({ decision: "reject", category: "spam", confidence: 0.9 }));
    expect(v.status).toBe("rejected");
    expect(v.category).toBe("spam");
  });

  it("downgrades a low-confidence reject to human review", () => {
    const v = judgeVerdict(judge({ decision: "reject", category: "off_policy", confidence: 0.3 }));
    expect(v.status).toBe("pending_review");
    expect(v.source).toBe("tier2_lowconf");
  });

  it("routes approve and hold to the human queue (no auto-publish in the pilot)", () => {
    expect(judgeVerdict(judge({ decision: "approve", confidence: 0.95 })).status).toBe("pending_review");
    expect(judgeVerdict(judge({ decision: "hold", category: "borderline", confidence: 0.5 })).status).toBe("pending_review");
  });
});
