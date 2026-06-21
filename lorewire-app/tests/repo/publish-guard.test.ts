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
  await run(
    "INSERT INTO stories (id, reddit_id, title, body, source_url, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      redditId,
      "Publish guard fixture",
      body,
      sourceUrl,
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
