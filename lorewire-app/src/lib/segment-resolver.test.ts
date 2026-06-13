// Coverage for the TS pick_segment mirror. Tests the resolver in isolation
// by injecting `getSetting` + `fetchSegment` stubs so the data layer stays
// out — the resolver chain is the load-bearing piece, not the DB plumbing.
// Parity with pipeline/tests/test_segments.py is the goal: every branch
// the Python resolver tests, this file tests too.

import { describe, expect, it } from "vitest";
import {
  pickSegmentPure,
  type SegmentKind,
  type SegmentResolverStory,
} from "@/lib/segment-resolver";
import type { SegmentRow } from "@/lib/repo";
import type { VideoAspect } from "@/lib/aspect";

function makeStory(overrides: Partial<SegmentResolverStory> = {}): SegmentResolverStory {
  return {
    intro_segment_id: null,
    outro_segment_id: null,
    skip_intro: 0,
    skip_outro: 0,
    video_config: null,
    ...overrides,
  };
}

function makeSegment(overrides: Partial<SegmentRow> = {}): SegmentRow {
  return {
    id: "seg-1",
    kind: "intro",
    label: "Intro 1",
    source_url: null,
    normalized_url: "https://cdn/seg-1.mp4",
    duration_ms: 4000,
    enabled: 1,
    status: "ready",
    error: null,
    uploaded_at: null,
    aspect: "9:16",
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

const PORTRAIT: VideoAspect = "9:16";
const LANDSCAPE: VideoAspect = "16:9";

function makeGetSetting(map: Record<string, string | null>) {
  return async (key: string) => (key in map ? map[key] : null);
}

function makeFetchSegment(byId: Record<string, SegmentRow>) {
  return async (id: string) => byId[id] ?? null;
}

describe("pickSegmentPure", () => {
  it("returns null on skip-flag for intro", async () => {
    const story = makeStory({ skip_intro: 1 });
    const pick = await pickSegmentPure(
      "intro",
      story,
      PORTRAIT,
      makeGetSetting({}),
      makeFetchSegment({}),
    );
    expect(pick.segment).toBeNull();
    expect(pick.reason).toBe("skip-flag");
  });

  it("returns null on skip-flag for outro", async () => {
    const story = makeStory({ skip_outro: 1 });
    const pick = await pickSegmentPure(
      "outro",
      story,
      PORTRAIT,
      makeGetSetting({}),
      makeFetchSegment({}),
    );
    expect(pick.segment).toBeNull();
    expect(pick.reason).toBe("skip-flag");
  });

  it("returns the pinned row even when soft-disabled", async () => {
    const seg = makeSegment({ id: "pinned-1", enabled: 0, aspect: "9:16" });
    const story = makeStory({ intro_segment_id: "pinned-1" });
    const pick = await pickSegmentPure(
      "intro",
      story,
      PORTRAIT,
      makeGetSetting({}),
      makeFetchSegment({ "pinned-1": seg }),
    );
    expect(pick.segment?.id).toBe("pinned-1");
    expect(pick.reason).toBe("pinned");
  });

  it("returns pinned-missing when the pinned id has no row", async () => {
    const story = makeStory({ intro_segment_id: "ghost-id" });
    const pick = await pickSegmentPure(
      "intro",
      story,
      PORTRAIT,
      makeGetSetting({}),
      makeFetchSegment({}),
    );
    expect(pick.segment).toBeNull();
    expect(pick.reason).toBe("pinned-missing");
  });

  it("does NOT fall through to the global active when pin is missing", async () => {
    // Pinning is a strong statement; even a missing pin must not
    // silently fall back to the global pick (parity with Python).
    const story = makeStory({ intro_segment_id: "ghost-id" });
    const pick = await pickSegmentPure(
      "intro",
      story,
      PORTRAIT,
      makeGetSetting({
        "video.active_intro_id": "global-1",
      }),
      makeFetchSegment({
        "global-1": makeSegment({ id: "global-1" }),
      }),
    );
    expect(pick.segment).toBeNull();
    expect(pick.reason).toBe("pinned-missing");
  });

  it("returns null when master switch is explicitly off", async () => {
    const seg = makeSegment({ id: "global-1" });
    const story = makeStory();
    const pick = await pickSegmentPure(
      "intro",
      story,
      PORTRAIT,
      makeGetSetting({
        "video.intro_outro_enabled": "0",
        "video.active_intro_id": "global-1",
      }),
      makeFetchSegment({ "global-1": seg }),
    );
    expect(pick.segment).toBeNull();
    expect(pick.reason).toBe("master-disabled");
  });

  it("treats master switch unset as ON (chain proceeds to global-active)", async () => {
    const seg = makeSegment({ id: "global-1" });
    const story = makeStory();
    const pick = await pickSegmentPure(
      "intro",
      story,
      PORTRAIT,
      makeGetSetting({ "video.active_intro_id": "global-1" }),
      makeFetchSegment({ "global-1": seg }),
    );
    expect(pick.segment?.id).toBe("global-1");
    expect(pick.reason).toBe("global-active");
  });

  it("returns no-default when no global active id is set", async () => {
    const story = makeStory();
    const pick = await pickSegmentPure(
      "intro",
      story,
      PORTRAIT,
      makeGetSetting({}),
      makeFetchSegment({}),
    );
    expect(pick.segment).toBeNull();
    expect(pick.reason).toBe("no-default");
  });

  it("skips a disabled global-active row", async () => {
    const seg = makeSegment({ id: "global-1", enabled: 0 });
    const story = makeStory();
    const pick = await pickSegmentPure(
      "intro",
      story,
      PORTRAIT,
      makeGetSetting({ "video.active_intro_id": "global-1" }),
      makeFetchSegment({ "global-1": seg }),
    );
    expect(pick.segment).toBeNull();
    expect(pick.reason).toBe("global-active-missing");
  });

  it("aspect-mismatch on a pinned 9:16 segment with a 16:9 story", async () => {
    const seg = makeSegment({
      id: "pinned-1",
      aspect: "9:16",
      enabled: 1,
    });
    const story = makeStory({ intro_segment_id: "pinned-1" });
    const pick = await pickSegmentPure(
      "intro",
      story,
      LANDSCAPE,
      makeGetSetting({}),
      makeFetchSegment({ "pinned-1": seg }),
    );
    expect(pick.segment).toBeNull();
    expect(pick.reason).toBe("aspect-mismatch");
  });

  it("aspect-mismatch on global-active for a 16:9 story", async () => {
    const seg = makeSegment({ id: "global-1", aspect: "9:16" });
    const story = makeStory();
    const pick = await pickSegmentPure(
      "intro",
      story,
      LANDSCAPE,
      makeGetSetting({ "video.active_intro_id": "global-1" }),
      makeFetchSegment({ "global-1": seg }),
    );
    expect(pick.segment).toBeNull();
    expect(pick.reason).toBe("aspect-mismatch");
  });

  it("matching aspect on global-active returns the row", async () => {
    const seg = makeSegment({ id: "global-1", aspect: "16:9" });
    const story = makeStory();
    const pick = await pickSegmentPure(
      "intro",
      story,
      LANDSCAPE,
      makeGetSetting({ "video.active_intro_id": "global-1" }),
      makeFetchSegment({ "global-1": seg }),
    );
    expect(pick.segment?.id).toBe("global-1");
    expect(pick.reason).toBe("global-active");
  });

  it("treats null segment aspect as legacy 9:16", async () => {
    const seg = makeSegment({ id: "legacy-1", aspect: null });
    const story = makeStory();
    const pick = await pickSegmentPure(
      "intro",
      story,
      PORTRAIT,
      makeGetSetting({ "video.active_intro_id": "legacy-1" }),
      makeFetchSegment({ "legacy-1": seg }),
    );
    expect(pick.segment?.id).toBe("legacy-1");
    expect(pick.reason).toBe("global-active");
  });

  it.each([
    ["off", true],
    ["0", true],
    ["false", true],
    ["no", true],
    ["1", false],
    ["true", false],
    ["", false],
    ["on", false],
  ])(
    "master switch parse: value=%j => disabled=%s",
    async (rawValue, expectMasterDisabled: boolean) => {
      const seg = makeSegment({ id: "global-1" });
      const story = makeStory();
      const pick = await pickSegmentPure(
        "intro",
        story,
        PORTRAIT,
        makeGetSetting({
          "video.intro_outro_enabled": rawValue,
          "video.active_intro_id": "global-1",
        }),
        makeFetchSegment({ "global-1": seg }),
      );
      if (expectMasterDisabled) {
        expect(pick.reason).toBe("master-disabled");
      } else {
        expect(pick.reason).toBe("global-active");
      }
    },
  );

  it("outro chain reads the outro-namespaced settings", async () => {
    // Sanity: a stray "active_intro_id" must not satisfy an outro pick.
    const seg = makeSegment({ id: "outro-1", kind: "outro", aspect: "9:16" });
    const story = makeStory();
    const pick = await pickSegmentPure(
      "outro" as SegmentKind,
      story,
      PORTRAIT,
      makeGetSetting({
        "video.active_intro_id": "outro-1", // wrong namespace
        "video.active_outro_id": "outro-1",
      }),
      makeFetchSegment({ "outro-1": seg }),
    );
    expect(pick.segment?.id).toBe("outro-1");
    expect(pick.reason).toBe("global-active");
  });
});
