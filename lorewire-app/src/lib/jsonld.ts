// Shared JSON-LD plumbing for the structured-data layer
// (_plans/2026-07-05-seo-structured-data.md). The per-surface builders
// (story-jsonld, site-jsonld, the FAQ page) compose blocks with `maybe`
// and embed them with `serializeJsonLd`; article-seo.ts predates this
// module and keeps its own equivalent.

// Drop missing fields instead of emitting nulls — search engines treat
// null-valued properties as worse than absent ones.
export function maybe<T>(
  obj: Record<string, T | undefined | null>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v as T;
  }
  return out;
}

// JSON for a <script type="application/ld+json"> body. `<` is escaped so
// content containing "</script>" can never break out of the tag — the
// < form stays valid JSON and parses identically.
export function serializeJsonLd(
  blocks: Record<string, unknown>[],
): string {
  const payload = blocks.length === 1 ? blocks[0] : blocks;
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}
