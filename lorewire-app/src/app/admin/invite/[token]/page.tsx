// Staff invite acceptance. Sits OUTSIDE the (panel) route group, so it isn't
// behind requireAdmin — the invitee isn't staff yet; the one-time token in the
// URL is the authorization. Validates the token server-side and, if good,
// shows the set-password form. Plan: _plans/2026-06-22-admin-user-management.md.

import Link from "next/link";

import { getValidInvite } from "@/lib/staff-invites";
import AcceptInviteForm from "./AcceptInviteForm";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  editor: "Editor",
  moderator: "Moderator",
  viewer: "Viewer",
};

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = await getValidInvite(token);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-6">
        {/* 2026-06-26 slice H follow-up: admin invite wordmark
            locked to Archivo. */}
        <span className="text-[18px] font-extrabold tracking-tightest text-ink" style={{ fontFamily: "var(--font-archivo), Arial, sans-serif" }}>
          LORE<span className="text-accent">WIRE</span>
        </span>
        <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
          Studio
        </span>
      </div>

      {!invite ? (
        <div className="rounded-xl border border-line bg-surface p-5">
          <h1 className="font-display text-[18px] font-bold text-ink">
            This invite isn&apos;t valid
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            The link is invalid, already used, or expired. Ask an admin to send
            a fresh invite.
          </p>
          <Link
            href="/"
            className="mt-3 inline-block font-mono text-[11px] uppercase tracking-wider text-accent hover:underline"
          >
            ← Home
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border border-line bg-surface p-5">
          <h1 className="font-display text-[18px] font-bold text-ink">
            Set up your account
          </h1>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            You&apos;re joining as{" "}
            <span className="text-ink">
              {ROLE_LABEL[invite.role] ?? invite.role}
            </span>
            . Choose a password for{" "}
            <span className="text-ink">{invite.email}</span>.
          </p>
          <AcceptInviteForm token={token} />
        </div>
      )}
    </div>
  );
}
