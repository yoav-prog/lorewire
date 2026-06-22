// Impersonation cookie + resolver. The contracts that matter: the claim
// round-trips through a signed cookie, and resolveImpersonation only honors it
// while the actor STILL holds users.impersonate and isn't suspended (the
// revocation point). We mock the cookie store and the actor DB lookup; the JWT
// sign/verify and the capability map run for real.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Stateful in-memory cookie store so set -> read -> clear works across calls.
const store = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (store.has(n) ? { value: store.get(n) } : undefined),
    set: (n: string, v: string) => {
      store.set(n, v);
    },
    delete: (n: string) => {
      store.delete(n);
    },
  }),
}));

const { mockGetUserById } = vi.hoisted(() => ({ mockGetUserById: vi.fn() }));
vi.mock("@/lib/users", () => ({ getUserById: mockGetUserById }));

import {
  clearImpersonationCookie,
  readImpersonationClaim,
  resolveImpersonation,
  setImpersonationCookie,
} from "./impersonation";

beforeEach(() => {
  store.clear();
  mockGetUserById.mockReset();
});

describe("impersonation cookie", () => {
  it("round-trips the claim through a signed cookie", async () => {
    await setImpersonationCookie({ actorId: "a1", targetId: "t1" });
    expect(await readImpersonationClaim()).toEqual({ actorId: "a1", targetId: "t1" });
  });

  it("clear removes it", async () => {
    await setImpersonationCookie({ actorId: "a1", targetId: "t1" });
    await clearImpersonationCookie();
    expect(await readImpersonationClaim()).toBeNull();
  });

  it("returns null with no cookie", async () => {
    expect(await readImpersonationClaim()).toBeNull();
  });
});

describe("resolveImpersonation — actor re-validation", () => {
  it("honors the cookie while the actor holds users.impersonate", async () => {
    await setImpersonationCookie({ actorId: "a1", targetId: "t1" });
    mockGetUserById.mockResolvedValue({ id: "a1", role: "admin", status: null });
    expect(await resolveImpersonation()).toEqual({ actorId: "a1", targetId: "t1" });
  });

  it("drops it once the actor's role no longer grants the capability", async () => {
    await setImpersonationCookie({ actorId: "a1", targetId: "t1" });
    // editor has content/settings/users.view but NOT users.impersonate.
    mockGetUserById.mockResolvedValue({ id: "a1", role: "editor", status: null });
    expect(await resolveImpersonation()).toBeNull();
  });

  it("drops it when the actor is suspended", async () => {
    await setImpersonationCookie({ actorId: "a1", targetId: "t1" });
    mockGetUserById.mockResolvedValue({ id: "a1", role: "admin", status: "suspended" });
    expect(await resolveImpersonation()).toBeNull();
  });

  it("drops it when the actor no longer exists", async () => {
    await setImpersonationCookie({ actorId: "a1", targetId: "t1" });
    mockGetUserById.mockResolvedValue(null);
    expect(await resolveImpersonation()).toBeNull();
  });

  it("returns null with no cookie at all", async () => {
    expect(await resolveImpersonation()).toBeNull();
  });
});
