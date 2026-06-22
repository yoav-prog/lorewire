// Live end-to-end check of the moderation pipeline against the real OpenAI
// APIs. Gated on OPENAI_API_KEY (loaded from the worktree .env files the same
// way the eval harness does), so it is skipped in CI without a key and never
// blocks the normal suite. It exists to confirm the wiring the unit tests can't
// reach: the extended chatCompletion path actually produces a valid gpt-5-nano
// request, and the free Moderation API + judge return sane verdicts.
//
// Run: npx vitest run src/lib/comment-moderation.integration.test.ts

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { moderateComment } from "./comment-moderation";

function loadKey(): string {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "..", "..", ".."); // src/lib -> worktree root
  for (const file of [resolve(root, ".env.local"), resolve(root, ".env")]) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      if (line.slice(0, eq).trim() !== "OPENAI_API_KEY") continue;
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (val) return val;
    }
  }
  return "";
}

const key = loadKey();
if (key) process.env.OPENAI_API_KEY = key;

// Opt-in only: this test hits the live API and costs money, so the normal
// suite skips it even when a key is present. Run with:
//   RUN_LIVE_MODERATION=1 npx vitest run src/lib/comment-moderation.integration.test.ts
const live = !!key && process.env.RUN_LIVE_MODERATION === "1";

const article = {
  articleTitle: "AITA for keeping my paid window seat on a long flight?",
  articleSummary:
    "A passenger declined to swap their paid window seat so a child could sit by the window.",
};

describe.skipIf(!live)("moderateComment — live", () => {
  it("publishes a clearly clean comment", async () => {
    const v = await moderateComment({
      body: "Honestly NTA, you paid for that seat and the airline sells selection for a reason.",
      lang: "en",
      ...article,
    });
    expect(v.status).toBe("published");
  }, 30000);

  it("does not publish clear hate (English)", async () => {
    const v = await moderateComment({
      body: "Immigrants are subhuman and ruin every country they touch.",
      lang: "en",
      ...article,
    });
    expect(v.status).not.toBe("published");
  }, 30000);

  it("does not publish clear hate (Hebrew)", async () => {
    const v = await moderateComment({
      body: "כל המהגרים האלה הם טפילים שהורסים את המדינה.",
      lang: "he",
      ...article,
    });
    expect(v.status).not.toBe("published");
  }, 30000);

  it("does not publish obvious spam", async () => {
    const v = await moderateComment({
      body: "Make $5000 a week from home! DM me, link in bio, limited spots!",
      lang: "en",
      ...article,
    });
    expect(v.status).not.toBe("published");
  }, 30000);
});
