// /admin/account — the user menu's Account link surfaces this page.
// Read-only view of the signed-in admin's profile today; password
// change + email change live behind their own server actions, which
// are scaffolded as TODOs (no password rotation surface exists in the
// admin yet; the existing seeded-admin flow rotates via env vars).
//
// The page intentionally keeps a tight footprint — its job is to make
// the "Account" link a real destination instead of a placeholder, and
// to give a future password / API-key / display-name screen a stable
// home.

import { logout } from "@/app/admin/actions";
import { currentUser, requireStaff } from "@/lib/dal";

export default async function AccountPage() {
  await requireStaff();
  const user = await currentUser();

  return (
    <div className="space-y-6">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
          Account
        </p>
        <h1 className="mt-1 font-display text-[22px] font-extrabold tracking-tightest">
          Your account
        </h1>
        <p className="mt-1 text-[14px] text-muted">
          The admin profile attached to this session. Edit surfaces land
          here as they&apos;re built.
        </p>
      </header>

      <section className="rounded-xl border border-line bg-surface p-5">
        <h2 className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
          Profile
        </h2>
        <dl className="mt-4 space-y-3 text-[14px]">
          <Row label="Email" value={user?.email ?? "—"} />
          <Row label="Role" value={user?.role ?? "—"} />
          <Row
            label="User id"
            value={user?.id ? user.id : "—"}
            mono
          />
          <Row
            label="Created"
            value={
              user?.created_at ? user.created_at.slice(0, 16) : "—"
            }
            mono
          />
        </dl>
      </section>

      <section className="rounded-xl border border-line bg-surface p-5">
        <h2 className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
          Password
        </h2>
        <p className="mt-2 text-[13px] text-muted">
          Rotate the seeded admin password via the environment
          (<code className="font-mono text-ink">ADMIN_SEED_EMAIL</code>{" "}
          + <code className="font-mono text-ink">ADMIN_SEED_PASSWORD</code>)
          and restart, or open an in-app password-change form once it
          ships.
        </p>
        <p className="mt-2 text-[12px] text-muted">
          In-app change is queued for follow-up — track it in{" "}
          <code className="font-mono text-ink">_plans/</code>.
        </p>
      </section>

      <section className="rounded-xl border border-line bg-surface p-5">
        <h2 className="font-display text-[15px] font-bold uppercase tracking-tight text-ink">
          Session
        </h2>
        <p className="mt-2 text-[13px] text-muted">
          Sign out to end this session on this browser.
        </p>
        <form action={logout} className="mt-3">
          <button
            type="submit"
            className="rounded-lg border border-line px-4 py-2 font-mono text-[12px] uppercase tracking-wider text-ink transition-colors hover:border-danger hover:text-danger"
          >
            Sign out
          </button>
        </form>
      </section>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/40 pb-2 last:border-0 last:pb-0">
      <dt className="font-mono text-[11px] uppercase tracking-wider text-muted">
        {label}
      </dt>
      <dd
        className={`${
          mono ? "font-mono text-[12px]" : "text-[14px]"
        } text-ink`}
      >
        {value}
      </dd>
    </div>
  );
}
