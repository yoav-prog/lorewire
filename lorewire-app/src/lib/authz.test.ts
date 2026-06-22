// Tests for the capability map — the single source of truth that gates every
// admin action. The load-bearing guarantees: admins hold every capability (so
// a new capability is never silently withheld from them), public/unknown roles
// hold none (the trust boundary), and lesser roles never sneak a destructive
// capability. Pin all three hard.

import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  STAFF_ROLES,
  capabilitiesFor,
  hasCapability,
  isStaffRole,
  type Capability,
} from "./authz";

describe("isStaffRole", () => {
  it("accepts every declared staff role", () => {
    for (const r of STAFF_ROLES) expect(isStaffRole(r)).toBe(true);
  });

  it("rejects public, unknown, and empty roles", () => {
    expect(isStaffRole("user")).toBe(false);
    expect(isStaffRole("superuser")).toBe(false);
    expect(isStaffRole("")).toBe(false);
    expect(isStaffRole(null)).toBe(false);
    expect(isStaffRole(undefined)).toBe(false);
  });
});

describe("capabilitiesFor", () => {
  it("grants admin every capability — none can be withheld from admin", () => {
    const adminCaps = capabilitiesFor("admin");
    for (const cap of CAPABILITIES) expect(adminCaps).toContain(cap);
    expect(adminCaps).toHaveLength(CAPABILITIES.length);
  });

  it("grants public and unknown roles nothing — the trust boundary", () => {
    expect(capabilitiesFor("user")).toEqual([]);
    expect(capabilitiesFor("anything")).toEqual([]);
    expect(capabilitiesFor(null)).toEqual([]);
    expect(capabilitiesFor(undefined)).toEqual([]);
  });

  it("only ever returns declared capabilities for every role", () => {
    for (const role of STAFF_ROLES) {
      for (const cap of capabilitiesFor(role)) {
        expect(CAPABILITIES).toContain(cap);
      }
    }
  });

  it("withholds destructive + staff capabilities from every lesser role", () => {
    const restricted: Capability[] = [
      "users.delete",
      "users.impersonate",
      "team.manage",
    ];
    for (const role of ["editor", "moderator", "viewer"] as const) {
      for (const cap of restricted) {
        expect(hasCapability(role, cap)).toBe(false);
      }
    }
  });
});

describe("hasCapability — role boundaries", () => {
  it("editor manages content but cannot moderate or delete users", () => {
    expect(hasCapability("editor", "content.manage")).toBe(true);
    expect(hasCapability("editor", "settings.manage")).toBe(true);
    expect(hasCapability("editor", "users.view")).toBe(true);
    expect(hasCapability("editor", "users.moderate")).toBe(false);
    expect(hasCapability("editor", "users.delete")).toBe(false);
  });

  it("moderator views + suspends users but cannot delete or manage the team", () => {
    expect(hasCapability("moderator", "users.view")).toBe(true);
    expect(hasCapability("moderator", "users.moderate")).toBe(true);
    expect(hasCapability("moderator", "audit.view")).toBe(true);
    expect(hasCapability("moderator", "users.delete")).toBe(false);
    expect(hasCapability("moderator", "team.manage")).toBe(false);
    expect(hasCapability("moderator", "content.manage")).toBe(false);
  });

  it("viewer is read-only — sees users + audit, changes nothing", () => {
    expect(hasCapability("viewer", "users.view")).toBe(true);
    expect(hasCapability("viewer", "audit.view")).toBe(true);
    expect(hasCapability("viewer", "users.moderate")).toBe(false);
    expect(hasCapability("viewer", "content.manage")).toBe(false);
    expect(hasCapability("viewer", "settings.manage")).toBe(false);
  });

  it("denies public and unknown roles every capability", () => {
    for (const cap of CAPABILITIES) {
      expect(hasCapability("user", cap)).toBe(false);
      expect(hasCapability("ghost", cap)).toBe(false);
      expect(hasCapability(null, cap)).toBe(false);
      expect(hasCapability(undefined, cap)).toBe(false);
    }
  });
});
