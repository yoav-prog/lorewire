"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/stories", label: "Stories" },
  { href: "/admin/models", label: "Models" },
  { href: "/admin/templates", label: "Templates" },
  { href: "/admin/segments", label: "Intros & outros" },
  { href: "/admin/settings", label: "Settings" },
];

export default function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1 font-mono text-[12px] uppercase tracking-wider">
      {LINKS.map((l) => {
        const active =
          l.href === "/admin"
            ? pathname === "/admin"
            : pathname.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              active
                ? "bg-surface2 text-ink"
                : "text-muted hover:text-ink hover:bg-surface"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
