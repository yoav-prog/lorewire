"use server";

// Server actions for /admin/notifications — the operator's only writes
// against the inbox: mark one row read, or clear the whole unread set.
// Both revalidate the page so the row moves to the read section (and the
// sidebar badge drops on its next poll).
//
// Plan: _plans/2026-07-02-never-publish-without-video.md.

import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/dal";
import {
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
} from "@/lib/admin-notifications";

export async function markNotificationReadAction(id: string): Promise<void> {
  const session = await requireCapability("content.manage");
  await markAdminNotificationRead(id);
  console.info("[notifications page] mark read", {
    id,
    user_id: session.userId,
  });
  revalidatePath("/admin/notifications");
}

export async function markAllNotificationsReadAction(): Promise<void> {
  const session = await requireCapability("content.manage");
  await markAllAdminNotificationsRead();
  console.info("[notifications page] mark all read", {
    user_id: session.userId,
  });
  revalidatePath("/admin/notifications");
}
