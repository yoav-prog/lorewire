"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// Studio sidebar. Three primary destinations: Overview, Content, Settings.
// Plus an optional Dev zone surfaced only when NODE_ENV !== 'production'
// so the throwaway player spike stays reachable locally without leaking
// into prod.
//
// Content is the canonical landing page for everything the studio produces
// — articles AND videos (stories) in one list with kind chips. Earlier the
// sidebar also surfaced Articles and Videos as separate entries; those
// turned out to be duplicate paths to the same data, so we collapsed them
// into Content. /admin/articles and /admin/videos still respond as deep
// links — they light up Content in the sidebar.
//
// Models, Captions, Intros & outros all collapse into Settings — the page at
// /admin/settings is a hub with internal category sub-nav. The old standalone
// /admin/models, /admin/templates, /admin/segments URLs keep responding.

export type SidebarItem = {
  href: string;
  label: string;
  /** Path prefixes that should highlight this item. Defaults to [href without query]. */
  activePrefixes?: string[];
  /** When true, the item is active only when pathname exactly equals href (no query). */
  exact?: boolean;
};

export type SidebarGroup = {
  /** Header label above the group; null = ungrouped (no header). */
  label: string | null;
  items: SidebarItem[];
};

const STATIC_GROUPS: SidebarGroup[] = [
  {
    label: null,
    items: [
      { href: "/admin", label: "Overview", exact: true },
      {
        href: "/admin/content",
        label: "Content",
        // Canonical mixed feed. Active for the unified URL plus the legacy
        // per-kind URLs that still deep-link in (/admin/articles*,
        // /admin/videos*, /admin/stories*) — those pages remain alive so
        // bookmarks and external links don't break, but they're all just
        // different lenses on the same Content list.
        activePrefixes: [
          "/admin/content",
          "/admin/articles",
          "/admin/videos",
          "/admin/stories",
        ],
      },
      {
        // Reddit candidate pool — the import / review / publish upstream
        // for stories. See _plans/2026-06-14-reddit-db-sync.md.
        href: "/admin/reddit-sources",
        label: "Reddit Sources",
        activePrefixes: ["/admin/reddit-sources"],
      },
      {
        // Public-site curation — Billboard, rails, category pages.
        // See _plans/2026-06-15-curation-system.md.
        href: "/admin/curation",
        label: "Curation",
        activePrefixes: ["/admin/curation"],
      },
      {
        href: "/admin/settings",
        label: "Settings",
        // All four config URLs land on the Settings hub with the right
        // sub-nav category active. /admin/templates renders standalone
        // (per Phase 3 plan) but the sidebar still highlights Settings
        // when we land there from a deep link.
        activePrefixes: [
          "/admin/settings",
          "/admin/models",
          "/admin/templates",
          "/admin/segments",
        ],
      },
    ],
  },
];

const DEV_GROUP: SidebarGroup = {
  label: "Dev",
  items: [
    {
      href: "/admin/videos-spike",
      label: "Player spike",
      activePrefixes: ["/admin/videos-spike/"],
    },
  ],
};

// Exported so unit tests can verify the active-state contract without
// rendering React.
export function isItemActive(pathname: string, item: SidebarItem): boolean {
  const hrefPath = item.href.split("?")[0];
  if (item.exact) return pathname === hrefPath;
  const prefixes = item.activePrefixes ?? [hrefPath];
  return prefixes.some((p) => pathname.startsWith(p));
}

export function buildGroups(isDev: boolean): SidebarGroup[] {
  return isDev ? [...STATIC_GROUPS, DEV_GROUP] : STATIC_GROUPS;
}

export default function AdminSidebar({ isDev }: { isDev: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const groups = buildGroups(isDev);

  useEffect(() => {
    console.info("[admin sidebar] route", {
      path: pathname,
      groups: groups.length,
      dev_visible: isDev,
    });
  }, [pathname, groups.length, isDev]);

  // Drawer closes via the Link's onClick (below) so we never call setState
  // from inside an effect — the close happens during the click handler, the
  // route change naturally follows.

  return (
    <>
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="fixed left-3 top-3 z-30 inline-flex h-9 w-9 items-center justify-center rounded-md border border-line bg-bg text-ink shadow-sm md:hidden"
      >
        <span aria-hidden="true" className="text-[18px] leading-none">
          {open ? "×" : "☰"}
        </span>
      </button>

      {open && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-20 w-[220px] border-r border-line bg-surface transition-transform md:sticky md:top-0 md:h-screen md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="border-b border-line px-5 py-4">
            <Link
              href="/admin"
              className="block"
              onClick={() => setOpen(false)}
            >
              <span className="font-display text-[16px] font-extrabold tracking-tightest text-ink">
                LORE<span className="text-accent">WIRE</span>
              </span>
              <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
                Studio
              </span>
            </Link>
          </div>

          <nav className="flex-1 overflow-y-auto px-3 py-4">
            {groups.map((g, gi) => (
              <div key={g.label ?? `group-${gi}`} className={gi > 0 ? "mt-5" : ""}>
                {g.label && (
                  <div className="px-2 pb-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
                    {g.label}
                  </div>
                )}
                <ul className="space-y-0.5">
                  {g.items.map((it) => {
                    const active = isItemActive(pathname, it);
                    return (
                      <li key={`${g.label ?? "_"}-${it.href}`}>
                        <Link
                          href={it.href}
                          onClick={() => setOpen(false)}
                          className={`block rounded-md px-2.5 py-1.5 font-mono text-[12px] uppercase tracking-wider transition-colors ${
                            active
                              ? "bg-surface2 text-ink"
                              : "text-muted hover:bg-surface2 hover:text-ink"
                          }`}
                        >
                          {it.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </div>
      </aside>
    </>
  );
}
