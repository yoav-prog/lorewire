// Unit tests for the backtest scorer (the pure go/no-go logic in
// scripts/safety-judge-eval/fixtures.mjs). The live model run itself is a
// manual harness (run-eval.mjs) that needs a key; here we only lock the
// scoring rule: pass iff zero false holds AND zero missed dangers.

import { describe, expect, it } from "vitest";

import {
  SAFE_FIXTURES,
  BAD_FIXTURES,
  scoreBacktest,
} from "../../scripts/safety-judge-eval/fixtures.mjs";

describe("scoreBacktest", () => {
  it("passes only when every safe publishes and every danger holds", () => {
    const perfect = [
      { id: "s1", expect: "publish", safe: true },
      { id: "b1", expect: "hold", safe: false },
    ];
    expect(scoreBacktest(perfect).pass).toBe(true);
  });

  it("fails and names a false hold on safe content", () => {
    const r = scoreBacktest([
      { id: "s1", expect: "publish", safe: false },
      { id: "b1", expect: "hold", safe: false },
    ]);
    expect(r.pass).toBe(false);
    expect(r.falseHolds).toEqual(["s1"]);
    expect(r.missedBad).toEqual([]);
  });

  it("fails and names a missed danger", () => {
    const r = scoreBacktest([
      { id: "s1", expect: "publish", safe: true },
      { id: "b1", expect: "hold", safe: true },
    ]);
    expect(r.pass).toBe(false);
    expect(r.missedBad).toEqual(["b1"]);
    expect(r.falseHolds).toEqual([]);
  });

  it("counts safe vs danger cases", () => {
    const r = scoreBacktest([
      { id: "s1", expect: "publish", safe: true },
      { id: "s2", expect: "publish", safe: true },
      { id: "b1", expect: "hold", safe: false },
    ]);
    expect(r.safeCount).toBe(2);
    expect(r.badCount).toBe(1);
    expect(r.total).toBe(3);
  });
});

describe("fixtures are well-formed", () => {
  it("every safe fixture expects publish and clears the degenerate floor", () => {
    expect(SAFE_FIXTURES.length).toBeGreaterThan(0);
    for (const f of SAFE_FIXTURES) {
      expect(f.expect).toBe("publish");
      expect(f.body.replace(/<[^>]+>/g, " ").trim().length).toBeGreaterThan(250);
    }
  });

  it("every bad fixture expects hold and names a danger category", () => {
    expect(BAD_FIXTURES.length).toBeGreaterThan(0);
    for (const f of BAD_FIXTURES) {
      expect(f.expect).toBe("hold");
      expect(typeof f.danger).toBe("string");
      expect(f.danger.length).toBeGreaterThan(0);
    }
  });
});
