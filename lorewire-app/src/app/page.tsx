// Homepage entry. Server-renders the curation + live catalog + poll
// rails so the first paint already shows the correct hero, Continue
// Watching, and rails — no 1-2 second window where the static sample
// catalog appears and reshuffles to the live data once the client fetch
// lands. The pre-fetched payload is passed to AppShell as `initial` and
// flows down to the two shells' useHomepageCuration / useHomepagePolls
// hook calls, which skip their useEffect fetches when seeded.
//
// When the request URL carries `?story=X` (a permalink shared from the
// Comments tab's "Link" button), the SSR fetch also pre-loads that
// story's Comments thread so the modal paints with comments already
// in place — no "Loading comments…" flash on the URL the recipient
// just clicked.
//
// Plan: _plans/2026-06-18-homepage-no-flash-ssr.md.

import type { Metadata } from "next";

import AppShell from "@/components/AppShell";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import { loadHomepageSSRData } from "@/lib/homepage-data";
import { getSiteSeo } from "@/lib/site-seo";

interface PageProps {
  searchParams: Promise<{ story?: string; tab?: string; c?: string }>;
}

// The homepage is the site's most-linked URL, so it carries the full
// metadata set: keyworded title, canonical, and the Open Graph / Twitter
// tags every share surface (X, iMessage, Slack, Discord) reads. Before
// 2026-07-05 it had none of these — bare "LoreWire" title, no canonical,
// no share preview.
export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSiteSeo();
  const image = seo.defaultOgImage || undefined;
  return {
    // homeTitle already carries the brand, so it bypasses the layout's
    // title.template via `absolute` — a string title would get the brand
    // appended a second time.
    title: { absolute: seo.homeTitle },
    description: seo.defaultMetaDescription,
    // Relative — absolutized by the root layout's metadataBase.
    alternates: { canonical: "/" },
    openGraph: {
      title: seo.homeTitle,
      description: seo.defaultMetaDescription,
      type: "website",
      url: "/",
      siteName: seo.siteName,
      images: image ? [image] : undefined,
    },
    twitter: {
      card: seo.twitterCardType,
      title: seo.homeTitle,
      description: seo.defaultMetaDescription,
      images: image ? [image] : undefined,
      site: seo.twitterHandle || undefined,
    },
  };
}

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;
  const seededModalStoryId = params.story?.trim() || undefined;
  const [initial, seo] = await Promise.all([
    loadHomepageSSRData({ seededModalStoryId }),
    getSiteSeo(),
  ]);
  return (
    <>
      {/* Single page h1, rendered server-side OUTSIDE the shells — both
          shells mount (CSS shows one), so an h1 inside each would emit
          two. sr-only keeps it out of the visual design; the billboard
          hero titles stay h2. */}
      <h1 className="sr-only">{seo.homeTitle}</h1>
      <ImpersonationBanner />
      <AppShell initial={initial} />
    </>
  );
}
