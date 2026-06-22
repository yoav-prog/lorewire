// Staff-invite lifecycle: create → resolve → accept (single-use) → revoke.
// The security-critical contracts: the role is whatever the inviter bound
// (never escalatable at accept), accept is single-use, and an invite for an
// email that already has an account is refused. DB-backed against the test
// SQLite, same pattern as users.test.ts.

import { beforeEach, describe, expect, it } from "vitest";

import { run } from "@/lib/db";
import { getUserByEmail } from "@/lib/users";
import {
  acceptStaffInvite,
  createStaffInvite,
  getValidInvite,
  listStaffInvites,
  revokeStaffInvite,
} from "./staff-invites";

async function clear(): Promise<void> {
  await run("DELETE FROM staff_invites", []);
  await run("DELETE FROM users", []);
}

describe("createStaffInvite + getValidInvite", () => {
  beforeEach(clear);

  it("creates a pending invite that resolves by its token", async () => {
    const r = await createStaffInvite({
      email: "New@Example.com",
      role: "editor",
      invitedBy: "admin1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const invite = await getValidInvite(r.token);
    expect(invite?.email).toBe("new@example.com"); // normalized
    expect(invite?.role).toBe("editor");
  });

  it("refuses to invite an email that already has an account", async () => {
    await run(
      `INSERT INTO users (id, email, role, password_hash, provider, provider_sub, created_at)
       VALUES ('u1', 'taken@example.com', 'user', NULL, 'google', 'g1', '2026-06-01T00:00:00.000Z')`,
      [],
    );
    const r = await createStaffInvite({
      email: "taken@example.com",
      role: "editor",
      invitedBy: null,
    });
    expect(r.ok).toBe(false);
  });

  it("supersedes an earlier pending invite to the same email", async () => {
    const first = await createStaffInvite({ email: "dup@example.com", role: "viewer", invitedBy: null });
    const second = await createStaffInvite({ email: "dup@example.com", role: "editor", invitedBy: null });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(await getValidInvite(first.token)).toBeNull(); // revoked
    expect((await getValidInvite(second.token))?.role).toBe("editor");
  });

  it("getValidInvite returns null for an unknown token", async () => {
    expect(await getValidInvite("nope")).toBeNull();
  });
});

describe("acceptStaffInvite", () => {
  beforeEach(clear);

  it("creates a staff account with the bound role + hashed password, single-use", async () => {
    const r = await createStaffInvite({ email: "mod@example.com", role: "moderator", invitedBy: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const acc = await acceptStaffInvite(r.token, "a-good-password");
    expect(acc.ok).toBe(true);

    const u = await getUserByEmail("mod@example.com");
    expect(u?.role).toBe("moderator");
    expect(u?.password_hash).toMatch(/^scrypt\$/);

    // The token is now consumed.
    expect(await getValidInvite(r.token)).toBeNull();
    const second = await acceptStaffInvite(r.token, "a-good-password");
    expect(second.ok).toBe(false);
  });

  it("rejects a short password and creates no account", async () => {
    const r = await createStaffInvite({ email: "short@example.com", role: "viewer", invitedBy: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const acc = await acceptStaffInvite(r.token, "short");
    expect(acc.ok).toBe(false);
    expect(await getUserByEmail("short@example.com")).toBeNull();
  });

  it("rejects an invalid token", async () => {
    const acc = await acceptStaffInvite("bogus", "a-good-password");
    expect(acc.ok).toBe(false);
  });
});

describe("revokeStaffInvite + listStaffInvites", () => {
  beforeEach(clear);

  it("revokes a pending invite so its token stops working", async () => {
    const r = await createStaffInvite({ email: "rev@example.com", role: "editor", invitedBy: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await revokeStaffInvite(r.id)).toBe(true);
    expect(await getValidInvite(r.token)).toBeNull();
  });

  it("returns false when revoking an already-accepted invite", async () => {
    const r = await createStaffInvite({ email: "acc@example.com", role: "editor", invitedBy: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await acceptStaffInvite(r.token, "a-good-password");
    expect(await revokeStaffInvite(r.id)).toBe(false);
  });

  it("lists only pending invites", async () => {
    const a = await createStaffInvite({ email: "p1@example.com", role: "editor", invitedBy: null });
    const b = await createStaffInvite({ email: "p2@example.com", role: "viewer", invitedBy: null });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok) return;
    await acceptStaffInvite(a.token, "a-good-password");
    const pending = await listStaffInvites();
    expect(pending.map((i) => i.email)).toEqual(["p2@example.com"]);
  });
});
