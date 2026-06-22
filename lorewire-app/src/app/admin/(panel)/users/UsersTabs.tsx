// Tab nav across the Users area: Members (public sign-ups) and Team (staff).
// Server component — the active tab is passed by each page, so no client JS.
// Both tabs need only users.view; the Team page gates management actions
// separately on team.manage.

import Link from "next/link";

const TABS = [
  { key: "members", label: "Members", href: "/admin/users" },
  { key: "team", label: "Team", href: "/admin/users/team" },
] as const;

export default function UsersTabs({ active }: { active: "members" | "team" }) {
  return (
    <div className="flex gap-1 border-b border-line">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
            t.key === active
              ? "border-accent font-medium text-ink"
              : "border-transparent text-muted hover:text-ink"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
