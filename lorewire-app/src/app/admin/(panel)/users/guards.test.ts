// memberDeleteGuard rules — the lockout-safety + typed-confirmation gates for
// the irreversible delete action. Pure function, no DB, no session.

import { describe, expect, it } from "vitest";

import { memberDeleteGuard } from "./guards";

const base = {
  isSelf: false,
  targetRole: "user",
  targetStatus: null as string | null,
  confirmEmail: "alice@example.com",
  actualEmail: "alice@example.com",
};

describe("memberDeleteGuard", () => {
  it("allows deleting a member when the typed email matches", () => {
    expect(memberDeleteGuard(base)).toEqual({ ok: true });
  });

  it("refuses self-deletion first, before any other check", () => {
    const r = memberDeleteGuard({ ...base, isSelf: true, confirmEmail: "wrong" });
    expect(r).toEqual({ ok: false, error: "You can't delete your own account." });
  });

  it("refuses deleting an admin that isn't suspended", () => {
    const r = memberDeleteGuard({ ...base, targetRole: "admin", targetStatus: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Suspend this admin/);
  });

  it("allows deleting an admin once it's suspended", () => {
    expect(
      memberDeleteGuard({
        ...base,
        targetRole: "admin",
        targetStatus: "suspended",
      }),
    ).toEqual({ ok: true });
  });

  it("deletes non-admin staff directly (no suspend-first requirement)", () => {
    expect(memberDeleteGuard({ ...base, targetRole: "editor" })).toEqual({
      ok: true,
    });
  });

  it("refuses when the typed email doesn't match (case/space-insensitive)", () => {
    expect(memberDeleteGuard({ ...base, confirmEmail: "bob@example.com" }).ok).toBe(
      false,
    );
    // Matching is forgiving on case + surrounding whitespace.
    expect(
      memberDeleteGuard({ ...base, confirmEmail: "  ALICE@example.com " }),
    ).toEqual({ ok: true });
  });
});
