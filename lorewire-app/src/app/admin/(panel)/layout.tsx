import { requireAdmin } from "@/lib/dal";
import { logout } from "@/app/admin/actions";
import AdminSidebar from "@/app/admin/AdminSidebar";
import UserMenu from "@/app/admin/UserMenu";
import CommandPalette from "@/app/admin/CommandPalette";

// Studio shell. Sidebar + content column. The sidebar holds the brand and all
// navigation; the header is now a thin chrome line carrying just the user
// menu (and, on mobile, sitting alongside the hamburger fixed-positioned by
// the sidebar). See _plans/2026-06-11-admin-reorg.md for the full IA.

export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireAdmin();
  const isDev = process.env.NODE_ENV !== "production";

  console.info("[admin shell] render", {
    user_id: session.userId,
    node_env: process.env.NODE_ENV,
    dev_visible: isDev,
  });

  // Server-rendered slot for the sign-out form. Passed as ReactNode so the
  // server action (logout) is never pulled into the client bundle.
  const signOutSlot = (
    <form action={logout}>
      <button
        type="submit"
        className="block w-full rounded-md px-3 py-1.5 text-left font-mono text-[12px] text-ink transition-colors hover:bg-surface2"
      >
        Sign out
      </button>
    </form>
  );

  return (
    <div className="flex min-h-screen">
      <AdminSidebar isDev={isDev} />
      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center justify-end gap-3 border-b border-line bg-bg/85 px-5 py-3 backdrop-blur md:px-7">
          <UserMenu email={session.email} signOutSlot={signOutSlot} />
        </header>
        <main className="mx-auto w-full max-w-[1100px] px-5 py-7 md:px-7">
          {children}
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
