import { requireAdmin } from "@/lib/dal";
import { logout } from "@/app/admin/actions";
import AdminNav from "@/app/admin/AdminNav";

export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireAdmin();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-line bg-bg/85 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-6">
          <span className="font-display text-[18px] font-extrabold tracking-tightest">
            LORE<span className="text-accent">WIRE</span>
            <span className="ml-2 align-middle font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
              Studio
            </span>
          </span>
          <AdminNav />
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden font-mono text-[11px] text-muted sm:inline">
            {session.email}
          </span>
          <form action={logout}>
            <button className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:text-ink">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-[1100px] px-5 py-7">{children}</main>
    </div>
  );
}
