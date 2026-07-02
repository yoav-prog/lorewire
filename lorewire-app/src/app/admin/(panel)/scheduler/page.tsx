// Scheduler admin page. Two automation layers on one screen:
//   1. Rendering: the rate-limited auto-render of Reddit sources, with the
//      backpressure status shown up top so a paused pipeline is obvious.
//   2. Publishing: per-platform daily caps + fixed posting slots, with a
//      per-platform "today" line and a double-post warning if the legacy
//      auto_publish is still on.
// Plus the human gate in the middle: the review queue with Approve / Reject.
//
// Server component: reads effective settings + live counts, then renders the
// shared Setting* controls (auto-save) and the scheduler-specific client bits.
//
// Plan: _plans/2026-07-01-render-and-publish-schedulers.md.

import { requireCapability } from "@/lib/dal";
import { all } from "@/lib/db";
import {
  RENDER_SETTING_KEYS,
  describeRenderGate,
  getEligibilityMinStrength,
  getFreshnessTtlDays,
  getRenderEnabled,
  getRenderRatePerHour,
  getReviewQueueCap,
  getStaleHours,
  resolveRenderGate,
} from "@/lib/render-scheduler";
import { getBudgetSummary, formatCents } from "@/lib/story-jobs-budget";
import {
  AUTOPILOT_DEFAULTS,
  AUTOPILOT_SETTING_KEYS,
  getAutopilotStatus,
  listRecentAutoPublishes,
} from "@/lib/autopilot";
import {
  PUBLISH_DEFAULTS,
  PUBLISH_ENABLED_KEY,
  getPublishCalendar,
  getSchedulerOverview,
  listSchedulableStories,
  listUpcomingPublishes,
  platformSettingKey,
  type PlatformOverview,
} from "@/lib/publish-scheduler";
import {
  SettingSelect,
  SettingSlider,
  SettingText,
  SettingToggle,
} from "@/app/admin/(panel)/settings/_components/SettingControls";
import { AutopilotModeSelect } from "./_components/AutopilotModeSelect";
import { RecentAutoPublishes } from "./_components/RecentAutoPublishes";
import { PlatformEnableToggle } from "./_components/PlatformEnableToggle";
import { SlotsEditor } from "./_components/SlotsEditor";
import { ReviewActions } from "./_components/ReviewActions";
import { CalendarPreview } from "./_components/CalendarPreview";
import { SchedulePostForm } from "./_components/SchedulePostForm";
import { UpcomingPosts } from "./_components/UpcomingPosts";

interface ReviewRow {
  id: string;
  title: string | null;
  category: string | null;
  updated_at: string | null;
  /** 1 when autopilot enqueued this story's render. */
  autopilot: number;
  /** 1 when the safety judge held this story for a human. */
  auto_held: number;
}

const PLATFORM_LABELS: Record<string, string> = {
  youtube: "YouTube",
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
};

function ageLabel(iso: string | null): string {
  if (!iso) return "unknown";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "unknown";
  const hours = (Date.now() - then) / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatSlot(iso: string | null, tz: string): string {
  if (!iso) return "nothing queued";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export default async function SchedulerPage() {
  await requireCapability("settings.manage");

  const [
    gate,
    budget,
    renderEnabled,
    ratePerHour,
    reviewCap,
    staleHours,
    ttlDays,
    eligibility,
    overview,
    reviewRows,
    upcoming,
    schedulable,
    calendars,
    autopilot,
    recentAutoPublishes,
  ] = await Promise.all([
    resolveRenderGate(),
    getBudgetSummary(),
    getRenderEnabled(),
    getRenderRatePerHour(),
    getReviewQueueCap(),
    getStaleHours(),
    getFreshnessTtlDays(),
    getEligibilityMinStrength(),
    getSchedulerOverview(),
    all<ReviewRow>(
      `SELECT id, title, category, updated_at,
         EXISTS(SELECT 1 FROM story_jobs j
                WHERE j.story_id = stories.id AND j.requested_by = 'autopilot') AS autopilot,
         EXISTS(SELECT 1 FROM scheduler_decisions d
                WHERE d.story_id = stories.id AND d.decision = 'auto_held') AS auto_held
       FROM stories WHERE status = 'review' ORDER BY updated_at DESC LIMIT 50`,
    ),
    listUpcomingPublishes(50),
    listSchedulableStories(50),
    getPublishCalendar(7),
    getAutopilotStatus(),
    listRecentAutoPublishes(10),
  ]);

  const rendering = gate.reason === "ok";

  return (
    <div className="mx-auto max-w-[900px] space-y-10">
      <header>
        <h1 className="font-display text-2xl text-ink">Scheduler</h1>
        <p className="mt-1 text-[13px] text-muted">
          Auto-render the strongest Reddit sources, approve what is worth
          posting, and let each platform publish on its own schedule.
        </p>
      </header>

      {/* ── Status strip ─────────────────────────────────────────────── */}
      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                rendering ? "bg-accent" : "bg-muted"
              }`}
              aria-hidden
            />
            <span className="text-[13px] font-semibold text-ink">
              {describeRenderGate(gate)}
            </span>
          </div>
          <p className="mt-2 font-mono text-[12px] text-muted">
            {gate.reviewDepth}/{gate.reviewQueueCap} in review ·{" "}
            {formatCents(budget.spentCents)}
            {budget.capCents !== null ? ` / ${formatCents(budget.capCents)}` : ""}{" "}
            today
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                overview.publishEnabled ? "bg-accent" : "bg-muted"
              }`}
              aria-hidden
            />
            <span className="text-[13px] font-semibold text-ink">
              {overview.publishEnabled ? "Publishing on" : "Publishing off"}
            </span>
          </div>
          <p className="mt-2 font-mono text-[12px] text-muted">
            {overview.platforms.filter((p) => p.config.enabled).length} of 4
            platforms live ·{" "}
            {overview.platforms.reduce((n, p) => n + p.pendingScheduled, 0)}{" "}
            queued
          </p>
        </div>
      </section>

      {/* ── Rendering ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">Rendering</h2>
        <SettingToggle
          settingKey={RENDER_SETTING_KEYS.enabled}
          label="Auto-render Reddit sources"
          hint="Continuously render the highest-priority sources into the review queue. Off by default."
          initialOn={renderEnabled}
        />
        <SettingSlider
          settingKey={RENDER_SETTING_KEYS.ratePerHour}
          label="Render rate"
          hint="Renders enqueued per hour. 0.5 is about 12 per day; 1 is about 24 per day."
          initial={String(ratePerHour)}
          min={0.1}
          max={5}
          step={0.1}
          unit="/hr"
        />
        <SettingSelect
          settingKey={RENDER_SETTING_KEYS.eligibilityMinStrength}
          label="Which sources qualify"
          hint="Weaker sources are left for manual processing."
          initial={eligibility}
          options={[
            { id: "strong", label: "Strong only" },
            { id: "medium", label: "Medium and up" },
            { id: "none", label: "All sources" },
          ]}
        />
        <details className="rounded-xl border border-line bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-[13px] font-semibold text-ink">
            Advanced backpressure
          </summary>
          <div className="space-y-3 border-t border-line p-4">
            <SettingSlider
              settingKey={RENDER_SETTING_KEYS.reviewQueueCap}
              label="Pause when review queue reaches"
              hint="Stop rendering once this many stories are waiting for approval, so renders can't outrun you."
              initial={String(reviewCap)}
              min={1}
              max={200}
              step={1}
              unit=" items"
            />
            <SettingSlider
              settingKey={RENDER_SETTING_KEYS.staleHours}
              label="Pause after inactivity"
              hint="If nothing waiting has been approved or rejected in this many hours, stop rendering until you return."
              initial={String(staleHours)}
              min={1}
              max={168}
              step={1}
              unit="h"
            />
            <SettingSlider
              settingKey={RENDER_SETTING_KEYS.freshnessTtlDays}
              label="Auto-archive stale reviews after"
              hint="Auto-rendered stories left unapproved this long are archived so the queue can't fill with dead content."
              initial={String(ttlDays)}
              min={1}
              max={60}
              step={1}
              unit="d"
            />
          </div>
        </details>
      </section>

      {/* ── Autopilot ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">Autopilot</h2>
        <p className="text-[13px] text-muted">
          When nothing is waiting for you below, autopilot pulls the strongest
          Reddit sources — strong tier only — renders them, and (in Live)
          publishes them without a click. Your track record on strong sources:
          approved {autopilot.strongApproved}, rejected {autopilot.strongRejected}.
        </p>
        {autopilot.trippedAt && (
          <p className="rounded-lg border border-accent bg-accent/10 px-3 py-2 text-[12px] text-accent">
            Autopilot switched itself off on{" "}
            {new Date(autopilot.trippedAt).toLocaleString("en-US")} after
            repeated publish failures. Check the newest stories, then pick a
            mode below to start fresh.
          </p>
        )}
        <div className="rounded-xl border border-line bg-surface p-4">
          <AutopilotModeSelect initialMode={autopilot.mode} />
          {autopilot.mode !== "off" && (
            <p className="mt-3 font-mono text-[12px] text-muted">
              {autopilot.usedToday}/{autopilot.dailyLimit} pulled today ·{" "}
              {autopilot.autoApproved} auto-published all-time ·{" "}
              {autopilot.autoHeld} held for you
            </p>
          )}
        </div>
        {autopilot.mode !== "off" && (
          <>
            <SettingSlider
              settingKey={AUTOPILOT_SETTING_KEYS.dailyLimit}
              label="Stories per day"
              hint="How many sources autopilot may pull per day. Start at 1 and raise it as the results earn trust."
              initial={String(autopilot.dailyLimit)}
              min={1}
              max={20}
              step={1}
              unit="/day"
            />
            <SettingText
              settingKey={AUTOPILOT_SETTING_KEYS.alertEmail}
              label="Alert email"
              hint={`If autopilot disables itself (after ${AUTOPILOT_DEFAULTS.breakerThreshold} failed publishes in a row), this address gets an email. Leave blank for logs only.`}
              initial={autopilot.alertEmail ?? ""}
              placeholder="you@example.com"
            />
          </>
        )}
        {(autopilot.mode !== "off" || recentAutoPublishes.length > 0) && (
          <div>
            <div className="mb-2 text-[13px] font-semibold text-ink">
              Published by autopilot
            </div>
            <RecentAutoPublishes
              items={recentAutoPublishes.map((r) => ({
                storyId: r.storyId,
                title: r.title || r.storyId,
                status: r.status,
                whenLabel: ageLabel(r.decidedAt),
              }))}
            />
          </div>
        )}
      </section>

      {/* ── Review queue (the human gate) ────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">
          Review queue{" "}
          <span className="font-mono text-[13px] text-muted">
            ({reviewRows.length})
          </span>
        </h2>
        {reviewRows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-surface p-6 text-center text-[13px] text-muted">
            Nothing waiting. Approved stories leave here and post on schedule.
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {reviewRows.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-4 p-4"
              >
                <div className="min-w-0">
                  <a
                    href={`/admin/shorts/${row.id}`}
                    className="block truncate text-[14px] text-ink hover:text-accent"
                  >
                    {row.title || row.id}
                  </a>
                  <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-muted">
                    {row.category || "uncategorized"} · {ageLabel(row.updated_at)}
                    {row.auto_held ? (
                      <span className="ml-2 rounded-full border border-accent px-2 py-px text-[10px] normal-case tracking-normal text-accent">
                        Held by safety check
                      </span>
                    ) : row.autopilot ? (
                      <span className="ml-2 rounded-full border border-line px-2 py-px text-[10px] normal-case tracking-normal text-muted">
                        Autopilot
                      </span>
                    ) : null}
                  </p>
                </div>
                <ReviewActions storyId={row.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Publishing ───────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">Publishing</h2>
        <SettingToggle
          settingKey={PUBLISH_ENABLED_KEY}
          label="Scheduled publishing"
          hint="Master switch. When off, approving a story publishes it but queues no social posts."
          initialOn={overview.publishEnabled}
        />
        <div className="grid gap-3">
          {overview.platforms.map((p) => (
            <PlatformCard key={p.config.platform} overview={p} />
          ))}
        </div>
      </section>

      {/* ── Next 7 days ──────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">Next 7 days</h2>
        <CalendarPreview calendars={calendars} platformLabels={PLATFORM_LABELS} />
      </section>

      {/* ── Posting queue ────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="font-display text-lg text-ink">
          Posting queue{" "}
          <span className="font-mono text-[13px] text-muted">
            ({upcoming.length})
          </span>
        </h2>
        <UpcomingPosts
          items={upcoming.map((u) => ({
            id: u.id,
            storyId: u.storyId,
            title: u.storyTitle || u.storyId,
            platformLabel: PLATFORM_LABELS[u.platform] ?? u.platform,
            whenLabel: formatSlot(
              u.scheduledFor,
              u.timezone || PUBLISH_DEFAULTS.timezone,
            ),
          }))}
        />
        <SchedulePostForm
          stories={schedulable.map((s) => ({ id: s.id, title: s.title || s.id }))}
          platforms={overview.platforms.map((p) => ({
            id: p.config.platform,
            label: PLATFORM_LABELS[p.config.platform] ?? p.config.platform,
            timezone: p.config.timezone,
          }))}
        />
      </section>
    </div>
  );
}

function PlatformCard({ overview }: { overview: PlatformOverview }) {
  const { config } = overview;
  const label = PLATFORM_LABELS[config.platform] ?? config.platform;
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-ink">{label}</div>
          <p className="mt-0.5 font-mono text-[11px] text-muted">
            {overview.posted} posted · {overview.pendingScheduled} queued · next{" "}
            {formatSlot(overview.nextSlotIso, config.timezone)}
          </p>
        </div>
        <PlatformEnableToggle
          platform={config.platform}
          label={`${label} publishing`}
          initialOn={config.enabled}
        />
      </div>

      {overview.legacyAutoPublishOn && config.enabled && (
        <p className="mt-3 rounded-lg border border-accent bg-accent/10 px-3 py-2 text-[12px] text-accent">
          Heads up: this platform&apos;s legacy instant-publish is also on, which
          can double-post. Turning scheduler publishing off and on again clears
          it.
        </p>
      )}

      {config.enabled && (
        <div className="mt-4 space-y-4 border-t border-line pt-4">
          <div>
            <div className="mb-1 text-[13px] font-semibold text-ink">
              Posting times
            </div>
            <p className="mb-2 text-[12px] text-muted">
              Each approved post goes out at the next open slot, in the timezone
              below. Times apply every day unless a specific day is customized.
            </p>
            <SlotsEditor
              settingKey={platformSettingKey(config.platform, "slots")}
              initialSlots={config.slots}
            />
          </div>
          <SettingSlider
            settingKey={platformSettingKey(config.platform, "daily_cap")}
            label="Posts per day"
            hint="Once this many are scheduled for a day, the rest roll to the next day."
            initial={String(config.dailyCap)}
            min={1}
            max={50}
            step={1}
            unit="/day"
          />
          <SettingText
            settingKey={platformSettingKey(config.platform, "timezone")}
            label="Timezone"
            hint="IANA name, e.g. America/New_York, Europe/London, Asia/Jerusalem."
            initial={config.timezone}
            placeholder="America/New_York"
          />
        </div>
      )}
    </div>
  );
}
