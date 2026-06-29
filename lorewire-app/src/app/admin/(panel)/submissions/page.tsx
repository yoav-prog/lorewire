// /admin/submissions — the human side of the submission moderator. Lists what the
// AI did not auto-resolve: "Needs review" (clean/borderline/ambiguous/low-confidence
// it routed to a person) and "Quarantined" (severe — threats, self-harm, sexual
// content involving minors; preserved, never auto-deleted). The AI's read is shown
// on each card to speed the call. Approve clears it (Phase 3 renders on approval);
// reject sends it back to the author with a reason they can fix and resubmit.
//
// Plan: _plans/2026-06-29-user-submitted-stories.md (Phase 2).

import { requireCapability } from "@/lib/dal";
import Breadcrumb from "@/app/admin/Breadcrumb";
import { getSetting } from "@/lib/repo";
import { listSubmissionQueue, type SubmissionRow } from "@/lib/submissions";
import type { SubmissionJudgeOutput } from "@/lib/submission-moderation";
import { SubmissionModerationActions } from "./SubmissionModerationActions";
import { SubmissionsKillSwitch } from "./SubmissionsKillSwitch";

export const dynamic = "force-dynamic";

const LABEL = "font-mono text-[11px] uppercase tracking-wider text-muted";
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

function parseSignal(raw: string | null): SubmissionJudgeOutput | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SubmissionJudgeOutput;
  } catch {
    return null;
  }
}

export default async function SubmissionsModerationPage() {
  await requireCapability("content.manage");
  const rows = await listSubmissionQueue(200);
  const quarantined = rows.filter((r) => r.status === "quarantined");
  const pending = rows.filter((r) => r.status === "pending_review");
  const submissionsEnabled = (await getSetting("submissions.enabled")) !== "0";

  return (
    <div className="space-y-5">
      <Breadcrumb trail={[{ href: "/admin", label: "Overview" }]} />

      <header className="space-y-1">
        <h1 className="font-display text-[24px] font-extrabold tracking-tightest text-ink">
          Submission review
        </h1>
        <p className="text-[13px] text-muted">
          Users submit their own story and dilemma. The AI rejects the
          clearly-bad and flags anyone naming a real person; what lands here is
          everything it wants a person to confirm. Approve to clear it; reject to
          send it back with a reason they can fix.
        </p>
      </header>

      <SubmissionsKillSwitch enabled={submissionsEnabled} />

      {quarantined.length > 0 && (
        <section className="space-y-3">
          <div className="rounded-xl border border-cat-entitled/40 bg-cat-entitled/10 px-4 py-3">
            <p className="text-[13px] font-semibold text-cat-entitled">
              Quarantined — handle with care
            </p>
            <p className="mt-1 text-[12px] text-muted">
              Flagged as a severe category (credible threats, self-harm intent,
              sexual content involving minors). Preserved, never auto-deleted.
              Follow your reporting policy before you act.
            </p>
          </div>
          <div className="space-y-3">
            {quarantined.map((row) => (
              <QueueCard key={row.id} row={row} />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className={LABEL}>Needs review ({pending.length})</h2>
        {pending.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-surface p-8 text-center">
            <p className="text-[14px] text-ink">Nothing waiting.</p>
            <p className="mt-1 text-[13px] text-muted">
              New submissions will appear here once the AI has screened them.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {pending.map((row) => (
              <QueueCard key={row.id} row={row} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function QueueCard({ row }: { row: SubmissionRow }) {
  const dir = row.lang === "he" ? "rtl" : "ltr";
  const signal = parseSignal(row.ai_signal);
  const confidencePct =
    typeof row.moderation_confidence === "number"
      ? `${Math.round(row.moderation_confidence * 100)}%`
      : null;

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-ink">
              {row.display_name || "Member"}
            </span>
            {Number(row.resubmit_count) > 0 && (
              <span className={CHIP}>resubmit #{row.resubmit_count}</span>
            )}
            <span className="font-mono text-[10px] text-muted">
              {ago(row.created_at)}
            </span>
          </div>

          <h3 dir={dir} className="text-[14px] font-semibold text-ink">
            {row.title}
          </h3>
          <p
            dir={dir}
            className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink"
          >
            {row.body}
          </p>
          <p dir={dir} className="text-[13px] text-muted">
            <span className="font-semibold text-ink">{row.dilemma_question}</span>{" "}
            — {row.option_a_text} / {row.option_b_text}
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {signal && <span className={CHIP}>AI: {signal.decision}</span>}
            {signal?.category && <span className={CHIP}>{signal.category}</span>}
            {signal?.identifies_real_person && (
              <span className="rounded-full border border-cat-entitled/40 bg-cat-entitled/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-cat-entitled">
                real person: {signal.real_person_kind}
              </span>
            )}
            {confidencePct && (
              <span className="font-mono text-[10px] text-muted">
                confidence {confidencePct}
              </span>
            )}
            {row.moderation_source && (
              <span className="font-mono text-[10px] text-muted">
                via {row.moderation_source}
              </span>
            )}
          </div>

          {signal?.reason && (
            <p className="text-[12px] italic text-muted">AI: {signal.reason}</p>
          )}
        </div>

        <SubmissionModerationActions
          submissionId={row.id}
          suggested={signal?.category}
        />
      </div>
    </div>
  );
}
