// Public-side users repo SHIM.
//
// Re-exports `getUserById` from the existing repo on `main`. The
// source-branch `users.ts` carried the anonymous-first auth columns
// (name, picture_url, provider, provider_sub, anonymous_id,
// last_seen_at) that haven't shipped to `main` yet, so this shim
// widens the row shape with optional fields the comments code reads.
// The underlying SELECT does not include them, so `user.name` etc.
// are `undefined` at runtime — the comments code already falls back
// to email-local-part or the guest_name.
//
// When the real public-side users module lands (as part of the
// anonymous-first auth surface), replace this file with the real
// implementation. The comments code keeps working.
//
// Plan: _plans/2026-06-22-comments-feature-restoration.md.

import "server-only";

import { getUserById as repoGetUserById, type UserRow as RepoUserRow } from "@/lib/repo";

export interface UserRow extends RepoUserRow {
  name?: string | null;
  picture_url?: string | null;
}

export async function getUserById(id: string): Promise<UserRow | null> {
  return (await repoGetUserById(id)) as UserRow | null;
}
