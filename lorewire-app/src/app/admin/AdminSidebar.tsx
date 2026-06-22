"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { Capability } from "@/lib/authz";

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
  /** When set, the item is shown only to staff whose role grants this
   *  capability. Unset = visible to every staff role. Server-side gates still
   *  enforce access; this only hides what the user can't use. */
  capability?: Capability;
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
        capability: "content.manage",
      },
      {
        // Reddit candidate pool — the import / review / publish upstream
        // for stories. See _plans/2026-06-14-reddit-db-sync.md.
        href: "/admin/reddit-sources",
        label: "Reddit Sources",
        activePrefixes: ["/admin/reddit-sources"],
        capability: "content.manage",
      },
      {
        // Homepage curation: which stories appear on each rail. Live
        // edits land on the next homepage load. Plan:
        // _plans/2026-06-16-homepage-curation.md.
        href: "/admin/curation",
        label: "Homepage",
        activePrefixes: ["/admin/curation"],
        capability: "content.manage",
      },
      {
        // Engagement polls overview. Author lives on the story edit
        // page; this is the cross-cutting "every poll + how it's
        // voting" view. Plan: _plans/2026-06-17-engagement-polls.md.
        href: "/admin/polls",
        label: "Polls",
        activePrefixes: ["/admin/polls"],
        capability: "content.manage",
      },
      {
        // User management: members (public sign-ups), staff/roles, audit log.
        // Capability-gated so non-admin staff only see it if their role grants
        // users.view. Plan: _plans/2026-06-22-admin-user-management.md.
        href: "/admin/users",
        label: "Users",
        activePrefixes: ["/admin/users"],
        capability: "users.view",
      },
      {
        // Comment moderation queue — the human side of the hybrid
        // moderator. Gated under content.manage (comments are content); the
        // page + its server actions enforce the same capability. Plan:
        // _plans/2026-06-22-article-comments-ai-moderation.md.
        href: "/admin/comments",
        label: "Comments",
        activePrefixes: ["/admin/comments"],
        capability: "content.manage",
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
          "/admin/voiceovers",
          "/admin/templates",
          "/admin/segments",
        ],
        capability: "settings.manage",
      },
      {
        // One-time media migration tool: copy all media from the legacy GCS
        // bucket to R2. Plan:
        // _plans/2026-06-22-r2-media-migration-and-avatar-upload.md.
        href: "/admin/migrate",
        label: "Migrate",
        activePrefixes: ["/admin/migrate"],
        capability: "settings.manage",
      },
      {
        // One-time media compression tool: re-encode the existing images the
        // DB references to WebP (what fixes slow media after the R2 cutover).
        // Sibling of Migrate. Plan: _plans/2026-06-22-media-compression.md.
        href: "/admin/compress",
        label: "Compress",
        activePrefixes: ["/admin/compress"],
        capability: "settings.manage",
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

// Build the visible nav. `caps` filters out items whose `capability` the
// current staff role doesn't grant; passing `undefined` (the default) shows
// every item, which keeps the pure-function tests and any capability-agnostic
// caller working unchanged. A group that loses all its items is dropped.
export function buildGroups(
  isDev: boolean,
  caps?: readonly Capability[],
): SidebarGroup[] {
  const base = isDev ? [...STATIC_GROUPS, DEV_GROUP] : STATIC_GROUPS;
  if (!caps) return base;
  return base
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (it) => !it.capability || caps.includes(it.capability),
      ),
    }))
    .filter((g) => g.items.length > 0);
}

export default function AdminSidebar({
  isDev,
  caps,
}: {
  isDev: boolean;
  caps?: readonly Capability[];
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const groups = buildGroups(isDev, caps);

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
