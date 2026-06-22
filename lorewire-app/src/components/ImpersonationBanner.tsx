// Loud, persistent banner shown whenever an admin is impersonating a member
// ("view as" support mode). Self-contained: it reads the impersonation state
// itself (no prop threading) and renders null when not active. Rendered on the
// public homepage and in the admin panel shell so the admin always sees it
// while a session is live. The Exit button clears the cookie.
//
// Phase 7 of _plans/2026-06-22-admin-user-management.md.

import { resolveImpersonation } from "@/lib/impersonation";
import { getUserById } from "@/lib/users";
import { stopImpersonationAction } from "@/app/admin/(panel)/users/actions";

export default async function ImpersonationBanner() {
  const imp = await resolveImpersonation();
  if (!imp) return null;
  const target = await getUserById(imp.targetId);
  const label = target?.name?.trim() || target?.email || imp.targetId;

  return (
    <div className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-accent px-4 py-2 text-center text-bg">
      <span className="text-[13px] font-semibold">
        Support mode — viewing as {label}
      </span>
      <span className="text-[11px] opacity-80">
        Read-only. Your admin account is unchanged.
      </span>
      <form action={stopImpersonationAction}>
        <button
          type="submit"
          className="rounded-md border border-bg/40 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-bg transition-colors hover:bg-bg/15"
        >
          Exit
        </button>
      </form>
    </div>
  );
}
