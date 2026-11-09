// Tests for the publish-time guard that refuses to promote a story to
// ready/published status when its Reddit identity is a dry-run fixture.
//
// Why this matters: the article reader's Reddit embed is gated on
// reddit_id + source_url agreement (see lib/reddit-thread.ts), but a
// fixture row with a placeholder reddit_id ('envelope') OR a `[DRY RUN
// ARTICLE]` body marker can still slip into status='published' through
// the admin's status flip. Once it's published it lands on rails and
// the reader sees an article whose "From the original thread" section
// has nothing real to link to — which contradicts the invariant that
// every public story is sourced from a real Reddit post.
//
// The guard rejects three classes of fixture data at the repo layer:
//   1. reddit_id matching a known placeholder ('envelope', 'example',
//      'test', 'demo', 'sample', 'placeholder')
//   2. source_url containing /comments/example/ or /comments/test/
//   3. body starting with the '[DRY RUN ARTICLE]' marker
//
// Each guard fires regardless of which order the others would; the
// publish click reports the failure instead of silently shipping a
// dummy row.

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { setStatus, type StoryStatus } from "@/lib/repo";
import { run } from "@/lib/db";

async function makeStory(
  overrides: {
    reddit_id?: string | null;
    source_url?: string | null;
    body?: string | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  // `??` skips defaults only on undefined, so an explicit `null` override
  // passes through — that's how the null-reddit_id case below tests the
  // guard's null branch.
  const redditId =
    "reddit_id" in overrides ? overrides.reddit_id : id;
  const sourceUrl =
    "source_url" in overrides
      ? overrides.source_url
      : `https://www.reddit.com/r/aita/comments/${id}/`;
  const body =
    "body" in overrides ? overrides.body : "Real body content, not a dry-run.";
  // video_url satisfies the publish-time media invariant
  // (_plans/2026-07-02-never-publish-without-video.md) so these tests
  // keep exercising ONLY the fixture guard.
  await run(
    "INSERT INTO stories (id, reddit_id, title, body, source_url, video_url, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      redditId,
      "Publish guard fixture",
      body,
      sourceUrl,
      "https://example.com/short.mp4",
      "review" satisfies StoryStatus,
      now,
      now,
    ],
  );
  return id;
}

describe("setStatus publish guard", () => {
  it("allows promoting a real-looking story to published", async () => {
    const id = await makeStory();
    await expect(setStatus(id, "published")).resolves.toBeUndefined();
  });

  it("allows promoting to non-public statuses regardless of fixture markers", async () => {
    // The guard only fires for ready/published. Internal statuses
    // (draft, review, scripted, rendering, archived) stay flexible so
    // the admin can move fixture rows around without hitting the gate.
    const id = await makeStory({ reddit_id: "envelope" });
    await expect(setStatus(id, "archived")).resolves.toBeUndefined();
    await expect(setStatus(id, "review")).resolves.toBeUndefined();
  });

  it("REJECTS publish when reddit_id is a fixture placeholder", async () => {
    for (const placeholder of [
      "envelope",
      "example",
      "test",
      "demo",
      "sample",
      "placeholder",
    ]) {
      const id = await makeStory({ reddit_id: placeholder });
      await expect(setStatus(id, "published")).rejects.toThrow(
        /reddit_id is a fixture placeholder/,
      );
    }
  });

  it("REJECTS promote to 'ready' on the same placeholder ids", async () => {
    // 'ready' is also gated — once status reaches 'ready' the homepage
    // catalog query (status IN 'ready','published') surfaces the row,
    // so the guard fires there too.
    const id = await makeStory({ reddit_id: "envelope" });
    await expect(setStatus(id, "ready")).rejects.toThrow(
      /reddit_id is a fixture placeholder/,
    );
  });

  it("REJECTS publish when reddit_id is null/empty", async () => {
    const id = await makeStory({ reddit_id: null });
    await expect(setStatus(id, "published")).rejects.toThrow(
      /reddit_id is a fixture placeholder/,
    );
  });

  it("REJECTS publish when source_url is the /comments/example/ fixture", async () => {
    const id = await makeStory({
      source_url:
        "https://www.reddit.com/r/AmItheAsshole/comments/example/",
    });
    await expect(setStatus(id, "published")).rejects.toThrow(
      /source_url is a fixture placeholder/,
    );
  });

  it("REJECTS publish when source_url is the /comments/test/ fixture", async () => {
    const id = await makeStory({
      source_url: "https://www.reddit.com/r/aita/comments/test/",
    });
    await expect(setStatus(id, "published")).rejects.toThrow(
      /source_url is a fixture placeholder/,
    );
  });

  it("REJECTS publish when body starts with the [DRY RUN ARTICLE] marker", async () => {
    const id = await makeStory({
      body: "[DRY RUN ARTICLE]\n\nSynthetic story content.",
    });
    await expect(setStatus(id, "published")).rejects.toThrow(
      /body is a dry-run fixture/,
    );
  });

  it("REJECTS publish when story id doesn't exist", async () => {
    await expect(
      setStatus("nonexistent-id-9999", "published"),
    ).rejects.toThrow(/cannot publish missing story/);
  });
});

describe("setStatus originality gate", () => {
  const SOURCE = 'I told Karen that "nobody touches my yogurt" and walked away slowly.';

  async function makeOriginalStory(
    body: string,
    withSource = true,
  ): Promise<string> {
    const id = await makeStory({ body });
    const now = new Date().toISOString();
    await run("UPDATE stories SET content_origin = 'original' WHERE id = ?", [id]);
    if (withSource) {
      await run(
        "INSERT INTO story_sources (story_id, source_kind, source_ref, source_title, source_text, source_url, premise, compliance_report, created_at, updated_at) " +
          "VALUES (?, 'reddit', ?, '', ?, 'https://example.test/thread', 'A premise.', '{}', ?, ?)",
        [id, id, SOURCE, now, now],
      );
    }
    return id;
  }

  it("publishes a clean original story", async () => {
    const id = await makeOriginalStory("Priya taped a border down the shelf.");
    await expect(setStatus(id, "published")).resolves.toBeUndefined();
  });

  it("blocks an original story that reuses a source name", async () => {
    const id = await makeOriginalStory("Then Karen opened the fridge.");
    await expect(setStatus(id, "published")).rejects.toThrow(/originality check \(identifying\)/);
  });

  it("names checks in the error, never source text", async () => {
    const id = await makeOriginalStory("Karen said nobody touches my yogurt.");
    const error = await setStatus(id, "published").catch((e: Error) => e);
    expect(String(error)).not.toContain("yogurt");
    expect(String(error)).not.toContain("Karen");
  });

  it("re-checks edited text at publish time", async () => {
    const id = await makeOriginalStory("Priya taped a border down the shelf.");
    await run("UPDATE stories SET body = ? WHERE id = ?", ["A true story about Karen.", id]);
    await expect(setStatus(id, "ready")).rejects.toThrow(/originality check/);
  });

  it("checks the short's narration and social metadata", async () => {
    const id = await makeOriginalStory("Priya taped a border down the shelf.");
    await run("UPDATE stories SET short_config = ? WHERE id = ?", [
      JSON.stringify({ script: "It was all over Reddit by noon." }),
      id,
    ]);
    await expect(setStatus(id, "published")).rejects.toThrow(/labeling/);
    await run("UPDATE stories SET short_config = NULL, seo_metadata_json = ? WHERE id = ?", [
      JSON.stringify({ youtube: { description: "#TrueStory" } }),
      id,
    ]);
    await expect(setStatus(id, "published")).rejects.toThrow(/labeling/);
  });

  it("fails closed when the source record is missing", async () => {
    const id = await makeOriginalStory("Priya taped a border down the shelf.", false);
    await expect(setStatus(id, "published")).rejects.toThrow(/originality check/);
  });

  it("leaves older stories alone", async () => {
    const id = await makeStory({ body: "A true story about Reddit and Karen." });
    await expect(setStatus(id, "published")).resolves.toBeUndefined();
  });
});
