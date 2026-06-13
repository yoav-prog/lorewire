// Coverage for the image-regen queue + budget helpers. The queue itself is
// simple — insert a row, read it back — but the budget guard is load-bearing:
// it's the only thing stopping a stuck Regenerate button from draining the
// daily kie budget. Test the full happy path and the cap-exceeded path.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { run } from "@/lib/db";
import { setSetting } from "@/lib/repo";
import {
  ACTIVE_IMAGE_RENDER_STATUSES,
  canEnqueueImageRegen,
  cancelAllImageRendersForOwner,
  cancelImageRender,
  enqueueImageRegen,
  enqueueScenesBulk,
  estimateImageRegenCostCents,
  getDailyImageBudget,
  getImageRender,
  latestBulkScenes,
  latestRenderForAsset,
  recentRendersForOwner,
} from "@/lib/image-render-queue";

beforeAll(async () => {
  // Force a no-op read so the lazy schema migration runs the image_renders
  // CREATE TABLE before the first INSERT.
  await getDailyImageBudget();
});

beforeEach(async () => {
  await run("DELETE FROM image_renders", []);
  await run(
    "DELETE FROM settings WHERE key IN ('budget.daily_usd', 'media.scene_count', 'media.prop_count')",
    [],
  );
});

describe("estimateImageRegenCostCents", () => {
  it("returns a positive cost for any asset", async () => {
    const cents = await estimateImageRegenCostCents("hero");
    expect(cents).toBeGreaterThan(0);
  });

  it("hero costs two images (portrait 3:4 + landscape 16:9)", async () => {
    // The _regen_hero pipeline now generates both orientations so the
    // public reader + landscape video poster stay in sync. See the
    // caveat-fix round of _plans/2026-06-12-video-aspect-ratio.md.
    const oneImage = await estimateImageRegenCostCents("scene:0");
    const hero = await estimateImageRegenCostCents("hero");
    expect(hero).toBe(oneImage * 2);
  });

  it("doubles for mouth_swap (two images per regen)", async () => {
    const oneImage = await estimateImageRegenCostCents("scene:0");
    const mouthSwap = await estimateImageRegenCostCents("mouth_swap");
    expect(mouthSwap).toBe(oneImage * 2);
  });

  it("treats scene:N and prop:N as single-image regens", async () => {
    const scene = await estimateImageRegenCostCents("scene:5");
    const prop = await estimateImageRegenCostCents("prop:3");
    const oneImage = await estimateImageRegenCostCents("scene:0");
    expect(scene).toBe(oneImage);
    expect(prop).toBe(oneImage);
  });

  it("scales 'scenes' by media.scene_count setting (clamped)", async () => {
    await setSetting("media.scene_count", "20");
    const oneImage = await estimateImageRegenCostCents("scene:0");
    const scenes = await estimateImageRegenCostCents("scenes");
    expect(scenes).toBe(oneImage * 20);
  });

  it("'scenes' clamps a wildly large media.scene_count down to 60", async () => {
    await setSetting("media.scene_count", "9999");
    const oneImage = await estimateImageRegenCostCents("scene:0");
    const scenes = await estimateImageRegenCostCents("scenes");
    expect(scenes).toBe(oneImage * 60);
  });

  it("'props' uses media.prop_count when set, defaults to 5", async () => {
    const oneImage = await estimateImageRegenCostCents("scene:0");
    // Default (setting cleared in beforeEach).
    const propsDefault = await estimateImageRegenCostCents("props");
    expect(propsDefault).toBe(oneImage * 5);

    await setSetting("media.prop_count", "7");
    const propsSet = await estimateImageRegenCostCents("props");
    expect(propsSet).toBe(oneImage * 7);
  });
});

describe("enqueueImageRegen", () => {
  it("inserts a queued row that the queue can read back", async () => {
    const fresh = await enqueueImageRegen({
      ownerKind: "story",
      ownerId: randomUUID(),
      asset: "hero",
      promptHash: null,
      requestedBy: null,
    });
    expect(fresh.status).toBe("queued");
    expect(fresh.progress).toBe(0);
    expect(fresh.cost_cents).toBeNull();
    const refetched = await getImageRender(fresh.id);
    expect(refetched?.id).toBe(fresh.id);
  });

  it("records owner kind + id + asset slug verbatim", async () => {
    const ownerId = randomUUID();
    const fresh = await enqueueImageRegen({
      ownerKind: "article",
      ownerId,
      asset: "gallery:7",
      promptHash: "abc123",
      requestedBy: "user-1",
    });
    expect(fresh.owner_kind).toBe("article");
    expect(fresh.owner_id).toBe(ownerId);
    expect(fresh.asset).toBe("gallery:7");
    expect(fresh.prompt_hash).toBe("abc123");
    expect(fresh.requested_by).toBe("user-1");
  });

  it("does NOT dedupe — two requests for the same asset create two rows", async () => {
    const ownerId = randomUUID();
    const a = await enqueueImageRegen({
      ownerKind: "story",
      ownerId,
      asset: "hero",
      promptHash: null,
      requestedBy: null,
    });
    const b = await enqueueImageRegen({
      ownerKind: "story",
      ownerId,
      asset: "hero",
      promptHash: null,
      requestedBy: null,
    });
    expect(b.id).not.toBe(a.id);
  });
});

describe("recentRendersForOwner / latestRenderForAsset", () => {
  it("returns owner rows in requested_at-desc order", async () => {
    const ownerId = randomUUID();
    await enqueueImageRegen({
      ownerKind: "story",
      ownerId,
      asset: "hero",
      promptHash: null,
      requestedBy: null,
    });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await enqueueImageRegen({
      ownerKind: "story",
      ownerId,
      asset: "scene:0",
      promptHash: null,
      requestedBy: null,
    });
    const rows = await recentRendersForOwner("story", ownerId);
    expect(rows.length).toBe(2);
    expect(rows[0].id).toBe(newer.id);
  });

  it("latestRenderForAsset returns null when nothing has been queued", async () => {
    const row = await latestRenderForAsset(
      "story",
      randomUUID(),
      "hero",
    );
    expect(row).toBeNull();
  });
});

describe("getDailyImageBudget", () => {
  it("uses the default $5 cap when budget.daily_usd is unset", async () => {
    const b = await getDailyImageBudget();
    expect(b.capCents).toBe(500);
  });

  it("respects budget.daily_usd when set", async () => {
    await setSetting("budget.daily_usd", "12.50");
    const b = await getDailyImageBudget();
    expect(b.capCents).toBe(1250);
  });

  it("sums cost_cents of recent rows", async () => {
    const ownerId = randomUUID();
    await enqueueImageRegen({
      ownerKind: "story",
      ownerId,
      asset: "hero",
      promptHash: null,
      requestedBy: null,
    });
    // Simulate the worker writing a cost_cents back to the row.
    await run(
      "UPDATE image_renders SET cost_cents = ? WHERE owner_id = ?",
      [25, ownerId],
    );
    const b = await getDailyImageBudget();
    expect(b.spentCents).toBe(25);
    expect(b.remainingCents).toBe(b.capCents - 25);
    expect(b.exceeded).toBe(false);
  });
});

describe("cancelImageRender", () => {
  it("flips a queued row to cancelled and writes the reason as error", async () => {
    const fresh = await enqueueImageRegen({
      ownerKind: "story",
      ownerId: randomUUID(),
      asset: "hero",
      promptHash: null,
      requestedBy: null,
    });
    const updated = await cancelImageRender(fresh.id, "cancelled by admin");
    expect(updated?.status).toBe("cancelled");
    expect(updated?.error).toBe("cancelled by admin");
    expect(updated?.finished_at).not.toBeNull();
  });

  it("flips a generating row to cancelled", async () => {
    const fresh = await enqueueImageRegen({
      ownerKind: "story",
      ownerId: randomUUID(),
      asset: "hero",
      promptHash: null,
      requestedBy: null,
    });
    await run(
      "UPDATE image_renders SET status = 'generating', started_at = ? WHERE id = ?",
      [new Date().toISOString(), fresh.id],
    );
    const updated = await cancelImageRender(fresh.id, "stopped by admin");
    expect(updated?.status).toBe("cancelled");
  });

  it("is a no-op on done rows (status stays done)", async () => {
    const fresh = await enqueueImageRegen({
      ownerKind: "story",
      ownerId: randomUUID(),
      asset: "hero",
      promptHash: null,
      requestedBy: null,
    });
    await run(
      "UPDATE image_renders SET status = 'done', cost_cents = 25 WHERE id = ?",
      [fresh.id],
    );
    const updated = await cancelImageRender(fresh.id, "ignored");
    expect(updated?.status).toBe("done");
    expect(updated?.cost_cents).toBe(25);
  });

  it("ACTIVE_IMAGE_RENDER_STATUSES covers exactly queued and generating", () => {
    expect(ACTIVE_IMAGE_RENDER_STATUSES.has("queued")).toBe(true);
    expect(ACTIVE_IMAGE_RENDER_STATUSES.has("generating")).toBe(true);
    expect(ACTIVE_IMAGE_RENDER_STATUSES.has("done")).toBe(false);
    expect(ACTIVE_IMAGE_RENDER_STATUSES.has("error")).toBe(false);
    expect(ACTIVE_IMAGE_RENDER_STATUSES.has("cancelled")).toBe(false);
  });
});

describe("cancelAllImageRendersForOwner", () => {
  it("cancels every active row for the owner and reports the ids", async () => {
    const ownerId = randomUUID();
    const a = await enqueueImageRegen({
      ownerKind: "story",
      ownerId,
      asset: "hero",
      promptHash: null,
      requestedBy: null,
    });
    const b = await enqueueImageRegen({
      ownerKind: "story",
      ownerId,
      asset: "scene:0",
      promptHash: null,
      requestedBy: null,
    });
    await run(
      "UPDATE image_renders SET status = 'generating', started_at = ? WHERE id = ?",
      [new Date().toISOString(), b.id],
    );
    const { cancelled } = await cancelAllImageRendersForOwner(
      "story",
      ownerId,
      "test bulk",
    );
    expect(cancelled).toHaveLength(2);
    expect(new Set(cancelled)).toEqual(new Set([a.id, b.id]));
    const refetchedA = await getImageRender(a.id);
    const refetchedB = await getImageRender(b.id);
    expect(refetchedA?.status).toBe("cancelled");
    expect(refetchedB?.status).toBe("cancelled");
  });

  it("does not touch settled rows for the owner", async () => {
    const ownerId = randomUUID();
    const done = await enqueueImageRegen({
      ownerKind: "story",
      ownerId,
      asset: "hero",
      promptHash: null,
      requestedBy: null,
    });
    await run("UPDATE image_renders SET status = 'done' WHERE id = ?", [
      done.id,
    ]);
    const { cancelled } = await cancelAllImageRendersForOwner(
      "story",
      ownerId,
      "should be a noop",
    );
    expect(cancelled).toEqual([]);
    const refetched = await getImageRender(done.id);
    expect(refetched?.status).toBe("done");
  });

  it("ignores rows for other owners", async () => {
    const targetOwner = randomUUID();
    const otherOwner = randomUUID();
    const other = await enqueueImageRegen({
      ownerKind: "story",
      ownerId: otherOwner,
      asset: "hero",
      promptHash: null,
      requestedBy: null,
    });
    const { cancelled } = await cancelAllImageRendersForOwner(
      "story",
      targetOwner,
      "scoped",
    );
    expect(cancelled).toEqual([]);
    const refetchedOther = await getImageRender(other.id);
    expect(refetchedOther?.status).toBe("queued");
  });
});

describe("enqueueScenesBulk", () => {
  it("creates N scene:0..N-1 rows where N is media.scene_count", async () => {
    await setSetting("media.scene_count", "12");
    await setSetting("budget.daily_usd", "100");
    const ownerId = randomUUID();
    const r = await enqueueScenesBulk({
      ownerKind: "story",
      ownerId,
      requestedBy: null,
    });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(12);
    const rows = await recentRendersForOwner("story", ownerId, 50);
    expect(rows).toHaveLength(12);
    const slugs = new Set(rows.map((row) => row.asset));
    for (let i = 0; i < 12; i++) {
      expect(slugs.has(`scene:${i}`)).toBe(true);
    }
    for (const row of rows) {
      expect(row.status).toBe("queued");
      expect(row.owner_kind).toBe("story");
      expect(row.owner_id).toBe(ownerId);
    }
  });

  it("rejects with daily-budget-exceeded when the batch would exceed the cap", async () => {
    await setSetting("budget.daily_usd", "0.01");
    await setSetting("media.scene_count", "10");
    const r = await enqueueScenesBulk({
      ownerKind: "story",
      ownerId: randomUUID(),
      requestedBy: null,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("daily-budget-exceeded");
    expect(r.estimateCents).toBeGreaterThan(r.capCents!);
  });

  it("returns firstRenderId pointing at scene:0", async () => {
    await setSetting("media.scene_count", "6");
    await setSetting("budget.daily_usd", "100");
    const r = await enqueueScenesBulk({
      ownerKind: "story",
      ownerId: randomUUID(),
      requestedBy: null,
    });
    expect(r.firstRenderId).toBeTruthy();
    const first = await getImageRender(r.firstRenderId!);
    expect(first?.asset).toBe("scene:0");
  });
});

describe("latestBulkScenes", () => {
  it("returns total/done/active counts for the most recent batch", async () => {
    await setSetting("budget.daily_usd", "100");
    await setSetting("media.scene_count", "8");
    const ownerId = randomUUID();
    await enqueueScenesBulk({
      ownerKind: "story",
      ownerId,
      requestedBy: null,
    });
    // Mark a couple as done, one as in-flight.
    await run(
      "UPDATE image_renders SET status = 'done' WHERE owner_id = ? AND asset = 'scene:0'",
      [ownerId],
    );
    await run(
      "UPDATE image_renders SET status = 'done' WHERE owner_id = ? AND asset = 'scene:1'",
      [ownerId],
    );
    await run(
      "UPDATE image_renders SET status = 'generating' WHERE owner_id = ? AND asset = 'scene:2'",
      [ownerId],
    );
    const agg = await latestBulkScenes("story", ownerId);
    expect(agg.total).toBe(8);
    expect(agg.done).toBe(2);
    expect(agg.active).toBe(6);
    expect(agg.activeIds).toHaveLength(6);
  });

  it("returns an empty aggregate when no scenes have ever been queued", async () => {
    const agg = await latestBulkScenes("story", randomUUID());
    expect(agg.total).toBe(0);
    expect(agg.latest).toBeNull();
    expect(agg.activeIds).toEqual([]);
  });
});

describe("canEnqueueImageRegen", () => {
  it("allows when projected spend stays under the cap", async () => {
    await setSetting("budget.daily_usd", "10");
    const r = await canEnqueueImageRegen("hero");
    expect(r.ok).toBe(true);
    expect(r.estimateCents).toBeGreaterThan(0);
    expect(r.budget.capCents).toBe(1000);
  });

  it("blocks when projected spend would push over the cap", async () => {
    // Tiny cap so even a single image regen would exceed it.
    await setSetting("budget.daily_usd", "0.01");
    const r = await canEnqueueImageRegen("hero");
    expect(r.ok).toBe(false);
    expect(r.estimateCents).toBeGreaterThan(r.budget.capCents);
  });

  it("blocks when prior spend has consumed the cap", async () => {
    await setSetting("budget.daily_usd", "1.00");
    const ownerId = randomUUID();
    await enqueueImageRegen({
      ownerKind: "story",
      ownerId,
      asset: "hero",
      promptHash: null,
      requestedBy: null,
    });
    // Already spent the cap.
    await run(
      "UPDATE image_renders SET cost_cents = 100 WHERE owner_id = ?",
      [ownerId],
    );
    const r = await canEnqueueImageRegen("hero");
    expect(r.ok).toBe(false);
    expect(r.budget.exceeded).toBe(true);
  });
});
