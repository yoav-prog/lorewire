// Tests for the /api/auto_complete_publish cron's pipeline-running guard
// (plan: _plans/2026-07-02-content-admin-cleanup-and-full-pipeline.md).
//
// The guard: a flagged story whose reddit_id has a queued/processing
// story_jobs row is skipped WITHOUT incrementing auto_publish_attempts —
// the pipeline is actively rewriting the story, so the completeness gate
// could see stale-but-complete assets and publish old media, and the
// retry budget shouldn't burn while the rebuild runs. Once the job lands
// the normal gate flow resumes (and a not-ready story then DOES burn an
// attempt).
//
// Publishers + side-effect modules are mocked (they read platform env at
// call time); the DB, the completeness gate, and the attempts counter are
// real against the per-process SQLite test DB.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/poll-autodraft", () => ({
  autoDraftPollForSubject: vi.fn().mockResolvedValue({ ok: false, ai: false }),
}));
vi.mock("@/lib/publish-auto-curate", () => ({
  autoCurateOnPublish: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/seo-metadata", () => ({
  ensureSeoMetadataForStory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/publish-to-facebook", () => ({
  publishShortToFacebook: vi.fn(),
}));
vi.mock("@/lib/publish-to-instagram", () => ({
  publishShortToInstagram: vi.fn(),
}));
vi.mock("@/lib/publish-to-youtube", () => ({
  publishShortToYouTube: vi.fn(),
}));
vi.mock("@/lib/publish-to-tiktok", () => ({
  publishShortToTikTok: vi.fn(),
}));
vi.mock("@/lib/publish-to-facebook-story", () => ({
  publishShortToFacebookStory: vi.fn(),
  SETTING_AUTO_PUBLISH: "facebook_story.auto_publish",
}));
vi.mock("@/lib/publish-to-instagram-story", () => ({
  publishShortToInstagramStory: vi.fn(),
  SETTING_AUTO_PUBLISH: "instagram_story.auto_publish",
}));

// Import AFTER the mocks so the route picks up the stubs.
import { POST } from "@/app/api/auto_complete_publish/route";

const CRON_SECRET = "test-cron-secret";

function makeRequest(): Request {
  return new Request("https://example.test/api/auto_complete_publish", {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

async function reset(): Promise<void> {
  await run("DELETE FROM stories WHERE 1=1", []);
  await run("DELETE FROM story_jobs WHERE 1=1", []);
  await run("DELETE FROM short_renders WHERE 1=1", []);
}

/** A flagged, unpublished story whose assets are incomplete (no hero, no
 *  short) — the "waiting on the pipeline" shape the guard exists for. */
async function seedFlaggedStory(): Promise<{ id: string; redditId: string }> {
  const id = randomUUID();
  const redditId = `1${id.slice(0, 6).replace(/-/g, "0")}`;
  await run(
    "INSERT INTO stories (id, reddit_id, slug, title, status, body, " +
      "auto_publish_when_ready, auto_publish_attempts, source_url, created_at, updated_at) " +
      "VALUES (?, ?, ?, 'T', 'review', 'body', 1, 0, ?, " +
      "'2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')",
    [
      id,
      redditId,
      `story-${id.slice(0, 6)}`,
      `https://www.reddit.com/r/aita/comments/${redditId}/`,
    ],
  );
  return { id, redditId };
}

async function attemptsFor(id: string): Promise<number> {
  const row = await one<{ n: number | null }>(
    "SELECT auto_publish_attempts AS n FROM stories WHERE id = ?",
    [id],
  );
  return row?.n ?? -1;
}

beforeEach(async () => {
  process.env.CRON_SECRET = CRON_SECRET;
  await reset();
});

describe("/api/auto_complete_publish pipeline-running guard", () => {
  it("skips a flagged story with an active pipeline job without burning an attempt", async () => {
    const { id, redditId } = await seedFlaggedStory();
    await run(
      "INSERT INTO story_jobs (id, reddit_id, status, requested_at) " +
        "VALUES (?, ?, 'processing', '2026-07-02T00:00:00.000Z')",
      [randomUUID(), redditId],
    );

    const res = await POST(makeRequest() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drained).toBe(1);
    expect(body.still_waiting).toBe(1);
    expect(body.published).toBe(0);

    // No attempt burned, flag intact, story untouched.
    expect(await attemptsFor(id)).toBe(0);
    const after = await one<{ status: string; auto_publish_when_ready: number }>(
      "SELECT status, auto_publish_when_ready FROM stories WHERE id = ?",
      [id],
    );
    expect(after!.status).toBe("review");
    expect(after!.auto_publish_when_ready).toBe(1);
  });

  it("resumes the normal not-ready flow (attempt burned) once the job lands", async () => {
    const { id, redditId } = await seedFlaggedStory();
    await run(
      "INSERT INTO story_jobs (id, reddit_id, status, requested_at) " +
        "VALUES (?, ?, 'done', '2026-07-02T00:00:00.000Z')",
      [randomUUID(), redditId],
    );

    const res = await POST(makeRequest() as never);
    const body = await res.json();
    expect(body.still_waiting).toBe(1);
    // Assets are genuinely missing and no pipeline is running — this
    // tick counts against the retry budget.
    expect(await attemptsFor(id)).toBe(1);
  });

  it("ignores queued/processing jobs of OTHER reddit ids", async () => {
    const { id } = await seedFlaggedStory();
    await run(
      "INSERT INTO story_jobs (id, reddit_id, status, requested_at) " +
        "VALUES (?, '1zzzzzz', 'processing', '2026-07-02T00:00:00.000Z')",
      [randomUUID()],
    );

    await POST(makeRequest() as never);
    expect(await attemptsFor(id)).toBe(1);
  });

  it("rejects a request without the cron secret", async () => {
    const res = await POST(
      new Request("https://example.test/api/auto_complete_publish", {
        method: "POST",
      }) as never,
    );
    expect(res.status).toBe(401);
    expect((await all("SELECT 1 AS x", [])).length).toBe(1); // DB untouched sanity
  });
});
