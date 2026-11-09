// Tests for the Publish Scheduler dispatcher's DB mechanics: the global
// switch, due-row selection, claim, and the no-video failure path. These
// paths never reach a real platform API (a row with no rendered short
// fails before the publisher call), so they are deterministic regardless
// of which platform env vars happen to be set. The publish call itself is
// covered by each publisher's own suite.

import { beforeEach, describe, expect, it } from "vitest";

import { all, run } from "@/lib/db";
import { PUBLISH_ENABLED_KEY } from "./publish-scheduler";
import {
  UNATTENDED_PUBLISH_SETTING_KEYS,
  isUnattendedPublishingStopped,
} from "./approve-reviewed-story";
import { dispatchDuePublishes, maybeHaltOnPublishFailures } from "./publish-dispatch";

async function clear() {
  await run("DELETE FROM scheduled_publishes", []);
  await run("DELETE FROM short_renders", []);
  await run("DELETE FROM settings", []);
}

async function enablePublish() {
  await run(
    "INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
    [PUBLISH_ENABLED_KEY],
  );
}

async function insertScheduled(
  id: string,
  platform: string,
  scheduledForIso: string,
  state = "scheduled",
) {
  await run(
    "INSERT INTO scheduled_publishes (id, story_id, platform, scheduled_for, state, attempts, created_at) " +
      "VALUES (?, ?, ?, ?, ?, 0, ?)",
    [id, `story-${id}`, platform, scheduledForIso, state, scheduledForIso],
  );
}

async function stateOf(id: string): Promise<string> {
  const rows = await all<{ state: string }>(
    "SELECT state FROM scheduled_publishes WHERE id = ?",
    [id],
  );
  return rows[0]?.state ?? "MISSING";
}

const NOW = Date.UTC(2026, 6, 1, 12, 0);

describe("dispatchDuePublishes", () => {
  beforeEach(clear);

  it("no-ops when the global publish switch is off", async () => {
    await insertScheduled("a", "youtube", new Date(NOW - 60_000).toISOString());
    const r = await dispatchDuePublishes(NOW);
    expect(r.disabled).toBe(true);
    expect(await stateOf("a")).toBe("scheduled"); // untouched
  });

  it("fails a due row whose story has no rendered short", async () => {
    await enablePublish();
    await insertScheduled("a", "youtube", new Date(NOW - 60_000).toISOString());
    const r = await dispatchDuePublishes(NOW);
    expect(r.disabled).toBe(false);
    expect(r.due).toBe(1);
    expect(r.failed).toBe(1);
    expect(await stateOf("a")).toBe("failed");
  });

  it("does not pick a row whose slot is still in the future", async () => {
    await enablePublish();
    await insertScheduled("future", "youtube", new Date(NOW + 3_600_000).toISOString());
    const r = await dispatchDuePublishes(NOW);
    expect(r.due).toBe(0);
    expect(await stateOf("future")).toBe("scheduled");
  });

  it("only touches rows in the scheduled state", async () => {
    await enablePublish();
    await insertScheduled(
      "already",
      "youtube",
      new Date(NOW - 60_000).toISOString(),
      "published",
    );
    const r = await dispatchDuePublishes(NOW);
    expect(r.due).toBe(0);
    expect(await stateOf("already")).toBe("published");
  });

  it("records an attempt on the failed row", async () => {
    await enablePublish();
    await insertScheduled("a", "tiktok", new Date(NOW - 60_000).toISOString());
    await dispatchDuePublishes(NOW);
    const rows = await all<{ attempts: number | string }>(
      "SELECT attempts FROM scheduled_publishes WHERE id = 'a'",
      [],
    );
    expect(Number(rows[0].attempts)).toBe(1);
  });

  it("freezes the dispatcher while the emergency stop is engaged", async () => {
    await enablePublish();
    await run(
      "INSERT INTO settings (key, value) VALUES (?, '1')",
      [UNATTENDED_PUBLISH_SETTING_KEYS.stop],
    );
    await insertScheduled("a", "youtube", new Date(NOW - 60_000).toISOString());

    const r = await dispatchDuePublishes(NOW);
    expect(r.stopped).toBe(true);
    expect(r.due).toBe(0);
    expect(await stateOf("a")).toBe("scheduled"); // untouched
  });
});

describe("maybeHaltOnPublishFailures", () => {
  beforeEach(clear);

  const RECENT = new Date(NOW - 5 * 60_000).toISOString(); // 5 min ago
  const OLD = new Date(NOW - 3 * 3_600_000).toISOString(); // 3h ago, out of window

  async function insertOutcome(
    id: string,
    state: "failed" | "published",
    when: string,
  ) {
    const dispatchedAt = state === "failed" ? when : when;
    const postedAt = state === "published" ? when : null;
    await run(
      "INSERT INTO scheduled_publishes (id, story_id, platform, scheduled_for, state, attempts, created_at, dispatched_at, posted_at) " +
        "VALUES (?, ?, 'youtube', ?, ?, 1, ?, ?, ?)",
      [id, `story-${id}`, when, state, when, dispatchedAt, postedAt],
    );
  }

  it("engages the emergency stop after a recent failure spike", async () => {
    for (let i = 0; i < 4; i++) await insertOutcome(`f${i}`, "failed", RECENT);

    const r = await maybeHaltOnPublishFailures(NOW);

    expect(r.recentFailures).toBe(4);
    expect(r.halted).toBe(true);
    expect(await isUnattendedPublishingStopped()).toBe(true);
  });

  it("does not halt below the failure threshold", async () => {
    for (let i = 0; i < 3; i++) await insertOutcome(`f${i}`, "failed", RECENT);
    const r = await maybeHaltOnPublishFailures(NOW);
    expect(r.halted).toBe(false);
    expect(await isUnattendedPublishingStopped()).toBe(false);
  });

  it("does not halt when failures are a minority of recent posts", async () => {
    for (let i = 0; i < 4; i++) await insertOutcome(`f${i}`, "failed", RECENT);
    for (let i = 0; i < 10; i++) await insertOutcome(`p${i}`, "published", RECENT);
    const r = await maybeHaltOnPublishFailures(NOW);
    expect(r.halted).toBe(false); // 4/14 ratio is below the failure ratio
  });

  it("ignores failures outside the window", async () => {
    for (let i = 0; i < 6; i++) await insertOutcome(`f${i}`, "failed", OLD);
    const r = await maybeHaltOnPublishFailures(NOW);
    expect(r.recentFailures).toBe(0);
    expect(r.halted).toBe(false);
  });

  it("is a no-op (and does not re-alert) when already stopped", async () => {
    await run("INSERT INTO settings (key, value) VALUES (?, '1')", [
      UNATTENDED_PUBLISH_SETTING_KEYS.stop,
    ]);
    for (let i = 0; i < 6; i++) await insertOutcome(`f${i}`, "failed", RECENT);
    const r = await maybeHaltOnPublishFailures(NOW);
    expect(r.halted).toBe(false);
  });
});
