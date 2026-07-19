// Tests for the bulk Content actions wired up at
// /admin/content (ContentList client island). The actions themselves live in
// src/app/admin/actions.ts; they own the validation, the per-item failure
// collection, and the publish-time alt-missing guard for articles.
//
// We mock the admin guard and the Next caching APIs because they're side
// effects, not behavior under test. Everything else exercises the real repo
// against the per-process SQLite test DB (see tests/setup.ts).
//
// Plan: _plans/2026-06-19-content-bulk-actions.md.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import { createArticle, setArticleStatus } from "@/lib/repo";

// Mock the admin guard, the cache revalidator, and the GCS media cleanup.
// requireAdmin() would otherwise call redirect() when there's no session,
// which throws inside test context.
// The bulk regen action reads `session.userId` and `session.email` from the
// capability gate, so the mock returns a SessionData-shaped object instead of
// null. Existing bulk-update / bulk-delete tests ignore the return value, so
// the shape change is backward-compatible.
// The literal is inlined inside the factory because vi.mock is hoisted to
// the top of the file — a `const TEST_SESSION = {...}` above it is not yet
// initialised at hoist time and crashes the suite import.
vi.mock("@/lib/dal", () => {
  const session = {
    userId: "test-user",
    email: "test@lorewire.local",
    role: "admin",
  };
  return {
    requireAdmin: vi.fn().mockResolvedValue(session),
    requireCapability: vi.fn().mockResolvedValue(session),
    requireStaff: vi.fn().mockResolvedValue(session),
    ensureSeedAdmin: vi.fn().mockResolvedValue(null),
    currentUser: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
// poll-autodraft pulls in models + Anthropic config at import time; the
// bulk-publish path only fires it as a best-effort side effect, so mocking
// the entry point keeps the test self-contained and offline.
vi.mock("@/lib/poll-autodraft", () => ({
  autoDraftPollForSubject: vi.fn().mockResolvedValue(null),
}));

// Track GCS deletes so the delete test can verify both audio_url and
// video_url were passed in.
const gcsCalls: { audioUrl: string | null; videoUrl: string | null }[] = [];
vi.mock("@/lib/gcs", () => ({
  deleteStoryMedia: vi.fn(async (audioUrl, videoUrl) => {
    gcsCalls.push({ audioUrl, videoUrl });
    return { attempted: 2, skipped: 0 };
  }),
}));

// The bulk AI reclassify action calls the TS classifier once per story;
// mocking the module boundary keeps the suite offline and lets each test
// script the model's answer. Referenced lazily inside the factory (same
// pattern as gcsCalls above) so vi.mock hoisting doesn't hit the TDZ.
const classifyStoryTagsMock = vi.fn<
  (input: unknown) => Promise<{ slug: string; confidence: number }[]>
>();
vi.mock("@/lib/category-tags-classifier", () => ({
  classifyStoryTags: (input: unknown) => classifyStoryTagsMock(input),
}));

// The bulk title-regen action calls regenerateTitleForStory once per story
// (an inline LLM call). Mock it at the module boundary so the suite stays
// offline and each test scripts the outcome. actions.ts imports this module
// dynamically, but vi.mock intercepts dynamic imports too. Same lazy-reference
// pattern as classifyStoryTagsMock to dodge vi.mock hoisting's TDZ.
type RegenTitleResult =
  | { ok: true; title: string; previousTitle: string | null; model: string }
  | { ok: false; error: string; stage: string };
const regenerateTitleForStoryMock = vi.fn<
  (storyId: string) => Promise<RegenTitleResult>
>();
vi.mock("@/lib/title-regenerator", () => ({
  regenerateTitleForStory: (storyId: string) =>
    regenerateTitleForStoryMock(storyId),
}));

// Import AFTER vi.mock so the action module picks up the mocked deps.
import {
  bulkUpdateContentAction,
  bulkUpdateContentByFilterAction,
  bulkDeleteContentAction,
  bulkFullPipelineAction,
  bulkReclassifyContentAction,
  bulkRegenerateContentAction,
  bulkRegenerateTitlesAction,
  bulkRestartPipelineForceAction,
  type BulkContentItem,
  type BulkUpdateOp,
} from "@/app/admin/actions";

async function reset(): Promise<void> {
  await run("DELETE FROM stories WHERE 1=1", []);
  await run("DELETE FROM story_tags WHERE 1=1", []);
  await run("DELETE FROM articles WHERE 1=1", []);
  await run("DELETE FROM article_revisions WHERE 1=1", []);
  await run("DELETE FROM image_renders WHERE 1=1", []);
  await run("DELETE FROM voice_renders WHERE 1=1", []);
  await run("DELETE FROM story_jobs WHERE 1=1", []);
  await run("DELETE FROM reddit_source WHERE 1=1", []);
  await run("DELETE FROM short_renders WHERE 1=1", []);
  await run("DELETE FROM admin_audit_log WHERE 1=1", []);
  gcsCalls.length = 0;
}

async function seedStory(opts: {
  id?: string;
  title?: string;
  status?: string;
  category?: string;
  audioUrl?: string;
  videoUrl?: string;
}): Promise<string> {
  const id = opts.id ?? randomUUID();
  // reddit_id + source_url are populated so the publish-time guard in
  // setStatus (lib/repo.ts) doesn't reject the fixture as a dry-run row.
  // The id-as-reddit_id pattern matches what the pipeline writes for
  // real Reddit pulls (story_jobs_worker.py: id = idea["reddit_id"]).
  // The hex prefix on the slug guarantees a digit so the strict reddit-
  // post-id check passes too.
  const redditId = `1${id.slice(0, 6).replace(/-/g, "0")}`;
  await run(
    "INSERT INTO stories (id, reddit_id, slug, title, status, category, audio_url, video_url, body, source_url, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-06-19T00:00:00.000Z', '2026-06-19T00:00:00.000Z')",
    [
      id,
      redditId,
      `story-${id.slice(0, 6)}`,
      opts.title ?? "Test story",
      opts.status ?? "ready",
      opts.category ?? "Drama",
      opts.audioUrl ?? null,
      opts.videoUrl ?? null,
      // <50 chars so the autodraft side-effect early-outs even without the
      // mock catching it.
      "short body",
      `https://www.reddit.com/r/aita/comments/${redditId}/`,
    ],
  );
  return id;
}

async function seedArticle(opts: {
  id?: string;
  title?: string;
  status?: string;
  document?: unknown;
}): Promise<string> {
  const id = opts.id ?? randomUUID();
  await createArticle({
    id,
    type: "feature",
    language: "en",
    slug: `art-${id.slice(0, 6)}`,
    title: opts.title ?? "Test article",
    author_id: null,
  });
  if (opts.status) {
    await setArticleStatus(id, opts.status as "draft" | "review" | "published" | "archived");
  }
  if (opts.document !== undefined) {
    await run("UPDATE articles SET document = ? WHERE id = ?", [
      typeof opts.document === "string"
        ? opts.document
        : JSON.stringify(opts.document),
      id,
    ]);
  }
  return id;
}

beforeEach(async () => {
  await reset();
  classifyStoryTagsMock.mockReset();
  regenerateTitleForStoryMock.mockReset();
});

// --- Input validation -------------------------------------------------------

describe("bulkUpdateContentAction: validation", () => {
  it("throws on an empty item list", async () => {
    await expect(
      bulkUpdateContentAction([], { type: "status", status: "draft" }),
    ).rejects.toThrow(/empty/);
  });

  it("throws past the 200-item cap", async () => {
    const items: BulkContentItem[] = Array.from({ length: 201 }, () => ({
      kind: "story",
      id: randomUUID(),
    }));
    await expect(
      bulkUpdateContentAction(items, { type: "status", status: "draft" }),
    ).rejects.toThrow(/exceeds/);
  });

  it("rejects a status not in the closed enum", async () => {
    const id = await seedStory({});
    await expect(
      bulkUpdateContentAction(
        [{ kind: "story", id }],
        { type: "status", status: "bogus" },
      ),
    ).rejects.toThrow(/invalid status/);
  });

  it("rejects a category not in the closed enum", async () => {
    const id = await seedStory({});
    await expect(
      bulkUpdateContentAction(
        [{ kind: "story", id }],
        { type: "category", category: "Bogus" },
      ),
    ).rejects.toThrow(/invalid category/);
  });
});

// --- Mixed-batch status change ----------------------------------------------

describe("bulkUpdateContentAction: status change", () => {
  it("publishes one story and one article together; not-found is reported in failures", async () => {
    // The bulk publish path runs evaluateAssetCompleteness (2026-06-25)
    // and setStatus's publish-time media invariant (2026-07-02), so the
    // story fixture needs the FULL asset chain: hero + thumbnail
    // variants + a done short render + video_url + an enabled poll.
    // Pre-2026-07-02 this fixture was incomplete and the test failed
    // with `asset-incomplete` — fixed alongside the video_url gate
    // (_plans/2026-07-02-never-publish-without-video.md).
    const storyId = await seedStory({
      status: "ready",
      videoUrl: "https://example.com/short.mp4",
    });
    await run(
      "UPDATE stories SET hero_image = ?, hero_image_landscape = ?, " +
        "thumbnail_image = ?, thumbnail_image_landscape = ?, " +
        "thumbnail_image_square = ? WHERE id = ?",
      [
        "https://example.com/hero.png",
        "https://example.com/hero-landscape.png",
        "https://example.com/thumb.png",
        "https://example.com/thumb-landscape.png",
        "https://example.com/thumb-square.png",
        storyId,
      ],
    );
    await run(
      "INSERT INTO short_renders (id, story_id, status, output_url, props, requested_at) " +
        "VALUES (?, ?, 'done', 'https://example.com/short.mp4', '{}', '2026-06-24T00:00:00.000Z')",
      [`${storyId}-short`, storyId],
    );
    await run(
      "INSERT INTO polls (id, story_id, article_id, question, option_a_text, option_b_text, " +
        "enabled, category, created_at, updated_at) " +
        "VALUES (?, ?, NULL, 'Who is right?', 'A', 'B', 1, 'Drama', " +
        "'2026-06-24T00:00:00.000Z', '2026-06-24T00:00:00.000Z')",
      [`${storyId}-poll`, storyId],
    );
    const articleId = await seedArticle({ document: { type: "doc", content: [] } });
    const ghostId = randomUUID();
    const items: BulkContentItem[] = [
      { kind: "story", id: storyId },
      { kind: "article", id: articleId },
      { kind: "article", id: ghostId },
    ];
    const result = await bulkUpdateContentAction(items, {
      type: "status",
      status: "published",
    });

    expect(result.ok.map((i) => i.id).sort()).toEqual(
      [storyId, articleId].sort(),
    );
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(ghostId);
    expect(result.failed[0].reason).toBe("not-found");

    const story = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id = ?",
      [storyId],
    );
    const article = await one<{ status: string }>(
      "SELECT status FROM articles WHERE id = ?",
      [articleId],
    );
    expect(story!.status).toBe("published");
    expect(article!.status).toBe("published");

    // prev map drives the inline undo banner.
    expect(result.prev[`story:${storyId}`]).toBe("ready");
    expect(result.prev[`article:${articleId}`]).toBe("draft");
  });

  it("rejects a story-only status for an article row with a precise reason", async () => {
    const articleId = await seedArticle({});
    const result = await bulkUpdateContentAction(
      [{ kind: "article", id: articleId }],
      { type: "status", status: "scripted" },
    );
    expect(result.ok).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toBe("invalid-status-for-article");
    const after = await one<{ status: string }>(
      "SELECT status FROM articles WHERE id = ?",
      [articleId],
    );
    expect(after!.status).toBe("draft");
  });

  it("blocks article publish when images are missing alt text and surfaces the count", async () => {
    const articleId = await seedArticle({
      document: {
        type: "doc",
        content: [
          {
            type: "articleImage",
            attrs: { src: "https://x/y.jpg", alt: "" },
          },
          {
            type: "articleImage",
            attrs: { src: "https://x/z.jpg", alt: "" },
          },
        ],
      },
    });
    const result = await bulkUpdateContentAction(
      [{ kind: "article", id: articleId }],
      { type: "status", status: "published" },
    );
    expect(result.ok).toHaveLength(0);
    expect(result.failed[0].reason).toBe("alt-missing-2");
    const after = await one<{ status: string }>(
      "SELECT status FROM articles WHERE id = ?",
      [articleId],
    );
    expect(after!.status).toBe("draft");
  });
});

// --- Category change (stories only) -----------------------------------------

describe("bulkUpdateContentAction: category change", () => {
  it("updates story category and records prev for undo", async () => {
    const storyId = await seedStory({ category: "Drama" });
    const result = await bulkUpdateContentAction(
      [{ kind: "story", id: storyId }],
      { type: "category", category: "Wholesome" },
    );
    expect(result.ok).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(result.prev[`story:${storyId}`]).toBe("Drama");
    const after = await one<{ category: string }>(
      "SELECT category FROM stories WHERE id = ?",
      [storyId],
    );
    expect(after!.category).toBe("Wholesome");
  });

  it("accepts a granular DB category and writes the primary story_tag", async () => {
    // "Creepy" exists only in the categories TABLE (granular seed), not in
    // the legacy manifest — this locks the validation to the DB set. The
    // primary story_tag write is what stops syncStoryPrimaryCategory from
    // reverting the admin's change on the next boot.
    const storyId = await seedStory({ category: "Drama" });
    const result = await bulkUpdateContentAction(
      [{ kind: "story", id: storyId }],
      { type: "category", category: "Creepy" },
    );
    expect(result.ok).toHaveLength(1);
    const after = await one<{ category: string }>(
      "SELECT category FROM stories WHERE id = ?",
      [storyId],
    );
    expect(after!.category).toBe("Creepy");
    const tag = await one<{ category_slug: string; is_primary: number; source: string }>(
      "SELECT category_slug, is_primary, source FROM story_tags " +
        "WHERE story_id = ? AND is_primary = 1",
      [storyId],
    );
    expect(tag).not.toBeNull();
    expect(tag!.category_slug).toBe("creepy");
    expect(tag!.source).toBe("admin");
  });

  it("still accepts a legacy label (the Undo banner replays old values)", async () => {
    const storyId = await seedStory({ category: "Creepy" });
    const result = await bulkUpdateContentAction(
      [{ kind: "story", id: storyId }],
      { type: "category", category: "Roommate" },
    );
    expect(result.ok).toHaveLength(1);
    const after = await one<{ category: string }>(
      "SELECT category FROM stories WHERE id = ?",
      [storyId],
    );
    expect(after!.category).toBe("Roommate");
  });

  it("rejects category change for articles with kind-mismatch-category", async () => {
    const articleId = await seedArticle({});
    const result = await bulkUpdateContentAction(
      [{ kind: "article", id: articleId }],
      { type: "category", category: "Drama" },
    );
    expect(result.ok).toHaveLength(0);
    expect(result.failed[0].reason).toBe("kind-mismatch-category");
  });
});

// --- Hard delete ------------------------------------------------------------

describe("bulkDeleteContentAction", () => {
  it("hard-deletes a story and calls deleteStoryMedia with both URLs", async () => {
    const storyId = await seedStory({
      audioUrl: "https://storage.googleapis.com/lw-media/audio/a.mp3",
      videoUrl: "https://storage.googleapis.com/lw-media/video/v.mp4",
    });
    const result = await bulkDeleteContentAction([
      { kind: "story", id: storyId },
    ]);
    expect(result.ok).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(
      await one("SELECT id FROM stories WHERE id = ?", [storyId]),
    ).toBeNull();
    expect(gcsCalls).toHaveLength(1);
    expect(gcsCalls[0]).toEqual({
      audioUrl: "https://storage.googleapis.com/lw-media/audio/a.mp3",
      videoUrl: "https://storage.googleapis.com/lw-media/video/v.mp4",
    });
  });

  it("hard-deletes an article via deleteArticle (revisions cascade)", async () => {
    const articleId = await seedArticle({});
    await run(
      "INSERT INTO article_revisions (id, article_id, document, title, status, is_named, created_at) " +
        "VALUES (?, ?, '{}', 'snap', 'draft', 0, '2026-06-19')",
      [randomUUID(), articleId],
    );
    const result = await bulkDeleteContentAction([
      { kind: "article", id: articleId },
    ]);
    expect(result.ok).toHaveLength(1);
    expect(
      await one("SELECT id FROM articles WHERE id = ?", [articleId]),
    ).toBeNull();
    expect(
      await all("SELECT id FROM article_revisions WHERE article_id = ?", [
        articleId,
      ]),
    ).toHaveLength(0);
  });

  it("reports not-found for unknown ids without blocking other items", async () => {
    const storyId = await seedStory({});
    const ghost = randomUUID();
    const result = await bulkDeleteContentAction([
      { kind: "story", id: ghost },
      { kind: "story", id: storyId },
    ]);
    expect(result.ok.map((i) => i.id)).toEqual([storyId]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(ghost);
    expect(result.failed[0].reason).toBe("not-found");
  });
});

// --- Bulk regenerate --------------------------------------------------------
// 2026-06-24. The action fans out the per-story regen buttons to N tickboxes
// at once. Each test asserts both the user-facing result counts and the
// underlying queue row was actually inserted — a green ok-count with no row
// in image_renders / voice_renders / story_jobs would be a silent regression.

describe("bulkRegenerateContentAction: validation", () => {
  it("throws on an empty item list", async () => {
    await expect(
      bulkRegenerateContentAction([], "hero"),
    ).rejects.toThrow(/empty/);
  });

  it("throws on an unknown target", async () => {
    const id = await seedStory({});
    await expect(
      bulkRegenerateContentAction(
        [{ kind: "story", id }],
        "bogus" as unknown as "hero",
      ),
    ).rejects.toThrow(/invalid target/);
  });
});

describe("bulkRegenerateContentAction: kind + lookup failures", () => {
  it("fails articles with reason 'not-a-story' without touching queue tables", async () => {
    const articleId = await seedArticle({});
    const result = await bulkRegenerateContentAction(
      [{ kind: "article", id: articleId }],
      "hero",
    );
    expect(result.ok).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toBe("not-a-story");
    const rows = await all("SELECT id FROM image_renders", []);
    expect(rows).toHaveLength(0);
  });

  it("fails ghost story ids with reason 'not-found' without blocking valid items", async () => {
    const storyId = await seedStory({});
    const ghost = randomUUID();
    const result = await bulkRegenerateContentAction(
      [
        { kind: "story", id: ghost },
        { kind: "story", id: storyId },
      ],
      "hero",
    );
    expect(result.ok.map((i) => i.id)).toEqual([storyId]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].id).toBe(ghost);
    expect(result.failed[0].reason).toBe("not-found");
  });
});

describe("bulkRegenerateContentAction: hero target", () => {
  it("inserts one queued image_renders row per story", async () => {
    const a = await seedStory({});
    const b = await seedStory({});
    const result = await bulkRegenerateContentAction(
      [
        { kind: "story", id: a },
        { kind: "story", id: b },
      ],
      "hero",
    );
    expect(result.ok).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    const rows = await all<{
      owner_id: string;
      owner_kind: string;
      asset: string;
      status: string;
      requested_by: string | null;
    }>(
      "SELECT owner_id, owner_kind, asset, status, requested_by FROM image_renders ORDER BY owner_id",
      [],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.owner_kind).toBe("story");
      expect(r.asset).toBe("hero");
      expect(r.status).toBe("queued");
      expect(r.requested_by).toBe("test-user");
    }
  });
});

describe("bulkRegenerateContentAction: voice target", () => {
  it("inserts one queued voice_renders row per story with non-empty body", async () => {
    const a = await seedStory({});
    const result = await bulkRegenerateContentAction(
      [{ kind: "story", id: a }],
      "voice",
    );
    expect(result.ok).toHaveLength(1);
    const rows = await all<{ story_id: string; status: string }>(
      "SELECT story_id, status FROM voice_renders",
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].story_id).toBe(a);
    expect(rows[0].status).toBe("queued");
  });

  it("fails with 'empty-body' when the story body is blank", async () => {
    const id = randomUUID();
    const redditId = `1${id.slice(0, 6).replace(/-/g, "0")}`;
    await run(
      "INSERT INTO stories (id, reddit_id, slug, title, status, category, body, source_url, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 'ready', 'Drama', '', ?, '2026-06-24T00:00:00.000Z', '2026-06-24T00:00:00.000Z')",
      [
        id,
        redditId,
        `story-${id.slice(0, 6)}`,
        "Body-less story",
        `https://www.reddit.com/r/aita/comments/${redditId}/`,
      ],
    );
    const result = await bulkRegenerateContentAction(
      [{ kind: "story", id }],
      "voice",
    );
    expect(result.ok).toHaveLength(0);
    expect(result.failed[0].reason).toBe("empty-body");
  });
});

describe("bulkRegenerateContentAction: pipeline target", () => {
  it("enqueues a story_jobs row when the story has a matching reddit_source in 'imported'", async () => {
    const storyId = await seedStory({});
    const story = await one<{ reddit_id: string }>(
      "SELECT reddit_id FROM stories WHERE id = ?",
      [storyId],
    );
    // The pipeline gate (bulkEnqueueStoryJobs) only enqueues when the
    // reddit_source row is in an allowed status (imported/queued). Seed
    // one so the fan-out actually lands a row, mirroring real usage.
    await run(
      "INSERT INTO reddit_source (reddit_id, full_text, status, first_synced, last_synced) " +
        "VALUES (?, ?, 'imported', '2026-06-24T00:00:00.000Z', '2026-06-24T00:00:00.000Z')",
      [story!.reddit_id, "seed body"],
    );
    const result = await bulkRegenerateContentAction(
      [{ kind: "story", id: storyId }],
      "pipeline",
    );
    expect(result.ok).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    const jobs = await all<{ reddit_id: string; status: string }>(
      "SELECT reddit_id, status FROM story_jobs",
      [],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].reddit_id).toBe(story!.reddit_id);
    expect(jobs[0].status).toBe("queued");
  });

  it("fails with 'not-enqueued' when no matching reddit_source row exists", async () => {
    // seedStory writes a reddit_id but does NOT seed a reddit_source row.
    // bulkEnqueueStoryJobs treats that as not-found and returns enqueued=0,
    // which the bulk action maps to "not-enqueued".
    const storyId = await seedStory({});
    const result = await bulkRegenerateContentAction(
      [{ kind: "story", id: storyId }],
      "pipeline",
    );
    expect(result.ok).toHaveLength(0);
    expect(result.failed[0].reason).toBe("not-enqueued");
  });

  // 2026-07-19 self-heal: the restart button now passes allowUsed, so an
  // already-shipped story (source at 'used') re-runs from the same click
  // instead of dead-ending on "reddit source is used or skipped".
  it("re-runs an already-shipped story whose source is 'used'", async () => {
    const storyId = await seedStory({ status: "published" });
    const story = await one<{ reddit_id: string }>(
      "SELECT reddit_id FROM stories WHERE id = ?",
      [storyId],
    );
    await run(
      "INSERT INTO reddit_source (reddit_id, full_text, status, first_synced, last_synced) " +
        "VALUES (?, 'seed body', 'used', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z')",
      [story!.reddit_id],
    );
    const result = await bulkRegenerateContentAction(
      [{ kind: "story", id: storyId }],
      "pipeline",
    );
    expect(result.ok).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    const jobs = await all<{ reddit_id: string }>(
      "SELECT reddit_id FROM story_jobs",
      [],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].reddit_id).toBe(story!.reddit_id);
  });

  // A 'skipped' source is the operator's own "no" — it stays refused, but now
  // with a precise reason the banner turns into a "Re-run anyway" button.
  it("maps a 'skipped' source to reason 'reddit-source-skipped'", async () => {
    const storyId = await seedStory({});
    const story = await one<{ reddit_id: string }>(
      "SELECT reddit_id FROM stories WHERE id = ?",
      [storyId],
    );
    await run(
      "INSERT INTO reddit_source (reddit_id, full_text, status, first_synced, last_synced) " +
        "VALUES (?, 'seed body', 'skipped', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z')",
      [story!.reddit_id],
    );
    const result = await bulkRegenerateContentAction(
      [{ kind: "story", id: storyId }],
      "pipeline",
    );
    expect(result.ok).toHaveLength(0);
    expect(result.failed[0].reason).toBe("reddit-source-skipped");
    // Not enqueued — the source is untouched until the operator overrides.
    expect(await all("SELECT id FROM story_jobs", [])).toHaveLength(0);
  });
});

// --- Restart pipeline (force / "Re-run anyway") -------------------------------
// Plan: _plans/2026-07-19-restart-pipeline-self-heal.md. The override for a
// skipped source: flips it back to 'imported' and enqueues.

describe("bulkRestartPipelineForceAction", () => {
  async function seedSkipped(): Promise<{ storyId: string; redditId: string }> {
    const storyId = await seedStory({});
    const story = await one<{ reddit_id: string }>(
      "SELECT reddit_id FROM stories WHERE id = ?",
      [storyId],
    );
    const redditId = story!.reddit_id;
    await run(
      "INSERT INTO reddit_source (reddit_id, full_text, status, first_synced, last_synced) " +
        "VALUES (?, 'seed body', 'skipped', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z')",
      [redditId],
    );
    return { storyId, redditId };
  }

  it("un-skips a skipped source and enqueues the job", async () => {
    const { storyId, redditId } = await seedSkipped();
    const result = await bulkRestartPipelineForceAction([
      { kind: "story", id: storyId },
    ]);
    expect(result.ok).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    // Source flipped off 'skipped' so the enqueue could take it.
    const source = await one<{ status: string }>(
      "SELECT status FROM reddit_source WHERE reddit_id = ?",
      [redditId],
    );
    expect(source!.status).toBe("queued");
    const jobs = await all<{ reddit_id: string; status: string }>(
      "SELECT reddit_id, status FROM story_jobs",
      [],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].reddit_id).toBe(redditId);
    expect(jobs[0].status).toBe("queued");
  });

  it("skips articles (not-a-story) and stories with no reddit source", async () => {
    const articleId = await seedArticle({});
    const manualSeedId = randomUUID();
    await run(
      "INSERT INTO stories (id, slug, title, status, body, created_at, updated_at) " +
        "VALUES (?, ?, 'Manual seed', 'published', 'body', '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z')",
      [manualSeedId, `story-${manualSeedId.slice(0, 6)}`],
    );
    const result = await bulkRestartPipelineForceAction([
      { kind: "article", id: articleId },
      { kind: "story", id: manualSeedId },
    ]);
    expect(result.ok).toHaveLength(0);
    const reasons = result.failed.map((f) => f.reason).sort();
    expect(reasons).toEqual(["no-reddit-source", "not-a-story"]);
  });

  it("reports pipeline-already-running without a second enqueue", async () => {
    const { storyId, redditId } = await seedSkipped();
    await run(
      "INSERT INTO story_jobs (id, reddit_id, status, requested_at) VALUES (?, ?, 'processing', '2026-07-19T00:00:00.000Z')",
      [randomUUID(), redditId],
    );
    const result = await bulkRestartPipelineForceAction([
      { kind: "story", id: storyId },
    ]);
    expect(result.ok).toHaveLength(0);
    expect(result.failed[0].reason).toBe("pipeline-already-running");
    // Only the pre-existing processing job — no duplicate enqueue.
    expect(await all("SELECT id FROM story_jobs", [])).toHaveLength(1);
  });
});

// --- Full pipeline & publish --------------------------------------------------
// Plan: _plans/2026-07-02-content-admin-cleanup-and-full-pipeline.md.

describe("bulkFullPipelineAction", () => {
  async function seedFullPipelineStory(): Promise<{
    storyId: string;
    redditId: string;
  }> {
    const storyId = await seedStory({ status: "published" });
    const story = await one<{ reddit_id: string }>(
      "SELECT reddit_id FROM stories WHERE id = ?",
      [storyId],
    );
    const redditId = story!.reddit_id;
    // Published stories' sources sit at 'used' — the exact status the
    // default enqueue gate refuses and allowUsed exists for.
    await run(
      "INSERT INTO reddit_source (reddit_id, full_text, status, first_synced, last_synced) " +
        "VALUES (?, 'seed body', 'used', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')",
      [redditId],
    );
    // Stale media the action must strip so the re-run regenerates
    // instead of resuming: a DONE short row + the 5 hero/thumb columns.
    await run(
      "INSERT INTO short_renders (id, story_id, config_hash, status, progress, props, requested_at) " +
        "VALUES (?, ?, 'hash-old', 'done', 1.0, '{\"old\":true}', '2026-07-01T00:00:00.000Z')",
      [randomUUID(), storyId],
    );
    await run(
      "UPDATE stories SET hero_image = 'h', hero_image_landscape = 'hl', " +
        "thumbnail_image = 't', thumbnail_image_landscape = 'tl', " +
        "thumbnail_image_square = 'ts' WHERE id = ?",
      [storyId],
    );
    return { storyId, redditId };
  }

  it("enqueues the job for a used source, strips stale media, and flags auto-publish", async () => {
    const { storyId, redditId } = await seedFullPipelineStory();
    const result = await bulkFullPipelineAction([{ kind: "story", id: storyId }]);
    expect(result.startedCount).toBe(1);
    expect(result.erroredCount).toBe(0);

    const jobs = await all<{ reddit_id: string; status: string; full_pipeline: number }>(
      "SELECT reddit_id, status, full_pipeline FROM story_jobs",
      [],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].reddit_id).toBe(redditId);
    expect(jobs[0].status).toBe("queued");
    // Forced off so the site-only full-pipeline lane can't publish ahead
    // of the flag lane (which also posts the socials).
    expect(jobs[0].full_pipeline).toBe(0);

    const shorts = await all<{ status: string; props: string | null }>(
      "SELECT status, props FROM short_renders WHERE story_id = ?",
      [storyId],
    );
    expect(shorts).toHaveLength(1);
    expect(shorts[0].status).toBe("cancelled");
    expect(shorts[0].props).toBeNull();

    const after = await one<{
      hero_image: string | null;
      thumbnail_image_square: string | null;
      auto_publish_when_ready: number;
    }>(
      "SELECT hero_image, thumbnail_image_square, auto_publish_when_ready " +
        "FROM stories WHERE id = ?",
      [storyId],
    );
    expect(after!.hero_image).toBeNull();
    expect(after!.thumbnail_image_square).toBeNull();
    expect(after!.auto_publish_when_ready).toBe(1);
  });

  it("skips a story whose pipeline is already running, without touching its media", async () => {
    const { storyId, redditId } = await seedFullPipelineStory();
    await run(
      "INSERT INTO story_jobs (id, reddit_id, status, requested_at) VALUES (?, ?, 'processing', '2026-07-02T00:00:00.000Z')",
      [randomUUID(), redditId],
    );
    const result = await bulkFullPipelineAction([{ kind: "story", id: storyId }]);
    expect(result.startedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.outcomes[0].reason).toBe("pipeline-already-running");
    // The stale-media strip must NOT have run for a refused enqueue.
    const after = await one<{ hero_image: string | null }>(
      "SELECT hero_image FROM stories WHERE id = ?",
      [storyId],
    );
    expect(after!.hero_image).toBe("h");
  });

  it("skips stories without a reddit source and articles", async () => {
    const id = randomUUID();
    await run(
      "INSERT INTO stories (id, slug, title, status, body, created_at, updated_at) " +
        "VALUES (?, ?, 'Manual seed', 'published', 'body', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')",
      [id, `story-${id.slice(0, 6)}`],
    );
    const articleId = await seedArticle({});
    const result = await bulkFullPipelineAction([
      { kind: "story", id },
      { kind: "article", id: articleId },
    ]);
    expect(result.startedCount).toBe(0);
    expect(result.skippedCount).toBe(2);
    const reasons = result.outcomes.map((o) => o.reason).sort();
    expect(reasons).toEqual(
      ["articles have no story pipeline", "no-reddit-source"].sort(),
    );
  });
});

// --- Bulk AI reclassify -------------------------------------------------------
// Plan: _plans/2026-07-05-bulk-ai-reclassify.md. The classifier is mocked at
// the module boundary (classifyStoryTagsMock above); everything below the
// mock — closed-set filtering, the confidence floor, the paired
// story_tags + stories.category write — is the real action against the
// real test DB, including the granular category seed (creepy,
// roommate-hell, ...).

describe("bulkReclassifyContentAction", () => {
  it("retags a confident story: category label + tags, primary first, source llm", async () => {
    const storyId = await seedStory({ category: "Drama" });
    classifyStoryTagsMock.mockResolvedValue([
      { slug: "roommate-hell", confidence: 0.9 },
      { slug: "creepy", confidence: 0.7 },
    ]);
    const result = await bulkReclassifyContentAction([
      { kind: "story", id: storyId },
    ]);
    expect(result.retaggedCount).toBe(1);
    expect(result.outcomes[0]).toMatchObject({
      state: "retagged",
      prevCategory: "Drama",
      nextCategory: "Roommate Hell",
      tags: ["roommate-hell", "creepy"],
      confidence: 0.9,
    });
    const after = await one<{ category: string }>(
      "SELECT category FROM stories WHERE id = ?",
      [storyId],
    );
    expect(after!.category).toBe("Roommate Hell");
    const tags = await all<{
      category_slug: string;
      is_primary: number;
      source: string;
    }>(
      "SELECT category_slug, is_primary, source FROM story_tags " +
        "WHERE story_id = ? ORDER BY is_primary DESC",
      [storyId],
    );
    expect(tags).toHaveLength(2);
    expect(tags[0]).toMatchObject({
      category_slug: "roommate-hell",
      is_primary: 1,
      source: "llm",
    });
    expect(tags[1]).toMatchObject({ category_slug: "creepy", is_primary: 0 });
  });

  it("reports unchanged when the label already matches, but still refreshes tags", async () => {
    const storyId = await seedStory({ category: "Creepy" });
    classifyStoryTagsMock.mockResolvedValue([
      { slug: "creepy", confidence: 0.8 },
    ]);
    const result = await bulkReclassifyContentAction([
      { kind: "story", id: storyId },
    ]);
    expect(result.unchangedCount).toBe(1);
    expect(result.retaggedCount).toBe(0);
    const tag = await one<{ category_slug: string }>(
      "SELECT category_slug FROM story_tags WHERE story_id = ? AND is_primary = 1",
      [storyId],
    );
    expect(tag!.category_slug).toBe("creepy");
  });

  it("leaves a below-floor story untouched and reports needs_review", async () => {
    const storyId = await seedStory({ category: "Drama" });
    classifyStoryTagsMock.mockResolvedValue([
      { slug: "roommate-hell", confidence: 0.4 },
    ]);
    const result = await bulkReclassifyContentAction([
      { kind: "story", id: storyId },
    ]);
    expect(result.needsReviewCount).toBe(1);
    expect(result.outcomes[0].reason).toContain("low confidence (40%)");
    const after = await one<{ category: string }>(
      "SELECT category FROM stories WHERE id = ?",
      [storyId],
    );
    expect(after!.category).toBe("Drama");
    const tags = await all<{ story_id: string }>(
      "SELECT story_id FROM story_tags WHERE story_id = ?",
      [storyId],
    );
    expect(tags).toHaveLength(0);
  });

  it("reports needs_review when the classifier returns nothing", async () => {
    const storyId = await seedStory({ category: "Drama" });
    classifyStoryTagsMock.mockResolvedValue([]);
    const result = await bulkReclassifyContentAction([
      { kind: "story", id: storyId },
    ]);
    expect(result.needsReviewCount).toBe(1);
    const after = await one<{ category: string }>(
      "SELECT category FROM stories WHERE id = ?",
      [storyId],
    );
    expect(after!.category).toBe("Drama");
  });

  it("drops hallucinated slugs; nothing usable left means needs_review, no writes", async () => {
    const storyId = await seedStory({ category: "Drama" });
    classifyStoryTagsMock.mockResolvedValue([
      { slug: "politics", confidence: 0.99 },
    ]);
    const result = await bulkReclassifyContentAction([
      { kind: "story", id: storyId },
    ]);
    expect(result.needsReviewCount).toBe(1);
    const tags = await all<{ story_id: string }>(
      "SELECT story_id FROM story_tags WHERE story_id = ?",
      [storyId],
    );
    expect(tags).toHaveLength(0);
  });

  it("skips articles without calling the classifier and errors unknown ids", async () => {
    const articleId = await seedArticle({});
    const result = await bulkReclassifyContentAction([
      { kind: "article", id: articleId },
      { kind: "story", id: "no-such-story" },
    ]);
    expect(result.skippedCount).toBe(1);
    expect(result.erroredCount).toBe(1);
    expect(result.outcomes[0].state).toBe("skipped");
    expect(result.outcomes[1]).toMatchObject({
      state: "errored",
      reason: "not-found",
    });
    expect(classifyStoryTagsMock).not.toHaveBeenCalled();
  });
});

// --- Bulk regenerate titles ---------------------------------------------------
// Plan: _plans/2026-07-15-too-long-title-filter-and-bulk-fix.md. The
// regenerator is mocked (regenerateTitleForStoryMock above); the action's own
// job — filter articles, map ok/skip/fail, count, audit — runs for real.

describe("bulkRegenerateTitlesAction", () => {
  it("regenerates a story title and reports prev → next", async () => {
    const storyId = await seedStory({
      title: "MY SON ATE THE MIDDLES OUT OF EVERY CINNAMON ROLL THIS MORNING",
    });
    regenerateTitleForStoryMock.mockResolvedValue({
      ok: true,
      title: "THE CINNAMON ROLL THIEF",
      previousTitle: "MY SON ATE THE MIDDLES OUT OF EVERY CINNAMON ROLL THIS MORNING",
      model: "openai/gpt-5-nano",
    });
    const result = await bulkRegenerateTitlesAction([
      { kind: "story", id: storyId },
    ]);
    expect(result.regeneratedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.erroredCount).toBe(0);
    expect(result.outcomes[0]).toMatchObject({
      state: "regenerated",
      nextTitle: "THE CINNAMON ROLL THIEF",
    });
    expect(regenerateTitleForStoryMock).toHaveBeenCalledWith(storyId);
  });

  it("skips articles (not-a-story) without calling the regenerator", async () => {
    const articleId = await seedArticle({});
    const result = await bulkRegenerateTitlesAction([
      { kind: "article", id: articleId },
    ]);
    expect(result.skippedCount).toBe(1);
    expect(result.regeneratedCount).toBe(0);
    expect(result.outcomes[0]).toMatchObject({
      state: "skipped",
      reason: "not-a-story",
    });
    expect(regenerateTitleForStoryMock).not.toHaveBeenCalled();
  });

  it("treats a body-less story as a soft skip, not a failure", async () => {
    const storyId = await seedStory({});
    regenerateTitleForStoryMock.mockResolvedValue({
      ok: false,
      error: "story has no body text to base a title on",
      stage: "story-missing-body",
    });
    const result = await bulkRegenerateTitlesAction([
      { kind: "story", id: storyId },
    ]);
    expect(result.skippedCount).toBe(1);
    expect(result.erroredCount).toBe(0);
    expect(result.outcomes[0].state).toBe("skipped");
  });

  it("reports a hard LLM/DB failure as errored", async () => {
    const storyId = await seedStory({});
    regenerateTitleForStoryMock.mockResolvedValue({
      ok: false,
      error: "model timeout",
      stage: "llm",
    });
    const result = await bulkRegenerateTitlesAction([
      { kind: "story", id: storyId },
    ]);
    expect(result.erroredCount).toBe(1);
    expect(result.outcomes[0]).toMatchObject({
      state: "errored",
      reason: "model timeout",
    });
  });

  it("rejects a run past the paid cap", async () => {
    const items: BulkContentItem[] = Array.from({ length: 51 }, () => ({
      kind: "story",
      id: randomUUID(),
    }));
    await expect(bulkRegenerateTitlesAction(items)).rejects.toThrow(/exceeds 50/);
  });

  it("audits content.bulk_regenerate_titles with the affected count", async () => {
    const a = await seedStory({});
    regenerateTitleForStoryMock.mockResolvedValue({
      ok: true,
      title: "SHORT TITLE",
      previousTitle: null,
      model: "openai/gpt-5-nano",
    });
    await bulkRegenerateTitlesAction([{ kind: "story", id: a }]);
    const row = await one<{ metadata: string; target_type: string }>(
      "SELECT metadata, target_type FROM admin_audit_log WHERE action = ?",
      ["content.bulk_regenerate_titles"],
    );
    expect(row).not.toBeNull();
    expect(row!.target_type).toBe("content");
    expect(JSON.parse(row!.metadata).count).toBe(1);
  });
});

// --- Danger-class caps (2026-07-15 safety spine) ----------------------------
// Destructive + paid bulk ops are capped far below the cheap-op limit and
// enforced in the handler, so a forged over-cap payload can't wipe hundreds of
// rows or spend four figures in one call.
// Plan: _plans/2026-07-15-content-pagination-and-bulk-safety.md.

describe("danger-class caps", () => {
  it("rejects a delete past the destructive cap", async () => {
    const items: BulkContentItem[] = Array.from({ length: 51 }, () => ({
      kind: "story",
      id: randomUUID(),
    }));
    await expect(bulkDeleteContentAction(items)).rejects.toThrow(/exceeds 50/);
  });

  it("rejects a regenerate past the paid cap", async () => {
    const items: BulkContentItem[] = Array.from({ length: 51 }, () => ({
      kind: "story",
      id: randomUUID(),
    }));
    await expect(bulkRegenerateContentAction(items, "hero")).rejects.toThrow(
      /exceeds 50/,
    );
  });

  it("still allows a cheap status change above the danger cap", async () => {
    // 60 rows is over the 50 danger cap but under the 200 cheap-op limit: the
    // ghost ids come back as not-found failures, but the call itself must not
    // throw — cheap, reversible ops keep the higher limit.
    const items: BulkContentItem[] = Array.from({ length: 60 }, () => ({
      kind: "story",
      id: randomUUID(),
    }));
    const result = await bulkUpdateContentAction(items, {
      type: "status",
      status: "draft",
    });
    expect(result.failed).toHaveLength(60);
  });
});

// --- Audit trail (2026-07-15) ------------------------------------------------
// Every danger-class bulk run writes one PII-free summary row through
// @/lib/audit BEFORE the mutation. reset() clears admin_audit_log so each
// assertion sees only its own run.

describe("bulk audit trail", () => {
  it("records a content.bulk_delete row with the affected count + ids", async () => {
    const a = await seedStory({});
    const b = await seedStory({});
    await bulkDeleteContentAction([
      { kind: "story", id: a },
      { kind: "story", id: b },
    ]);
    const rows = await all<{
      action: string;
      target_type: string;
      actor_id: string;
      metadata: string;
    }>(
      "SELECT action, target_type, actor_id, metadata FROM admin_audit_log WHERE action = ?",
      ["content.bulk_delete"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].target_type).toBe("content");
    expect(rows[0].actor_id).toBe("test-user");
    const meta = JSON.parse(rows[0].metadata);
    expect(meta.count).toBe(2);
    expect(meta.storyCount).toBe(2);
    expect(meta.ids).toEqual([`story:${a}`, `story:${b}`]);
  });

  it("records a content.bulk_regenerate row with target + estimated cost", async () => {
    const a = await seedStory({});
    await bulkRegenerateContentAction([{ kind: "story", id: a }], "short");
    const row = await one<{ metadata: string }>(
      "SELECT metadata FROM admin_audit_log WHERE action = ?",
      ["content.bulk_regenerate"],
    );
    expect(row).not.toBeNull();
    const meta = JSON.parse(row!.metadata);
    expect(meta.target).toBe("short");
    expect(meta.estCostUsd).toBe(1.13);
  });
});

// --- Idempotent paid re-run (2026-07-15) ------------------------------------
// A second identical regenerate must not double-charge: the queue skips work
// already in flight, so no second row is enqueued. The guard is the partial
// unique index over (story_id, text_hash, voice_provider, voice_id) WHERE
// status IN ('queued','processing') in enqueueVoiceRender.
//
// KNOWN GAP (see _plans/2026-07-15-content-pagination-and-bulk-safety.md
// follow-ups): SQL treats NULL as distinct in a unique index, so a story with
// no voice override (voice_provider/voice_id NULL) does NOT hit the conflict
// and a retry double-enqueues. The ≤50 paid cap bounds the blast radius; a
// null-safe uniqueness check is a scoped follow-up (a cross-DB queue change,
// out of scope for the safety spine). This test pins the guard for the
// voice-set case so a regression there is caught.

describe("bulkRegenerateContentAction: idempotent re-run", () => {
  it("does not enqueue a second voice render when one is already in flight", async () => {
    const a = await seedStory({});
    // A concrete voice override makes the partial unique index apply — the
    // NULL columns in the default-voice case would each read as distinct.
    await run(
      "UPDATE stories SET voice_provider = 'elevenlabs', voice_id = 'test-voice' WHERE id = ?",
      [a],
    );
    const first = await bulkRegenerateContentAction(
      [{ kind: "story", id: a }],
      "voice",
    );
    expect(first.ok).toHaveLength(1);
    const second = await bulkRegenerateContentAction(
      [{ kind: "story", id: a }],
      "voice",
    );
    expect(second.ok).toHaveLength(0);
    const rows = await all("SELECT id FROM voice_renders WHERE story_id = ?", [
      a,
    ]);
    expect(rows).toHaveLength(1);
  });
});

// --- Select-all-matching (2026-07-15 Phase 1 follow-up) ---------------------
// bulkUpdateContentByFilterAction resolves every row matching a filter and
// chunks the ids through bulkUpdateContentAction, so the per-item invariants
// (publish gate, tag write) still run. Cheap ops only.

describe("bulkUpdateContentByFilterAction (select-all-matching)", () => {
  it("applies a cheap status change to every matching row, leaves others, audits", async () => {
    const a = await seedStory({ category: "Humor", status: "draft" });
    const b = await seedStory({ category: "Humor", status: "draft" });
    const other = await seedStory({ category: "Drama", status: "draft" });
    const result = await bulkUpdateContentByFilterAction(
      { category: "Humor" },
      { type: "status", status: "archived" },
    );
    expect(result.ok.map((i) => i.id).sort()).toEqual([a, b].sort());
    const rowA = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id = ?",
      [a],
    );
    const rowOther = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id = ?",
      [other],
    );
    expect(rowA!.status).toBe("archived");
    expect(rowOther!.status).toBe("draft");
    const audit = await one<{ metadata: string }>(
      "SELECT metadata FROM admin_audit_log WHERE action = ?",
      ["content.bulk_by_filter"],
    );
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.metadata).count).toBe(2);
  });

  it("preserves the publish invariant: an asset-incomplete story is not published", async () => {
    const incomplete = await seedStory({ category: "Roommate", status: "ready" });
    const result = await bulkUpdateContentByFilterAction(
      { category: "Roommate" },
      { type: "status", status: "published" },
    );
    expect(
      result.failed.some(
        (f) => f.id === incomplete && f.reason.startsWith("asset-incomplete"),
      ),
    ).toBe(true);
    const after = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id = ?",
      [incomplete],
    );
    expect(after!.status).toBe("ready");
  });

  it("rejects non-cheap ops (status / category only)", async () => {
    await expect(
      bulkUpdateContentByFilterAction({}, {
        type: "delete",
      } as unknown as BulkUpdateOp),
    ).rejects.toThrow(/only status/);
  });
});
