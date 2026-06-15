import { describe, expect, it } from "vitest";

import { POST_TABLE_DDL } from "./schema";

// POST_TABLE_DDL is the TS source of truth for the indexes `ensureSchema`
// creates after building the tables. The partial unique indexes here are
// load-bearing, not perf hints: the `INSERT ... ON CONFLICT (...) WHERE ...`
// clauses in the TS enqueue paths require a matching partial unique index to
// exist on Postgres, or the insert throws "no unique or exclusion constraint
// matching the ON CONFLICT specification" and the server action 500s.
//
// A missing mirror is exactly what crashed the Regenerate voiceover action in
// prod on 2026-06-15: the voice_renders index lived only in pipeline/store.py,
// so the Vercel app created the table but never the index. These tests guard
// against that class of regression for both queues.
describe("POST_TABLE_DDL load-bearing partial unique indexes", () => {
  const joined = POST_TABLE_DDL.join("\n");

  it("includes the voice_renders one-active index the regen ON CONFLICT needs", () => {
    expect(joined).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_renders_one_active",
    );
    expect(joined).toContain(
      "ON voice_renders(story_id, text_hash, voice_provider, voice_id)",
    );
    expect(joined).toContain("WHERE status IN ('queued', 'processing')");
  });

  it("includes the story_jobs one-active index the bulk-enqueue ON CONFLICT needs", () => {
    expect(joined).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_story_jobs_one_active",
    );
    expect(joined).toContain(
      "ON story_jobs(reddit_id) WHERE status IN ('queued', 'processing')",
    );
  });
});
