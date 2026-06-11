"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// One unified Content tab replaces the previous Stories + Articles split.
// /admin/stories and /admin/articles still work as deep links so muscle
// memory and bookmarks are unbroken; they just aren't surfaced here. The
// active-state check below treats /admin/stories and /admin/articles as
// children of Content so the chip stays lit when you drill into an editor.
const LINKS = [
  { href: "/admin", label: "Overview" },
  {
    href: "/admin/content",
    label: "Content",
    activePrefixes: ["/admin/content", "/admin/stories", "/admin/articles"],
  },
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
        const prefixes = l.activePrefixes ?? [l.href];
        const active =
          l.href === "/admin"
            ? pathname === "/admin"
            : prefixes.some((p) => pathname.startsWith(p));
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
