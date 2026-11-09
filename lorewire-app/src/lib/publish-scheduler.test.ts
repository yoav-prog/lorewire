// Tests for the Publish Scheduler slot engine (Phase 5 core). Pure DST
// math is asserted against known US Eastern offsets; the slot-assignment,
// daily-cap, one-post-per-slot, and idempotency behaviors run against the
// real store like the other scheduler tests.

import { beforeEach, describe, expect, it } from "vitest";

import { all, run } from "@/lib/db";
import {
  DAILY_DROP_SETTING_KEYS,
  PUBLISH_DEFAULTS,
  PUBLISH_ENABLED_KEY,
  buildCalendarDays,
  dropMsForDay,
  getDailyDropConfig,
  isBeforeDailyDrop,
  nextDropMs,
  cancelScheduledPublish,
  computeNextOpenSlot,
  enumerateSlotInstants,
  getPlatformConfig,
  getPlatformDailyCap,
  getPlatformSlots,
  getPublishEnabled,
  listUpcomingPublishes,
  logSchedulerDecision,
  normalizeSlotList,
  parseSlot,
  parseSlotsSetting,
  partsInTz,
  platformSettingKey,
  scheduleStoryPublish,
  scheduleStoryPublishAt,
  slotsForWeekday,
  wallClockToUtcMs,
  type PlatformConfig,
  type WeeklySlots,
} from "./publish-scheduler";

function weekly(defaults: string[], overrides: WeeklySlots["overrides"] = {}): WeeklySlots {
  return { default: defaults, overrides };
}

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

describe("parseSlotsSetting", () => {
  it("parses the v1 flat array into an every-day schedule", () => {
    expect(parseSlotsSetting(JSON.stringify(["18:00", "09:00", "9:00"]))).toEqual({
      default: ["09:00", "18:00"],
      overrides: {},
    });
  });

  it("falls back to defaults on blank, bad JSON, or an empty flat array", () => {
    const fallback = { default: [...PUBLISH_DEFAULTS.slots], overrides: {} };
    expect(parseSlotsSetting(null)).toEqual(fallback);
    expect(parseSlotsSetting("  ")).toEqual(fallback);
    expect(parseSlotsSetting("{ not json")).toEqual(fallback);
    expect(parseSlotsSetting("[]")).toEqual(fallback);
    expect(parseSlotsSetting(JSON.stringify(["nope"]))).toEqual(fallback);
    expect(parseSlotsSetting(JSON.stringify(42))).toEqual(fallback);
    expect(parseSlotsSetting(JSON.stringify({ overrides: {} }))).toEqual(fallback);
  });

  it("parses the v2 object shape, keeping an explicit empty override AND an explicit empty default", () => {
    const parsed = parseSlotsSetting(
      JSON.stringify({
        default: ["13:00", "9:00"],
        overrides: { sat: [], sun: ["11:00"], nonsense: ["10:00"] },
      }),
    );
    expect(parsed).toEqual({
      default: ["09:00", "13:00"],
      overrides: { sat: [], sun: ["11:00"] },
    });
    // Weekend-only schedule: empty default is deliberate, not corruption.
    expect(
      parseSlotsSetting(JSON.stringify({ default: [], overrides: { sat: ["10:00"] } })),
    ).toEqual({ default: [], overrides: { sat: ["10:00"] } });
  });
});

describe("slotsForWeekday", () => {
  it("uses the override when present (even empty), else the default", () => {
    const w = weekly(["09:00"], { sat: [], sun: ["11:00"] });
    expect(slotsForWeekday(w, "mon")).toEqual(["09:00"]);
    expect(slotsForWeekday(w, "sat")).toEqual([]);
    expect(slotsForWeekday(w, "sun")).toEqual(["11:00"]);
  });
});

describe("normalizeSlotList", () => {
  it("validates, zero-pads, de-dupes and sorts", () => {
    expect(normalizeSlotList(["18:00", "9:05", "09:05", "bad", 7])).toEqual([
      "09:05",
      "18:00",
    ]);
    expect(normalizeSlotList("not a list")).toEqual([]);
  });
});

describe("enumerateSlotInstants", () => {
  it("emits only future slots, ascending", () => {
    const config = { slots: weekly(["09:00", "13:00", "18:00"]), timezone: "UTC" };
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
      enumerateSlotInstants({ slots: weekly([]), timezone: "UTC" }, Date.now(), 3),
    ).toEqual([]);
  });

  it("skips a weekday with an explicit no-posts override", () => {
    // 2026-07-03 is a Friday; Saturday July 4 is overridden to no posts.
    const config = {
      slots: weekly(["09:00"], { sat: [] }),
      timezone: "UTC",
    };
    const from = Date.UTC(2026, 6, 3, 10, 0); // Friday, after 09:00
    const cands = enumerateSlotInstants(config, from, 3);
    expect(cands[0].ms).toBe(Date.UTC(2026, 6, 5, 9, 0)); // Sunday
  });

  it("uses a weekday's custom times instead of the default", () => {
    // Sunday 2026-07-05 posts at 11:00 instead of 09:00.
    const config = {
      slots: weekly(["09:00"], { sun: ["11:00"] }),
      timezone: "UTC",
    };
    const from = Date.UTC(2026, 6, 4, 10, 0); // Saturday, after 09:00
    const cands = enumerateSlotInstants(config, from, 1);
    expect(cands[0].ms).toBe(Date.UTC(2026, 6, 5, 11, 0));
  });

  it("resolves the weekday in the platform timezone, not UTC", () => {
    // 03:00 UTC Saturday July 4 is still 23:00 FRIDAY July 3 in New York.
    // With Saturdays off, the Friday view has no slots left (09:00 passed),
    // Saturday is skipped, so the first candidate is Sunday 09:00 local.
    const config = {
      slots: weekly(["09:00"], { sat: [] }),
      timezone: "America/New_York",
    };
    const from = Date.UTC(2026, 6, 4, 3, 0);
    const cands = enumerateSlotInstants(config, from, 3);
    expect(cands[0].ms).toBe(
      wallClockToUtcMs("America/New_York", 2026, 7, 5, 9, 0),
    );
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

  it("slots read both stored shapes; bad JSON falls back to defaults", async () => {
    await setSetting(
      platformSettingKey("youtube", "slots"),
      JSON.stringify(["18:00", "09:00", "09:00", "nope", "13:00"]),
    );
    expect(await getPlatformSlots("youtube")).toEqual(
      weekly(["09:00", "13:00", "18:00"]),
    );
    await setSetting(
      platformSettingKey("youtube", "slots"),
      JSON.stringify({ default: ["09:00"], overrides: { sat: [] } }),
    );
    expect(await getPlatformSlots("youtube")).toEqual(
      weekly(["09:00"], { sat: [] }),
    );
    await setSetting(platformSettingKey("youtube", "slots"), "{ not json");
    expect(await getPlatformSlots("youtube")).toEqual(
      weekly([...PUBLISH_DEFAULTS.slots]),
    );
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

describe("buildCalendarDays", () => {
  const config = {
    slots: weekly(["09:00", "13:00"], { sat: [] }),
    timezone: "UTC",
    dailyCap: 2,
  };

  it("merges queued posts with projected open slots, ascending, capped", () => {
    // Wednesday 2026-07-01, 08:00 UTC. One post queued at 09:00.
    const from = Date.UTC(2026, 6, 1, 8, 0);
    const days = buildCalendarDays(
      config,
      [
        {
          storyId: "s1",
          storyTitle: "Queued",
          scheduledForIso: new Date(Date.UTC(2026, 6, 1, 9, 0)).toISOString(),
        },
      ],
      from,
      3,
    );
    expect(days).toHaveLength(3);
    expect(days[0].isToday).toBe(true);
    expect(days[0].entries.map((e) => [e.kind, e.timeLocal])).toEqual([
      ["queued", "09:00"],
      ["open", "13:00"],
    ]);
    // Thursday: nothing queued, both slots open (cap 2).
    expect(days[1].entries.map((e) => [e.kind, e.timeLocal])).toEqual([
      ["open", "09:00"],
      ["open", "13:00"],
    ]);
  });

  it("projects nothing past the daily cap and nothing in the past", () => {
    // 10:00: today's 09:00 is gone; two queued posts fill the cap.
    const from = Date.UTC(2026, 6, 1, 10, 0);
    const queued = [11, 12].map((h) => ({
      storyId: `s${h}`,
      storyTitle: null,
      scheduledForIso: new Date(Date.UTC(2026, 6, 1, h, 0)).toISOString(),
    }));
    const days = buildCalendarDays(config, queued, from, 1);
    expect(days[0].entries.map((e) => e.kind)).toEqual(["queued", "queued"]);
  });

  it("shows no open slots on a no-posts weekday but still shows queued rows", () => {
    // Saturday 2026-07-04 is overridden to no posts; an explicit post
    // scheduled by hand that day must still appear.
    const from = Date.UTC(2026, 6, 4, 6, 0);
    const days = buildCalendarDays(
      config,
      [
        {
          storyId: "s1",
          storyTitle: "By hand",
          scheduledForIso: new Date(Date.UTC(2026, 6, 4, 15, 0)).toISOString(),
        },
      ],
      from,
      1,
    );
    expect(days[0].weekday).toBe("sat");
    expect(days[0].entries.map((e) => [e.kind, e.timeLocal])).toEqual([
      ["queued", "15:00"],
    ]);
  });
});

describe("scheduleStoryPublishAt", () => {
  beforeEach(async () => {
    await clear();
    await run("DELETE FROM stories", []);
  });

  it("schedules at the explicit wall-clock time in the platform timezone", async () => {
    await configurePlatform("youtube", { enabled: true, cap: 3, tz: "America/New_York" });
    const now = Date.UTC(2026, 6, 1, 0, 0);
    const r = await scheduleStoryPublishAt(
      "s1",
      "youtube",
      { year: 2026, month: 7, day: 4, hour: 15, minute: 30 },
      { nowMs: now },
    );
    expect(r.status).toBe("scheduled");
    expect(r.slotLocal).toBe("15:30");
    expect(r.capExceeded).toBe(false);
    // 15:30 EDT (UTC-4) = 19:30 UTC.
    expect(r.scheduledForIso).toBe(
      new Date(Date.UTC(2026, 6, 4, 19, 30)).toISOString(),
    );
  });

  it("rejects a time in the past", async () => {
    await configurePlatform("youtube", { enabled: true, cap: 3, tz: "UTC" });
    const now = Date.UTC(2026, 6, 4, 12, 0);
    const r = await scheduleStoryPublishAt(
      "s1",
      "youtube",
      { year: 2026, month: 7, day: 4, hour: 9, minute: 0 },
      { nowMs: now },
    );
    expect(r.status).toBe("in_past");
  });

  it("reports duplicate when the story already has an active row", async () => {
    await configurePlatform("youtube", { enabled: true, cap: 3, tz: "UTC" });
    const now = Date.UTC(2026, 6, 1, 0, 0);
    const when = { year: 2026, month: 7, day: 4, hour: 9, minute: 0 };
    const first = await scheduleStoryPublishAt("s1", "youtube", when, { nowMs: now });
    expect(first.status).toBe("scheduled");
    const second = await scheduleStoryPublishAt(
      "s1",
      "youtube",
      { ...when, hour: 12 },
      { nowMs: now },
    );
    expect(second.status).toBe("duplicate");
  });

  it("still lands past the daily cap but says so", async () => {
    await configurePlatform("youtube", { enabled: true, cap: 1, tz: "UTC" });
    const now = Date.UTC(2026, 6, 1, 0, 0);
    await insertSlotRow("youtube", new Date(Date.UTC(2026, 6, 4, 9, 0)).toISOString());
    const r = await scheduleStoryPublishAt(
      "s1",
      "youtube",
      { year: 2026, month: 7, day: 4, hour: 12, minute: 0 },
      { nowMs: now },
    );
    expect(r.status).toBe("scheduled");
    expect(r.capExceeded).toBe(true);
  });
});

describe("cancelScheduledPublish", () => {
  beforeEach(clear);

  async function insertRow(id: string, platform: string, state: string) {
    await run(
      "INSERT INTO scheduled_publishes (id, story_id, platform, scheduled_for, state, attempts, created_at) " +
        "VALUES (?, 's1', ?, '2026-07-04T09:00:00.000Z', ?, 0, '2026-07-01T00:00:00.000Z')",
      [id, platform, state],
    );
  }

  it("cancels a waiting row; a second cancel is a harmless yes", async () => {
    await insertRow("row1", "youtube", "scheduled");
    expect(await cancelScheduledPublish("row1")).toBe(true);
    expect(await cancelScheduledPublish("row1")).toBe(true);
    const back = await all<{ state: string }>(
      "SELECT state FROM scheduled_publishes WHERE id = 'row1'",
      [],
    );
    expect(back[0].state).toBe("cancelled");
  });

  it("refuses a row the dispatcher already claimed or posted", async () => {
    await insertRow("row2", "youtube", "publishing");
    await insertRow("row3", "tiktok", "published");
    expect(await cancelScheduledPublish("row2")).toBe(false);
    expect(await cancelScheduledPublish("row3")).toBe(false);
  });
});

describe("listUpcomingPublishes", () => {
  beforeEach(async () => {
    await clear();
    await run("DELETE FROM stories", []);
  });

  it("returns waiting rows soonest-first with story titles", async () => {
    await run(
      "INSERT INTO stories (id, title, status, created_at, updated_at) VALUES ('s1', 'A Story', 'published', '2026-07-01', '2026-07-01')",
      [],
    );
    await run(
      "INSERT INTO scheduled_publishes (id, story_id, platform, scheduled_for, state, attempts, created_at) VALUES " +
        "('later', 's1', 'youtube', '2026-07-05T09:00:00.000Z', 'scheduled', 0, '2026-07-01'), " +
        "('sooner', 's1', 'tiktok', '2026-07-04T09:00:00.000Z', 'scheduled', 0, '2026-07-01'), " +
        "('done', 's1', 'facebook', '2026-07-03T09:00:00.000Z', 'published', 0, '2026-07-01')",
      [],
    );
    const rows = await listUpcomingPublishes();
    expect(rows.map((r) => r.id)).toEqual(["sooner", "later"]);
    expect(rows[0].storyTitle).toBe("A Story");
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

describe("daily site drop", () => {
  beforeEach(clear);

  it("defaults to 09:00 Asia/Jerusalem when unset", async () => {
    const c = await getDailyDropConfig();
    expect(c).toMatchObject({ time: "09:00", timezone: "Asia/Jerusalem", hour: 9, minute: 0 });
  });

  it("parses a configured time + zone and normalizes HH:MM", async () => {
    await setSetting(DAILY_DROP_SETTING_KEYS.time, "7:05");
    await setSetting(DAILY_DROP_SETTING_KEYS.timezone, "Europe/London");
    const c = await getDailyDropConfig();
    expect(c).toMatchObject({ time: "07:05", timezone: "Europe/London", hour: 7, minute: 5 });
  });

  it("falls back on garbage time and invalid zone", async () => {
    await setSetting(DAILY_DROP_SETTING_KEYS.time, "banana");
    await setSetting(DAILY_DROP_SETTING_KEYS.timezone, "Mars/Olympus");
    const c = await getDailyDropConfig();
    expect(c).toMatchObject({ time: "09:00", timezone: "Asia/Jerusalem" });
  });

  it("computes the drop instant DST-safely (summer vs winter offset)", () => {
    const cfg = { time: "09:00", timezone: "Asia/Jerusalem", hour: 9, minute: 0 };
    // July: Israel is UTC+3 (IDT) -> 09:00 local = 06:00 UTC.
    expect(dropMsForDay(cfg, Date.UTC(2026, 6, 15, 12, 0))).toBe(Date.UTC(2026, 6, 15, 6, 0));
    // January: Israel is UTC+2 (IST) -> 09:00 local = 07:00 UTC.
    expect(dropMsForDay(cfg, Date.UTC(2026, 0, 15, 12, 0))).toBe(Date.UTC(2026, 0, 15, 7, 0));
  });

  it("isBeforeDailyDrop is true before and false after the drop instant", async () => {
    // Default 09:00 Israel (=06:00 UTC in July).
    expect(await isBeforeDailyDrop(Date.UTC(2026, 6, 15, 5, 0))).toBe(true); // 08:00 IDT
    expect(await isBeforeDailyDrop(Date.UTC(2026, 6, 15, 7, 0))).toBe(false); // 10:00 IDT
  });

  it("nextDropMs is today's drop before it, tomorrow's after it", () => {
    const cfg = { time: "09:00", timezone: "Asia/Jerusalem", hour: 9, minute: 0 };
    const beforeDrop = Date.UTC(2026, 6, 15, 5, 0); // 08:00 IDT
    expect(nextDropMs(cfg, beforeDrop)).toBe(Date.UTC(2026, 6, 15, 6, 0)); // today 09:00 IDT
    const afterDrop = Date.UTC(2026, 6, 15, 8, 0); // 11:00 IDT
    expect(nextDropMs(cfg, afterDrop)).toBe(Date.UTC(2026, 6, 16, 6, 0)); // tomorrow 09:00 IDT
  });
});
