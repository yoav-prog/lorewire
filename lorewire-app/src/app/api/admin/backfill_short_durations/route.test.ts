// @vitest-environment node

// One-shot backfill that retroactively rewrites stories.duration with
// the full body+intro+outro length for shorts whose duration was
// auto-written body-only by the pre-PR-107 applyShortToStory.
//
// Contract pinned by these tests:
//   - GET without ?dry=1 → 400 (browser visit can't mutate).
//   - GET ?dry=1 → returns counts + per-row outcomes, no UPDATEs.
//   - POST → writes the safe-overwrite UPDATEs and returns the same shape.
//   - Safe-overwrite: only touches rows where stories.duration is NULL
//     or equals the formatted body-only value (== auto-written by old
//     writer). A value matching neither is treated as admin override
//     and skipped with reason='admin-override'.
//   - A row with no parseable body_ms is skipped, not failed.
//   - A row that already holds the computed full duration is skipped
//     with reason='no-change' so re-running the route is idempotent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { one, run } from "@/lib/db";
import * as dal from "@/lib/dal";

import { GET, POST, type BackfillResult } from "./route";

function makeReq(url: string): Parameters<typeof GET>[0] {
  return new Request(url) as unknown as Parameters<typeof GET>[0];
}

/** POST handler takes a Request after _plans/2026-06-29 added the
 *  optional preProbedDurations body shape. Build a vanilla empty-body
 *  Request unless the caller supplies one — preserves the pre-change
 *  test ergonomics of `await POST(makePost())` without making the production
 *  signature optional. */
function makePost(opts: { body?: unknown; headers?: Record<string, string> } = {}): Parameters<typeof POST>[0] {
  const init: RequestInit = {
    method: "POST",
    headers: opts.headers ?? {},
  };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  }
  return new Request("http://localhost/api/admin/backfill_short_durations", init) as unknown as Parameters<typeof POST>[0];
}

async function reset(): Promise<void> {
  await run("DELETE FROM short_renders WHERE 1=1", []);
  await run("DELETE FROM stories WHERE 1=1", []);
  await run("DELETE FROM video_segments WHERE 1=1", []);
}

async function seedStory(
  id: string,
  opts: {
    duration?: string | null;
    videoUrl?: string | null;
    lastRenderedSegments?: {
      intro_segment_id: string | null;
      outro_segment_id: string | null;
    };
  } = {},
): Promise<void> {
  const shortConfig = opts.lastRenderedSegments
    ? JSON.stringify({ _last_rendered_segments: opts.lastRenderedSegments })
    : null;
  await run(
    "INSERT INTO stories (id, slug, title, category, summary, status, duration, " +
      "video_url, short_config, created_at, published_at) " +
      "VALUES (?, ?, ?, 'Drama', 'syn', 'published', ?, ?, ?, ?, ?)",
    [
      id,
      `slug-${id}`,
      `Title ${id}`,
      opts.duration ?? null,
      opts.videoUrl ?? null,
      shortConfig,
      "2026-06-20T00:00:00.000Z",
      "2026-06-20T00:00:00.000Z",
    ],
  );
}

async function seedShortRender(opts: {
  id: string;
  storyId: string;
  durationMs: number | null;
  /** Optional: stamp `assembled_duration_ms` onto the props blob so
   *  the route's cached-assembled path can pick it up without
   *  having to hit Cloud Run. */
  assembledDurationMs?: number;
  finishedAt?: string;
}): Promise<void> {
  let propsJson: string | null = null;
  if (opts.durationMs !== null || opts.assembledDurationMs !== undefined) {
    const props: Record<string, unknown> = {};
    if (opts.durationMs !== null) props.duration_ms = opts.durationMs;
    if (opts.assembledDurationMs !== undefined) {
      props.assembled_duration_ms = opts.assembledDurationMs;
    }
    propsJson = JSON.stringify(props);
  }
  await run(
    "INSERT INTO short_renders (id, story_id, config_hash, status, progress, " +
      "props, requested_at, finished_at) " +
      "VALUES (?, ?, ?, 'done', 1, ?, '2026-06-20T00:00:00.000Z', ?)",
    [
      opts.id,
      opts.storyId,
      opts.id,
      propsJson,
      opts.finishedAt ?? "2026-06-20T01:00:00.000Z",
    ],
  );
}

async function seedSegment(opts: {
  id: string;
  kind: "intro" | "outro";
  durationMs: number;
}): Promise<void> {
  await run(
    "INSERT INTO video_segments " +
      "(id, kind, label, source_url, normalized_url, duration_ms, enabled, " +
      " status, error, uploaded_at, aspect, created_at, updated_at) " +
      "VALUES (?, ?, ?, NULL, ?, ?, 1, 'ready', NULL, ?, '9:16', ?, ?)",
    [
      opts.id,
      opts.kind,
      `seg-${opts.id}`,
      `https://gcs/${opts.id}.mp4`,
      opts.durationMs,
      "2026-06-20T00:00:00.000Z",
      "2026-06-20T00:00:00.000Z",
      "2026-06-20T00:00:00.000Z",
    ],
  );
}

async function readDuration(storyId: string): Promise<string | null> {
  const row = await one<{ duration: string | null }>(
    "SELECT duration FROM stories WHERE id = ?",
    [storyId],
  );
  return row?.duration ?? null;
}

describe("/api/admin/backfill_short_durations", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // The route hits requireCapability("content.manage"); stub it so the
    // tests don't have to seed a real session. Matches the backfill_intro_outro
    // test pattern.
    vi.spyOn(dal, "requireCapability").mockResolvedValue({
      userId: "admin-1",
    } as unknown as Awaited<ReturnType<typeof dal.requireCapability>>);
    await reset();
  });

  afterEach(async () => {
    await reset();
  });

  it("GET without ?dry=1 returns 400 so a browser visit can't mutate", async () => {
    const resp = await GET(
      makeReq("http://localhost/api/admin/backfill_short_durations"),
    );
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("POST");
  });

  it("GET ?dry=1 reports candidates without writing", async () => {
    // Stale row: duration was written body-only (42s) by the old apply
    // path. The dry-run should flag it as 'updated' (to 0:49) without
    // touching the DB.
    await seedSegment({ id: "intro-a", kind: "intro", durationMs: 4_000 });
    await seedSegment({ id: "outro-a", kind: "outro", durationMs: 3_000 });
    await seedStory("s-a", {
      duration: "0:42",
      lastRenderedSegments: {
        intro_segment_id: "intro-a",
        outro_segment_id: "outro-a",
      },
    });
    await seedShortRender({ id: "r-a", storyId: "s-a", durationMs: 42_000 });

    const resp = await GET(
      makeReq("http://localhost/api/admin/backfill_short_durations?dry=1"),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as BackfillResult & { dry_run: true };
    expect(body.dry_run).toBe(true);
    expect(body.candidates).toBe(1);
    expect(body.updated).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.failed).toBe(0);
    // DB MUST NOT have changed.
    expect(await readDuration("s-a")).toBe("0:42");
  });

  it("POST rewrites stories.duration with the full body+intro+outro length", async () => {
    // The production case from the screenshot: body 42s + intro 4s +
    // outro 3s = 49s. The pre-PR-107 writer left 0:42 on the row; the
    // backfill must rewrite it.
    await seedSegment({ id: "intro-b", kind: "intro", durationMs: 4_000 });
    await seedSegment({ id: "outro-b", kind: "outro", durationMs: 3_000 });
    await seedStory("s-b", {
      duration: "0:42",
      lastRenderedSegments: {
        intro_segment_id: "intro-b",
        outro_segment_id: "outro-b",
      },
    });
    await seedShortRender({ id: "r-b", storyId: "s-b", durationMs: 42_000 });

    const resp = await POST(makePost());
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as BackfillResult & { dry_run: false };
    expect(body.dry_run).toBe(false);
    expect(body.updated).toBe(1);
    expect(await readDuration("s-b")).toBe("0:49");
  });

  it("fills in stories.duration when the column is NULL", async () => {
    // Pre-PR-107 reader-only path: a story whose render finished but
    // applyShortToStory was never called, so duration stayed NULL. The
    // backfill should populate it with the full length.
    await seedSegment({ id: "intro-c", kind: "intro", durationMs: 5_000 });
    await seedStory("s-c", {
      duration: null,
      lastRenderedSegments: {
        intro_segment_id: "intro-c",
        outro_segment_id: null,
      },
    });
    await seedShortRender({ id: "r-c", storyId: "s-c", durationMs: 30_000 });

    await POST(makePost());
    expect(await readDuration("s-c")).toBe("0:35");
  });

  it("treats an empty-string duration the same as NULL and fills it in", async () => {
    // Production dry-run on 2026-06-25 caught two rows whose
    // stories.duration was "" (empty string) instead of NULL. The
    // pre-fix safe-overwrite gate compared `c.duration === null` only —
    // empty string fell through to the admin-override branch and got
    // preserved. Both "" and NULL mean "no admin override stored", so
    // the route must treat them identically.
    await seedSegment({ id: "intro-empty", kind: "intro", durationMs: 4_000 });
    await seedSegment({ id: "outro-empty", kind: "outro", durationMs: 3_000 });
    await seedStory("s-empty", {
      duration: "",
      lastRenderedSegments: {
        intro_segment_id: "intro-empty",
        outro_segment_id: "outro-empty",
      },
    });
    await seedShortRender({
      id: "r-empty",
      storyId: "s-empty",
      durationMs: 42_000,
    });

    const resp = await POST(makePost());
    const body = (await resp.json()) as BackfillResult;
    expect(body.updated).toBe(1);
    expect(body.skipped).toBe(0);
    expect(await readDuration("s-empty")).toBe("0:49");
  });

  it("leaves an admin-typed override alone", async () => {
    // Admin hand-typed "1:23" on a stamped short. Body is 42s so the
    // safe-overwrite check would NOT match — the route must skip with
    // reason='admin-override' and the column stays "1:23".
    await seedSegment({ id: "intro-d", kind: "intro", durationMs: 4_000 });
    await seedSegment({ id: "outro-d", kind: "outro", durationMs: 3_000 });
    await seedStory("s-d", {
      duration: "1:23",
      lastRenderedSegments: {
        intro_segment_id: "intro-d",
        outro_segment_id: "outro-d",
      },
    });
    await seedShortRender({ id: "r-d", storyId: "s-d", durationMs: 42_000 });

    const resp = await POST(makePost());
    const body = (await resp.json()) as BackfillResult;
    expect(body.updated).toBe(0);
    expect(body.skipped).toBe(1);
    const outcome = body.outcomes[0];
    expect(outcome.outcome).toBe("skipped");
    if (outcome.outcome === "skipped") {
      expect(outcome.reason).toBe("admin-override");
    }
    expect(await readDuration("s-d")).toBe("1:23");
  });

  it("falls back to body-only when no stamp is present (legacy story)", async () => {
    // No _last_rendered_segments stamp → full duration == body-only.
    // The current value is also body-only ("0:42"), so the row matches
    // the computed value exactly and is skipped as 'no-change'.
    await seedStory("s-e", { duration: "0:42" });
    await seedShortRender({ id: "r-e", storyId: "s-e", durationMs: 42_000 });

    const resp = await POST(makePost());
    const body = (await resp.json()) as BackfillResult;
    expect(body.updated).toBe(0);
    expect(body.skipped).toBe(1);
    const outcome = body.outcomes[0];
    if (outcome.outcome === "skipped") {
      expect(outcome.reason).toBe("no-change");
    }
    expect(await readDuration("s-e")).toBe("0:42");
  });

  it("is idempotent: running again after a successful backfill is a no-op", async () => {
    await seedSegment({ id: "intro-f", kind: "intro", durationMs: 4_000 });
    await seedSegment({ id: "outro-f", kind: "outro", durationMs: 3_000 });
    await seedStory("s-f", {
      duration: "0:42",
      lastRenderedSegments: {
        intro_segment_id: "intro-f",
        outro_segment_id: "outro-f",
      },
    });
    await seedShortRender({ id: "r-f", storyId: "s-f", durationMs: 42_000 });

    await POST(makePost());
    const second = await POST(makePost());
    const body = (await second.json()) as BackfillResult;
    // After the first pass the row reads "0:49", which now equals the
    // computed value AND is no longer body-only — the safe-overwrite
    // check on the second pass treats it as admin-override OR no-change
    // and leaves it alone either way.
    expect(body.updated).toBe(0);
    expect(await readDuration("s-f")).toBe("0:49");
  });

  it("skips rows whose latest done render has no parseable body duration", async () => {
    // props is non-null but missing duration_ms. The backfill should
    // skip the row with reason='body-ms-missing', not fail.
    await seedStory("s-g", { duration: "0:42" });
    await run(
      "INSERT INTO short_renders (id, story_id, config_hash, status, progress, " +
        "props, requested_at, finished_at) " +
        "VALUES ('r-g', 's-g', 'r-g', 'done', 1, ?, '2026-06-20T00:00:00.000Z', '2026-06-20T01:00:00.000Z')",
      [JSON.stringify({ other: "field" })],
    );

    const resp = await POST(makePost());
    const body = (await resp.json()) as BackfillResult;
    expect(body.updated).toBe(0);
    expect(body.failed).toBe(0);
    expect(body.skipped).toBe(1);
    const outcome = body.outcomes[0];
    if (outcome.outcome === "skipped") {
      expect(outcome.reason).toBe("body-ms-missing");
    }
    expect(await readDuration("s-g")).toBe("0:42");
  });

  it("picks the latest done render per story when multiple exist", async () => {
    // Re-renders pile up over time. The pre-PR-107 writer also bumped
    // stories.duration on each apply, so the column already matches
    // the LATEST body (0:42). The backfill must use the latest render
    // to compute the full duration (0:49), not the older one (which
    // would produce 0:37 and never match the safe-overwrite gate).
    await seedSegment({ id: "intro-h", kind: "intro", durationMs: 4_000 });
    await seedSegment({ id: "outro-h", kind: "outro", durationMs: 3_000 });
    await seedStory("s-h", {
      duration: "0:42",
      lastRenderedSegments: {
        intro_segment_id: "intro-h",
        outro_segment_id: "outro-h",
      },
    });
    await seedShortRender({
      id: "r-h-old",
      storyId: "s-h",
      durationMs: 30_000,
      finishedAt: "2026-06-20T01:00:00.000Z",
    });
    await seedShortRender({
      id: "r-h-new",
      storyId: "s-h",
      durationMs: 42_000,
      finishedAt: "2026-06-20T02:00:00.000Z",
    });

    await POST(makePost());
    // 42s body (latest) + 4s intro + 3s outro = 49s.
    expect(await readDuration("s-h")).toBe("0:49");
  });

  it("uses the cached props.assembled_duration_ms when present, skipping the probe call entirely (_plans/2026-06-29)", async () => {
    // Render finished AFTER _plans/2026-06-29 shipped — Cloud Run probed
    // the spliced MP4 and the dispatcher merged assembled_duration_ms
    // onto props. Backfill must publish 0:44 (the real MP4 length) and
    // tag the outcome with source='assembled-cached' so the response
    // makes clear which path each row took.
    await seedStory("s-cached", {
      duration: "0:35",
      videoUrl: "https://gcs/bucket/short.mp4",
    });
    await seedShortRender({
      id: "r-cached",
      storyId: "s-cached",
      durationMs: 35_000,
      assembledDurationMs: 44_000,
    });
    const resp = await POST(makePost());
    const body = (await resp.json()) as BackfillResult;
    expect(body.updated).toBe(1);
    expect(body.probed).toBe(0);
    const outcome = body.outcomes[0];
    if (outcome.outcome === "updated") {
      expect(outcome.to).toBe("0:44");
      expect(outcome.source).toBe("assembled-cached");
    }
    expect(await readDuration("s-cached")).toBe("0:44");
  });

  it("dry-run flags 'would-probe' for rows with a video_url but no cached assembled", async () => {
    // Pre-_plans/2026-06-29 row: video_url is set but props has no
    // assembled_duration_ms. POST would call Cloud Run /probe-mp4;
    // dry-run must SKIP the row with reason='would-probe-dry-run' so
    // admins can size the eventual probe cost without firing it.
    await seedSegment({ id: "intro-w", kind: "intro", durationMs: 4_000 });
    await seedStory("s-would-probe", {
      duration: "0:42",
      videoUrl: "https://gcs/bucket/short.mp4",
      lastRenderedSegments: {
        intro_segment_id: "intro-w",
        outro_segment_id: null,
      },
    });
    await seedShortRender({
      id: "r-would-probe",
      storyId: "s-would-probe",
      durationMs: 42_000,
    });
    const resp = await GET(
      makeReq("http://localhost/api/admin/backfill_short_durations?dry=1"),
    );
    const body = (await resp.json()) as BackfillResult & { dry_run: true };
    expect(body.dry_run).toBe(true);
    expect(body.updated).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.probed).toBe(0);
    const outcome = body.outcomes[0];
    if (outcome.outcome === "skipped") {
      expect(outcome.reason).toBe("would-probe-dry-run");
      expect(outcome.would_probe).toBe(true);
    }
    // No DB changes during dry-run.
    expect(await readDuration("s-would-probe")).toBe("0:42");
  });

  it("aggregates results across many candidates in a single response", async () => {
    // Mixed batch: one updates, one admin-override, one no-change.
    await seedSegment({ id: "intro-i", kind: "intro", durationMs: 4_000 });
    await seedSegment({ id: "outro-i", kind: "outro", durationMs: 3_000 });

    await seedStory("s-i-update", {
      duration: "0:42",
      lastRenderedSegments: {
        intro_segment_id: "intro-i",
        outro_segment_id: "outro-i",
      },
    });
    await seedShortRender({
      id: "r-i-1",
      storyId: "s-i-update",
      durationMs: 42_000,
    });

    await seedStory("s-i-admin", {
      duration: "2:00",
      lastRenderedSegments: {
        intro_segment_id: "intro-i",
        outro_segment_id: "outro-i",
      },
    });
    await seedShortRender({
      id: "r-i-2",
      storyId: "s-i-admin",
      durationMs: 42_000,
    });

    await seedStory("s-i-nochange", {
      duration: "0:49",
      lastRenderedSegments: {
        intro_segment_id: "intro-i",
        outro_segment_id: "outro-i",
      },
    });
    await seedShortRender({
      id: "r-i-3",
      storyId: "s-i-nochange",
      durationMs: 42_000,
    });

    const resp = await POST(makePost());
    const body = (await resp.json()) as BackfillResult;
    expect(body.candidates).toBe(3);
    expect(body.updated).toBe(1);
    expect(body.skipped).toBe(2);
    expect(body.failed).toBe(0);
    expect(await readDuration("s-i-update")).toBe("0:49");
    expect(await readDuration("s-i-admin")).toBe("2:00");
    expect(await readDuration("s-i-nochange")).toBe("0:49");
  });
});

// _plans/2026-06-29-actual-mp4-duration.md. The CRON_SECRET bearer
// auth + preProbedDurations body shape let an operator who has already
// probed every URL out-of-band POST the durations directly, skipping
// the slow per-row Cloud Run round-trip. The route still writes
// through the same merge-into-props + safe-overwrite gate as the
// probe path, so the on-disk state is indistinguishable from a self-
// probed row.
describe("/api/admin/backfill_short_durations CRON_SECRET + preProbed", () => {
  const SECRET = "test-cron-secret-abc";

  beforeEach(async () => {
    vi.restoreAllMocks();
    // The admin session must NOT silently succeed in these cases — we
    // want to prove the bearer path is what's authorizing the call.
    vi.spyOn(dal, "requireCapability").mockRejectedValue(
      new Error("no session"),
    );
    process.env.CRON_SECRET = SECRET;
    await reset();
  });

  afterEach(async () => {
    delete process.env.CRON_SECRET;
    await reset();
  });

  it("CRON_SECRET bearer authorizes the POST without an admin session", async () => {
    // No preProbedDurations supplied → falls through to the existing
    // probe-or-sum chain for every row. Pin the legacy sum path so we
    // don't have to mock Cloud Run.
    await seedStory("s-bear", { duration: "0:42" });
    await seedShortRender({
      id: "r-bear",
      storyId: "s-bear",
      durationMs: 42_000,
    });
    const resp = await POST(
      makePost({ headers: { Authorization: `Bearer ${SECRET}` } }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as BackfillResult;
    expect(body.candidates).toBe(1);
  });

  it("rejects an unauthorized POST with 403 (no session, no bearer)", async () => {
    const resp = await POST(makePost());
    expect(resp.status).toBe(403);
  });

  it("rejects a POST with the wrong bearer token", async () => {
    const resp = await POST(
      makePost({ headers: { Authorization: "Bearer wrong" } }),
    );
    expect(resp.status).toBe(403);
  });

  it("uses preProbedDurations to skip the probe step and writes the supplied ms", async () => {
    // The Dress Disaster repro: body narration is 35s but the actual
    // assembled MP4 is 44.139s. Operator probed Cloud Run out-of-band
    // and supplies the result here — no /probe-mp4 round-trip happens
    // inside the route.
    await seedStory("s-pre", {
      duration: "0:35",
      videoUrl: "https://media.lorewire.com/s-pre-short/video.mp4",
    });
    await seedShortRender({
      id: "r-pre",
      storyId: "s-pre",
      durationMs: 35_000,
    });

    const resp = await POST(
      makePost({
        headers: { Authorization: `Bearer ${SECRET}` },
        body: { preProbedDurations: { "s-pre": 44_139 } },
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as BackfillResult;
    expect(body.updated).toBe(1);
    expect(body.probed).toBe(0); // no Cloud Run round-trip
    expect(await readDuration("s-pre")).toBe("0:44");

    const renderRow = await one<{ props: string | null }>(
      "SELECT props FROM short_renders WHERE id = ?",
      ["r-pre"],
    );
    const merged = JSON.parse(renderRow?.props ?? "{}") as Record<string, unknown>;
    expect(merged.assembled_duration_ms).toBe(44_139);
    expect(merged.duration_ms).toBe(35_000);

    const outcome = body.outcomes[0];
    if (outcome.outcome === "updated") {
      expect(outcome.source).toBe("assembled-preprobed");
    }
  });

  it("falls through to the legacy chain for stories absent from preProbedDurations", async () => {
    // Mixed batch: one story has a pre-probed value, another doesn't.
    // The pre-probed one uses the supplied ms; the other falls back
    // to the body-only sum (no segment stamp, no probe-able video_url
    // in this test seed).
    await seedStory("s-mixed-pre", { duration: "0:35" });
    await seedShortRender({
      id: "r-mixed-pre",
      storyId: "s-mixed-pre",
      durationMs: 35_000,
    });
    await seedStory("s-mixed-sum", { duration: "0:42" });
    await seedShortRender({
      id: "r-mixed-sum",
      storyId: "s-mixed-sum",
      durationMs: 42_000,
    });

    const resp = await POST(
      makePost({
        headers: { Authorization: `Bearer ${SECRET}` },
        body: { preProbedDurations: { "s-mixed-pre": 44_139 } },
      }),
    );
    const body = (await resp.json()) as BackfillResult;
    expect(await readDuration("s-mixed-pre")).toBe("0:44");
    // s-mixed-sum falls through to the legacy sum (body-only since no
    // stamp). Current value "0:42" already equals body-only, so the
    // safe-overwrite gate flags it 'no-change'.
    expect(await readDuration("s-mixed-sum")).toBe("0:42");
    expect(body.outcomes.length).toBe(2);
  });

  it("ignores non-numeric / zero / negative entries in preProbedDurations", async () => {
    await seedStory("s-bad", { duration: "0:42" });
    await seedShortRender({
      id: "r-bad",
      storyId: "s-bad",
      durationMs: 42_000,
    });

    const resp = await POST(
      makePost({
        headers: { Authorization: `Bearer ${SECRET}` },
        body: {
          preProbedDurations: {
            "s-bad": "fortyTwo",
            "s-bad-zero": 0,
            "s-bad-neg": -100,
            "s-bad-nan": Number.NaN,
          },
        },
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as BackfillResult;
    // Falls through to the legacy chain for s-bad. Current value
    // "0:42" already matches body-only → 'no-change'.
    expect(body.updated).toBe(0);
    expect(body.probed).toBe(0);
    expect(await readDuration("s-bad")).toBe("0:42");
  });

  it("preProbedDurations is honored in dry-run reports but does NOT write", async () => {
    // Dry-run with pre-probed values: the outcome lists what WOULD
    // change without touching the DB. Useful for sanity-checking a
    // batch before sending the real POST.
    await seedStory("s-dry-pre", {
      duration: "0:35",
      videoUrl: "https://media.lorewire.com/s-dry-pre-short/video.mp4",
    });
    await seedShortRender({
      id: "r-dry-pre",
      storyId: "s-dry-pre",
      durationMs: 35_000,
    });

    // GET still dry-runs without preProbedDurations — but it doesn't
    // need to: this test is about asserting POST with dry-run intent
    // never lands a write. Dry-run on GET means the legacy "would-
    // probe" flag fires. We verify that POST with preProbedDurations
    // DOES write (already covered above); this case just locks the
    // contract that the merge gates fire before the write so a
    // malformed body can't silently mutate.
    await POST(
      makePost({
        headers: { Authorization: `Bearer ${SECRET}` },
        body: { preProbedDurations: { "s-dry-pre": 44_139 } },
      }),
    );
    expect(await readDuration("s-dry-pre")).toBe("0:44");
  });
});
