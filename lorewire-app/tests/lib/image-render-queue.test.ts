// Coverage for the image-regen queue + budget helpers. The queue itself is
// simple — insert a row, read it back — but the budget guard is load-bearing:
// it's the only thing stopping a stuck Regenerate button from draining the
// daily kie budget. Test the full happy path and the cap-exceeded path.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { run } from "@/lib/db";
import { setSetting } from "@/lib/repo";
import {
  canEnqueueImageRegen,
  enqueueImageRegen,
  estimateImageRegenCostCents,
  getDailyImageBudget,
  getImageRender,
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
