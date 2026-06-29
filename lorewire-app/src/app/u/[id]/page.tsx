// Public contributor profile at /u/[id]. A limited, public-safe view of a
// signed-in user: avatar, name, rank + badge, contribution counts, member-since.
// 404s when the user is missing, suspended, or has hidden their profile (the
// getPublicProfile gate). Linked from the "Submitted by" byline on user-submitted
// stories. The URL is the opaque user id — users have no public handle.
//
// Plan: _plans/2026-06-29-contributor-profiles-gamification.md.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { ContributorCard } from "@/components/ContributorCard";
import { getPublicProfile } from "@/lib/contributions";
import { buildPageTitle, getSiteSeo } from "@/lib/site-seo";
import { readUserSession } from "@/lib/user-session";

interface Params {
  id: string;
}

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { id } = await params;
  const profile = await getPublicProfile(id);
  if (!profile) return { title: "Profile", robots: { index: false } };
  const seo = await getSiteSeo();
  return {
    title: buildPageTitle(
      `${profile.name} · ${profile.stats.rank.name}`,
      seo.titleTemplate,
      seo.siteName,
    ),
    // A thin, personal page — keep it out of search results.
    robots: { index: false },
  };
}

export default async function ContributorProfilePage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { id } = await params;
  const profile = await getPublicProfile(id);
  if (!profile) notFound();

  const session = await readUserSession();
  const isSelf = session?.userId === profile.userId;

  return (
    <main className="mx-auto max-w-md px-6 py-10">
      <Link
        href="/"
        className="inline-flex items-center gap-1 font-mono text-[12px] uppercase tracking-[.2em] text-muted hover:text-ink"
      >
        ← LoreWire
      </Link>

      <div className="mt-5">
        <ContributorCard
          name={profile.name}
          pictureUrl={profile.pictureUrl}
          memberSince={profile.memberSince}
          stats={profile.stats}
        />
      </div>

      {isSelf && (
        <p className="mt-3 text-center text-[12px] text-muted">
          This is your public profile.{" "}
          <Link
            href="/auth/account"
            className="text-ink underline decoration-line hover:decoration-accent"
          >
            Manage visibility
          </Link>
        </p>
      )}
    </main>
  );
}
