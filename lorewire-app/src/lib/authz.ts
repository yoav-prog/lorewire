// Capability-based authorization for the admin (studio) surface.
//
// Named roles are thin *bundles of capabilities* declared here in code — not
// rows in a DB permissions table. The DB is a no-FK dual-driver layer with
// boot-time additive migrations (src/lib/db.ts); modelling permissions there
// would mean hand-rolling referential integrity and writing every migration
// twice. Capabilities-in-code give the same named roles (Admin / Editor /
// Moderator / Viewer) with none of that cost, and one source of truth that
// both the server gates (dal.requireCapability) and the UI (which nav to show)
// read.
//
// The `role` column on `users` stays free-text; only the values in
// STAFF_ROLES grant any capability. Public users (role 'user') and any unknown
// role resolve to zero capabilities — that is the trust boundary.
//
// Pure module: no DB, no secrets, no server-only marker, so it is safe to
// import from a client component (e.g. to hide a nav item the user can't use).
// Authorization is still enforced on the server; the client read is cosmetic.
//
// Plan: _plans/2026-06-22-admin-user-management.md (Phase 0).

/** Every distinct action class the admin surface gates on. Adding a value here
 *  and granting it below is the whole job of introducing a new gate. */
export const CAPABILITIES = [
  "content.manage", // create / edit / delete stories & articles, curation, polls
  "settings.manage", // models, voiceovers, templates, segments, SEO, settings
  "users.view", // read members + staff, profiles, activity
  "users.moderate", // suspend / unsuspend (ban) public users
  "users.delete", // GDPR-wipe a user and their data
  "users.impersonate", // view-as a public user for support
  "team.manage", // invite / role-change / remove staff
  "audit.view", // read the admin audit log
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Roles that may sign into the admin. Order is display-only (most → least
 *  privileged). Public users carry role 'user', deliberately NOT in this list. */
export const STAFF_ROLES = ["admin", "editor", "moderator", "viewer"] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

/** Role → the capabilities it grants. `admin` holds every capability by
 *  construction, so a newly-added capability can never be accidentally
 *  withheld from admins; grants to lesser roles are always explicit. */
const ROLE_CAPABILITIES: Record<StaffRole, readonly Capability[]> = {
  admin: CAPABILITIES,
  editor: ["content.manage", "settings.manage", "users.view"],
  moderator: ["users.view", "users.moderate", "audit.view"],
  viewer: ["users.view", "audit.view"],
};

/** True when `role` is one of the admin staff roles (type-narrowing guard). */
export function isStaffRole(role: string | null | undefined): role is StaffRole {
  return role != null && (STAFF_ROLES as readonly string[]).includes(role);
}

/** The capabilities a role grants. Unknown / public roles → none. */
export function capabilitiesFor(
  role: string | null | undefined,
): readonly Capability[] {
  return isStaffRole(role) ? ROLE_CAPABILITIES[role] : [];
}

/** Does `role` grant `cap`? The single check every server gate funnels through. */
export function hasCapability(
  role: string | null | undefined,
  cap: Capability,
): boolean {
  return capabilitiesFor(role).includes(cap);
}
