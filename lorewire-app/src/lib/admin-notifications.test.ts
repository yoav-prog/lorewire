// Tests for the admin notifications inbox. The contract that matters:
// writers can fire repeatedly for the same stuck subject (cron ticks)
// but the operator sees ONE unread row per problem (dedupe on unread
// dedupe_key); a read row does NOT suppress a fresh occurrence
// (recurrence is information); and notifyAdmin never throws.
//
// Plan: _plans/2026-07-02-never-publish-without-video.md.

import { beforeEach, describe, expect, it } from "vitest";
import { run } from "@/lib/db";
import {
  countUnreadAdminNotifications,
  listAdminNotifications,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
  notifyAdmin,
} from "@/lib/admin-notifications";

async function reset(): Promise<void> {
  await run("DELETE FROM admin_notifications WHERE 1=1", []);
}

beforeEach(reset);

describe("notifyAdmin", () => {
  it("creates a row with the writer's context serialised into detail", async () => {
    const r = await notifyAdmin({
      severity: "error",
      source: "auto-publish",
      subjectKind: "story",
      subjectId: "s-1",
      title: "Story did not publish",
      detail: { missing: ["video_url"], attempts: 12 },
      dedupeKey: "auto-publish-giveup:s-1",
    });
    expect(r.created).toBe(true);

    const rows = await listAdminNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("error");
    expect(rows[0].source).toBe("auto-publish");
    expect(rows[0].subject_id).toBe("s-1");
    expect(rows[0].read_at).toBeNull();
    expect(JSON.parse(rows[0].detail ?? "{}")).toEqual({
      missing: ["video_url"],
      attempts: 12,
    });
  });

  it("dedupes while an unread row with the same dedupe_key exists", async () => {
    const first = await notifyAdmin({
      severity: "error",
      source: "auto-publish",
      title: "Stuck story",
      dedupeKey: "k-1",
    });
    const second = await notifyAdmin({
      severity: "error",
      source: "auto-publish",
      title: "Stuck story",
      dedupeKey: "k-1",
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, reason: "deduped" });
    expect(await countUnreadAdminNotifications()).toBe(1);
  });

  it("a READ row does not suppress a fresh occurrence", async () => {
    const first = await notifyAdmin({
      severity: "error",
      source: "auto-publish",
      title: "Stuck story",
      dedupeKey: "k-1",
    });
    expect(first.created).toBe(true);
    if (first.created) await markAdminNotificationRead(first.id);

    const again = await notifyAdmin({
      severity: "error",
      source: "auto-publish",
      title: "Stuck story",
      dedupeKey: "k-1",
    });
    expect(again.created).toBe(true);
    expect(await countUnreadAdminNotifications()).toBe(1);
    expect(await listAdminNotifications()).toHaveLength(2);
  });

  it("rows without a dedupeKey always insert", async () => {
    await notifyAdmin({ severity: "warning", source: "x", title: "a" });
    await notifyAdmin({ severity: "warning", source: "x", title: "a" });
    expect(await countUnreadAdminNotifications()).toBe(2);
  });
});

describe("read state", () => {
  it("markAllAdminNotificationsRead clears the unread count", async () => {
    await notifyAdmin({ severity: "error", source: "x", title: "a" });
    await notifyAdmin({ severity: "error", source: "x", title: "b" });
    expect(await countUnreadAdminNotifications()).toBe(2);

    await markAllAdminNotificationsRead();
    expect(await countUnreadAdminNotifications()).toBe(0);
    // Rows survive as history.
    expect(await listAdminNotifications()).toHaveLength(2);
  });

  it("lists unread rows before read rows", async () => {
    const first = await notifyAdmin({
      severity: "error",
      source: "x",
      title: "older-then-read",
    });
    if (first.created) await markAdminNotificationRead(first.id);
    await notifyAdmin({ severity: "error", source: "x", title: "unread" });

    const rows = await listAdminNotifications();
    expect(rows[0].title).toBe("unread");
    expect(rows[1].title).toBe("older-then-read");
  });
});
