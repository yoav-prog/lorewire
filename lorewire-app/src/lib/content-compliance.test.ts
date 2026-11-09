// Runs the cases shared with pipeline/tests/test_compliance.py so the Python
// checker and this port cannot drift apart.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCompliance, type ComplianceStory } from "@/lib/content-compliance";

interface SharedCase {
  name: string;
  story: ComplianceStory;
  source_text: string;
  source_title?: string;
  source_url?: string;
  expected: string[];
}

const CASES = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../pipeline/fixtures/compliance_cases.json"),
    "utf-8",
  ),
) as SharedCase[];

describe("checkCompliance shared cases", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const findings = checkCompliance(c.story, {
      sourceText: c.source_text,
      sourceTitle: c.source_title,
      sourceUrl: c.source_url,
    });
    expect([...new Set(findings.map((f) => f.check))].sort()).toEqual(c.expected);
  });
});

describe("checkCompliance input handling", () => {
  it("ignores null and empty fields", () => {
    expect(
      checkCompliance({ title: null, body: "   " }, { sourceText: "Told Karen." }),
    ).toEqual([]);
  });

  it("does not treat regex characters in the source as patterns", () => {
    expect(() =>
      checkCompliance({ body: "text" }, { sourceText: 'he said "a (b" and [c' }),
    ).not.toThrow();
  });
});
