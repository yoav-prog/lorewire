// @vitest-environment node

// Phase 2 of _plans/2026-06-14-cloud-run-render.md.
//
// Tests the Vercel cron orchestrator. We stub the queue helpers + the
// fetch to Cloud Run because the orchestrator is pure plumbing — its
// job is to glue (claim → POST → write-back) correctly, not to render
// or hit the DB itself. The contract we lock:
//   - Missing/wrong CRON_SECRET → 401.
//   - Empty queue → 200 with { drained: 0 } and NO fetch fires.
//   - Cloud Run returns { url } → finishRender called, NOT failRender.
//   - Cloud Run returns 5xx → failRender called with the HTTP status
//     in the message.
//   - Cloud Run returns 200 but malformed body → failRender called.
//   - Network error (fetch throws) → failRender called.
//   - CLOUD_RUN_RENDER_URL or CRON_SECRET missing → 500.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";
import * as queue from "@/lib/video-render-queue";
import * as repo from "@/lib/repo";

// Minimal story row stub. getStory returns a full StoryRow but the
// dispatcher only reads `video_config`, so the test only fills that
// + the id. Cast via `as` so TypeScript accepts the partial shape.
function makeStory(
  videoConfig: string | null,
): repo.StoryRow {
  return {
    id: "envelope",
    video_config: videoConfig,
  } as unknown as repo.StoryRow;
}

// NextRequest is a thin wrapper over Request. For these tests a plain
// Request suffices (Route handlers accept NextRequest but Request
// works at runtime). We import the type from the route module path
// indirectly via the NextRequest-shaped object the handlers expect.
function makeReq(
  opts: {
    auth?: string;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
  } = {},
) {
  const headers = new Headers(opts.headers ?? {});
  if (opts.auth !== undefined) {
    headers.set("authorization", opts.auth);
  }
  // The handler only reads headers; URL is required to construct a
  // Request. We pick a stable placeholder so the test is hermetic.
  return new Request("http://localhost/api/render_video", {
    method: opts.method ?? "GET",
    headers,
  }) as unknown as Parameters<typeof GET>[0];
}

const FAKE_ROW: queue.RenderRow = {
  id: "r-1",
  story_id: "envelope",
  config_hash: "deadbeef00112233",
  status: "rendering",
  progress: 0,
  error: null,
  output_url: null,
  requested_by: "user-1",
  requested_at: "2026-06-14T00:00:00.000Z",
  started_at: "2026-06-14T00:01:00.000Z",
  finished_at: null,
};

describe("/api/render_video (Vercel cron orchestrator)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("CRON_SECRET", "test-secret");
    vi.stubEnv("CLOUD_RUN_RENDER_URL", "https://run.example.com");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns 401 when CRON_SECRET header is missing", async () => {
    const claimSpy = vi.spyOn(queue, "claimNextRender");
    const resp = await GET(makeReq());
    expect(resp.status).toBe(401);
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when CRON_SECRET header is wrong", async () => {
    const resp = await GET(makeReq({ auth: "Bearer wrong" }));
    expect(resp.status).toBe(401);
  });

  it("returns 500 when CLOUD_RUN_RENDER_URL is unconfigured", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("CRON_SECRET", "test-secret");
    // CLOUD_RUN_RENDER_URL deliberately not set.
    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));
    expect(resp.status).toBe(500);
    const body = await resp.json();
    expect(body.error).toContain("CLOUD_RUN_RENDER_URL");
  });

  it("returns { drained: 0 } when the queue is empty + does NOT fire fetch", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.drained).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs to Cloud Run + writes URL via finishRender on success", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
    vi.spyOn(repo, "getStory").mockResolvedValue(
      makeStory(
        JSON.stringify({
          voiceover_url: "https://gcs/envelope/narration.mp3",
          title: "Envelope",
          duration_ms: 131000,
        }),
      ),
    );
    const finishSpy = vi
      .spyOn(queue, "finishRender")
      .mockResolvedValue(undefined);
    const failSpy = vi
      .spyOn(queue, "failRender")
      .mockResolvedValue(undefined);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ url: "https://storage.googleapis.com/b/envelope/video.mp4" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.drained).toBe(1);
    expect(body.status).toBe("done");
    expect(body.url).toBe(
      "https://storage.googleapis.com/b/envelope/video.mp4",
    );

    // Verify the Cloud Run POST went where we expect AND carries the
    // shared-secret header AND the real inputProps (not an empty
    // placeholder). This is the load-bearing assertion of this PR —
    // the previous Phase 2 code shipped `inputProps: {}` which would
    // render the composition's DEFAULT_PROPS (5-second preview) and
    // not the actual story.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [callUrl, callInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(callUrl).toBe("https://run.example.com/render");
    expect(callInit.method).toBe("POST");
    const authHeader = new Headers(callInit.headers as HeadersInit).get(
      "authorization",
    );
    expect(authHeader).toBe("Bearer test-secret");
    const sentBody = JSON.parse(callInit.body as string) as {
      storyId: string;
      configHash: string;
      inputProps: { voiceover_url?: string; title?: string };
    };
    expect(sentBody.storyId).toBe("envelope");
    expect(sentBody.inputProps.voiceover_url).toBe(
      "https://gcs/envelope/narration.mp3",
    );
    expect(sentBody.inputProps.title).toBe("Envelope");

    // Verify writeback chose the success path, not the failure path.
    expect(finishSpy).toHaveBeenCalledWith(
      "r-1",
      "envelope",
      "https://storage.googleapis.com/b/envelope/video.mp4",
    );
    expect(failSpy).not.toHaveBeenCalled();
  });

  it("fails the render when the story row is gone", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
    vi.spyOn(repo, "getStory").mockResolvedValue(null);
    const failSpy = vi
      .spyOn(queue, "failRender")
      .mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.error).toContain("not found");
    // No fetch fired — orchestrator gave up before reaching Cloud Run.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(failSpy).toHaveBeenCalledTimes(1);
  });

  it("fails the render when video_config is NULL", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
    vi.spyOn(repo, "getStory").mockResolvedValue(makeStory(null));
    const failSpy = vi
      .spyOn(queue, "failRender")
      .mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.error).toContain("video_config");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(failSpy).toHaveBeenCalledTimes(1);
  });

  it("fails the render when video_config is malformed JSON", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
    vi.spyOn(repo, "getStory").mockResolvedValue(makeStory("{not json"));
    const failSpy = vi
      .spyOn(queue, "failRender")
      .mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.error).toContain("valid JSON");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(failSpy).toHaveBeenCalledTimes(1);
  });

  it("calls failRender with HTTP status when Cloud Run returns 5xx", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
    vi.spyOn(repo, "getStory").mockResolvedValue(
      makeStory(JSON.stringify({ voiceover_url: "x" })),
    );
    const finishSpy = vi
      .spyOn(queue, "finishRender")
      .mockResolvedValue(undefined);
    const failSpy = vi
      .spyOn(queue, "failRender")
      .mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("internal error", { status: 503 }),
    );

    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.error).toContain("503");

    expect(finishSpy).not.toHaveBeenCalled();
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(failSpy.mock.calls[0][0]).toBe("r-1");
    expect(failSpy.mock.calls[0][1]).toContain("503");
  });

  it("calls failRender when Cloud Run returns 200 but a malformed body", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
    vi.spyOn(repo, "getStory").mockResolvedValue(
      makeStory(JSON.stringify({ voiceover_url: "x" })),
    );
    const failSpy = vi
      .spyOn(queue, "failRender")
      .mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ wrong: "shape" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.error).toContain("malformed");
    expect(failSpy).toHaveBeenCalledTimes(1);
  });

  it("calls failRender when fetch throws (network error)", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
    vi.spyOn(repo, "getStory").mockResolvedValue(
      makeStory(JSON.stringify({ voiceover_url: "x" })),
    );
    const failSpy = vi
      .spyOn(queue, "failRender")
      .mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.error).toContain("ECONNREFUSED");
    expect(failSpy).toHaveBeenCalledTimes(1);
  });

  it("POST verb works identically to GET (manual kick parity)", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(null);
    const resp = await POST(
      makeReq({ auth: "Bearer test-secret", method: "POST" }),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.drained).toBe(0);
  });
});
