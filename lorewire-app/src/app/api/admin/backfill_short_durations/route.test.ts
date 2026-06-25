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
import { all, one, run } from "@/lib/db";
import * as dal from "@/lib/dal";

import { GET, POST, type BackfillResult } from "./route";

function makeReq(url: string): Parameters<typeof GET>[0] {
  return new Request(url) as unknown as Parameters<typeof GET>[0];
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
      "short_config, created_at, published_at) " +
      "VALUES (?, ?, ?, 'Drama', 'syn', 'published', ?, ?, ?, ?)",
    [
      id,
      `slug-${id}`,
      `Title ${id}`,
      opts.duration ?? null,
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
  finishedAt?: string;
}): Promise<void> {
  await run(
    "INSERT INTO short_renders (id, story_id, config_hash, status, progress, " +
      "props, requested_at, finished_at) " +
      "VALUES (?, ?, ?, 'done', 1, ?, '2026-06-20T00:00:00.000Z', ?)",
    [
      opts.id,
      opts.storyId,
      opts.id,
      opts.durationMs === null
        ? null
        : JSON.stringify({ duration_ms: opts.durationMs }),
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

    const resp = await POST();
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

    await POST();
    expect(await readDuration("s-c")).toBe("0:35");
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

    const resp = await POST();
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

    const resp = await POST();
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

    await POST();
    const second = await POST();
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

    const resp = await POST();
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

    await POST();
    // 42s body (latest) + 4s intro + 3s outro = 49s.
    expect(await readDuration("s-h")).toBe("0:49");
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

    const resp = await POST();
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
