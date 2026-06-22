// readActiveUserSession is the public-side revocation point for suspension:
// the lw_user JWT can't be revoked, so this re-reads the DB and drops a
// suspended (or deleted) account to "signed out". We mock the JWT layer
// (readUserSession) and let the DB layer run for real against the test SQLite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "@/lib/db";

const { mockReadUserSession } = vi.hoisted(() => ({
  mockReadUserSession: vi.fn(),
}));

vi.mock("@/lib/user-session", () => ({
  readUserSession: mockReadUserSession,
}));

import { readActiveUserSession } from "@/lib/member-session";

async function seed(id: string, status: string | null): Promise<void> {
  await run(
    `INSERT INTO users (id, email, role, provider, provider_sub, status, created_at)
     VALUES (?, ?, 'user', 'google', ?, ?, '2026-06-01T00:00:00.000Z')`,
    [id, `${id}@example.com`, `${id}_sub`, status],
  );
}

describe("readActiveUserSession", () => {
  beforeEach(async () => {
    await run("DELETE FROM users", []);
    mockReadUserSession.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when there is no JWT session", async () => {
    mockReadUserSession.mockResolvedValue(null);
    expect(await readActiveUserSession()).toBeNull();
  });

  it("returns the session for an active account", async () => {
    await seed("active1", null); // NULL status = active
    mockReadUserSession.mockResolvedValue({
      userId: "active1",
      email: "active1@example.com",
      role: "user",
    });
    const session = await readActiveUserSession();
    expect(session?.userId).toBe("active1");
  });

  it("returns null for a suspended account (the revocation point)", async () => {
    await seed("susp1", "suspended");
    mockReadUserSession.mockResolvedValue({
      userId: "susp1",
      email: "susp1@example.com",
      role: "user",
    });
    expect(await readActiveUserSession()).toBeNull();
  });

  it("returns null when the user row no longer exists (deleted account)", async () => {
    mockReadUserSession.mockResolvedValue({
      userId: "gone",
      email: "gone@example.com",
      role: "user",
    });
    expect(await readActiveUserSession()).toBeNull();
  });
});
