"use server";

// Self-takedown for a submitter: delete your own submission. Re-checks the
// session at the data source (a suspended account is treated as signed out);
// eraseSubmission verifies ownership and pulls any promoted story off the public
// site. Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 4).

import { revalidatePath } from "next/cache";
import { readActiveUserSession } from "@/lib/member-session";
import { eraseSubmission } from "@/lib/submissions";

export async function eraseMySubmissionAction(id: string): Promise<void> {
  const session = await readActiveUserSession();
  if (!session) throw new Error("You need to be signed in.");
  await eraseSubmission(id, session.userId);
  revalidatePath("/submissions");
}
