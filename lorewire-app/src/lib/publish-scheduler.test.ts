// Tests for the Publish Scheduler slot engine (Phase 5 core). Pure DST
// math is asserted against known US Eastern offsets; the slot-assignment,
// daily-cap, one-post-per-slot, and idempotency behaviors run against the
// real store like the other scheduler tests.

import { beforeEach, describe, expect, it } from "vitest";

import { all, run } from "@/lib/db";
import {
  PUBLISH_DEFAULTS,
  PUBLISH_ENABLED_KEY,
  computeNextOpenSlot,
  enumerateSlotInstants,
  getPlatformConfig,
  getPlatformDailyCap,
  getPlatformSlots,
  getPublishEnabled,
  logSchedulerDecision,
  parseSlot,
  partsInTz,
  platformSettingKey,
  scheduleStoryPublish,
  wallClockToUtcMs,
  type PlatformConfig,
} from "./publish-scheduler";

async function clear() {
  await run("DELETE FROM scheduled_publishes", []);
  await run("DELETE FROM scheduler_decisions", []);
  await run("DELETE FROM settings", []);
}

async function setSetting(key: string, value: string) {
  await run(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

async function configurePlatform(
  platform: "youtube" | "facebook" | "instagram" | "tiktok",
  opts: { enabled?: boolean; cap?: number; slots?: string[]; tz?: string },
) {
  await setSetting(platformSettingKey(platform, "enabled"), opts.enabled ? "1" : "0");
  if (opts.cap !== undefined) {
    await setSetting(platformSettingKey(platform, "daily_cap"), String(opts.cap));
  }
  if (opts.slots) {
    await setSetting(platformSettingKey(platform, "slots"), JSON.stringify(opts.slots));
  }
  if (opts.tz) {
    await setSetting(platformSettingKey(platform, "timezone"), opts.tz);
  }
}

async function insertSlotRow(
  platform: string,
  scheduledForIso: string,
  state = "scheduled",
) {
  await run(
    "INSERT INTO scheduled_publishes (id, story_id, platform, scheduled_for, state, attempts, created_at) " +
      "VALUES (?, ?, ?, ?, ?, 0, ?)",
    [
      `${platform}-${scheduledForIso}-${Math.floor(Math.random() * 1e6)}`,
      `story-${scheduledForIso}`,
      platform,
      scheduledForIso,
      state,
      scheduledForIso,
    ],
  );
}

describe("parseSlot", () => {
  it("accepts valid HH:MM and rejects nonsense", () => {
    expect(parseSlot("09:00")).toEqual({ hour: 9, minute: 0 });
    expect(parseSlot("9:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseSlot("23:59")).toEqual({ hour: 23, minute: 59 });
    for (const bad of ["24:00", "09:60", "abc", "9", "09:0", "-1:00", ""]) {
      expect(parseSlot(bad)).toBeNull();
    }
  });
});

describe("DST-safe timezone math (America/New_York)", () => {
  it("resolves a winter (EST, UTC-5) wall clock to the right UTC instant", () => {
    // 2026-01-15 09:00 EST = 14:00 UTC.
    expect(wallClockToUtcMs("America/New_York", 2026, 1, 15, 9, 0)).toBe(
      Date.UTC(2026, 0, 15, 14, 0),
    );
  });

  it("resolves a summer (EDT, UTC-4) wall clock to the right UTC instant", () => {
    // 2026-07-15 09:00 EDT = 13:00 UTC.
    expect(wallClockToUtcMs("America/New_York", 2026, 7, 15, 9, 0)).toBe(
      Date.UTC(2026, 6, 15, 13, 0),
    );
  });

  it("round-trips a UTC instant back to local parts", () => {
    const p = partsInTz(Date.UTC(2026, 6, 15, 13, 0), "America/New_York");
    expect({ y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute }).toEqual({
      y: 2026,
      mo: 7,
      d: 15,
      h: 9,
      mi: 0,
    });
  });

  it("keeps the same wall-clock slot across the spring-forward boundary", () => {
    // DST begins 2026-03-08. A 09:00 slot the day before (EST) and the day
    // after (EDT) must both read 09:00 local, an hour apart in UTC.
    const before = wallClockToUtcMs("America/New_York", 2026, 3, 7, 9, 0);
    const after = wallClockToUtcMs("America/New_York", 2026, 3, 9, 9, 0);
    expect(partsInTz(before, "America/New_York").hour).toBe(9);
    expect(partsInTz(after, "America/New_York").hour).toBe(9);
  });
});

describe("enumerateSlotInstants", () => {
  it("emits only future slots, ascending", () => {
    const config = { slots: ["09:00", "13:00", "18:00"], timezone: "UTC" };
    const from = Date.UTC(2026, 6, 1, 12, 0); // noon UTC July 1
    const cands = enumerateSlotInstants(config, from, 1);
    // July 1 09:00 is in the past; first future is July 1 13:00.
    expect(cands[0].ms).toBe(Date.UTC(2026, 6, 1, 13, 0));
    expect(cands[1].ms).toBe(Date.UTC(2026, 6, 1, 18, 0));
    expect(cands[2].ms).toBe(Date.UTC(2026, 6, 2, 9, 0));
    // strictly ascending
    for (let i = 1; i < cands.length; i++) {
      expect(cands[i].ms).toBeGreaterThan(cands[i - 1].ms);
    }
  });

  it("returns nothing when there are no valid slots", () => {
    expect(
      enumerateSlotInstants({ slots: [], timezone: "UTC" }, Date.now(), 3),
    ).toEqual([]);
  });
});

describe("setting readers", () => {
  beforeEach(clear);

  it("publish + platform enabled default off", async () => {
    expect(await getPublishEnabled()).toBe(false);
    const cfg = await getPlatformConfig("youtube");
    expect(cfg.enabled).toBe(false);
  });

  it("daily cap defaults and clamps", async () => {
    expect(await getPlatformDailyCap("tiktok")).toBe(PUBLISH_DEFAULTS.dailyCap);
    await setSetting(platformSettingKey("tiktok", "daily_cap"), "0");
    expect(await getPlatformDailyCap("tiktok")).toBe(PUBLISH_DEFAULTS.dailyCap);
    await setSetting(platformSettingKey("tiktok", "daily_cap"), "5");
    expect(await getPlatformDailyCap("tiktok")).toBe(5);
  });

  it("slots parse, validate, de-dupe and sort; bad JSON falls back to defaults", async () => {
    await setSetting(
      platformSettingKey("youtube", "slots"),
      JSON.stringify(["18:00", "09:00", "09:00", "nope", "13:00"]),
    );
    expect(await getPlatformSlots("youtube")).toEqual(["09:00", "13:00", "18:00"]);
    await setSetting(platformSettingKey("youtube", "slots"), "{ not json");
    expect(await getPlatformSlots("youtube")).toEqual([...PUBLISH_DEFAULTS.slots]);
  });

  it("invalid timezone falls back to the default", async () => {
    await setSetting(platformSettingKey("facebook", "timezone"), "Mars/Phobos");
    const cfg = await getPlatformConfig("facebook");
    expect(cfg.timezone).toBe(PUBLISH_DEFAULTS.timezone);
  });
});

describe("computeNextOpenSlot", () => {
  beforeEach(clear);

  async function utcConfig(cap: number): Promise<PlatformConfig> {
    await configurePlatform("youtube", {
      enabled: true,
      cap,
      slots: ["09:00", "13:00"],
      tz: "UTC",
    });
    return getPlatformConfig("youtube");
  }

  it("returns the earliest future slot when everything is open", async () => {
    const cfg = await utcConfig(3);
    const from = Date.UTC(2026, 6, 1, 8, 0);
    const slot = await computeNextOpenSlot(cfg, from);
    expect(slot?.scheduledForIso).toBe(new Date(Date.UTC(2026, 6, 1, 9, 0)).toISOString());
    expect(slot?.slotLocal).toBe("09:00");
  });

  it("skips a taken slot but stays on the same day when under cap", async () => {
    const cfg = await utcConfig(3);
    const from = Date.UTC(2026, 6, 1, 8, 0);
    await insertSlotRow("youtube", new Date(Date.UTC(2026, 6, 1, 9, 0)).toISOString());
    const slot = await computeNextOpenSlot(cfg, from);
    expect(slot?.scheduledForIso).toBe(new Date(Date.UTC(2026, 6, 1, 13, 0)).toISOString());
  });

  it("rolls to the next day once the daily cap is reached", async () => {
    const cfg = await utcConfig(2);
    const from = Date.UTC(2026, 6, 1, 8, 0);
    await insertSlotRow("youtube", new Date(Date.UTC(2026, 6, 1, 9, 0)).toISOString());
    await insertSlotRow("youtube", new Date(Date.UTC(2026, 6, 1, 13, 0)).toISOString());
    const slot = await computeNextOpenSlot(cfg, from);
    expect(slot?.scheduledForIso).toBe(new Date(Date.UTC(2026, 6, 2, 9, 0)).toISOString());
  });

  it("does not count failed/cancelled rows against capacity", async () => {
    const cfg = await utcConfig(1);
    const from = Date.UTC(2026, 6, 1, 8, 0);
    // A failed row at 09:00 must not consume the day's single slot.
    await insertSlotRow(
      "youtube",
      new Date(Date.UTC(2026, 6, 1, 9, 0)).toISOString(),
      "failed",
    );
    const slot = await computeNextOpenSlot(cfg, from);
    expect(slot?.scheduledForIso).toBe(new Date(Date.UTC(2026, 6, 1, 9, 0)).toISOString());
  });
});

describe("scheduleStoryPublish", () => {
  beforeEach(clear);

  it("does nothing when the global publish switch is off", async () => {
    await configurePlatform("youtube", { enabled: true, cap: 3, slots: ["09:00"], tz: "UTC" });
    const r = await scheduleStoryPublish("s1", { nowMs: Date.UTC(2026, 6, 1, 8, 0) });
    expect(r.publishEnabled).toBe(false);
    expect(r.scheduled).toBe(0);
  });

  it("schedules only enabled platforms and marks the rest disabled", async () => {
    await setSetting(PUBLISH_ENABLED_KEY, "1");
    await configurePlatform("youtube", { enabled: true, cap: 3, slots: ["09:00"], tz: "UTC" });
    await configurePlatform("tiktok", { enabled: true, cap: 3, slots: ["10:00"], tz: "UTC" });
    // facebook + instagram left disabled (default).
    const now = Date.UTC(2026, 6, 1, 8, 0);
    const r = await scheduleStoryPublish("s1", { nowMs: now, approvedBy: "admin" });
    expect(r.scheduled).toBe(2);
    const byPlatform = Object.fromEntries(r.outcomes.map((o) => [o.platform, o.status]));
    expect(byPlatform.youtube).toBe("scheduled");
    expect(byPlatform.tiktok).toBe("scheduled");
    expect(byPlatform.facebook).toBe("disabled");
    expect(byPlatform.instagram).toBe("disabled");
    const rows = await all<{ n: number | string }>(
      "SELECT count(*) AS n FROM scheduled_publishes WHERE story_id = 's1'",
      [],
    );
    expect(Number(rows[0].n)).toBe(2);
  });

  it("is idempotent per (story, platform): re-approving reports duplicate", async () => {
    await setSetting(PUBLISH_ENABLED_KEY, "1");
    await configurePlatform("youtube", { enabled: true, cap: 3, slots: ["09:00"], tz: "UTC" });
    const now = Date.UTC(2026, 6, 1, 8, 0);
    const first = await scheduleStoryPublish("s1", { nowMs: now });
    expect(first.scheduled).toBe(1);
    const second = await scheduleStoryPublish("s1", { nowMs: now });
    expect(second.scheduled).toBe(0);
    expect(second.outcomes.find((o) => o.platform === "youtube")?.status).toBe(
      "duplicate",
    );
    const rows = await all<{ n: number | string }>(
      "SELECT count(*) AS n FROM scheduled_publishes WHERE story_id = 's1'",
      [],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("two different stories take consecutive slots on the same platform", async () => {
    await setSetting(PUBLISH_ENABLED_KEY, "1");
    await configurePlatform("youtube", {
      enabled: true,
      cap: 3,
      slots: ["09:00", "13:00"],
      tz: "UTC",
    });
    const now = Date.UTC(2026, 6, 1, 8, 0);
    const a = await scheduleStoryPublish("a", { nowMs: now });
    const b = await scheduleStoryPublish("b", { nowMs: now });
    expect(a.outcomes.find((o) => o.platform === "youtube")?.slotLocal).toBe("09:00");
    expect(b.outcomes.find((o) => o.platform === "youtube")?.slotLocal).toBe("13:00");
  });
});

describe("logSchedulerDecision", () => {
  beforeEach(clear);

  it("appends a row capturing the verdict and signals", async () => {
    await logSchedulerDecision(
      {
        storyId: "s1",
        redditId: "r1",
        decision: "approved",
        tier: "strong",
        comments: 512,
        ageHours: 3.5,
        subreddit: "tifu",
        decidedBy: "admin",
      },
      Date.UTC(2026, 6, 1, 12, 0),
    );
    const rows = await all<{ decision: string; tier: string; comments: number }>(
      "SELECT decision, tier, comments FROM scheduler_decisions WHERE story_id = 's1'",
      [],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].decision).toBe("approved");
    expect(rows[0].tier).toBe("strong");
    expect(Number(rows[0].comments)).toBe(512);
  });
});
