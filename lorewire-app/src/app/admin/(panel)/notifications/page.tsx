// /admin/notifications — the failure inbox. Every row is something that
// needed a human because an automated flow could not complete: an
// auto-publish that gave up after its attempt cap, a full-pipeline story
// the gate blocked. Unread rows sit on top with the reason spelled out;
// marking a row read moves it into the history below (rows are never
// deleted — recent history is the audit trail for "what broke lately").
//
// Born from the 2026-07-02 incident where two stories published without
// their video: failures must land HERE, loudly, instead of a story
// shipping half-built. Plan:
// _plans/2026-07-02-never-publish-without-video.md.

import Link from "next/link";
import { requireCapability } from "@/lib/dal";
import Breadcrumb from "@/app/admin/Breadcrumb";
import {
  listAdminNotifications,
  type AdminNotificationRow,
} from "@/lib/admin-notifications";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "./actions";

export const dynamic = "force-dynamic";

const CHIP =
  "rounded-full border border-line bg-surface2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted";

function ago(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Flatten the writer's JSON detail blob into readable "key: value"
 *  lines. Arrays join with commas; nested objects stringify. Bad JSON
 *  renders as-is rather than hiding information. */
function detailLines(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [raw];
  }
  if (typeof parsed !== "object" || parsed === null) return [String(parsed)];
  return Object.entries(parsed as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      const value = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
      return `${k}: ${value}`;
    });
}

function NotificationCard({
  n,
  showMarkRead,
}: {
  n: AdminNotificationRow;
  showMarkRead: boolean;
}) {
  const lines = detailLines(n.detail);
  return (
    <li
      className={`rounded-lg border border-line bg-surface p-4 ${n.read_at ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <span
          aria-hidden="true"
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
            n.severity === "error" ? "bg-danger" : "bg-warn"
          }`}
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold text-ink">
              {n.title}
            </span>
            <span className={CHIP}>{n.source}</span>
            <span className="font-mono text-[11px] text-muted">
              {ago(n.created_at)}
            </span>
          </div>
          {lines.length > 0 && (
            <div className="space-y-0.5">
              {lines.map((line) => (
                <p key={line} className="font-mono text-[11px] text-muted">
                  {line}
                </p>
              ))}
            </div>
          )}
          {n.subject_kind === "story" && n.subject_id && (
            <Link
              href={`/admin/stories/${n.subject_id}`}
              className="inline-block font-mono text-[11px] uppercase tracking-wider text-accent hover:underline"
            >
              Open story →
            </Link>
          )}
        </div>
        {showMarkRead && (
          <form action={markNotificationReadAction.bind(null, n.id)}>
            <button
              type="submit"
              className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:bg-surface2 hover:text-ink"
            >
              Mark read
            </button>
          </form>
        )}
      </div>
    </li>
  );
}

export default async function NotificationsPage() {
  await requireCapability("content.manage");
  const rows = await listAdminNotifications(200);
  const unread = rows.filter((r) => !r.read_at);
  const read = rows.filter((r) => !!r.read_at);

  console.info("[notifications page] render", {
    unread: unread.length,
    read: read.length,
  });

  return (
    <div className="space-y-5">
      <Breadcrumb trail={[{ href: "/admin", label: "Overview" }]} />

      <header className="space-y-1">
        <h1 className="font-display text-[24px] font-extrabold tracking-tightest text-ink">
          Notifications
        </h1>
        <p className="text-[13px] text-muted">
          Anything the automated flows could not finish lands here — a story
          that failed to publish, a pipeline run the gate blocked. Each row
          says what happened and what is missing. Mark it read once handled.
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted">
            Needs attention ({unread.length})
          </h2>
          {unread.length > 0 && (
            <form action={markAllNotificationsReadAction}>
              <button
                type="submit"
                className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:bg-surface2 hover:text-ink"
              >
                Mark all read
              </button>
            </form>
          )}
        </div>
        {unread.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface p-4 text-[13px] text-muted">
            All clear — nothing needs your attention.
          </p>
        ) : (
          <ul className="space-y-2">
            {unread.map((n) => (
              <NotificationCard key={n.id} n={n} showMarkRead />
            ))}
          </ul>
        )}
      </section>

      {read.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted">
            History
          </h2>
          <ul className="space-y-2">
            {read.map((n) => (
              <NotificationCard key={n.id} n={n} showMarkRead={false} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
