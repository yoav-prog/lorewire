// Pins the Phase 3 frame-regen contracts (per
// _plans/2026-06-12-video-editor-overhaul.md):
//
//   - Prompt validation: empty / too-long / control-char inputs are
//     rejected before any state change.
//   - Prompt source resolution: user-supplied > existing image_prompt >
//     scene fallback > error.
//   - prev_image snapshot captures the pre-regen url + image_prompt
//     exactly, so Revert always returns the user to what they saw
//     before clicking Regenerate.
//   - url stays pointed at the OLD image until the worker writes back
//     (the editor's polling loop swaps it on completion).
//   - SHA-256 hash is deterministic across calls — drives both the
//     `prompt_hash` queue column AND the action-layer soft-idempotency.
//   - Revert restores both fields and clears prev_image so a second
//     Revert returns no-snapshot rather than silently no-oping.

import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_LEN,
  planFrameRegen,
  planFrameRevert,
  promptHash,
  validatePrompt,
} from "@/lib/frame-regen";
import {
  CURRENT_CONFIG_VERSION,
  type ShortVideoConfig,
} from "@/lib/video-config";

const NOW = "2026-06-12T12:00:00.000Z";

function baseConfig(overrides: Partial<ShortVideoConfig> = {}): ShortVideoConfig {
  return {
    config_version: CURRENT_CONFIG_VERSION,
    voiceover_url: "/v.mp3",
    duration_ms: 10000,
    doodle_frames: [
      {
        id: "frame-a",
        url: "/old-a.png",
        caption_chunk_start_index: 0,
        image_prompt: "a doodle of an accountant",
      },
      {
        id: "frame-b",
        url: "/old-b.png",
        caption_chunk_start_index: 0,
      },
    ],
    captions: [{ start_ms: 0, end_ms: 10000, text: "Hi" }],
    ...overrides,
  };
}

// ─── promptHash ──────────────────────────────────────────────────────────────

describe("promptHash", () => {
  it("returns a 64-char hex sha256", () => {
    const h = promptHash("a doodle of an accountant");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic for the same input", () => {
    expect(promptHash("hello")).toBe(promptHash("hello"));
  });

  it("differs for different inputs (sanity)", () => {
    expect(promptHash("hello")).not.toBe(promptHash("world"));
  });
});

// ─── validatePrompt ──────────────────────────────────────────────────────────

describe("validatePrompt", () => {
  it("accepts a normal prompt and trims surrounding whitespace", () => {
    const r = validatePrompt("   a doodle of an accountant   ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("a doodle of an accountant");
  });

  it("rejects empty / whitespace-only", () => {
    expect(validatePrompt("").ok).toBe(false);
    expect(validatePrompt("   ").ok).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(validatePrompt(42).ok).toBe(false);
    expect(validatePrompt(null).ok).toBe(false);
    expect(validatePrompt(undefined).ok).toBe(false);
  });

  it("rejects prompts above MAX_PROMPT_LEN", () => {
    const r = validatePrompt("a".repeat(MAX_PROMPT_LEN + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("prompt-too-long");
  });

  it("accepts a prompt exactly at the length cap", () => {
    const r = validatePrompt("a".repeat(MAX_PROMPT_LEN));
    expect(r.ok).toBe(true);
  });

  it("rejects control characters but allows tab + newline", () => {
    // Tab and newline are legitimate in multi-line prompts.
    expect(validatePrompt("line 1\nline 2").ok).toBe(true);
    expect(validatePrompt("col1\tcol2").ok).toBe(true);
    // Bell, escape, null are not.
    expect(validatePrompt("evil\x07prompt").ok).toBe(false);
    expect(validatePrompt("evil\x1bprompt").ok).toBe(false);
    expect(validatePrompt("evil\x00prompt").ok).toBe(false);
  });
});

// ─── planFrameRegen ──────────────────────────────────────────────────────────

describe("planFrameRegen — prompt source resolution", () => {
  it("uses the user-supplied prompt over the existing one", () => {
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "frame-a",
      newPrompt: "a glowing dragon",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.prompt).toBe("a glowing dragon");
      expect(r.promptSource).toBe("user");
    }
  });

  it("falls back to the frame's existing image_prompt when no newPrompt given", () => {
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "frame-a",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.prompt).toBe("a doodle of an accountant");
      expect(r.promptSource).toBe("existing");
    }
  });

  it("falls back to the scene prompt when frame has neither user nor existing prompt", () => {
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "frame-b", // no image_prompt
      now: NOW,
      sceneFallbackPrompt: "scene-derived prompt",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.prompt).toBe("scene-derived prompt");
      expect(r.promptSource).toBe("scene-fallback");
    }
  });

  it("returns no-prompt-available when every source is absent", () => {
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "frame-b",
      now: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("no-prompt-available");
  });
});

describe("planFrameRegen — validation", () => {
  it("rejects an unknown frame id", () => {
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "does-not-exist",
      newPrompt: "ok",
      now: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("frame-not-found");
  });

  it("propagates a prompt-validation failure", () => {
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "frame-a",
      newPrompt: "a".repeat(MAX_PROMPT_LEN + 1),
      now: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("prompt-too-long");
  });

  it("does not mutate the base config on success", () => {
    const base = baseConfig();
    const beforeJson = JSON.stringify(base);
    const r = planFrameRegen({
      base,
      frameId: "frame-a",
      newPrompt: "new",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(base)).toBe(beforeJson);
  });
});

describe("planFrameRegen — snapshot behavior", () => {
  it("snapshots the pre-regen url + image_prompt into prev_image", () => {
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "frame-a",
      newPrompt: "fresh prompt",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const frame = r.nextConfig.doodle_frames[r.frameIndex];
      expect(frame.prev_image).toEqual({
        url: "/old-a.png",
        image_prompt: "a doodle of an accountant",
        replaced_at: NOW,
      });
      expect(r.snapshottedFrom).toEqual({
        url: "/old-a.png",
        image_prompt: "a doodle of an accountant",
      });
    }
  });

  it("snapshots an empty image_prompt as an empty string (not undefined)", () => {
    // Otherwise the Revert path would lose the distinction between "no
    // prompt yet" and "user previously had a prompt".
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "frame-b",
      newPrompt: "first ever prompt",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const frame = r.nextConfig.doodle_frames[r.frameIndex];
      expect(frame.prev_image?.image_prompt).toBe("");
    }
  });

  it("keeps url pointed at the OLD image (worker writes the new one later)", () => {
    // The editor's polling loop swaps url on render completion; until
    // then the preview keeps showing the old frame.
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "frame-a",
      newPrompt: "fresh prompt",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const frame = r.nextConfig.doodle_frames[r.frameIndex];
      expect(frame.url).toBe("/old-a.png");
    }
  });

  it("writes the new image_prompt into the live field", () => {
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "frame-a",
      newPrompt: "fresh prompt",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const frame = r.nextConfig.doodle_frames[r.frameIndex];
      expect(frame.image_prompt).toBe("fresh prompt");
    }
  });

  it("computes a deterministic prompt hash matching promptHash()", () => {
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "frame-a",
      newPrompt: "fresh prompt",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.promptHash).toBe(promptHash("fresh prompt"));
    }
  });

  it("does not touch sibling frames", () => {
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "frame-a",
      newPrompt: "fresh",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nextConfig.doodle_frames[1]).toEqual(
        baseConfig().doodle_frames[1],
      );
    }
  });
});

// ─── planFrameRevert ─────────────────────────────────────────────────────────

describe("planFrameRevert", () => {
  function configWithSnapshot(): ShortVideoConfig {
    return baseConfig({
      doodle_frames: [
        {
          id: "frame-a",
          url: "/new-a.png",
          caption_chunk_start_index: 0,
          image_prompt: "the new prompt",
          prev_image: {
            url: "/old-a.png",
            image_prompt: "the old prompt",
            replaced_at: "2026-06-12T11:55:00Z",
          },
        },
      ],
    });
  }

  it("restores url + image_prompt from prev_image", () => {
    const r = planFrameRevert(configWithSnapshot(), "frame-a");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const frame = r.nextConfig.doodle_frames[r.frameIndex];
      expect(frame.url).toBe("/old-a.png");
      expect(frame.image_prompt).toBe("the old prompt");
      expect(r.restoredUrl).toBe("/old-a.png");
      expect(r.restoredPrompt).toBe("the old prompt");
    }
  });

  it("clears prev_image so a second revert returns no-snapshot", () => {
    const first = planFrameRevert(configWithSnapshot(), "frame-a");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      first.nextConfig.doodle_frames[first.frameIndex].prev_image,
    ).toBeUndefined();
    const second = planFrameRevert(first.nextConfig, "frame-a");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("no-snapshot");
  });

  it("returns no-snapshot when the frame never had a prev_image", () => {
    const r = planFrameRevert(baseConfig(), "frame-a"); // no prev_image
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("no-snapshot");
  });

  it("returns frame-not-found for an unknown id", () => {
    const r = planFrameRevert(configWithSnapshot(), "does-not-exist");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("frame-not-found");
  });

  it("treats an empty restored image_prompt as undefined in the live frame", () => {
    // Empty-string image_prompt was the snapshot's marker for "never had
    // a prompt"; restoring it should clear the field rather than write
    // an empty string the parser would strip anyway.
    const cfg = baseConfig({
      doodle_frames: [
        {
          id: "frame-a",
          url: "/new.png",
          caption_chunk_start_index: 0,
          image_prompt: "current",
          prev_image: {
            url: "/old.png",
            image_prompt: "",
            replaced_at: NOW,
          },
        },
      ],
    });
    const r = planFrameRevert(cfg, "frame-a");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const frame = r.nextConfig.doodle_frames[r.frameIndex];
      expect(frame.image_prompt).toBeUndefined();
    }
  });

  it("does not mutate the base config", () => {
    const base = configWithSnapshot();
    const beforeJson = JSON.stringify(base);
    planFrameRevert(base, "frame-a");
    expect(JSON.stringify(base)).toBe(beforeJson);
  });
});

// ─── Round-trip with parseVideoConfig ────────────────────────────────────────

describe("planFrameRegen + parseVideoConfig round-trip", () => {
  it("the regenerated config still validates", async () => {
    const { parseVideoConfig } = await import("@/lib/video-config");
    const r = planFrameRegen({
      base: baseConfig(),
      frameId: "frame-a",
      newPrompt: "round-trip",
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const parsed = parseVideoConfig(r.nextConfig);
      expect(parsed.ok).toBe(true);
    }
  });

  it("the reverted config still validates", async () => {
    const { parseVideoConfig } = await import("@/lib/video-config");
    const cfg = baseConfig({
      doodle_frames: [
        {
          id: "frame-a",
          url: "/new.png",
          caption_chunk_start_index: 0,
          image_prompt: "new",
          prev_image: {
            url: "/old.png",
            image_prompt: "old",
            replaced_at: NOW,
          },
        },
      ],
    });
    const r = planFrameRevert(cfg, "frame-a");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const parsed = parseVideoConfig(r.nextConfig);
      expect(parsed.ok).toBe(true);
    }
  });
});
