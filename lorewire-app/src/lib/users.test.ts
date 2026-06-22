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
  countActiveAdmins,
  countMembers,
  getMemberActivity,
  getUserByEmail,
  getUserById,
  getUserByProvider,
  hashForLog,
  isSuspended,
  listMemberProviders,
  listMembers,
  setUserRole,
  suspendUser,
  unsuspendUser,
  upsertUserOnSignIn,
  verifyStaffPassword,
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

describe("admin members view", () => {
  // These tests own the users + per-user tables, so wipe all of them before
  // each case (the shared per-process test DB makes a full clear safe).
  async function clearMembers(): Promise<void> {
    for (const t of [
      "users",
      "user_saves",
      "user_likes",
      "user_fav_categories",
      "user_recently_viewed",
      "user_continue",
      "poll_votes",
    ]) {
      await run(`DELETE FROM ${t}`, []);
    }
  }

  async function seedMember(opts: {
    id: string;
    email: string;
    name?: string | null;
    provider: string;
    created: string;
    lastSeen?: string | null;
  }): Promise<void> {
    await run(
      `INSERT INTO users
         (id, email, password_hash, role, name, picture_url,
          provider, provider_sub, anonymous_id, last_seen_at, created_at)
       VALUES (?, ?, NULL, 'user', ?, NULL, ?, ?, NULL, ?, ?)`,
      [
        opts.id,
        opts.email,
        opts.name ?? null,
        opts.provider,
        `${opts.id}_sub`,
        opts.lastSeen ?? null,
        opts.created,
      ],
    );
  }

  beforeEach(clearMembers);

  it("lists only public members and never staff", async () => {
    await seedMember({
      id: "m_alice",
      email: "alice@example.com",
      name: "Alice",
      provider: "google",
      created: "2026-06-01T00:00:00.000Z",
    });
    // An admin row must never surface in the Members list.
    await run(
      `INSERT INTO users (id, email, role, password_hash, provider, provider_sub, created_at)
       VALUES ('m_admin', 'admin@example.com', 'admin', 'x', NULL, NULL, '2026-06-01T00:00:00.000Z')`,
      [],
    );

    const rows = await listMembers();
    expect(rows.map((r) => r.id)).toEqual(["m_alice"]);
    expect(await countMembers()).toBe(1);
  });

  it("filters by search across email and name", async () => {
    await seedMember({ id: "m_a", email: "alice@example.com", name: "Alice", provider: "google", created: "2026-06-01T00:00:00.000Z" });
    await seedMember({ id: "m_b", email: "bob@elsewhere.com", name: "Bob Jones", provider: "facebook", created: "2026-06-02T00:00:00.000Z" });

    expect((await listMembers({ search: "alice" })).map((r) => r.id)).toEqual(["m_a"]);
    expect((await listMembers({ search: "jones" })).map((r) => r.id)).toEqual(["m_b"]);
    // No match → empty, and the count agrees.
    expect(await listMembers({ search: "zzz" })).toHaveLength(0);
    expect(await countMembers({ search: "elsewhere" })).toBe(1);
  });

  it("filters by provider", async () => {
    await seedMember({ id: "m_g", email: "g@example.com", provider: "google", created: "2026-06-01T00:00:00.000Z" });
    await seedMember({ id: "m_f", email: "f@example.com", provider: "facebook", created: "2026-06-02T00:00:00.000Z" });

    const facebook = await listMembers({ provider: "facebook" });
    expect(facebook.map((r) => r.id)).toEqual(["m_f"]);
    expect(await countMembers({ provider: "google" })).toBe(1);
  });

  it("sorts recent (last_seen) vs joined (created)", async () => {
    // Alice joined first but Bob was active more recently.
    await seedMember({ id: "m_a", email: "a@example.com", provider: "google", created: "2026-06-01T00:00:00.000Z", lastSeen: "2026-06-10T00:00:00.000Z" });
    await seedMember({ id: "m_b", email: "b@example.com", provider: "google", created: "2026-06-05T00:00:00.000Z", lastSeen: "2026-06-20T00:00:00.000Z" });

    expect((await listMembers({}, { sort: "recent" })).map((r) => r.id)).toEqual(["m_b", "m_a"]);
    expect((await listMembers({}, { sort: "joined" })).map((r) => r.id)).toEqual(["m_b", "m_a"]);
    // Make joined order diverge from recent: Carol joined last, seen long ago.
    await seedMember({ id: "m_c", email: "c@example.com", provider: "google", created: "2026-06-30T00:00:00.000Z", lastSeen: "2026-06-02T00:00:00.000Z" });
    expect((await listMembers({}, { sort: "joined" }))[0].id).toBe("m_c");
    expect((await listMembers({}, { sort: "recent" }))[0].id).toBe("m_b");
  });

  it("paginates with limit + offset, no overlap", async () => {
    for (let i = 0; i < 5; i++) {
      await seedMember({ id: `m_p${i}`, email: `p${i}@example.com`, provider: "google", created: `2026-06-0${i + 1}T00:00:00.000Z` });
    }
    const first = await listMembers({}, { limit: 2, offset: 0, sort: "joined" });
    const second = await listMembers({}, { limit: 2, offset: 2, sort: "joined" });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    const firstIds = new Set(first.map((r) => r.id));
    expect(second.some((r) => firstIds.has(r.id))).toBe(false);
  });

  it("listMemberProviders returns the distinct providers among members only", async () => {
    await seedMember({ id: "m_g1", email: "g1@example.com", provider: "google", created: "2026-06-01T00:00:00.000Z" });
    await seedMember({ id: "m_g2", email: "g2@example.com", provider: "google", created: "2026-06-02T00:00:00.000Z" });
    await seedMember({ id: "m_f1", email: "f1@example.com", provider: "facebook", created: "2026-06-03T00:00:00.000Z" });
    // Admin (provider NULL) must not leak into the provider list.
    await run(
      `INSERT INTO users (id, email, role, password_hash, provider, provider_sub, created_at)
       VALUES ('m_admin2', 'admin2@example.com', 'admin', 'x', NULL, NULL, '2026-06-01T00:00:00.000Z')`,
      [],
    );
    expect(await listMemberProviders()).toEqual(["facebook", "google"]);
  });

  it("getMemberActivity counts each user-keyed table", async () => {
    await seedMember({ id: "m_act", email: "act@example.com", provider: "google", created: "2026-06-01T00:00:00.000Z" });
    await run(`INSERT INTO user_saves (id, user_id, story_id, created_at) VALUES ('s1', 'm_act', 'st1', '2026-06-01T00:00:00.000Z')`, []);
    await run(`INSERT INTO user_saves (id, user_id, story_id, created_at) VALUES ('s2', 'm_act', 'st2', '2026-06-01T00:00:00.000Z')`, []);
    await run(`INSERT INTO user_likes (id, user_id, story_id, created_at) VALUES ('l1', 'm_act', 'st1', '2026-06-01T00:00:00.000Z')`, []);

    const activity = await getMemberActivity("m_act");
    expect(activity.saves).toBe(2);
    expect(activity.likes).toBe(1);
    expect(activity.favCategories).toBe(0);
    expect(activity.recentlyViewed).toBe(0);
  });

  it("getMemberActivity returns all-zero for an empty id", async () => {
    expect(await getMemberActivity("")).toEqual({
      saves: 0,
      likes: 0,
      favCategories: 0,
      recentlyViewed: 0,
      continueItems: 0,
      pollVotes: 0,
    });
  });

  it("filters by status (active treats NULL as active)", async () => {
    await seedMember({ id: "m_active", email: "active@example.com", provider: "google", created: "2026-06-01T00:00:00.000Z" });
    await seedMember({ id: "m_susp", email: "susp@example.com", provider: "google", created: "2026-06-02T00:00:00.000Z" });
    await suspendUser("m_susp", "spam");

    expect((await listMembers({ status: "suspended" })).map((r) => r.id)).toEqual(["m_susp"]);
    // 'active' includes the NULL-status legacy/normal row, excludes suspended.
    expect((await listMembers({ status: "active" })).map((r) => r.id)).toEqual(["m_active"]);
    expect(await countMembers({ status: "suspended" })).toBe(1);
  });
});

describe("suspend / unsuspend", () => {
  async function clearUsersOnly(): Promise<void> {
    await run("DELETE FROM users", []);
  }

  async function seedRole(
    id: string,
    role: string,
    status: string | null = null,
  ): Promise<void> {
    await run(
      `INSERT INTO users (id, email, role, password_hash, provider, provider_sub, status, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
      [
        id,
        `${id}@example.com`,
        role,
        role === "admin" ? "x" : null,
        status,
        "2026-06-01T00:00:00.000Z",
      ],
    );
  }

  beforeEach(clearUsersOnly);

  it("suspends a regular member and records reason + timestamp", async () => {
    await seedRole("u1", "user");
    expect(await suspendUser("u1", "  abuse  ")).toBe("suspended");
    const row = await getUserById("u1");
    expect(isSuspended(row?.status)).toBe(true);
    expect(row?.suspended_reason).toBe("abuse"); // trimmed
    expect(row?.suspended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns not_found for a missing user", async () => {
    expect(await suspendUser("ghost")).toBe("not_found");
  });

  it("REFUSES to suspend the last active admin (lockout guard)", async () => {
    await seedRole("admin1", "admin");
    expect(await suspendUser("admin1")).toBe("last_admin");
    // The admin stays active.
    expect(isSuspended((await getUserById("admin1"))?.status)).toBe(false);
  });

  it("allows suspending an admin when another active admin remains", async () => {
    await seedRole("admin1", "admin");
    await seedRole("admin2", "admin");
    expect(await suspendUser("admin1")).toBe("suspended");
    expect(isSuspended((await getUserById("admin1"))?.status)).toBe(true);
    // ...but now admin2 is the last one and can't be suspended.
    expect(await suspendUser("admin2")).toBe("last_admin");
  });

  it("counts only active admins (suspended ones don't count)", async () => {
    await seedRole("admin1", "admin");
    await seedRole("admin2", "admin", "suspended");
    await seedRole("u1", "user");
    expect(await countActiveAdmins()).toBe(1);
  });

  it("unsuspend clears the status, timestamp, and reason", async () => {
    await seedRole("u1", "user");
    await suspendUser("u1", "spam");
    expect(await unsuspendUser("u1")).toBe(true);
    const row = await getUserById("u1");
    expect(row?.status).toBe("active");
    expect(row?.suspended_at).toBeNull();
    expect(row?.suspended_reason).toBeNull();
  });
});

describe("isSuspended helper", () => {
  it("treats only the literal 'suspended' as suspended", () => {
    expect(isSuspended("suspended")).toBe(true);
    expect(isSuspended("active")).toBe(false);
    expect(isSuspended(null)).toBe(false);
    expect(isSuspended(undefined)).toBe(false);
  });
});

describe("setUserRole", () => {
  async function clearUsersOnly(): Promise<void> {
    await run("DELETE FROM users", []);
  }
  async function seedRole(id: string, role: string): Promise<void> {
    await run(
      `INSERT INTO users (id, email, role, password_hash, provider, provider_sub, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, '2026-06-01T00:00:00.000Z')`,
      [id, `${id}@example.com`, role, role === "user" ? null : "x"],
    );
  }
  beforeEach(clearUsersOnly);

  it("promotes a member to a staff role", async () => {
    await seedRole("u1", "user");
    expect(await setUserRole("u1", "editor")).toBe("ok");
    expect((await getUserById("u1"))?.role).toBe("editor");
  });

  it("rejects an unknown role", async () => {
    await seedRole("u1", "user");
    expect(await setUserRole("u1", "wizard")).toBe("invalid_role");
    expect((await getUserById("u1"))?.role).toBe("user");
  });

  it("returns not_found for a missing user", async () => {
    expect(await setUserRole("ghost", "admin")).toBe("not_found");
  });

  it("is a no-op (ok) when the role is unchanged", async () => {
    await seedRole("u1", "user");
    expect(await setUserRole("u1", "user")).toBe("ok");
  });

  it("REFUSES demoting the last active admin", async () => {
    await seedRole("a1", "admin");
    expect(await setUserRole("a1", "editor")).toBe("last_admin");
    expect((await getUserById("a1"))?.role).toBe("admin");
  });

  it("allows demoting an admin when another active admin remains", async () => {
    await seedRole("a1", "admin");
    await seedRole("a2", "admin");
    expect(await setUserRole("a1", "editor")).toBe("ok");
    expect((await getUserById("a1"))?.role).toBe("editor");
  });
});

describe("verifyStaffPassword (step-up re-auth)", () => {
  beforeEach(async () => {
    await run("DELETE FROM users", []);
  });

  it("returns true for the correct password, false for a wrong one", async () => {
    const { createPasswordUser } = await import("./users");
    const u = await createPasswordUser({
      email: "reauth@example.com",
      password: "correct-horse-battery",
      anonymousId: null,
    });
    expect(await verifyStaffPassword(u.id, "correct-horse-battery")).toBe(true);
    expect(await verifyStaffPassword(u.id, "wrong-password")).toBe(false);
  });

  it("fails closed for unknown user or empty input", async () => {
    expect(await verifyStaffPassword("ghost", "x")).toBe(false);
    expect(await verifyStaffPassword("", "x")).toBe(false);
    expect(await verifyStaffPassword("ghost", "")).toBe(false);
  });

  it("returns false for a passwordless (OAuth) row", async () => {
    await run(
      `INSERT INTO users (id, email, role, password_hash, provider, provider_sub, created_at)
       VALUES ('oauth1', 'o@example.com', 'user', NULL, 'google', 'g1', '2026-06-01T00:00:00.000Z')`,
      [],
    );
    expect(await verifyStaffPassword("oauth1", "anything")).toBe(false);
  });
});
