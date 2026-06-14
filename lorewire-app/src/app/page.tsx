// Phase 4 of _plans/2026-06-15-curation-system.md. Home page is now a
// server component: it resolves every curation slot on the server (one
// SELECT via listAllSlots) and hands the resulting story-id lists to
// AppShell as initial props. AppShell stays "use client" — the shell's
// state (active modal, pill, scroll) belongs on the client.
//
// Empty slots fall back to the hardcoded arrays in lib/stories.ts so the
// page never goes blank if the admin hasn't curated yet. The hardcoded
// arrays remain canonical fallbacks; admin picks override them per-slot.
//
// Revalidate every 60s — same cadence as /c/[category] — so a freshly
// pinned story shows up without a manual purge. Admin actions
// (setCurationSlotAction) call revalidatePath("/") so a click on Save
// invalidates the cache immediately.

import AppShell from "@/components/AppShell";
import { getHomePagePicks } from "@/lib/curation";

export const revalidate = 60;

export default async function Page() {
  const initialHomePicks = await getHomePagePicks();
  return <AppShell initialHomePicks={initialHomePicks} />;
}
