// Repo tests for deleteStory. The schema has no FK CASCADE (see schema.ts),
// so the function does explicit cleanup across every table that points at a
// story_id. These tests lock the cleanup matrix in place — anything we add
// later (a new short_X queue, a new user_state row) gets a failing test if
// it pulls a story_id without being cleaned.
//
// The behavior we verify mirrors the plan
// (_plans/2026-06-19-content-bulk-actions.md, "Behavioral rules"):
//   - Owned rows (renders, render-events, polls, votes, aggregates) deleted.
//   - User-state rows (saves, likes, recently viewed, continue) deleted.
//   - Homepage curation slot deleted (an empty slot is worse than no slot).
//   - Loose links nulled: articles.story_id, reddit_source.story_id,
//     story_jobs.story_id — the parent rows survive.
//   - The story row itself deleted; the returned row carries audio_url and
//     video_url so the action can fan them into GCS cleanup.
//
// The test seeds one of each dependent kind, runs deleteStory, and asserts
// every expected post-condition. A second story is created alongside as a
// "control" to make sure we don't over-delete.

import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";
import { createArticle, deleteStory } from "@/lib/repo";

async function reset(): Promise<void> {
  await run("DELETE FROM stories WHERE 1=1", []);
  await run("DELETE FROM articles WHERE 1=1", []);
  await run("DELETE FROM reddit_source WHERE 1=1", []);
  await run("DELETE FROM story_jobs WHERE 1=1", []);
  await run("DELETE FROM video_renders WHERE 1=1", []);
  await run("DELETE FROM video_render_events WHERE 1=1", []);
  await run("DELETE FROM short_renders WHERE 1=1", []);
  await run("DELETE FROM short_render_events WHERE 1=1", []);
  await run("DELETE FROM image_renders WHERE 1=1", []);
  await run("DELETE FROM image_render_events WHERE 1=1", []);
  await run("DELETE FROM voice_renders WHERE 1=1", []);
  await run("DELETE FROM polls WHERE 1=1", []);
  await run("DELETE FROM poll_votes WHERE 1=1", []);
  await run("DELETE FROM poll_aggregates WHERE 1=1", []);
  await run("DELETE FROM user_saves WHERE 1=1", []);
  await run("DELETE FROM user_likes WHERE 1=1", []);
  await run("DELETE FROM user_recently_viewed WHERE 1=1", []);
  await run("DELETE FROM user_continue WHERE 1=1", []);
  await run("DELETE FROM homepage_curation WHERE 1=1", []);
}

async function seedStoryRow(id: string): Promise<void> {
  await run(
    "INSERT INTO stories (id, slug, title, status, audio_url, video_url, category, created_at, updated_at) " +
      "VALUES (?, ?, ?, 'ready', ?, ?, 'Drama', '2026-06-19T00:00:00.000Z', '2026-06-19T00:00:00.000Z')",
    [
      id,
      `story-${id.slice(0, 6)}`,
      "Doomed story",
      `https://storage.googleapis.com/lw-media/audio/${id}.mp3`,
      `https://storage.googleapis.com/lw-media/video/${id}.mp4`,
    ],
  );
}

async function seedFullDependentSet(
  id: string,
  opts: { curationPosition?: number } = {},
): Promise<{
  videoRenderId: string;
  shortRenderId: string;
  imageRenderId: string;
}> {
  const videoRenderId = randomUUID();
  const shortRenderId = randomUUID();
  const imageRenderId = randomUUID();
  await run(
    "INSERT INTO video_renders (id, story_id, config_hash, status, progress) VALUES (?, ?, ?, 'done', 100)",
    [videoRenderId, id, "vhash"],
  );
  await run(
    "INSERT INTO video_render_events (id, render_id, ts, level, event) VALUES (?, ?, '2026-06-19', 'info', 'done')",
    [randomUUID(), videoRenderId],
  );
  await run(
    "INSERT INTO short_renders (id, story_id, config_hash, status, progress, props) VALUES (?, ?, ?, 'done', 1, '{}')",
    [shortRenderId, id, "shash"],
  );
  await run(
    "INSERT INTO short_render_events (id, render_id, ts, level, event) VALUES (?, ?, '2026-06-19', 'info', 'done')",
    [randomUUID(), shortRenderId],
  );
  await run(
    "INSERT INTO image_renders (id, owner_kind, owner_id, asset, status, progress) VALUES (?, 'story', ?, 'hero', 'done', 100)",
    [imageRenderId, id],
  );
  await run(
    "INSERT INTO image_render_events (id, render_id, ts, level, event) VALUES (?, ?, '2026-06-19', 'info', 'done')",
    [randomUUID(), imageRenderId],
  );
  await run(
    "INSERT INTO voice_renders (id, story_id, voice_provider, voice_id, text_hash, status, progress) VALUES (?, ?, 'elevenlabs', 'v1', 'h', 'done', 100)",
    [randomUUID(), id],
  );

  // Poll + vote + aggregate.
  const pollId = randomUUID();
  await run(
    "INSERT INTO polls (id, story_id, article_id, question, option_a_text, option_b_text, enabled, category, created_at, updated_at) " +
      "VALUES (?, ?, NULL, 'Q?', 'A', 'B', 1, 'Drama', '2026-06-19', '2026-06-19')",
    [pollId, id],
  );
  await run(
    "INSERT INTO poll_votes (id, poll_id, story_id, article_id, category, side, cookie_token, created_at) " +
      "VALUES (?, ?, ?, NULL, 'Drama', 'A', ?, '2026-06-19')",
    [randomUUID(), pollId, id, randomUUID()],
  );
  await run(
    "INSERT INTO poll_aggregates (story_id, poll_id, category, votes_a, votes_b, total_votes, divisiveness, agreement, refreshed_at) " +
      "VALUES (?, ?, 'Drama', 1, 0, 1, 0.0, 1.0, '2026-06-19')",
    [id, pollId],
  );

  // User state.
  await run(
    "INSERT INTO user_saves (id, user_id, story_id, created_at) VALUES (?, ?, ?, '2026-06-19')",
    [randomUUID(), randomUUID(), id],
  );
  await run(
    "INSERT INTO user_likes (id, user_id, story_id, created_at) VALUES (?, ?, ?, '2026-06-19')",
    [randomUUID(), randomUUID(), id],
  );
  await run(
    "INSERT INTO user_recently_viewed (id, user_id, story_id, viewed_at) VALUES (?, ?, ?, '2026-06-19')",
    [randomUUID(), randomUUID(), id],
  );
  await run(
    "INSERT INTO user_continue (id, user_id, story_id, position_ms, updated_at) VALUES (?, ?, ?, 12345, '2026-06-19')",
    [randomUUID(), randomUUID(), id],
  );

  // Homepage curation. Position is parameterized because (surface, position)
  // is the unique index; tests with two stories pass distinct positions.
  await run(
    "INSERT INTO homepage_curation (id, surface, position, story_id, created_at, updated_at) VALUES (?, 'hero', ?, ?, '2026-06-19', '2026-06-19')",
    [randomUUID(), opts.curationPosition ?? 0, id],
  );

  return { videoRenderId, shortRenderId, imageRenderId };
}

beforeEach(async () => {
  await reset();
});

describe("deleteStory", () => {
  it("returns null when the story does not exist", async () => {
    const result = await deleteStory("does-not-exist");
    expect(result).toBeNull();
  });

  it("returns the row (with audio_url and video_url) on success", async () => {
    const id = randomUUID();
    await seedStoryRow(id);
    const result = await deleteStory(id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(id);
    expect(result!.audio_url).toBe(
      `https://storage.googleapis.com/lw-media/audio/${id}.mp3`,
    );
    expect(result!.video_url).toBe(
      `https://storage.googleapis.com/lw-media/video/${id}.mp4`,
    );
  });

  it("deletes the story row and every dependent row owned by it", async () => {
    const id = randomUUID();
    await seedStoryRow(id);
    const seeded = await seedFullDependentSet(id);

    await deleteStory(id);

    expect(await one("SELECT id FROM stories WHERE id = ?", [id])).toBeNull();
    expect(
      await all("SELECT id FROM video_renders WHERE story_id = ?", [id]),
    ).toHaveLength(0);
    expect(
      await all("SELECT id FROM video_render_events WHERE render_id = ?", [
        seeded.videoRenderId,
      ]),
    ).toHaveLength(0);
    expect(
      await all("SELECT id FROM short_renders WHERE story_id = ?", [id]),
    ).toHaveLength(0);
    expect(
      await all("SELECT id FROM short_render_events WHERE render_id = ?", [
        seeded.shortRenderId,
      ]),
    ).toHaveLength(0);
    expect(
      await all(
        "SELECT id FROM image_renders WHERE owner_kind = 'story' AND owner_id = ?",
        [id],
      ),
    ).toHaveLength(0);
    expect(
      await all("SELECT id FROM image_render_events WHERE render_id = ?", [
        seeded.imageRenderId,
      ]),
    ).toHaveLength(0);
    expect(
      await all("SELECT id FROM voice_renders WHERE story_id = ?", [id]),
    ).toHaveLength(0);
    expect(
      await all("SELECT id FROM polls WHERE story_id = ?", [id]),
    ).toHaveLength(0);
    expect(
      await all("SELECT id FROM poll_votes WHERE story_id = ?", [id]),
    ).toHaveLength(0);
    expect(
      await all("SELECT story_id FROM poll_aggregates WHERE story_id = ?", [
        id,
      ]),
    ).toHaveLength(0);
    expect(
      await all("SELECT id FROM user_saves WHERE story_id = ?", [id]),
    ).toHaveLength(0);
    expect(
      await all("SELECT id FROM user_likes WHERE story_id = ?", [id]),
    ).toHaveLength(0);
    expect(
      await all("SELECT id FROM user_recently_viewed WHERE story_id = ?", [
        id,
      ]),
    ).toHaveLength(0);
    expect(
      await all("SELECT id FROM user_continue WHERE story_id = ?", [id]),
    ).toHaveLength(0);
    expect(
      await all("SELECT id FROM homepage_curation WHERE story_id = ?", [id]),
    ).toHaveLength(0);
  });

  it("nulls out loose references (articles, reddit_source, story_jobs) without deleting the parents", async () => {
    const id = randomUUID();
    await seedStoryRow(id);

    const articleId = randomUUID();
    await createArticle({
      id: articleId,
      type: "feature",
      language: "en",
      slug: `linked-${articleId.slice(0, 6)}`,
      title: "Article linked to the doomed story",
      author_id: null,
    });
    await run("UPDATE articles SET story_id = ? WHERE id = ?", [id, articleId]);

    const redditId = `t3_${id.slice(0, 6)}`;
    await run(
      "INSERT INTO reddit_source (reddit_id, subreddit, title, status, story_id, first_synced, last_synced) " +
        "VALUES (?, 'EntitledParents', 'Some post', 'used', ?, '2026-06-19', '2026-06-19')",
      [redditId, id],
    );

    const jobId = randomUUID();
    await run(
      "INSERT INTO story_jobs (id, reddit_id, status, story_id, requested_at) VALUES (?, ?, 'done', ?, '2026-06-19')",
      [jobId, redditId, id],
    );

    await deleteStory(id);

    const article = await one<{ story_id: string | null }>(
      "SELECT story_id FROM articles WHERE id = ?",
      [articleId],
    );
    expect(article).not.toBeNull();
    expect(article!.story_id).toBeNull();

    const reddit = await one<{ story_id: string | null }>(
      "SELECT story_id FROM reddit_source WHERE reddit_id = ?",
      [redditId],
    );
    expect(reddit).not.toBeNull();
    expect(reddit!.story_id).toBeNull();

    const job = await one<{ story_id: string | null }>(
      "SELECT story_id FROM story_jobs WHERE id = ?",
      [jobId],
    );
    expect(job).not.toBeNull();
    expect(job!.story_id).toBeNull();
  });

  it("leaves a sibling story and its dependents untouched", async () => {
    const targetId = randomUUID();
    const otherId = randomUUID();
    await seedStoryRow(targetId);
    await seedStoryRow(otherId);
    await seedFullDependentSet(targetId, { curationPosition: 0 });
    await seedFullDependentSet(otherId, { curationPosition: 1 });

    await deleteStory(targetId);

    expect(await one("SELECT id FROM stories WHERE id = ?", [otherId])).not.toBeNull();
    expect(
      await all("SELECT id FROM video_renders WHERE story_id = ?", [otherId]),
    ).toHaveLength(1);
    expect(
      await all("SELECT id FROM user_saves WHERE story_id = ?", [otherId]),
    ).toHaveLength(1);
  });
});
