// Identity-resolution coverage for the users repo. The three-branch path
// in upsertUserOnSignIn (provider+sub hit → email-fallback link → create)
// is the single point of truth for sign-in correctness; getting it wrong
// silently merges accounts, dupes users, or — worst case — links a public
// OAuth identity onto an admin row.
//
// The tests run against the shared per-process test SQLite DB configured
// in tests/setup.ts. ensureSchema runs on first query, so the users +
// poll_votes + per-user tables exist before any insert.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { all, run } from "@/lib/db";
import {
  getUserByEmail,
  getUserById,
  getUserByProvider,
  hashForLog,
  upsertUserOnSignIn,
} from "./users";

async function clearUsers(): Promise<void> {
  await run("DELETE FROM users", []);
}

async function insertAdminRow(email: string): Promise<string> {
  const id = randomUUID();
  await run(
    `INSERT INTO users
      (id, email, role, password_hash, provider, provider_sub, created_at)
     VALUES (?, ?, 'admin', 'x', NULL, NULL, ?)`,
    [id, email, new Date().toISOString()],
  );
  return id;
}

describe("upsertUserOnSignIn — identity resolution", () => {
  beforeEach(async () => {
    await clearUsers();
  });

  it("creates a new user on first sign-in and carries the anonymous_id", async () => {
    const result = await upsertUserOnSignIn({
      provider: "google",
      providerSub: "google_sub_001",
      email: "Alice@Example.com",
      name: "Alice",
      pictureUrl: "https://pic/alice",
      anonymousId: "anon_abcdef",
    });
    expect(result.created).toBe(true);
    expect(result.linked).toBe(false);
    expect(result.user.email).toBe("alice@example.com");
    expect(result.user.provider).toBe("google");
    expect(result.user.provider_sub).toBe("google_sub_001");
    expect(result.user.anonymous_id).toBe("anon_abcdef");
    expect(result.user.role).toBe("user");
  });

  it("returns the same row on a second sign-in for the same provider_sub", async () => {
    await upsertUserOnSignIn({
      provider: "google",
      providerSub: "google_sub_002",
      email: "bob@example.com",
      anonymousId: null,
    });
    const again = await upsertUserOnSignIn({
      provider: "google",
      providerSub: "google_sub_002",
      email: "bob@example.com",
      anonymousId: "anon_other",
    });
    expect(again.created).toBe(false);
    expect(again.linked).toBe(false);
    // anonymous_id was NOT overwritten — only set on first creation.
    expect(again.user.anonymous_id).toBeNull();
  });

  it("links across providers when the email matches an existing user row", async () => {
    const first = await upsertUserOnSignIn({
      provider: "google",
      providerSub: "google_sub_003",
      email: "carol@example.com",
      anonymousId: null,
    });
    // Same user signs in with Microsoft using the same email.
    const linked = await upsertUserOnSignIn({
      provider: "microsoft",
      providerSub: "ms_oid_003",
      email: "carol@example.com",
      anonymousId: null,
    });
    expect(linked.created).toBe(false);
    expect(linked.linked).toBe(true);
    expect(linked.user.id).toBe(first.user.id);
    expect(linked.user.provider).toBe("microsoft");
    expect(linked.user.provider_sub).toBe("ms_oid_003");
  });

  it("REFUSES to link an OAuth identity onto an admin row (privilege-escalation guard)", async () => {
    await insertAdminRow("admin@example.com");
    await expect(
      upsertUserOnSignIn({
        provider: "google",
        providerSub: "google_sub_admin",
        email: "admin@example.com",
        anonymousId: null,
      }),
    ).rejects.toThrow();
    // The admin row stays unchanged.
    const admin = await getUserByEmail("admin@example.com");
    expect(admin?.role).toBe("admin");
    expect(admin?.provider).toBeNull();
    expect(admin?.provider_sub).toBeNull();
  });

  it("normalizes the email on lookup so case + whitespace don't dupe rows", async () => {
    await upsertUserOnSignIn({
      provider: "google",
      providerSub: "google_sub_004",
      email: "dave@example.com",
      anonymousId: null,
    });
    const sameUser = await upsertUserOnSignIn({
      provider: "microsoft",
      providerSub: "ms_oid_004",
      email: "  DAVE@example.com  ",
      anonymousId: null,
    });
    expect(sameUser.linked).toBe(true);
    const allUsers = await all<{ email: string }>(
      "SELECT email FROM users WHERE email = 'dave@example.com'",
      [],
    );
    expect(allUsers.length).toBe(1);
  });

  it("preserves the existing name/picture on link if the new sign-in omits them", async () => {
    await upsertUserOnSignIn({
      provider: "google",
      providerSub: "google_sub_005",
      email: "erin@example.com",
      name: "Erin Greene",
      pictureUrl: "https://pic/erin",
      anonymousId: null,
    });
    const linked = await upsertUserOnSignIn({
      provider: "microsoft",
      providerSub: "ms_oid_005",
      email: "erin@example.com",
      // name + pictureUrl omitted — link must not overwrite to NULL.
      anonymousId: null,
    });
    expect(linked.user.name).toBe("Erin Greene");
    expect(linked.user.picture_url).toBe("https://pic/erin");
  });
});

describe("updateUserProfile", () => {
  beforeEach(async () => {
    await clearUsers();
  });

  async function createTestUser(): Promise<string> {
    const r = await upsertUserOnSignIn({
      provider: "google",
      providerSub: "google_sub_profile",
      email: "profile@example.com",
      name: "Original Name",
      pictureUrl: "https://pic/orig",
      anonymousId: null,
    });
    return r.user.id;
  }

  it("updates name + picture_url and returns the patched row", async () => {
    const { updateUserProfile } = await import("./users");
    const id = await createTestUser();
    const updated = await updateUserProfile(id, {
      name: "New Name",
      pictureUrl: "https://pic/new",
    });
    expect(updated.name).toBe("New Name");
    expect(updated.picture_url).toBe("https://pic/new");
    expect(updated.email).toBe("profile@example.com");
  });

  it("treats an empty string as 'clear the field' (NULL)", async () => {
    const { updateUserProfile } = await import("./users");
    const id = await createTestUser();
    const updated = await updateUserProfile(id, { name: "" });
    expect(updated.name).toBeNull();
  });

  it("leaves omitted fields alone (no clobber)", async () => {
    const { updateUserProfile } = await import("./users");
    const id = await createTestUser();
    const updated = await updateUserProfile(id, { name: "Just Name" });
    expect(updated.name).toBe("Just Name");
    // pictureUrl wasn't in the patch — original survives.
    expect(updated.picture_url).toBe("https://pic/orig");
  });

  it("rejects a name longer than the limit", async () => {
    const { updateUserProfile } = await import("./users");
    const id = await createTestUser();
    const tooLong = "x".repeat(100);
    await expect(updateUserProfile(id, { name: tooLong })).rejects.toThrow(
      /too long/,
    );
  });

  it("rejects names with HTML / control characters", async () => {
    const { updateUserProfile } = await import("./users");
    const id = await createTestUser();
    await expect(
      updateUserProfile(id, { name: "<script>alert(1)</script>" }),
    ).rejects.toThrow();
  });

  it("accepts Hebrew + Latin + spaces in names", async () => {
    const { updateUserProfile } = await import("./users");
    const id = await createTestUser();
    const updated = await updateUserProfile(id, { name: "יואב Yoav" });
    expect(updated.name).toBe("יואב Yoav");
  });

  it("rejects a picture URL without an http(s) scheme", async () => {
    const { updateUserProfile } = await import("./users");
    const id = await createTestUser();
    await expect(
      updateUserProfile(id, { pictureUrl: "javascript:alert(1)" }),
    ).rejects.toThrow(/http/);
  });

  it("throws when the user row is missing", async () => {
    const { updateUserProfile } = await import("./users");
    await expect(
      updateUserProfile("nonexistent", { name: "X" }),
    ).rejects.toThrow(/not found/);
  });
});

describe("users helpers", () => {
  it("hashForLog returns a stable 8-char identifier", () => {
    const h1 = hashForLog("user-001");
    const h2 = hashForLog("user-001");
    const h3 = hashForLog("user-002");
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it("getUserById returns null for an unknown id", async () => {
    expect(await getUserById("nope")).toBeNull();
  });

  it("getUserByProvider returns null for a never-seen provider_sub", async () => {
    expect(await getUserByProvider("google", "never")).toBeNull();
  });
});
