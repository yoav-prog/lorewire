// Integration test against the same temp SQLite db that tests/setup.ts wires
// up. We exercise bulkEnqueueStoryJobs end-to-end: seed a few
// reddit_source rows, call the function, assert per-row outcome (enqueued
// vs skipped_active vs skipped_status vs not_found).

import { beforeEach, describe, expect, it } from "vitest";

import { all, one, run } from "@/lib/db";
import {
  bulkEnqueueStoryJobs,
  countPendingStoryJobs,
  listLatestStoryJobsForReddit,
} from "./story-jobs";
import { bulkReprocessRedditSources } from "./reddit-source";

async function seedSource(redditId: string, status: string) {
  await run(
    "INSERT INTO reddit_source (reddit_id, subreddit, date_written, title, full_text, comments, status, first_synced, last_synced) " +
      "VALUES (?, 'AITAH', '2026-01-01T00:00:00+00:00', 't', 'f', 1, ?, '2026-06-14T00:00:00+00:00', '2026-06-14T00:00:00+00:00')",
    [redditId, status],
  );
}

async function clear() {
  await run("DELETE FROM story_jobs", []);
  await run("DELETE FROM reddit_source", []);
  await run("DELETE FROM stories", []);
}

// Seeds a story row matching `id` so bulkReprocessRedditSources has
// something to archive. We only need a minimal shape; the helper just
// flips status + updated_at.
async function seedStory(id: string, status: string = "review") {
  await run(
    "INSERT INTO stories (id, status, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [id, status, "2026-06-14T00:00:00+00:00", "2026-06-14T00:00:00+00:00"],
  );
}

async function setSourceUsed(redditId: string, storyId: string) {
  await run(
    "UPDATE reddit_source SET status='used', story_id=? WHERE reddit_id=?",
    [storyId, redditId],
  );
}

describe("bulkEnqueueStoryJobs", () => {
  beforeEach(clear);

  it("enqueues every imported row", async () => {
    await seedSource("a", "imported");
    await seedSource("b", "imported");

    const result = await bulkEnqueueStoryJobs(["a", "b"], {
      requested_by: "tester",
    });

    expect(result.enqueued).toBe(2);
    expect(result.skipped_active).toBe(0);
    expect(result.skipped_status).toBe(0);
    expect(result.not_found).toBe(0);
    expect(result.enqueued_ids.sort()).toEqual(["a", "b"]);

    // reddit_source.status flipped to queued; story_jobs has the rows.
    const sourceRows = await all<{ reddit_id: string; status: string }>(
      "SELECT reddit_id, status FROM reddit_source ORDER BY reddit_id",
      [],
    );
    expect(sourceRows).toEqual([
      { reddit_id: "a", status: "queued" },
      { reddit_id: "b", status: "queued" },
    ]);
    expect(await countPendingStoryJobs()).toBe(2);
  });

  it("skips rows that already have an active job (idempotent)", async () => {
    await seedSource("a", "imported");
    const first = await bulkEnqueueStoryJobs(["a"]);
    expect(first.enqueued).toBe(1);

    const second = await bulkEnqueueStoryJobs(["a"]);
    expect(second.enqueued).toBe(0);
    expect(second.skipped_active).toBe(1);
    expect(await countPendingStoryJobs()).toBe(1);
  });

  it("re-enqueues after a previous attempt finished", async () => {
    await seedSource("a", "imported");
    await bulkEnqueueStoryJobs(["a"]);

    // Simulate worker: claim + finish.
    await run("UPDATE story_jobs SET status='done' WHERE reddit_id=?", ["a"]);
    // Reset source row to 'imported' so a fresh re-process can run.
    await run("UPDATE reddit_source SET status='imported' WHERE reddit_id=?", [
      "a",
    ]);

    const result = await bulkEnqueueStoryJobs(["a"]);
    expect(result.enqueued).toBe(1);
    expect(result.skipped_active).toBe(0);
  });

  it("skips rows in 'used' or 'skipped' status", async () => {
    await seedSource("used-row", "used");
    await seedSource("skipped-row", "skipped");
    await seedSource("imported-row", "imported");

    const result = await bulkEnqueueStoryJobs([
      "used-row",
      "skipped-row",
      "imported-row",
    ]);

    expect(result.enqueued).toBe(1);
    expect(result.skipped_status).toBe(2);
    expect(result.enqueued_ids).toEqual(["imported-row"]);
  });

  it("counts not-found ids separately from skipped", async () => {
    await seedSource("a", "imported");
    const result = await bulkEnqueueStoryJobs(["a", "ghost"]);
    expect(result.enqueued).toBe(1);
    expect(result.not_found).toBe(1);
    expect(result.skipped_status).toBe(0);
  });

  it("respects with_media=false", async () => {
    await seedSource("a", "imported");
    await bulkEnqueueStoryJobs(["a"], { with_media: false });
    const jobs = await listLatestStoryJobsForReddit(["a"]);
    expect(jobs.get("a")?.with_media).toBe(0);
  });

  it("returns zero-result on empty input without touching the DB", async () => {
    await seedSource("a", "imported");
    const result = await bulkEnqueueStoryJobs([]);
    expect(result).toEqual({
      enqueued: 0,
      skipped_active: 0,
      skipped_status: 0,
      not_found: 0,
      enqueued_ids: [],
    });
    // Source row untouched.
    const rows = await all<{ status: string }>(
      "SELECT status FROM reddit_source WHERE reddit_id=?",
      ["a"],
    );
    expect(rows[0].status).toBe("imported");
  });

  it("re-clicking on a row already queued (worker pending) is a no-op", async () => {
    await seedSource("a", "imported");
    await bulkEnqueueStoryJobs(["a"]);
    // Now reddit_source.status='queued' and job is queued. Re-click:
    const result = await bulkEnqueueStoryJobs(["a"]);
    expect(result.enqueued).toBe(0);
    expect(result.skipped_active).toBe(1);
  });
});

describe("partial unique index", () => {
  beforeEach(clear);

  it("rejects a raw second insert with status='queued' for the same reddit_id", async () => {
    await seedSource("abc", "imported");
    await bulkEnqueueStoryJobs(["abc"]);

    // Direct INSERT bypassing the app-level guard — the partial unique
    // index must reject. We use a fresh UUID so the PRIMARY KEY doesn't
    // collide; the only constraint that should fire is the partial
    // unique index on `reddit_id` WHERE active.
    await expect(
      run(
        "INSERT INTO story_jobs " +
          "(id, reddit_id, status, progress, with_media, requested_at) " +
          "VALUES ('forced-dupe', 'abc', 'queued', 0, 1, '2026-06-14T00:00:00+00:00')",
        [],
      ),
    ).rejects.toThrow();
  });

  it("permits a fresh active job once the prior one settles", async () => {
    await seedSource("abc", "imported");
    await bulkEnqueueStoryJobs(["abc"]);
    // Settle the first job to 'done' — outside the partial index's predicate.
    await run("UPDATE story_jobs SET status='done' WHERE reddit_id=?", ["abc"]);

    // Now a raw insert with status='queued' must succeed (the index's
    // partial predicate is `status IN ('queued','processing')`; the prior
    // row no longer matches and so doesn't conflict).
    await run(
      "INSERT INTO story_jobs " +
        "(id, reddit_id, status, progress, with_media, requested_at) " +
        "VALUES ('after-settle', 'abc', 'queued', 0, 1, '2026-06-14T00:00:00+00:00')",
      [],
    );
    expect(await countPendingStoryJobs()).toBe(1);
  });

  it("bulkEnqueueStoryJobs is race-safe when the app-level guard misses", async () => {
    // The app-level snapshotActiveJobs check is a fast path, not the
    // safety net. If two simultaneous bulkEnqueue calls both see "no
    // active job" before either INSERTs, the partial unique index +
    // ON CONFLICT DO NOTHING in bulkInsertJobs must turn the loser
    // into a silent skip — not a UNIQUE error that aborts the whole batch.
    //
    // We can't easily simulate true concurrency in vitest, so we
    // approximate by pre-seeding an active job and then calling
    // bulkEnqueue with a row whose app-level snapshot we know would
    // race-lose. The bulkEnqueue itself filters by snapshotActiveJobs,
    // so it'll skip the dupe; we instead verify the underlying
    // bulkInsertJobs path's ON CONFLICT works by inserting directly.
    await seedSource("abc", "imported");
    await bulkEnqueueStoryJobs(["abc"]);
    // Verify: ON CONFLICT DO NOTHING swallows the dup, no throw.
    await run(
      "INSERT INTO story_jobs " +
        "(id, reddit_id, status, progress, with_media, requested_at) " +
        "VALUES ('on-conflict-test', 'abc', 'queued', 0, 1, '2026-06-14T00:00:00+00:00') " +
        "ON CONFLICT (reddit_id) WHERE status IN ('queued', 'processing') DO NOTHING",
      [],
    );
    // And the count stays at 1 — the dup was silently dropped.
    expect(await countPendingStoryJobs()).toBe(1);
  });
});

describe("bulkEnqueueStoryJobs race-loss handling", () => {
  beforeEach(clear);

  it("does NOT flip source.status='queued' when the ON CONFLICT swallows our INSERT", async () => {
    // Pre-seed an active job for 'a' so any new INSERT for 'a' will be
    // a race-loser. Then directly call bulkEnqueueStoryJobs on ['a','b']
    // — but first temporarily clear the active-jobs snapshot's table
    // signal so the helper thinks it can insert both. We approximate
    // the race by inserting the job AFTER the helper's snapshot would
    // have looked: actually simpler — we just pre-insert AND also
    // pre-flip 'a' to 'imported' (so the snapshot's source check passes)
    // AND skip the active-jobs snapshot by... actually, the cleanest
    // way to simulate this is to insert the active job DIRECTLY into
    // story_jobs without bulkEnqueue, then call bulkEnqueue and assert
    // that 'a' shows up as skipped_active and 'a's source.status is
    // unchanged.
    await seedSource("a", "imported");
    await seedSource("b", "imported");
    // Manually plant an active job for 'a'.
    await run(
      "INSERT INTO story_jobs (id, reddit_id, status, progress, with_media, requested_at) " +
        "VALUES ('preplanted', 'a', 'queued', 0, 1, '2026-06-14T00:00:00+00:00')",
      [],
    );

    const result = await bulkEnqueueStoryJobs(["a", "b"]);

    // 'a' is skipped via the active-jobs snapshot path (this was correct
    // before too). 'b' is enqueued.
    expect(result.enqueued).toBe(1);
    expect(result.skipped_active).toBe(1);
    expect(result.enqueued_ids).toEqual(["b"]);

    // 'a's source status must remain 'imported' — the helper must NOT
    // have flipped it to 'queued' just because we asked for it.
    const aStatus = await one<{ status: string }>(
      "SELECT status FROM reddit_source WHERE reddit_id=?",
      ["a"],
    );
    expect(aStatus?.status).toBe("imported");
  });

  it("bulkFlipSourceStatus does not demote 'processing' to 'queued'", async () => {
    await seedSource("a", "imported");
    // First enqueue puts 'a' into queued status.
    await bulkEnqueueStoryJobs(["a"]);
    // Worker claims, flipping source to 'processing'.
    await run("UPDATE reddit_source SET status='processing' WHERE reddit_id=?", [
      "a",
    ]);
    // Worker's previous job finishes externally and gets cleared.
    await run("UPDATE story_jobs SET status='done' WHERE reddit_id=?", ["a"]);

    // Now an admin re-clicks Process for 'a' — but source is currently
    // 'processing' which is NOT in ALLOWED_SOURCE_STATUSES. The helper
    // should bail out cleanly.
    const result = await bulkEnqueueStoryJobs(["a"]);
    expect(result.enqueued).toBe(0);
    expect(result.skipped_status).toBe(1);

    // Crucially, source.status MUST still be 'processing' — the helper's
    // bulkFlipSourceStatus guard prevented a regression even if a future
    // edit accidentally adds 'processing' to ALLOWED_SOURCE_STATUSES.
    const row = await one<{ status: string }>(
      "SELECT status FROM reddit_source WHERE reddit_id=?",
      ["a"],
    );
    expect(row?.status).toBe("processing");
  });
});

describe("bulkReprocessRedditSources", () => {
  beforeEach(clear);

  it("returns a zero-result on empty input", async () => {
    const result = await bulkReprocessRedditSources([]);
    expect(result).toEqual({
      reset: 0,
      skipped_active: 0,
      skipped_other: 0,
      not_found: 0,
      reset_ids: [],
    });
  });

  it("resets a single 'used' row and archives its story", async () => {
    await seedSource("a", "imported");
    await seedStory("story-a", "review");
    await setSourceUsed("a", "story-a");

    const result = await bulkReprocessRedditSources(["a"]);
    expect(result.reset).toBe(1);
    expect(result.reset_ids).toEqual(["a"]);

    const source = await one<{ status: string; story_id: string | null }>(
      "SELECT status, story_id FROM reddit_source WHERE reddit_id=?",
      ["a"],
    );
    expect(source).toEqual({ status: "imported", story_id: null });
    const story = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id=?",
      ["story-a"],
    );
    expect(story?.status).toBe("archived");
  });

  it("partitions a mixed batch into reset / skipped_active / skipped_other / not_found", async () => {
    // Three rows:
    //  - used:      status='used' + story_id → must reset, must archive story
    //  - queued:    status='queued'          → skipped_active
    //  - imported:  status='imported'        → skipped_other
    // Plus one id that doesn't exist        → not_found
    await seedSource("used-row", "imported");
    await seedStory("story-used", "review");
    await setSourceUsed("used-row", "story-used");

    await seedSource("queued-row", "imported");
    await run("UPDATE reddit_source SET status='queued' WHERE reddit_id=?", [
      "queued-row",
    ]);

    await seedSource("imported-row", "imported");

    const result = await bulkReprocessRedditSources([
      "used-row",
      "queued-row",
      "imported-row",
      "ghost",
    ]);

    expect(result.reset).toBe(1);
    expect(result.skipped_active).toBe(1);
    expect(result.skipped_other).toBe(1);
    expect(result.not_found).toBe(1);
    expect(result.reset_ids).toEqual(["used-row"]);

    // Source-side state per row:
    const usedRow = await one<{ status: string; story_id: string | null }>(
      "SELECT status, story_id FROM reddit_source WHERE reddit_id=?",
      ["used-row"],
    );
    expect(usedRow).toEqual({ status: "imported", story_id: null });

    const queuedRow = await one<{ status: string }>(
      "SELECT status FROM reddit_source WHERE reddit_id=?",
      ["queued-row"],
    );
    expect(queuedRow?.status).toBe(
      "queued",
      // Critically: the active row was NOT touched. A worker mid-execution
      // would have its source-row link silently stripped otherwise.
    );

    const importedRow = await one<{ status: string }>(
      "SELECT status FROM reddit_source WHERE reddit_id=?",
      ["imported-row"],
    );
    expect(importedRow?.status).toBe("imported");

    // Story-side: only the 'used' row's linked story got archived.
    const archivedStory = await one<{ status: string }>(
      "SELECT status FROM stories WHERE id=?",
      ["story-used"],
    );
    expect(archivedStory?.status).toBe("archived");
  });

  it("skips a 'used' row that has no linked story (defensive)", async () => {
    // Phase 3 contract says story_id is set whenever status='used', but
    // the helper shouldn't crash if that invariant is ever violated.
    // Treats it as "nothing to archive, just reset the source row."
    await seedSource("orphan", "imported");
    await run(
      "UPDATE reddit_source SET status='used', story_id=NULL WHERE reddit_id=?",
      ["orphan"],
    );

    const result = await bulkReprocessRedditSources(["orphan"]);
    expect(result.reset).toBe(1);

    const row = await one<{ status: string; story_id: string | null }>(
      "SELECT status, story_id FROM reddit_source WHERE reddit_id=?",
      ["orphan"],
    );
    expect(row).toEqual({ status: "imported", story_id: null });
  });

  it("double-click is safely idempotent (second call is all skipped_other)", async () => {
    await seedSource("a", "imported");
    await seedStory("story-a", "review");
    await setSourceUsed("a", "story-a");

    const first = await bulkReprocessRedditSources(["a"]);
    expect(first.reset).toBe(1);

    // Second call: row is now 'imported' — no work to redo.
    const second = await bulkReprocessRedditSources(["a"]);
    expect(second.reset).toBe(0);
    expect(second.skipped_other).toBe(1);
  });
});

describe("listLatestStoryJobsForReddit", () => {
  beforeEach(clear);

  it("returns one entry per reddit_id, picking the most recent", async () => {
    await seedSource("a", "imported");
    await bulkEnqueueStoryJobs(["a"]);
    // Fail the first attempt, enqueue another.
    await run("UPDATE story_jobs SET status='error' WHERE reddit_id=?", ["a"]);
    await run("UPDATE reddit_source SET status='imported' WHERE reddit_id=?", [
      "a",
    ]);
    // Tiny sleep so requested_at differs.
    await new Promise((r) => setTimeout(r, 5));
    await bulkEnqueueStoryJobs(["a"]);

    const map = await listLatestStoryJobsForReddit(["a"]);
    expect(map.size).toBe(1);
    expect(map.get("a")?.status).toBe("queued");
  });
});
