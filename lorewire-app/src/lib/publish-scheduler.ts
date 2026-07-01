// Publish Scheduler: the rate governor for social publishing.
//
// The render side fills the `review` queue; a human approves; then this
// module decides WHEN each approved story posts to each platform. Every
// platform is independent: its own on/off, its own daily cap, its own
// fixed wall-clock slots, its own timezone. Approving a story assigns it,
// per enabled platform, to the next open slot and writes a
// scheduled_publishes row; the per-minute dispatch cron (Phase 6) fires
// due rows through the existing publish-to-<platform> functions.
//
// Two things this module gets right on purpose:
//   1. DST. Slots are wall-clock strings ("09:00") in an IANA zone. We
//      resolve them to a UTC instant per calendar day using the zone's
//      offset AT THAT DAY, so a 09:00 slot is 09:00 local in summer and
//      in winter, not an hour off across a time change.
//   2. Idempotency. One active scheduled_publishes row per (story,
//      platform), enforced by a partial unique index, so approving twice
//      or a double-click never double-posts.
//
// Plan: _plans/2026-07-01-render-and-publish-schedulers.md.

import "server-only";
import { randomUUID } from "node:crypto";
import { one, run } from "@/lib/db";
import { getSetting } from "@/lib/repo";

// ---- platforms + settings --------------------------------------------

export const PUBLISH_PLATFORMS = [
  "youtube",
  "facebook",
  "instagram",
  "tiktok",
] as const;
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number];

/** Global publish kill switch. Per-platform keys are derived below. */
export const PUBLISH_ENABLED_KEY = "publish.enabled";

export function platformSettingKey(
  platform: PublishPlatform,
  suffix: "enabled" | "daily_cap" | "slots" | "timezone",
): string {
  return `publish.${platform}.${suffix}`;
}

export const PUBLISH_DEFAULTS = {
  dailyCap: 3,
  slots: ["09:00", "13:00", "18:00"] as readonly string[],
  timezone: "America/New_York",
} as const;

// How far ahead the slot search looks before giving up. A story that
// cannot be placed within two weeks almost certainly means every day is
// capped; that is a signal to raise caps, not to schedule three weeks out.
const SLOT_HORIZON_DAYS = 14;

// Active scheduled_publishes states: rows that occupy a slot. 'failed'
// and 'cancelled' free the slot back up.
const ACTIVE_STATES = ["scheduled", "publishing", "published"] as const;
const ACTIVE_STATES_SQL = "('scheduled', 'publishing', 'published')";

// ---- setting readers -------------------------------------------------

export async function getPublishEnabled(): Promise<boolean> {
  const raw = (await getSetting(PUBLISH_ENABLED_KEY))?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

export async function getPlatformEnabled(
  platform: PublishPlatform,
): Promise<boolean> {
  const raw = (await getSetting(platformSettingKey(platform, "enabled")))
    ?.trim()
    .toLowerCase();
  return raw === "1" || raw === "true";
}

export async function getPlatformDailyCap(
  platform: PublishPlatform,
): Promise<number> {
  const raw = await getSetting(platformSettingKey(platform, "daily_cap"));
  if (!raw) return PUBLISH_DEFAULTS.dailyCap;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return PUBLISH_DEFAULTS.dailyCap;
  return Math.floor(n);
}

// Validate one "HH:MM" 24-hour slot. Returns null on anything malformed
// so a corrupt setting silently drops the bad slot instead of scheduling
// at an absurd time.
export function parseSlot(slot: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(slot.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Parsed, validated, de-duplicated, ascending slot list for a platform.
 * Falls back to the default slots when the setting is blank or every
 * entry is malformed, so the scheduler always has at least one time to
 * aim at.
 */
export async function getPlatformSlots(
  platform: PublishPlatform,
): Promise<string[]> {
  const raw = await getSetting(platformSettingKey(platform, "slots"));
  let list: string[] = [...PUBLISH_DEFAULTS.slots];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const valid = parsed
          .filter((s): s is string => typeof s === "string")
          .filter((s) => parseSlot(s) !== null);
        if (valid.length > 0) list = valid;
      }
    } catch {
      // Malformed JSON: keep defaults rather than crash the scheduler.
    }
  }
  // Normalize to zero-padded HH:MM, de-dupe, sort ascending by time.
  const norm = new Map<string, { hour: number; minute: number }>();
  for (const s of list) {
    const p = parseSlot(s);
    if (!p) continue;
    const key = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    norm.set(key, p);
  }
  return [...norm.keys()].sort((a, b) => a.localeCompare(b));
}

/** Timezone for a platform, defaulting to the app default and falling
 *  back if the stored value is not a zone this runtime recognizes. */
export async function getPlatformTimezone(
  platform: PublishPlatform,
): Promise<string> {
  const raw = (await getSetting(platformSettingKey(platform, "timezone")))?.trim();
  if (raw && isValidTimezone(raw)) return raw;
  return PUBLISH_DEFAULTS.timezone;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface PlatformConfig {
  platform: PublishPlatform;
  enabled: boolean;
  dailyCap: number;
  slots: string[];
  timezone: string;
}

export async function getPlatformConfig(
  platform: PublishPlatform,
): Promise<PlatformConfig> {
  const [enabled, dailyCap, slots, timezone] = await Promise.all([
    getPlatformEnabled(platform),
    getPlatformDailyCap(platform),
    getPlatformSlots(platform),
    getPlatformTimezone(platform),
  ]);
  return { platform, enabled, dailyCap, slots, timezone };
}

// ---- DST-safe timezone math ------------------------------------------

interface TzParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock parts of a UTC instant as seen in `tz`. */
export function partsInTz(utcMs: number, tz: string): TzParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // some engines emit "24" for midnight
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

// Milliseconds `tz` is ahead of UTC at the given instant (negative when
// behind, e.g. the Americas). Derived by round-tripping the instant's
// wall-clock parts back through Date.UTC.
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = partsInTz(utcMs, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - utcMs;
}

/**
 * The UTC instant for a wall-clock time on a given calendar day in `tz`.
 * Uses the zone's offset at that day (not a fixed offset), so 09:00 stays
 * 09:00 local across daylight-saving changes. Applied twice to settle the
 * offset when the first guess lands on the wrong side of a transition;
 * fixed daytime slots never fall in the nonexistent spring-forward hour,
 * so this is exact for our use.
 */
export function wallClockToUtcMs(
  tz: string,
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz);
  return utc;
}

// UTC [start, end) bounds of a tz calendar day, used to count how many
// posts already occupy that local day regardless of its length in hours.
function tzDayBoundsMs(
  tz: string,
  year: number,
  month: number,
  day: number,
): { startMs: number; endMs: number } {
  const startMs = wallClockToUtcMs(tz, year, month, day, 0, 0);
  // Next calendar day at 00:00 local. Date.UTC normalizes day overflow
  // (e.g. day 32 -> next month), so this is safe at month/year ends.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const endMs = wallClockToUtcMs(
    tz,
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
  );
  return { startMs, endMs };
}

export interface SlotCandidate {
  /** UTC instant of the slot. */
  ms: number;
  /** The "HH:MM" wall-clock slot it came from. */
  local: string;
  /** UTC bounds of the tz calendar day this slot falls in. */
  dayStartMs: number;
  dayEndMs: number;
}

/**
 * Every future slot instant within the horizon, ascending. Pure: no DB,
 * no wall clock beyond the `fromMs` argument, so DST behavior is unit
 * testable in isolation.
 */
export function enumerateSlotInstants(
  config: Pick<PlatformConfig, "slots" | "timezone">,
  fromMs: number,
  horizonDays: number = SLOT_HORIZON_DAYS,
): SlotCandidate[] {
  const parsedSlots = config.slots
    .map((s) => ({ local: s, p: parseSlot(s) }))
    .filter((x): x is { local: string; p: { hour: number; minute: number } } => x.p !== null);
  if (parsedSlots.length === 0) return [];

  const startParts = partsInTz(fromMs, config.timezone);
  const out: SlotCandidate[] = [];
  for (let d = 0; d <= horizonDays; d++) {
    // Calendar-advance the local start date by d days (UTC math on a bare
    // date is pure calendar arithmetic, independent of any zone).
    const cal = new Date(
      Date.UTC(startParts.year, startParts.month - 1, startParts.day + d),
    );
    const y = cal.getUTCFullYear();
    const mo = cal.getUTCMonth() + 1;
    const day = cal.getUTCDate();
    const { startMs, endMs } = tzDayBoundsMs(config.timezone, y, mo, day);
    for (const { local, p } of parsedSlots) {
      const ms = wallClockToUtcMs(config.timezone, y, mo, day, p.hour, p.minute);
      if (ms > fromMs) {
        out.push({ ms, local, dayStartMs: startMs, dayEndMs: endMs });
      }
    }
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

// ---- capacity reads --------------------------------------------------

async function countActiveScheduledInRange(
  platform: PublishPlatform,
  startIso: string,
  endIso: string,
): Promise<number> {
  const row = await one<{ n: number | string }>(
    `SELECT count(*) AS n FROM scheduled_publishes
     WHERE platform = ?
       AND state IN ${ACTIVE_STATES_SQL}
       AND scheduled_for >= ? AND scheduled_for < ?`,
    [platform, startIso, endIso],
  );
  return Number(row?.n ?? 0);
}

async function isSlotTaken(
  platform: PublishPlatform,
  slotIso: string,
): Promise<boolean> {
  const row = await one<{ n: number | string }>(
    `SELECT count(*) AS n FROM scheduled_publishes
     WHERE platform = ? AND state IN ${ACTIVE_STATES_SQL} AND scheduled_for = ?`,
    [platform, slotIso],
  );
  return Number(row?.n ?? 0) > 0;
}

export interface OpenSlot {
  scheduledForMs: number;
  scheduledForIso: string;
  slotLocal: string;
  timezone: string;
}

/**
 * The next open slot for a platform after `fromMs`: the earliest future
 * slot whose local day is under the daily cap and whose exact instant is
 * not already taken (one post per slot). Returns null when the horizon is
 * exhausted (every day capped). Day counts are cached across candidates
 * so a full day costs one query, not one per slot.
 */
export async function computeNextOpenSlot(
  config: PlatformConfig,
  fromMs: number,
): Promise<OpenSlot | null> {
  const candidates = enumerateSlotInstants(config, fromMs);
  const dayCount = new Map<number, number>(); // dayStartMs -> active count
  for (const c of candidates) {
    let count = dayCount.get(c.dayStartMs);
    if (count === undefined) {
      count = await countActiveScheduledInRange(
        config.platform,
        new Date(c.dayStartMs).toISOString(),
        new Date(c.dayEndMs).toISOString(),
      );
      dayCount.set(c.dayStartMs, count);
    }
    if (count >= config.dailyCap) continue; // this local day is full
    const iso = new Date(c.ms).toISOString();
    if (await isSlotTaken(config.platform, iso)) continue;
    return {
      scheduledForMs: c.ms,
      scheduledForIso: iso,
      slotLocal: c.local,
      timezone: config.timezone,
    };
  }
  return null;
}

// ---- scheduling ------------------------------------------------------

export type PlatformScheduleStatus =
  | "scheduled"
  | "disabled"
  | "no_slot"
  | "duplicate";

export interface PlatformScheduleOutcome {
  platform: PublishPlatform;
  status: PlatformScheduleStatus;
  scheduledForIso?: string;
  slotLocal?: string;
  timezone?: string;
}

export interface ScheduleStoryResult {
  publishEnabled: boolean;
  outcomes: PlatformScheduleOutcome[];
  scheduled: number;
}

/**
 * Assign an approved story to the next open slot on every enabled
 * platform and write the scheduled_publishes rows. Idempotent per
 * (story, platform): a second call (double-click, re-approve) hits the
 * partial unique index and reports "duplicate" instead of double-booking.
 *
 * This does NOT publish anything and does NOT change the story's status;
 * it only fills the schedule. The dispatch cron does the posting; the
 * caller (the approve action) owns the story-status transition.
 */
export async function scheduleStoryPublish(
  storyId: string,
  opts: { renderId?: string | null; approvedBy?: string | null; nowMs?: number } = {},
): Promise<ScheduleStoryResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const publishEnabled = await getPublishEnabled();
  if (!publishEnabled) {
    return { publishEnabled: false, outcomes: [], scheduled: 0 };
  }

  const outcomes: PlatformScheduleOutcome[] = [];
  let scheduled = 0;
  for (const platform of PUBLISH_PLATFORMS) {
    const config = await getPlatformConfig(platform);
    if (!config.enabled) {
      outcomes.push({ platform, status: "disabled" });
      continue;
    }
    const slot = await computeNextOpenSlot(config, nowMs);
    if (!slot) {
      outcomes.push({ platform, status: "no_slot" });
      continue;
    }
    const landed = await insertScheduledPublish({
      storyId,
      renderId: opts.renderId ?? null,
      platform,
      slot,
      approvedBy: opts.approvedBy ?? null,
      nowMs,
    });
    if (landed) {
      scheduled += 1;
      outcomes.push({
        platform,
        status: "scheduled",
        scheduledForIso: slot.scheduledForIso,
        slotLocal: slot.slotLocal,
        timezone: slot.timezone,
      });
    } else {
      outcomes.push({ platform, status: "duplicate" });
    }
  }
  return { publishEnabled: true, outcomes, scheduled };
}

// Insert one scheduled row, skipping on the partial unique index if the
// story already has an active row for this platform. Returns whether the
// row actually landed (read-back by id, since run() reports no rowcount).
async function insertScheduledPublish(args: {
  storyId: string;
  renderId: string | null;
  platform: PublishPlatform;
  slot: OpenSlot;
  approvedBy: string | null;
  nowMs: number;
}): Promise<boolean> {
  const id = randomUUID();
  const nowIso = new Date(args.nowMs).toISOString();
  await run(
    `INSERT INTO scheduled_publishes
       (id, story_id, render_id, platform, scheduled_for, slot_local, timezone,
        state, external_post_id, error_message, attempts, approved_by,
        created_at, dispatched_at, posted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, NULL, 0, ?, ?, NULL, NULL)
     ON CONFLICT (story_id, platform) WHERE state IN ${ACTIVE_STATES_SQL} DO NOTHING`,
    [
      id,
      args.storyId,
      args.renderId,
      args.platform,
      args.slot.scheduledForIso,
      args.slot.slotLocal,
      args.slot.timezone,
      args.approvedBy,
      nowIso,
    ],
  );
  const back = await one<{ id: string }>(
    "SELECT id FROM scheduled_publishes WHERE id = ?",
    [id],
  );
  return back !== null;
}

// ---- decision log ----------------------------------------------------

export interface SchedulerDecisionInput {
  storyId: string;
  redditId?: string | null;
  decision: "approved" | "rejected";
  tier?: string | null;
  comments?: number | null;
  ageHours?: number | null;
  subreddit?: string | null;
  decidedBy?: string | null;
}

/**
 * Append one row to the write-only decision log. Cheap; swallows write
 * errors so logging can never break the approve/reject action itself.
 */
export async function logSchedulerDecision(
  input: SchedulerDecisionInput,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    await run(
      `INSERT INTO scheduler_decisions
         (id, story_id, reddit_id, decision, tier, comments, age_hours,
          subreddit, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        input.storyId,
        input.redditId ?? null,
        input.decision,
        input.tier ?? null,
        input.comments ?? null,
        input.ageHours ?? null,
        input.subreddit ?? null,
        input.decidedBy ?? null,
        new Date(nowMs).toISOString(),
      ],
    );
  } catch (e) {
    // eslint-disable-next-line no-console -- rule 14
    console.warn("[publish-scheduler] decision log failed", {
      story_id: input.storyId,
      decision: input.decision,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

// ---- admin overview reads --------------------------------------------

export interface PlatformOverview {
  config: PlatformConfig;
  /** True when the legacy render-time auto_publish toggle is still on.
   *  The scheduler auto-disables it on enable, but surfacing it lets the
   *  admin catch a manual re-enable that would double-post. */
  legacyAutoPublishOn: boolean;
  /** Rows waiting to fire (state='scheduled'). */
  pendingScheduled: number;
  /** Posts already sent (state='published'). */
  posted: number;
  /** Next scheduled instant (ISO), or null when nothing is queued. */
  nextSlotIso: string | null;
}

export async function getPlatformOverview(
  platform: PublishPlatform,
): Promise<PlatformOverview> {
  const [config, legacyRaw, pending, postedRow, nextRow] = await Promise.all([
    getPlatformConfig(platform),
    getSetting(`publisher.${platform}.auto_publish`),
    one<{ n: number | string }>(
      "SELECT count(*) AS n FROM scheduled_publishes WHERE platform = ? AND state = 'scheduled'",
      [platform],
    ),
    one<{ n: number | string }>(
      "SELECT count(*) AS n FROM scheduled_publishes WHERE platform = ? AND state = 'published'",
      [platform],
    ),
    one<{ m: string | null }>(
      "SELECT MIN(scheduled_for) AS m FROM scheduled_publishes WHERE platform = ? AND state = 'scheduled'",
      [platform],
    ),
  ]);
  return {
    config,
    legacyAutoPublishOn: legacyRaw?.trim() === "1",
    pendingScheduled: Number(pending?.n ?? 0),
    posted: Number(postedRow?.n ?? 0),
    nextSlotIso: nextRow?.m ?? null,
  };
}

export interface SchedulerOverview {
  publishEnabled: boolean;
  platforms: PlatformOverview[];
}

export async function getSchedulerOverview(): Promise<SchedulerOverview> {
  const [publishEnabled, ...platforms] = await Promise.all([
    getPublishEnabled(),
    ...PUBLISH_PLATFORMS.map((p) => getPlatformOverview(p)),
  ]);
  return { publishEnabled, platforms };
}

export { ACTIVE_STATES };
