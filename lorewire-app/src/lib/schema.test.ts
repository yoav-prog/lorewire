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

  // 2026-06-19 anonymous-first auth. The OAuth callback's user lookup
  // resolves identity via (provider, provider_sub) — Google's `sub`
  // claim or Microsoft's `oid` — and the per-user state tables upsert
  // via (user_id, story_id). Missing any of these indexes silently
  // permits duplicate rows on Postgres and would break the sign-in /
  // sync flow. Plan: _plans/2026-06-19-anonymous-first-auth.md.
  it("includes the users (provider, provider_sub) partial unique index", () => {
    expect(joined).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider_sub",
    );
    expect(joined).toContain(
      "WHERE provider IS NOT NULL AND provider_sub IS NOT NULL",
    );
  });

  it("includes the user_saves (user_id, story_id) unique index", () => {
    expect(joined).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_saves_user_story",
    );
    expect(joined).toContain("ON user_saves(user_id, story_id)");
  });

  it("includes the user_likes (user_id, story_id) unique index", () => {
    expect(joined).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_likes_user_story",
    );
    expect(joined).toContain("ON user_likes(user_id, story_id)");
  });

  it("includes the user_fav_categories (user_id, category) unique index", () => {
    expect(joined).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_fav_categories_user_cat",
    );
  });

  it("includes the user_continue (user_id, story_id) unique index", () => {
    expect(joined).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_continue_user_story",
    );
  });

  // 2026-06-19 polls + auth. Signed-in voters get a second
  // anti-double-vote primitive keyed on user_id. The PARTIAL clause
  // matters — without it, the index would treat anonymous votes (user_id
  // NULL) as duplicates of each other and break the existing cookie-only
  // path.
  it("includes the partial unique index for signed-in poll votes", () => {
    expect(joined).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_votes_poll_user",
    );
    expect(joined).toContain("ON poll_votes(poll_id, user_id)");
    expect(joined).toContain("WHERE user_id IS NOT NULL");
  });

  // 2026-06-19 Phase 3 magic link. The verify path's hot read is by
  // token_hash; missing this index turns every verify click into a
  // table scan on Postgres as the magic_link_tokens table grows.
  it("includes the magic_link_tokens token_hash lookup index", () => {
    expect(joined).toContain(
      "CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_hash",
    );
    expect(joined).toContain("ON magic_link_tokens(token_hash)");
  });
});
