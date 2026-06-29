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

// The route imports `fetch` from `undici` (NOT global fetch) so it can
// pass a long-running `Agent` with raised headersTimeout/bodyTimeout.
// Mock the module at load time so the route's captured `undiciFetch`
// reference is our spy. `Agent` is mocked as a no-op class so the
// route's `new Agent({...})` doesn't try to open a real connection
// pool in the test runtime.
//
// `vi.mock` is hoisted above all imports + locals; the mock factory
// can only reference variables declared via `vi.hoisted`. That's why
// `undiciFetchMock` is created inside hoisted() instead of as a plain
// `const undiciFetchMock = vi.fn()`.
const { undiciFetchMock } = vi.hoisted(() => ({
  undiciFetchMock: vi.fn(),
}));
vi.mock("undici", () => ({
  fetch: undiciFetchMock,
  Agent: class MockAgent {},
}));

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
    undiciFetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.stubEnv("CRON_SECRET", "test-secret");
    vi.stubEnv("CLOUD_RUN_RENDER_URL", "https://run.example.com");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    undiciFetchMock.mockReset();
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
    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.drained).toBe(0);
    expect(undiciFetchMock).not.toHaveBeenCalled();
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
    undiciFetchMock.mockResolvedValue(
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
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    const [callUrl, callInit] = undiciFetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
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

  it("rewrites legacy GCS URLs in inputProps onto MEDIA_PUBLIC_BASE before POSTing to Cloud Run", async () => {
    // The load-bearing assertion for the 2026-06-23 outbound-URL fix:
    // pre-migration GCS URLs persisted in video_config must arrive at
    // Cloud Run already pointed at the R2 delivery host, otherwise
    // Remotion's fetch 404s against GCS and the render fails.
    vi.stubEnv("MEDIA_PUBLIC_BASE", "https://media.lorewire.com");
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
    vi.spyOn(repo, "getStory").mockResolvedValue(
      makeStory(
        JSON.stringify({
          title: "Envelope",
          voiceover_url:
            "https://storage.googleapis.com/aporia-unleash/envelope/voice.mp3",
          hero_image:
            "https://storage.googleapis.com/aporia-unleash/envelope/hero.png?v=abc",
          scenes: [
            {
              url: "https://storage.googleapis.com/aporia-unleash/envelope/scene-00.png",
            },
          ],
          caption: "Just prose, leave alone",
        }),
      ),
    );
    vi.spyOn(queue, "finishRender").mockResolvedValue(undefined);
    undiciFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ url: "https://example/out.mp4" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await GET(makeReq({ auth: "Bearer test-secret" }));

    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    const [, callInit] = undiciFetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(callInit.body as string) as {
      inputProps: {
        voiceover_url: string;
        hero_image: string;
        scenes: { url: string }[];
        caption: string;
      };
    };
    expect(sentBody.inputProps.voiceover_url).toBe(
      "https://media.lorewire.com/envelope/voice.mp3",
    );
    expect(sentBody.inputProps.hero_image).toBe(
      "https://media.lorewire.com/envelope/hero.png?v=abc",
    );
    expect(sentBody.inputProps.scenes[0].url).toBe(
      "https://media.lorewire.com/envelope/scene-00.png",
    );
    expect(sentBody.inputProps.caption).toBe("Just prose, leave alone");
  });

  it("leaves inputProps unchanged when MEDIA_PUBLIC_BASE is unset (dev / pre-cutover)", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
    vi.spyOn(repo, "getStory").mockResolvedValue(
      makeStory(
        JSON.stringify({
          voiceover_url:
            "https://storage.googleapis.com/aporia-unleash/envelope/voice.mp3",
        }),
      ),
    );
    vi.spyOn(queue, "finishRender").mockResolvedValue(undefined);
    undiciFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ url: "https://example/out.mp4" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await GET(makeReq({ auth: "Bearer test-secret" }));

    const [, callInit] = undiciFetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(callInit.body as string) as {
      inputProps: { voiceover_url: string };
    };
    expect(sentBody.inputProps.voiceover_url).toBe(
      "https://storage.googleapis.com/aporia-unleash/envelope/voice.mp3",
    );
  });

  it("fails the render when the story row is gone", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
    vi.spyOn(repo, "getStory").mockResolvedValue(null);
    const failSpy = vi
      .spyOn(queue, "failRender")
      .mockResolvedValue(undefined);

    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.error).toContain("not found");
    // No fetch fired — orchestrator gave up before reaching Cloud Run.
    expect(undiciFetchMock).not.toHaveBeenCalled();
    expect(failSpy).toHaveBeenCalledTimes(1);
  });

  it("fails the render when video_config is NULL", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
    vi.spyOn(repo, "getStory").mockResolvedValue(makeStory(null));
    const failSpy = vi
      .spyOn(queue, "failRender")
      .mockResolvedValue(undefined);

    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.error).toContain("video_config");
    expect(undiciFetchMock).not.toHaveBeenCalled();
    expect(failSpy).toHaveBeenCalledTimes(1);
  });

  it("fails the render when video_config is malformed JSON", async () => {
    vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
    vi.spyOn(repo, "getStory").mockResolvedValue(makeStory("{not json"));
    const failSpy = vi
      .spyOn(queue, "failRender")
      .mockResolvedValue(undefined);

    const resp = await GET(makeReq({ auth: "Bearer test-secret" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("error");
    expect(body.error).toContain("valid JSON");
    expect(undiciFetchMock).not.toHaveBeenCalled();
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
    undiciFetchMock.mockResolvedValue(
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
    undiciFetchMock.mockResolvedValue(
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
    undiciFetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

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

  // Phase 4 of _plans/2026-06-15-cloud-run-intro-outro-splice.md.
  // The dispatcher resolves intro/outro per story and passes the URLs
  // in the segments field on the Cloud Run POST body. When the
  // resolver returns null for either end (skip flag, missing setting,
  // aspect mismatch, etc.) we still POST a `segments` field — Cloud
  // Run treats {intro: null, outro: null} as "body-only render", same
  // as omitting the field entirely. We send it explicitly so a stale
  // Cloud Run image can't accidentally splice old data.
  describe("segments field on Cloud Run POST", () => {
    it("includes resolved intro+outro URLs when both are picked", async () => {
      vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
      vi.spyOn(repo, "getStory").mockResolvedValue({
        ...makeStory(JSON.stringify({ aspect: "9:16" })),
        intro_segment_id: "intro-1",
        outro_segment_id: "outro-1",
      } as unknown as repo.StoryRow);
      vi.spyOn(repo, "getSetting").mockImplementation(async (k: string) => {
        if (k === "video.default_aspect") return "9:16";
        return null;
      });
      vi.spyOn(repo, "getSegment").mockImplementation(async (id: string) => {
        if (id === "intro-1") {
          return {
            id: "intro-1",
            kind: "intro",
            normalized_url: "https://storage.googleapis.com/b/segments/i1.mp4",
            enabled: 1,
            aspect: "9:16",
          } as unknown as repo.SegmentRow;
        }
        if (id === "outro-1") {
          return {
            id: "outro-1",
            kind: "outro",
            normalized_url: "https://storage.googleapis.com/b/segments/o1.mp4",
            enabled: 1,
            aspect: "9:16",
          } as unknown as repo.SegmentRow;
        }
        return null;
      });
      vi.spyOn(queue, "finishRender").mockResolvedValue(undefined);
      undiciFetchMock.mockResolvedValue(
        new Response(JSON.stringify({ url: "https://gcs/x.mp4" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await GET(makeReq({ auth: "Bearer test-secret" }));

      const [, callInit] = undiciFetchMock.mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(callInit.body as string) as {
        segments: { intro: string | null; outro: string | null };
      };
      expect(sent.segments.intro).toBe(
        "https://storage.googleapis.com/b/segments/i1.mp4",
      );
      expect(sent.segments.outro).toBe(
        "https://storage.googleapis.com/b/segments/o1.mp4",
      );
    });

    it("does NOT rewrite intro/outro URLs to MEDIA_PUBLIC_BASE even when the rewriter is active for inputProps", async () => {
      // Regression for the 2026-06-23 "intro and outro missing from rendered
      // short even after manual override" bug. The dispatcher used to call
      // `rewriteStoredMediaUrlsDeep(segments)` for consistency, which when
      // MEDIA_PUBLIC_BASE was set rewrote each segment URL to
      // `media.lorewire.com/<key>` — a host that
      // `video/server/render.ts:parseGcsSegmentUrl` rejects, so the splice
      // was silently skipped and the rendered MP4 came back body-only.
      // Cloud Run downloads segments via the authenticated GCS SDK, so
      // public-read state does not matter and the rewriter is not needed
      // here. Assert the segments pass through verbatim even when
      // MEDIA_PUBLIC_BASE is set (which would activate the rewriter for
      // inputProps).
      const prev = process.env.MEDIA_PUBLIC_BASE;
      process.env.MEDIA_PUBLIC_BASE = "https://media.lorewire.com";
      try {
        vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
        vi.spyOn(repo, "getStory").mockResolvedValue({
          ...makeStory(JSON.stringify({ aspect: "9:16" })),
          intro_segment_id: "intro-1",
          outro_segment_id: "outro-1",
        } as unknown as repo.StoryRow);
        vi.spyOn(repo, "getSetting").mockImplementation(async (k: string) => {
          if (k === "video.default_aspect") return "9:16";
          return null;
        });
        vi.spyOn(repo, "getSegment").mockImplementation(async (id: string) => {
          if (id === "intro-1") {
            return {
              id: "intro-1",
              kind: "intro",
              normalized_url: "https://storage.googleapis.com/b/segments/i1.mp4",
              enabled: 1,
              aspect: "9:16",
            } as unknown as repo.SegmentRow;
          }
          if (id === "outro-1") {
            return {
              id: "outro-1",
              kind: "outro",
              normalized_url: "https://storage.googleapis.com/b/segments/o1.mp4",
              enabled: 1,
              aspect: "9:16",
            } as unknown as repo.SegmentRow;
          }
          return null;
        });
        vi.spyOn(queue, "finishRender").mockResolvedValue(undefined);
        undiciFetchMock.mockResolvedValue(
          new Response(JSON.stringify({ url: "https://gcs/x.mp4" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );

        await GET(makeReq({ auth: "Bearer test-secret" }));

        const [, callInit] = undiciFetchMock.mock.calls[0] as [string, RequestInit];
        const sent = JSON.parse(callInit.body as string) as {
          segments: { intro: string | null; outro: string | null };
        };
        // Original storage.googleapis.com URLs must be preserved — anything
        // else (notably the media.lorewire.com rewrite) makes Cloud Run skip
        // the splice.
        expect(sent.segments.intro).toBe(
          "https://storage.googleapis.com/b/segments/i1.mp4",
        );
        expect(sent.segments.outro).toBe(
          "https://storage.googleapis.com/b/segments/o1.mp4",
        );
      } finally {
        if (prev === undefined) delete process.env.MEDIA_PUBLIC_BASE;
        else process.env.MEDIA_PUBLIC_BASE = prev;
      }
    });

    it("sends {intro: null, outro: null} when the story opts out of both", async () => {
      vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
      vi.spyOn(repo, "getStory").mockResolvedValue({
        ...makeStory(JSON.stringify({ aspect: "9:16" })),
        skip_intro: 1,
        skip_outro: 1,
      } as unknown as repo.StoryRow);
      vi.spyOn(repo, "getSetting").mockResolvedValue(null);
      vi.spyOn(queue, "finishRender").mockResolvedValue(undefined);
      undiciFetchMock.mockResolvedValue(
        new Response(JSON.stringify({ url: "https://gcs/x.mp4" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      await GET(makeReq({ auth: "Bearer test-secret" }));

      const [, callInit] = undiciFetchMock.mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(callInit.body as string) as {
        segments: { intro: string | null; outro: string | null };
      };
      expect(sent.segments).toEqual({ intro: null, outro: null });
    });

    it("falls through to {intro: null, outro: null} when the resolver throws", async () => {
      // The defensive try/catch in resolveSegmentsSafe should swallow
      // the error so the render still produces a body-only MP4 instead
      // of failing the whole row. Simulate by making getSetting throw.
      vi.spyOn(queue, "claimNextRender").mockResolvedValue(FAKE_ROW);
      vi.spyOn(repo, "getStory").mockResolvedValue(
        makeStory(JSON.stringify({ aspect: "9:16" })),
      );
      vi.spyOn(repo, "getSetting").mockRejectedValue(new Error("db down"));
      vi.spyOn(queue, "finishRender").mockResolvedValue(undefined);
      undiciFetchMock.mockResolvedValue(
        new Response(JSON.stringify({ url: "https://gcs/x.mp4" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const resp = await GET(makeReq({ auth: "Bearer test-secret" }));

      // Render still completes successfully — body-only mode.
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.status).toBe("done");
      const [, callInit] = undiciFetchMock.mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(callInit.body as string) as {
        segments: { intro: string | null; outro: string | null };
      };
      expect(sent.segments).toEqual({ intro: null, outro: null });
    });
  });
});
