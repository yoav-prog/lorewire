// Tests for the revision repo additions: nameRevision, unnameRevision,
// and pruneRevisions. The autosave / coalescing path is already covered in
// tests/repo/articles.test.ts.

import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  appendRevision,
  createArticle,
  listRevisions,
  nameRevision,
  pruneRevisions,
  unnameRevision,
} from "@/lib/repo";

async function fixture(): Promise<string> {
  const id = randomUUID();
  await createArticle({
    id,
    type: "feature",
    language: "en",
    slug: `rev-${id.slice(0, 6)}`,
    title: "Rev test",
    author_id: null,
  });
  return id;
}

async function append(articleId: string, label: string): Promise<string> {
  const id = randomUUID();
  await appendRevision({
    id,
    article_id: articleId,
    document: JSON.stringify({ type: "doc", content: [] }),
    payload: "{}",
    title: label,
    status: "draft",
    author_id: null,
    coalesceWindowSec: 0,
  });
  return id;
}

beforeAll(async () => {
  await listRevisions("warmup");
});

describe("nameRevision / unnameRevision", () => {
  it("flips is_named on and records the label", async () => {
    const articleId = await fixture();
    const revId = await append(articleId, "v1");
    await nameRevision(revId, "Before launch");
    const list = await listRevisions(articleId);
    const named = list.find((r) => r.id === revId);
    expect(named?.is_named).toBe(1);
    expect(named?.name).toBe("Before launch");
  });

  it("caps the label at 120 chars", async () => {
    const articleId = await fixture();
    const revId = await append(articleId, "v1");
    await nameRevision(revId, "x".repeat(200));
    const list = await listRevisions(articleId);
    const named = list.find((r) => r.id === revId);
    expect((named?.name ?? "").length).toBeLessThanOrEqual(120);
  });

  it("unname clears the label and flips is_named off", async () => {
    const articleId = await fixture();
    const revId = await append(articleId, "v1");
    await nameRevision(revId, "Named");
    await unnameRevision(revId);
    const list = await listRevisions(articleId);
    const after = list.find((r) => r.id === revId);
    expect(after?.is_named).toBe(0);
    expect(after?.name).toBeNull();
  });
});

describe("pruneRevisions", () => {
  it("returns 0 and does nothing when under the cap", async () => {
    const articleId = await fixture();
    await append(articleId, "v1");
    await append(articleId, "v2");
    const removed = await pruneRevisions(articleId, 50);
    expect(removed).toBe(0);
    const list = await listRevisions(articleId);
    expect(list.length).toBe(2);
  });

  it("drops oldest unnamed revisions, keeps the newest `keep` unnamed", async () => {
    const articleId = await fixture();
    // Append 5 unnamed revisions; keep=2 means we should drop the 3 oldest.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await append(articleId, `v${i}`));
    }
    const removed = await pruneRevisions(articleId, 2);
    expect(removed).toBe(3);
    const after = await listRevisions(articleId);
    // listRevisions orders newest-first; the surviving rows are the two
    // most-recently created.
    expect(after.length).toBe(2);
    expect(after[0].id).toBe(ids[4]);
    expect(after[1].id).toBe(ids[3]);
  });

  it("never drops a named revision even when it's old", async () => {
    const articleId = await fixture();
    const oldNamedId = await append(articleId, "old-named");
    await nameRevision(oldNamedId, "Pinned");
    for (let i = 0; i < 5; i++) {
      await append(articleId, `v${i}`);
    }
    await pruneRevisions(articleId, 2);
    const after = await listRevisions(articleId);
    expect(after.some((r) => r.id === oldNamedId)).toBe(true);
  });
});
