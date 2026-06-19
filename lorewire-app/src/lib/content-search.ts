// Pure predicate behind the /admin/content search bar. Lives in @/lib so the
// behavior can be unit-tested without spinning up React, and so the row list
// in ContentList stays a thin client island that just maps state to UI.
//
// Design:
//   - Multi-term AND matching: every whitespace-separated token in the query
//     must appear somewhere in the row's haystack. "steak entitled" matches
//     a Drama row only if both words land — the operator's mental model is
//     "narrow as I type."
//   - Case-insensitive; the haystack is lowercased once per row.
//   - RTL-safe: lowercasing is a no-op for Hebrew letters, and substring
//     matching does not depend on direction. A query of Hebrew text works
//     the same way as a query of Latin text.
//   - Empty / whitespace-only queries short-circuit to "match" so the caller
//     can pass query unconditionally.
//   - The haystack covers the fields the row actually surfaces: title,
//     slug, badge (category for stories / type for articles), status, and
//     a leading prefix of the id. The id prefix matters because the list
//     shows `id.slice(0, 8)` as a fallback label for rows with no title.

export interface ContentSearchHaystack {
  title: string | null;
  slug: string | null;
  badge: string | null;
  status: string | null;
  language: string | null;
  id: string;
}

export function buildContentSearchHaystack(
  row: ContentSearchHaystack,
): string {
  const parts: string[] = [];
  if (row.title) parts.push(row.title);
  if (row.slug) parts.push(row.slug);
  if (row.badge) parts.push(row.badge);
  if (row.status) parts.push(row.status);
  if (row.language) parts.push(row.language);
  // First 8 chars mirror the fallback label in ContentList so a user
  // searching by the visible id prefix gets a hit.
  parts.push(row.id.slice(0, 8));
  return parts.join(" ").toLowerCase();
}

export function matchesContentSearch(
  row: ContentSearchHaystack,
  query: string,
): boolean {
  const q = query.trim();
  if (!q) return true;
  const haystack = buildContentSearchHaystack(row);
  // Split on any whitespace run; an all-whitespace q is already gone above.
  const terms = q.toLowerCase().split(/\s+/);
  for (const t of terms) {
    if (!haystack.includes(t)) return false;
  }
  return true;
}
