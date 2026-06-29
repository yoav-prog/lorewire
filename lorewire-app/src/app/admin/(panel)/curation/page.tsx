// Homepage curation editor. Server-component shell — gates on
// requireAdmin, loads every rail + the published-story picker in a
// single round trip via loadCurationServerRenderAction, then hands
// off to the client editor.
//
// Plan: _plans/2026-06-16-homepage-curation.md (phase 3).

import { requireCapability } from "@/lib/dal";
import { getSetting } from "@/lib/repo";
import { CurationClient } from "./CurationClient";
import { loadCurationServerRenderAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function CurationPage() {
  await requireCapability("content.manage");
  const [initial, emptyRailRaw, heroRequiredRaw] = await Promise.all([
    loadCurationServerRenderAction(),
    getSetting("curation.empty_rail_behavior"),
    getSetting("curation.hero_required"),
  ]);
  const behavior = {
    emptyRailBehavior:
      emptyRailRaw === "hide" ? ("hide" as const) : ("fallback" as const),
    heroRequired: heroRequiredRaw === "true",
  };
  return <CurationClient initial={initial} behavior={behavior} />;
}
