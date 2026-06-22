// Admin → Users → Members. Read-only list of the public sign-ups with
// server-side search + filter + pagination (state lives in the URL so every
// view is shareable and browser-back works). Click a row for the detail panel.
//
// Phase 2 of _plans/2026-06-22-admin-user-management.md. Suspend / delete /
// role actions land in later phases; this view is deliberately read-only.

import Link from "next/link";
import { requireCapability } from "@/lib/dal";
import {
  countMembers,
  listMemberProviders,
  listMembers,
  type MemberFilters,
  type MemberSort,
  type UserProvider,
  type UserRow,
  type UserStatus,
} from "@/lib/users";
import MembersFilterBar from "./MembersFilterBar";
import UsersTabs from "./UsersTabs";
import {
  PROVIDER_LABEL,
  avatarTone,
  fmtDate,
  memberInitials,
} from "./member-display";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

interface SearchParams {
  q?: string;
  provider?: string;
  status?: string;
  sort?: string;
  page?: string;
}

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireCapability("users.view");
  const sp = await searchParams;

  const providers = await listMemberProviders();
  const provider =
    sp.provider && providers.includes(sp.provider)
      ? (sp.provider as UserProvider)
      : undefined;
  const status: UserStatus | undefined =
    sp.status === "suspended"
      ? "suspended"
      : sp.status === "active"
        ? "active"
        : undefined;
  const sort: MemberSort = sp.sort === "joined" ? "joined" : "recent";
  const page = Math.max(1, Number(sp.page) || 1);
  const filters: MemberFilters = {
    search: sp.q?.trim() || undefined,
    provider,
    status,
  };

  const [rows, total] = await Promise.all([
    listMembers(filters, {
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      sort,
    }),
    countMembers(filters),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isFiltered = Boolean(filters.search || filters.provider || filters.status);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-[22px] font-extrabold tracking-tightest">
          Users
        </h1>
        <p className="mt-1 font-mono text-[11px] text-muted">
          {total.toLocaleString()} member{total === 1 ? "" : "s"}
          {isFiltered ? " match the current filters" : " signed up"}.
        </p>
      </div>

      <UsersTabs active="members" />

      <MembersFilterBar
        q={sp.q ?? ""}
        provider={sp.provider ?? ""}
        status={sp.status ?? ""}
        sort={sort}
        providers={providers}
      />

      {rows.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface px-4 py-10 text-center text-[13px] text-muted">
          {isFiltered
            ? "No members match these filters."
            : "No public users have signed up yet."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line bg-surface text-left font-mono text-[10px] uppercase tracking-wider text-muted">
                <th className="px-4 py-2.5 font-medium">Member</th>
                <th className="px-4 py-2.5 font-medium">Provider</th>
                <th className="px-4 py-2.5 font-medium">Joined</th>
                <th className="px-4 py-2.5 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <MemberRow key={u.id} u={u} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        total={total}
        searchParams={sp}
      />
    </div>
  );
}

function MemberRow({ u }: { u: UserRow }) {
  return (
    <tr className="border-b border-line transition-colors last:border-b-0 hover:bg-surface">
      <td className="px-4 py-2.5">
        <Link
          href={`/admin/users/${encodeURIComponent(u.id)}`}
          className="flex items-center gap-3"
        >
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold ${avatarTone(
              u.id,
            )}`}
          >
            {memberInitials(u.name, u.email)}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-ink hover:text-accent">
                {u.name?.trim() || "(no name)"}
              </span>
              {u.status === "suspended" && (
                <span className="shrink-0 rounded-full border border-danger/40 bg-danger/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-danger">
                  Suspended
                </span>
              )}
            </span>
            <span className="block truncate font-mono text-[11px] text-muted">
              {u.email}
            </span>
          </span>
        </Link>
      </td>
      <td className="px-4 py-2.5">
        <span className="rounded-full border border-line bg-surface2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
          {u.provider ? PROVIDER_LABEL[u.provider] ?? u.provider : "—"}
        </span>
      </td>
      <td className="px-4 py-2.5 font-mono text-[12px] text-muted">
        {fmtDate(u.created_at)}
      </td>
      <td className="px-4 py-2.5 font-mono text-[12px] text-muted">
        {fmtDate(u.last_seen_at)}
      </td>
    </tr>
  );
}

// Preserve every filter param across the Prev/Next links so paging never
// silently drops the active search/filter (the reddit-sources bug we already
// fixed once — same fix here).
function buildPageHref(sp: SearchParams, page: number): string {
  const qs = new URLSearchParams();
  if (sp.q) qs.set("q", sp.q);
  if (sp.provider) qs.set("provider", sp.provider);
  if (sp.status) qs.set("status", sp.status);
  if (sp.sort) qs.set("sort", sp.sort);
  qs.set("page", String(page));
  return `/admin/users?${qs.toString()}`;
}

function Pagination({
  page,
  totalPages,
  total,
  searchParams,
}: {
  page: number;
  totalPages: number;
  total: number;
  searchParams: SearchParams;
}) {
  if (totalPages <= 1) {
    return (
      <p className="text-center font-mono text-[11px] text-muted">
        {total.toLocaleString()} member{total === 1 ? "" : "s"} total
      </p>
    );
  }
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;
  return (
    <div className="flex items-center justify-center gap-3 font-mono text-[11px]">
      {prevDisabled ? (
        <span className="opacity-40">← Prev</span>
      ) : (
        <Link
          href={buildPageHref(searchParams, page - 1)}
          className="text-accent hover:underline"
        >
          ← Prev
        </Link>
      )}
      <span className="text-muted">
        page {page} of {totalPages} · {total.toLocaleString()} member
        {total === 1 ? "" : "s"}
      </span>
      {nextDisabled ? (
        <span className="opacity-40">Next →</span>
      ) : (
        <Link
          href={buildPageHref(searchParams, page + 1)}
          className="text-accent hover:underline"
        >
          Next →
        </Link>
      )}
    </div>
  );
}
