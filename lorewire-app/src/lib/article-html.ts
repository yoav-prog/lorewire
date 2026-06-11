// Server-side renderer for Tiptap article documents. Pure function from
// Tiptap JSON to an HTML string — used by the public reader page and the
// RSS feed. Wired with the same node specs the editor uses (StarterKit
// plus our React-free Callout and ArticleImage) so the markup the reader
// sees is byte-for-byte what the editor's renderHTML would emit.
//
// Why this lives in lib (not in the editor file): so a future sibling site
// in the monorepo can import it directly without pulling React or any
// admin code. The seam is intentional — keeping article-html.ts dependency-
// free of React is the move that makes Phase 4b extraction cheap.

import { generateHTML } from "@tiptap/html";
import StarterKit from "@tiptap/starter-kit";
import { Callout } from "@/lib/tiptap-callout";
import { ArticleImage } from "@/lib/tiptap-article-image";

// Extensions array. Pin the same set the editor registers so the renderer
// understands every block the writer can author. Adding a new editor block
// means appending it here too — same node spec, both surfaces.
const EXTENSIONS = [StarterKit, Callout, ArticleImage];

// Empty doc shape used when the stored document is missing or unparseable.
// Returning empty HTML in that case beats throwing — a corrupt revision
// shouldn't take down the public page. Built fresh each call rather than
// `as const` so the mutable JSONContent shape that generateHTML expects
// stays satisfied under strict TS.
function emptyDoc(): { type: "doc"; content: { type: "paragraph" }[] } {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

export function renderArticleHtml(raw: string | null | undefined): string {
  if (!raw) return generateHTML(emptyDoc(), EXTENSIONS);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return generateHTML(emptyDoc(), EXTENSIONS);
  }
  if (!json || typeof json !== "object") {
    return generateHTML(emptyDoc(), EXTENSIONS);
  }
  try {
    // generateHTML's signature is permissive on the JSON shape; if a stored
    // document carries an unknown node type the renderer either drops it or
    // throws, depending on the extension. Catch ensures the public page
    // never 500s on a corrupt body — we surface an empty body instead.
    return generateHTML(
      json as Parameters<typeof generateHTML>[0],
      EXTENSIONS,
    );
  } catch (e) {
    console.error("[articles reader] render FAILED:", e);
    return generateHTML(emptyDoc(), EXTENSIONS);
  }
}
