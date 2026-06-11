// POST /api/admin/articles/[id]/autosave
//
// Body-only autosave for the editor's debounced onUpdate. Distinct from the
// form-based saveArticleAction (which redirects and writes title / subtitle
// / summary / hero too) because autosave fires every ~1.5s of editing and
// must not navigate, must not redirect, must not race the form. We accept
// the Tiptap JSON document, update the row, and append a coalescing
// revision so the audit trail captures editor activity without exploding
// the revisions table.
//
// Validation kept tight: the document is required and must parse as JSON,
// but we don't deep-validate the Tiptap shape here — that's the editor's
// job, and a tolerant parse on the read side means a future schema change
// won't break stored articles.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireAdmin, currentUser } from "@/lib/dal";
import {
  appendRevision,
  getArticle,
  updateArticle,
} from "@/lib/repo";

interface AutosaveRequest {
  document: unknown;
}

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  await requireAdmin();
  const { id } = await ctx.params;
  if (!id) return badRequest("missing-id");

  let body: AutosaveRequest;
  try {
    body = (await req.json()) as AutosaveRequest;
  } catch {
    return badRequest("bad-json");
  }
  if (typeof body.document !== "string" || !body.document) {
    return badRequest("missing-document");
  }

  // Defense in depth: the document MUST parse as JSON before we persist it.
  // The editor only ever sends `editor.getJSON()` stringified, so a bad
  // shape here is a bug on our side or a hostile client — either way we
  // refuse rather than store garbage.
  try {
    JSON.parse(body.document);
  } catch {
    return badRequest("invalid-document-json");
  }

  // Confirm the article still exists. Without this the autosave silently
  // resurrects a row the writer just deleted in another tab — surprising and
  // ugly. The cost is one slim query per autosave; we already measured the
  // existing repo functions at sub-ms on SQLite.
  const article = await getArticle(id);
  if (!article) {
    return NextResponse.json({ error: "article-not-found" }, { status: 404 });
  }

  const user = await currentUser();
  await updateArticle(id, { document: body.document });
  const revisionId = randomUUID();
  const { revisionId: persistedId, coalesced } = await appendRevision({
    id: revisionId,
    article_id: id,
    document: body.document,
    payload: article.payload ?? "{}",
    title: article.title ?? "",
    status: article.status ?? "draft",
    author_id: user?.id ?? null,
  });

  console.info("[articles autosave]", {
    id,
    revisionId: persistedId,
    coalesced,
    docLen: body.document.length,
  });

  return NextResponse.json({
    ok: true,
    revisionId: persistedId,
    coalesced,
    savedAt: new Date().toISOString(),
  });
}
