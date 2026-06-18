// Homepage entry. Server-renders the curation + live catalog + poll
// rails so the first paint already shows the correct hero, Continue
// Watching, and rails — no 1-2 second window where the static sample
// catalog appears and reshuffles to the live data once the client fetch
// lands. The pre-fetched payload is passed to AppShell as `initial` and
// flows down to the two shells' useHomepageCuration / useHomepagePolls
// hook calls, which skip their useEffect fetches when seeded.
//
// Plan: _plans/2026-06-18-homepage-no-flash-ssr.md.

import AppShell from "@/components/AppShell";
import { loadHomepageSSRData } from "@/lib/homepage-data";

export default async function Page() {
  const initial = await loadHomepageSSRData();
  return <AppShell initial={initial} />;
}
