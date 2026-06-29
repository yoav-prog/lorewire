// Tests for the publisher poll-hook caption suffix. Pure-function
// tests — no DB, no settings load. The wiring side (the future
// mapShortToPlatformPayload in the publisher) is the call-site
// integration that this module doesn't depend on.
//
// Plan: _plans/2026-06-17-engagement-polls.md (Phase 5).

import { describe, expect, it } from "vitest";
import {
  buildPollHook,
  DEFAULT_POLL_HOOK_TEMPLATES,
  pollHookSettingKey,
  PUBLISHER_PLATFORMS,
  type PublisherPlatform,
} from "@/lib/publisher-poll-hook";

describe("PUBLISHER_PLATFORMS + default templates", () => {
  it("covers exactly the four platforms from the publisher plan", () => {
    // If a new platform is added (e.g. "snapchat"), this test forces
    // the contributor to add a default template in the same commit.
    expect([...PUBLISHER_PLATFORMS].sort()).toEqual([
      "facebook",
      "instagram",
      "tiktok",
      "youtube",
    ]);
  });

  it("declares a default template for every platform", () => {
    for (const p of PUBLISHER_PLATFORMS) {
      const t = DEFAULT_POLL_HOOK_TEMPLATES[p];
      expect(t).toBeDefined();
      expect(t.length).toBeGreaterThan(0);
      // Every default must carry both substitution tokens — otherwise
      // the call site can't bind question + slug at runtime.
      expect(t).toContain("{question}");
      expect(t).toContain("{slug}");
    }
  });

  it("matches the plan §F4 strings verbatim", () => {
    // Keeping these literal so a reviewer can diff the plan against
    // the test file. Any future tweak to a template surface here
    // first.
    expect(DEFAULT_POLL_HOOK_TEMPLATES.youtube).toBe(
      "\n\n👉 {question} Vote at lorewire.com/v/{slug}",
    );
    expect(DEFAULT_POLL_HOOK_TEMPLATES.tiktok).toBe(
      "\n\n{question} 👉 lorewire.com/v/{slug}",
    );
    expect(DEFAULT_POLL_HOOK_TEMPLATES.instagram).toBe(
      "\n\n{question} 👉 lorewire.com/v/{slug}",
    );
    expect(DEFAULT_POLL_HOOK_TEMPLATES.facebook).toBe(
      "\n\n{question} 👉 lorewire.com/v/{slug}",
    );
  });
});

describe("pollHookSettingKey", () => {
  it("produces a stable key per platform", () => {
    expect(pollHookSettingKey("youtube")).toBe(
      "publisher.caption.youtube.poll_hook_template",
    );
    expect(pollHookSettingKey("tiktok")).toBe(
      "publisher.caption.tiktok.poll_hook_template",
    );
    expect(pollHookSettingKey("instagram")).toBe(
      "publisher.caption.instagram.poll_hook_template",
    );
    expect(pollHookSettingKey("facebook")).toBe(
      "publisher.caption.facebook.poll_hook_template",
    );
  });

  it("covers every platform", () => {
    for (const p of PUBLISHER_PLATFORMS) {
      expect(pollHookSettingKey(p)).toMatch(
        /^publisher\.caption\.[a-z]+\.poll_hook_template$/,
      );
    }
  });
});

describe("buildPollHook — substitution", () => {
  it("substitutes question and slug into the YouTube default", () => {
    const out = buildPollHook({
      question: "Who's wrong?",
      slug: "wife-vs-husband",
      platform: "youtube",
    });
    expect(out).toBe(
      "\n\n👉 Who's wrong? Vote at lorewire.com/v/wife-vs-husband",
    );
  });

  it("substitutes question and slug into the TikTok default", () => {
    const out = buildPollHook({
      question: "Was she justified?",
      slug: "the-800-envelope",
      platform: "tiktok",
    });
    expect(out).toBe(
      "\n\nWas she justified? 👉 lorewire.com/v/the-800-envelope",
    );
  });

  it("Instagram and Facebook use the TikTok-style default", () => {
    expect(
      buildPollHook({
        question: "Red flag?",
        slug: "wrong-number-right-guy",
        platform: "instagram",
      }),
    ).toBe("\n\nRed flag? 👉 lorewire.com/v/wrong-number-right-guy");
    expect(
      buildPollHook({
        question: "Red flag?",
        slug: "wrong-number-right-guy",
        platform: "facebook",
      }),
    ).toBe("\n\nRed flag? 👉 lorewire.com/v/wrong-number-right-guy");
  });

  it("trims trailing whitespace from question and slug before substituting", () => {
    const out = buildPollHook({
      question: "  Who's wrong?  ",
      slug: " wife-vs-husband ",
      platform: "youtube",
    });
    expect(out).toBe(
      "\n\n👉 Who's wrong? Vote at lorewire.com/v/wife-vs-husband",
    );
  });

  it("returns empty string when question is empty or whitespace-only", () => {
    expect(
      buildPollHook({ question: "", slug: "x", platform: "youtube" }),
    ).toBe("");
    expect(
      buildPollHook({
        question: "    ",
        slug: "x",
        platform: "tiktok",
      }),
    ).toBe("");
  });

  it("returns empty string when slug is empty or whitespace-only", () => {
    expect(
      buildPollHook({
        question: "Q?",
        slug: "",
        platform: "instagram",
      }),
    ).toBe("");
    expect(
      buildPollHook({
        question: "Q?",
        slug: "    ",
        platform: "facebook",
      }),
    ).toBe("");
  });
});

describe("buildPollHook — template override", () => {
  it("uses the override when non-empty", () => {
    const out = buildPollHook({
      question: "Q?",
      slug: "abc",
      platform: "youtube",
      templateOverride: "Vote here: lorewire.com/v/{slug} ({question})",
    });
    expect(out).toBe("Vote here: lorewire.com/v/abc (Q?)");
  });

  it("falls back to the default when override is null", () => {
    const out = buildPollHook({
      question: "Q?",
      slug: "abc",
      platform: "tiktok",
      templateOverride: null,
    });
    expect(out).toBe(DEFAULT_POLL_HOOK_TEMPLATES.tiktok
      .replaceAll("{question}", "Q?")
      .replaceAll("{slug}", "abc"));
  });

  it("falls back to the default when override is an empty string", () => {
    const out = buildPollHook({
      question: "Q?",
      slug: "abc",
      platform: "tiktok",
      templateOverride: "",
    });
    expect(out).toBe(DEFAULT_POLL_HOOK_TEMPLATES.tiktok
      .replaceAll("{question}", "Q?")
      .replaceAll("{slug}", "abc"));
  });

  it("falls back to the default when override is whitespace-only", () => {
    const out = buildPollHook({
      question: "Q?",
      slug: "abc",
      platform: "tiktok",
      templateOverride: "    ",
    });
    expect(out).toBe(DEFAULT_POLL_HOOK_TEMPLATES.tiktok
      .replaceAll("{question}", "Q?")
      .replaceAll("{slug}", "abc"));
  });

  it("substitutes globally (multiple occurrences of the same token)", () => {
    const out = buildPollHook({
      question: "Q?",
      slug: "abc",
      platform: "youtube",
      templateOverride: "{question} ... and again: {question}",
    });
    expect(out).toBe("Q? ... and again: Q?");
  });

  it("leaves unknown {tokens} literal (the publisher's template layer owns them)", () => {
    const out = buildPollHook({
      question: "Q?",
      slug: "abc",
      platform: "youtube",
      // {title} and {url} are publisher-template tokens, not poll-hook tokens.
      templateOverride: "{title} — {question} — {url}",
    });
    expect(out).toBe("{title} — Q? — {url}");
  });
});

describe("buildPollHook — type guard via the platform parameter", () => {
  it("typechecks every platform key against the default templates", () => {
    // This test is mostly TypeScript exhaustiveness — if a new platform
    // is added without a default, the test won't compile.
    const platforms: PublisherPlatform[] = [
      "youtube",
      "tiktok",
      "instagram",
      "facebook",
    ];
    for (const p of platforms) {
      const out = buildPollHook({
        question: "Q?",
        slug: "abc",
        platform: p,
      });
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain("Q?");
      expect(out).toContain("abc");
    }
  });
});
