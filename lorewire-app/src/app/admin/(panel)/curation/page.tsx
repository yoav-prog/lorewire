// Homepage curation editor. Server-component shell — gates on
// requireAdmin, loads every rail + the published-story picker in a
// single round trip via loadCurationServerRenderAction, then hands
// off to the client editor.
//
// Plan: _plans/2026-06-16-homepage-curation.md (phase 3).

import { requireAdmin } from "@/lib/dal";
import { CurationClient } from "./CurationClient";
import { loadCurationServerRenderAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function CurationPage() {
  await requireAdmin();
  const initial = await loadCurationServerRenderAction();
  return <CurationClient initial={initial} />;
}
