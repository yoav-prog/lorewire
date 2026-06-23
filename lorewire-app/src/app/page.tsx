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

import AppShell from "@/components/AppShell";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import { loadHomepageSSRData } from "@/lib/homepage-data";

interface PageProps {
  searchParams: Promise<{ story?: string; tab?: string; c?: string }>;
}

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;
  const seededModalStoryId = params.story?.trim() || undefined;
  const initial = await loadHomepageSSRData({ seededModalStoryId });
  return (
    <>
      <ImpersonationBanner />
      <AppShell initial={initial} />
    </>
  );
}
