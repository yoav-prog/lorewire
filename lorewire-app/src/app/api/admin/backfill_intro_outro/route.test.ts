// @vitest-environment node

// Phase 5 of _plans/2026-06-15-cloud-run-intro-outro-splice.md.
//
// Tests the one-shot intro/outro backfill endpoint. We stub the repo +
// queue helpers so the routes' candidate filtering + enqueue loop run
// against fakes — the contract we pin:
//
//   - GET without ?dry=1 → 400 (so an accidental browser visit doesn't
//     fire any inserts).
//   - GET ?dry=1 → returns candidate count, no enqueue fires.
//   - POST → enqueues a force re-render per candidate, returns the
//     (story_id, render_id) tuples.
//   - Stories WITHOUT video_url are excluded (nothing to improve).
//   - Stories with BOTH skip flags are excluded (intro/outro would be
//     skipped at render time anyway).
//   - A single enqueue failure does NOT abort the loop — the failed
//     story is reported, the rest still enqueue.

import { describe, expect, it, vi, beforeEach } from "vitest";

import { GET, POST } from "./route";
import * as dal from "@/lib/dal";
import * as repo from "@/lib/repo";
import * as queue from "@/lib/video-render-queue";

function makeStory(overrides: Partial<repo.StoryRow>): repo.StoryRow {
  return {
    id: "default",
    video_url: null,
    skip_intro: 0,
    skip_outro: 0,
    ...overrides,
  } as unknown as repo.StoryRow;
}

function makeReq(url: string) {
  return new Request(url) as unknown as Parameters<typeof GET>[0];
}

describe("/api/admin/backfill_intro_outro", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default: admin auth resolves (the route's await requireAdmin()
    // passes through). Individual tests can stub it to throw a
    // NEXT_REDIRECT to simulate an unauthenticated caller.
    vi.spyOn(dal, "requireAdmin").mockResolvedValue({
      userId: "admin-1",
    } as unknown as Awaited<ReturnType<typeof dal.requireAdmin>>);
  });

  it("GET without ?dry=1 returns 400 so a browser visit can't fire inserts", async () => {
    const enqueueSpy = vi.spyOn(queue, "forceEnqueueRender");
    const resp = await GET(makeReq("http://localhost/api/admin/backfill_intro_outro"));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("POST");
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("GET ?dry=1 returns a candidate count without enqueueing", async () => {
    vi.spyOn(repo, "listStories").mockResolvedValue([
      makeStory({ id: "a", video_url: "https://gcs/a.mp4" }),
      makeStory({ id: "b", video_url: "https://gcs/b.mp4", skip_intro: 1 }),
      makeStory({ id: "c", video_url: null }), // excluded — no video
      makeStory({
        id: "d",
        video_url: "https://gcs/d.mp4",
        skip_intro: 1,
        skip_outro: 1,
      }), // excluded — both flags
    ]);
    const enqueueSpy = vi.spyOn(queue, "forceEnqueueRender");

    const resp = await GET(
      makeReq("http://localhost/api/admin/backfill_intro_outro?dry=1"),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.dry_run).toBe(true);
    expect(body.candidates).toBe(2); // a + b
    expect(body.skipped_both_flags).toBe(1); // d
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("POST enqueues a force re-render per candidate", async () => {
    vi.spyOn(repo, "listStories").mockResolvedValue([
      makeStory({ id: "a", video_url: "https://gcs/a.mp4" }),
      makeStory({ id: "b", video_url: "https://gcs/b.mp4" }),
    ]);
    const enqueueSpy = vi
      .spyOn(queue, "forceEnqueueRender")
      .mockImplementation(async (storyId: string) => {
        return {
          id: `r-${storyId}`,
          story_id: storyId,
          config_hash: `backfill-intro-outro:force-...`,
          status: "queued",
        } as unknown as queue.RenderRow;
      });
    vi.spyOn(queue, "logVideoRenderEvent").mockResolvedValue(undefined);

    const resp = await POST();

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.dry_run).toBe(false);
    expect(body.candidates).toBe(2);
    expect(body.enqueued).toHaveLength(2);
    expect(body.failed).toHaveLength(0);
    // Verify the force-enqueue was called for each candidate with the
    // shared backfill prefix so render-history can grep for it later.
    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSpy.mock.calls[0][1]).toBe("backfill-intro-outro");
    expect(enqueueSpy.mock.calls[1][1]).toBe("backfill-intro-outro");
  });

  it("POST excludes stories without video_url + stories with both skip flags", async () => {
    vi.spyOn(repo, "listStories").mockResolvedValue([
      makeStory({ id: "a", video_url: "https://gcs/a.mp4" }),
      makeStory({ id: "no-video", video_url: null }),
      makeStory({
        id: "both-skipped",
        video_url: "https://gcs/x.mp4",
        skip_intro: 1,
        skip_outro: 1,
      }),
    ]);
    const enqueueSpy = vi
      .spyOn(queue, "forceEnqueueRender")
      .mockResolvedValue({
        id: "r-a",
        story_id: "a",
        config_hash: "x",
        status: "queued",
      } as unknown as queue.RenderRow);
    vi.spyOn(queue, "logVideoRenderEvent").mockResolvedValue(undefined);

    const resp = await POST();
    const body = await resp.json();
    expect(body.enqueued).toHaveLength(1);
    expect(body.enqueued[0].story_id).toBe("a");
    expect(body.skipped_both_flags).toBe(1);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("POST keeps going past one failing enqueue (reports it, doesn't abort)", async () => {
    vi.spyOn(repo, "listStories").mockResolvedValue([
      makeStory({ id: "a", video_url: "https://gcs/a.mp4" }),
      makeStory({ id: "b", video_url: "https://gcs/b.mp4" }),
      makeStory({ id: "c", video_url: "https://gcs/c.mp4" }),
    ]);
    vi.spyOn(queue, "forceEnqueueRender").mockImplementation(
      async (storyId: string) => {
        if (storyId === "b") throw new Error("simulated db blip");
        return {
          id: `r-${storyId}`,
          story_id: storyId,
          config_hash: "x",
          status: "queued",
        } as unknown as queue.RenderRow;
      },
    );
    vi.spyOn(queue, "logVideoRenderEvent").mockResolvedValue(undefined);

    const resp = await POST();
    const body = await resp.json();
    expect(body.enqueued).toHaveLength(2);
    expect(body.enqueued.map((e: { story_id: string }) => e.story_id)).toEqual(["a", "c"]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].story_id).toBe("b");
    expect(body.failed[0].error).toContain("simulated db blip");
  });
});
