// @vitest-environment node

// One-shot backfill route for Phase 3 OG posters. Per
// _plans/2026-06-29-phase-3-og-poster-cards.md.
//
// Contract pinned by these tests:
//   - GET ?dry=1 lists what would be processed without calling
//     ensureOgPoster (no LLM tokens / Cloud Run spend).
//   - POST actually invokes ensureOgPoster per eligible row.
//   - Stories with og_poster_landscape_url already set are NOT
//     candidates (the SQL filter excludes them).
//   - Stories with og_poster_disabled=true are SKIPPED with
//     reason='disabled_per_story' (per-story kill switch).
//   - Stories whose og_poster_attempted_at is inside the 7-day
//     re-attempt window are SKIPPED with reason='reattempt_window'
//     (Contrarian Failure Mode #1 — don't burn LLM + Cloud Run
//     cycles on the same broken stories).
//   - `?limit=N` caps eligible processing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "@/lib/db";
import * as dal from "@/lib/dal";
import * as posterModule from "@/lib/short-poster";

import { GET, POST } from "./route";

function makeReq(url: string): Parameters<typeof GET>[0] {
  return new Request(url) as unknown as Parameters<typeof GET>[0];
}

async function reset(): Promise<void> {
  await run("DELETE FROM short_renders WHERE 1=1", []);
  await run("DELETE FROM stories WHERE 1=1", []);
}

async function seed(
  id: string,
  opts: {
    shortConfig?: Record<string, unknown> | null;
    status?: string;
  } = {},
): Promise<void> {
  const shortConfigJson =
    opts.shortConfig === null || opts.shortConfig === undefined
      ? null
      : JSON.stringify(opts.shortConfig);
  await run(
    "INSERT INTO stories (id, slug, title, category, summary, status, " +
      "short_config, created_at, published_at) " +
      "VALUES (?, ?, ?, 'Drama', 'syn', ?, ?, ?, ?)",
    [
      id,
      `slug-${id}`,
      `Title ${id}`,
      opts.status ?? "published",
      shortConfigJson,
      "2026-06-29T00:00:00.000Z",
      "2026-06-29T00:00:00.000Z",
    ],
  );
}

describe("/api/admin/backfill_og_posters", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(dal, "requireCapability").mockResolvedValue({
      userId: "admin-1",
    } as unknown as Awaited<ReturnType<typeof dal.requireCapability>>);
    await reset();
  });

  afterEach(async () => {
    await reset();
  });

  it("dry-run does not call ensureOgPoster (zero LLM + Cloud Run spend)", async () => {
    await seed("s-1");
    await seed("s-2", { shortConfig: { poster_text: "x" } });
    const ensureSpy = vi
      .spyOn(posterModule, "ensureOgPoster")
      .mockResolvedValue(null);

    const resp = await GET(
      makeReq("http://localhost/api/admin/backfill_og_posters?dry=1"),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.candidates).toBe(2);
    // Two rows match "no og_poster_landscape_url", both flagged as
    // would_render_dry_run, ensure was not called.
    expect(ensureSpy).not.toHaveBeenCalled();
    const dryOutcomes = body.outcomes.filter(
      (o: { outcome: string }) => o.outcome === "skipped",
    );
    expect(dryOutcomes.every((o: { reason: string }) => o.reason === "would_render_dry_run")).toBe(true);
  });

  it("excludes stories that already have og_poster_landscape_url stamped", async () => {
    await seed("s-stamped", {
      shortConfig: {
        og_poster_landscape_url:
          "https://media.lorewire.com/x/poster-landscape-abc.png?v=abc",
      },
    });
    await seed("s-unstamped");
    const ensureSpy = vi
      .spyOn(posterModule, "ensureOgPoster")
      .mockResolvedValue(null);

    const resp = await GET(
      makeReq("http://localhost/api/admin/backfill_og_posters?dry=1"),
    );
    const body = await resp.json();
    // Only s-unstamped should appear; the SQL filter excludes
    // s-stamped.
    expect(body.candidates).toBe(1);
    expect(body.outcomes[0].story_id).toBe("s-unstamped");
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("skips disabled_per_story stories (per-story kill switch)", async () => {
    await seed("s-disabled", {
      shortConfig: { og_poster_disabled: true },
    });
    const ensureSpy = vi
      .spyOn(posterModule, "ensureOgPoster")
      .mockResolvedValue(null);

    const resp = await POST(
      makeReq("http://localhost/api/admin/backfill_og_posters"),
    );
    const body = await resp.json();
    expect(body.candidates).toBe(1);
    const outcome = body.outcomes[0];
    expect(outcome.outcome).toBe("skipped");
    expect(outcome.reason).toBe("disabled_per_story");
    // The per-story skip happens BEFORE ensureOgPoster, so no LLM /
    // Cloud Run spend even though we passed POST.
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("skips stories inside the 7-day re-attempt window (Contrarian FM#1)", async () => {
    // 6 days ago — inside the window.
    const sixDaysAgoIso = new Date(
      Date.now() - 6 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await seed("s-recent-attempt", {
      shortConfig: { og_poster_attempted_at: sixDaysAgoIso },
    });
    const ensureSpy = vi
      .spyOn(posterModule, "ensureOgPoster")
      .mockResolvedValue(null);

    const resp = await POST(
      makeReq("http://localhost/api/admin/backfill_og_posters"),
    );
    const body = await resp.json();
    expect(body.candidates).toBe(1);
    const outcome = body.outcomes[0];
    expect(outcome.outcome).toBe("skipped");
    expect(outcome.reason).toBe("reattempt_window");
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it("re-attempts stories past the 7-day window", async () => {
    // 8 days ago — past the window.
    const eightDaysAgoIso = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await seed("s-stale-attempt", {
      shortConfig: { og_poster_attempted_at: eightDaysAgoIso },
    });
    const ensureSpy = vi
      .spyOn(posterModule, "ensureOgPoster")
      .mockResolvedValue({
        url: "https://media.lorewire.com/x.png?v=h",
        alt: "alt",
        hash: "h".padEnd(16, "0") as string,
        width: 1200,
        height: 630,
        source: "rendered",
      } as Awaited<ReturnType<typeof posterModule.ensureOgPoster>>);

    const resp = await POST(
      makeReq("http://localhost/api/admin/backfill_og_posters"),
    );
    const body = await resp.json();
    expect(body.rendered).toBe(1);
    expect(body.failed).toBe(0);
    expect(ensureSpy).toHaveBeenCalledOnce();
    expect(ensureSpy).toHaveBeenCalledWith("s-stale-attempt");
  });

  it("respects ?limit=N for eligible rows", async () => {
    // Seed 5 eligible stories.
    for (let i = 0; i < 5; i++) {
      await seed(`s-${i}`);
    }
    const ensureSpy = vi
      .spyOn(posterModule, "ensureOgPoster")
      .mockResolvedValue({
        url: "https://x.png?v=h",
        alt: "a",
        hash: "h".padEnd(16, "0"),
        width: 1200,
        height: 630,
        source: "rendered",
      } as Awaited<ReturnType<typeof posterModule.ensureOgPoster>>);

    const resp = await POST(
      makeReq("http://localhost/api/admin/backfill_og_posters?limit=2"),
    );
    const body = await resp.json();
    // 5 candidates total, 2 processed (rendered), 3 not visited.
    expect(body.candidates).toBe(5);
    expect(body.rendered).toBe(2);
    expect(ensureSpy).toHaveBeenCalledTimes(2);
  });

  it("counts failed when ensureOgPoster throws", async () => {
    await seed("s-boom");
    vi.spyOn(posterModule, "ensureOgPoster").mockRejectedValue(
      new Error("simulated"),
    );

    const resp = await POST(
      makeReq("http://localhost/api/admin/backfill_og_posters"),
    );
    const body = await resp.json();
    expect(body.failed).toBe(1);
    const outcome = body.outcomes[0];
    expect(outcome.outcome).toBe("failed");
    expect(outcome.error).toMatch(/simulated/);
  });
});
