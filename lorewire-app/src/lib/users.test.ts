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

describe("email + password (Phase 5.3)", () => {
  beforeEach(async () => {
    await clearUsers();
  });

  it("createPasswordUser inserts a row with provider='email' and hashed password", async () => {
    const { createPasswordUser } = await import("./users");
    const row = await createPasswordUser({
      email: "Alice@Example.com",
      password: "super-secret-password",
      anonymousId: null,
    });
    expect(row.email).toBe("alice@example.com");
    expect(row.provider).toBe("email");
    expect(row.role).toBe("user");
    // Stored hash, not the raw value.
    expect(row.password_hash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(row.password_hash).not.toContain("super-secret");
  });

  it("createPasswordUser refuses a duplicate email", async () => {
    const { createPasswordUser, PublicAuthError } = await import("./users");
    await createPasswordUser({
      email: "dup@example.com",
      password: "first-password",
      anonymousId: null,
    });
    await expect(
      createPasswordUser({
        email: "dup@example.com",
        password: "second-password",
        anonymousId: null,
      }),
    ).rejects.toBeInstanceOf(PublicAuthError);
  });

  it("createPasswordUser rejects short passwords", async () => {
    const { createPasswordUser, PublicAuthError } = await import("./users");
    await expect(
      createPasswordUser({
        email: "short@example.com",
        password: "1234",
        anonymousId: null,
      }),
    ).rejects.toBeInstanceOf(PublicAuthError);
  });

  it("createPasswordUser rejects malformed emails", async () => {
    const { createPasswordUser, PublicAuthError } = await import("./users");
    await expect(
      createPasswordUser({
        email: "not-an-email",
        password: "valid-password-here",
        anonymousId: null,
      }),
    ).rejects.toBeInstanceOf(PublicAuthError);
  });

  it("verifyPasswordLogin returns the user on a correct match", async () => {
    const { createPasswordUser, verifyPasswordLogin } = await import("./users");
    await createPasswordUser({
      email: "verify@example.com",
      password: "the-right-password",
      anonymousId: null,
    });
    const user = await verifyPasswordLogin(
      "verify@example.com",
      "the-right-password",
    );
    expect(user.email).toBe("verify@example.com");
  });

  it("verifyPasswordLogin rejects a wrong password with bad_credentials", async () => {
    const { createPasswordUser, verifyPasswordLogin, PublicAuthError } =
      await import("./users");
    await createPasswordUser({
      email: "wrong@example.com",
      password: "the-right-password",
      anonymousId: null,
    });
    await expect(
      verifyPasswordLogin("wrong@example.com", "the-wrong-password"),
    ).rejects.toBeInstanceOf(PublicAuthError);
  });

  it("verifyPasswordLogin rejects an unknown email with the SAME error code (no enumeration)", async () => {
    const { verifyPasswordLogin, PublicAuthError } = await import("./users");
    try {
      await verifyPasswordLogin("unknown@example.com", "anything");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PublicAuthError);
      expect((err as InstanceType<typeof PublicAuthError>).code).toBe(
        "bad_credentials",
      );
    }
  });

  it("squatter guard: refuses to LINK an OAuth identity to an email-password row", async () => {
    const { createPasswordUser } = await import("./users");
    // Squatter creates the row first with email they don't own.
    await createPasswordUser({
      email: "alice@example.com",
      password: "squatter-password",
      anonymousId: null,
    });
    // Real Alice signs in via Google with the same email.
    await expect(
      upsertUserOnSignIn({
        provider: "google",
        providerSub: "google_alice_real",
        email: "alice@example.com",
        anonymousId: null,
      }),
    ).rejects.toThrow();
    // The original password row is untouched — Alice creates a separate
    // account via Google instead. (Support can clean up the squatter
    // row later.)
    const stillThere = await getUserByEmail("alice@example.com");
    expect(stillThere?.provider).toBe("email");
  });

  it("squatter guard does NOT block magic-link → magic-link or OAuth → magic-link", async () => {
    // Magic-link rows prove email ownership at signup, so cross-linking
    // INTO a magic-link row from Google is safe and should succeed.
    const result = await upsertUserOnSignIn({
      provider: "magic_link",
      providerSub: "ml@example.com",
      email: "ml@example.com",
      anonymousId: null,
    });
    expect(result.user.provider).toBe("magic_link");
    // Now Google sign-in on the same email — this should LINK (not
    // refuse) because the magic-link row already proved email ownership.
    const linked = await upsertUserOnSignIn({
      provider: "google",
      providerSub: "google_ml_owner",
      email: "ml@example.com",
      anonymousId: null,
    });
    expect(linked.linked).toBe(true);
    expect(linked.user.id).toBe(result.user.id);
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
