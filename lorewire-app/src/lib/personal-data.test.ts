import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { run } from "@/lib/db";
import { TABLES } from "./schema";
import { EXPORT_SOURCES, exportUserData } from "./personal-data";
import { getUserById } from "./users";

// Drift guard. Export is a hand-written read over EXPORT_SOURCES. If someone
// adds a new per-user table to the schema (any table with a `user_id` column)
// but forgets to register it here, that data silently never appears in a
// user's Article 15/20 export. These pure-data tests fail the build the moment
// that happens.
//
// Plan: _plans/2026-06-22-gdpr-compliance.md §Phase 2 (export).
describe("personal-data export registry", () => {
  const byName = new Map(TABLES.map((t) => [t.name, t]));
  const registered = new Set(EXPORT_SOURCES.map((s) => s.table));

  it("exports every schema table that has a user_id column", () => {
    const userKeyedTables = TABLES.filter((t) =>
      t.columns.some((c) => c.name === "user_id"),
    ).map((t) => t.name);

    for (const table of userKeyedTables) {
      expect(
        registered.has(table),
        `${table} has a user_id column but is missing from EXPORT_SOURCES — it would never appear in a user's export`,
      ).toBe(true);
    }
  });

  it("only references real tables and locator columns", () => {
    for (const source of EXPORT_SOURCES) {
      const table = byName.get(source.table);
      expect(table, `unknown table ${source.table}`).toBeDefined();
      expect(
        table!.columns.some((c) => c.name === source.column),
        `${source.table}.${source.column} is not a real column`,
      ).toBe(true);
    }
  });

  it("exports the users row keyed by id, never by user_id", () => {
    const usersSource = EXPORT_SOURCES.find((s) => s.table === "users");
    expect(usersSource).toBeDefined();
    expect(usersSource!.column).toBe("id");
  });

  it("only lists real columns and never the password hash", () => {
    for (const source of EXPORT_SOURCES) {
      if (!source.columns) continue;
      const cols = new Set(byName.get(source.table)!.columns.map((c) => c.name));
      for (const col of source.columns) {
        expect(
          cols.has(col),
          `${source.table}.${col} is listed for export but is not a real column`,
        ).toBe(true);
      }
      expect(source.columns).not.toContain("password_hash");
    }
  });
});

// Integration: the reader returns the user's own rows and strips secrets.
// Runs against the per-process temp SQLite DB from tests/setup.ts.
describe("exportUserData (integration)", () => {
  beforeEach(async () => {
    await run("DELETE FROM users", []);
    await run("DELETE FROM user_saves", []);
    await run("DELETE FROM poll_votes", []);
  });

  async function seedUser(): Promise<string> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await run(
      `INSERT INTO users
          (id, email, role, password_hash, name, picture_url,
           provider, provider_sub, anonymous_id, last_seen_at, created_at)
        VALUES (?, ?, 'user', ?, ?, NULL, 'email', ?, NULL, ?, ?)`,
      [id, "subject@example.com", "scrypt$salt$hash", "Subject", id, now, now],
    );
    await run(
      `INSERT INTO user_saves (id, user_id, story_id, created_at)
        VALUES (?, ?, ?, ?)`,
      [randomUUID(), id, "story-1", now],
    );
    await run(
      `INSERT INTO poll_votes
          (id, poll_id, story_id, side, cookie_token, ip_ua_hash, created_at, user_id)
        VALUES (?, ?, ?, 'A', ?, ?, ?, ?)`,
      [randomUUID(), "poll-1", "story-1", "nonce-secret", "iphash-secret", now, id],
    );
    return id;
  }

  it("returns the user's rows, never the password hash or vote secrets", async () => {
    const id = await seedUser();
    const user = await getUserById(id);
    expect(user).not.toBeNull();

    const result = await exportUserData(user!);

    // Account profile present, password hash absent.
    expect(result.data.users).toHaveLength(1);
    const profile = result.data.users[0] as Record<string, unknown>;
    expect(profile.email).toBe("subject@example.com");
    expect(profile).not.toHaveProperty("password_hash");

    // Satellite data present.
    expect(result.data.user_saves).toHaveLength(1);

    // Poll vote present but stripped of the anti-double-vote nonce and the
    // rate-limit hash.
    expect(result.data.poll_votes).toHaveLength(1);
    const vote = result.data.poll_votes[0] as Record<string, unknown>;
    expect(vote.side).toBe("A");
    expect(vote).not.toHaveProperty("cookie_token");
    expect(vote).not.toHaveProperty("ip_ua_hash");
  });

  it("returns empty arrays for a user with no activity", async () => {
    const id = await seedUser();
    await run("DELETE FROM user_saves", []);
    await run("DELETE FROM poll_votes", []);
    const user = await getUserById(id);

    const result = await exportUserData(user!);
    expect(result.data.user_saves).toEqual([]);
    expect(result.data.poll_votes).toEqual([]);
    expect(result.data.users).toHaveLength(1);
  });
});
