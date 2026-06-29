// Pure unit tests for the publish-gate readiness check. The action that
// calls this is in admin/actions.ts; the integration story for the
// action (DB + auth + redirect) lives in this file's TS companions.
//
// The gate exists because the original product requirement was "publish
// only after I see the whole article is good and ready to go, with
// images, proper video and everything." Each missing-piece string is a
// separate line so the admin sees the exact remaining work.

import { describe, expect, it } from "vitest";

import { evaluatePublishReadiness } from "./reddit-source";

const okSource = { status: "used", story_id: "story-1" };
const okStory = {
  status: "review",
  body: "the body",
  hero_image: "https://example/hero.png",
  video_url: "https://example/video.mp4",
};

describe("evaluatePublishReadiness", () => {
  it("returns ready=true when source and story are both complete", () => {
    const r = evaluatePublishReadiness(okStory, okSource);
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("blocks when story has not been generated yet", () => {
    const r = evaluatePublishReadiness(null, {
      status: "queued",
      story_id: null,
    });
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("story has not been generated yet");
    // Short-circuits when there's no story — body/hero/video checks are
    // skipped to avoid noise the admin can't act on.
    expect(r.missing).not.toContain("story body is empty");
  });

  it("blocks when source row hasn't reached 'used'", () => {
    const r = evaluatePublishReadiness(okStory, {
      status: "processing",
      story_id: "story-1",
    });
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("source row hasn't finished processing");
  });

  it("blocks when source has no story_id even if story is non-null", () => {
    const r = evaluatePublishReadiness(okStory, {
      status: "used",
      story_id: null,
    });
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("source row has no linked story_id");
  });

  it("blocks when body is empty or whitespace-only", () => {
    const r1 = evaluatePublishReadiness(
      { ...okStory, body: null },
      okSource,
    );
    expect(r1.missing).toContain("story body is empty");
    const r2 = evaluatePublishReadiness(
      { ...okStory, body: "   \n\t  " },
      okSource,
    );
    expect(r2.missing).toContain("story body is empty");
  });

  it("blocks when hero_image is missing", () => {
    const r = evaluatePublishReadiness(
      { ...okStory, hero_image: null },
      okSource,
    );
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("hero image is missing");
  });

  it("does NOT block when video_url is missing (2026-06-19 plan)", () => {
    // The publish gate stopped requiring a long-form MP4 when Reddit-source
    // jobs stopped auto-rendering one. The short carries the visual payload
    // now; the article reads from hero + scenes. See
    // _plans/2026-06-19-no-long-form-video-for-reddit-jobs.md.
    const r = evaluatePublishReadiness(
      { ...okStory, video_url: null },
      okSource,
    );
    expect(r.ready).toBe(true);
    expect(r.missing).not.toContain("video has not been rendered yet");
  });

  it("blocks publishing a story that's already published (avoids double-publish)", () => {
    const r = evaluatePublishReadiness(
      { ...okStory, status: "published" },
      okSource,
    );
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("story is already published");
  });

  it("blocks publishing an archived story (must un-archive first)", () => {
    const r = evaluatePublishReadiness(
      { ...okStory, status: "archived" },
      okSource,
    );
    expect(r.ready).toBe(false);
    expect(r.missing.some((m) => m.startsWith("story is archived"))).toBe(true);
  });

  it("can accumulate multiple blocker reasons in one pass", () => {
    const r = evaluatePublishReadiness(
      { status: "review", body: "", hero_image: null, video_url: null },
      okSource,
    );
    expect(r.ready).toBe(false);
    // body + hero — two reasons after the 2026-06-19 plan dropped
    // video_url from the gate. Both surface together so the admin
    // doesn't fix one and re-discover another on a second click.
    expect(r.missing).toEqual(
      expect.arrayContaining([
        "story body is empty",
        "hero image is missing",
      ]),
    );
    expect(r.missing).not.toContain("video has not been rendered yet");
  });
});
