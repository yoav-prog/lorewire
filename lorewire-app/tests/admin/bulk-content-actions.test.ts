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
vi.mock("@/lib/dal", () => ({
  requireAdmin: vi.fn().mockResolvedValue(null),
  requireCapability: vi.fn().mockResolvedValue(null),
  requireStaff: vi.fn().mockResolvedValue(null),
  ensureSeedAdmin: vi.fn().mockResolvedValue(null),
  currentUser: vi.fn().mockResolvedValue(null),
}));
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

// Import AFTER vi.mock so the action module picks up the mocked deps.
import {
  bulkUpdateContentAction,
  bulkDeleteContentAction,
  type BulkContentItem,
} from "@/app/admin/actions";

async function reset(): Promise<void> {
  await run("DELETE FROM stories WHERE 1=1", []);
  await run("DELETE FROM articles WHERE 1=1", []);
  await run("DELETE FROM article_revisions WHERE 1=1", []);
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
    const storyId = await seedStory({ status: "ready" });
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
