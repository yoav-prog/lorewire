// Tests for the unified runs layer (lib/runs.ts) and the bulk STOP RUNS
// action. Same harness as the other admin action tests: the admin guard
// and Next caching APIs are mocked; everything else exercises the real
// tables in the per-process SQLite test DB (tests/setup.ts).
//
// Plan: _plans/2026-07-03-unified-live-runs-and-stop.md.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { all, one, run } from "@/lib/db";

vi.mock("@/lib/dal", () => {
  const session = {
    userId: "test-user",
    email: "test@lorewire.local",
    role: "admin",
  };
  return {
    requireAdmin: vi.fn().mockResolvedValue(session),
    requireCapability: vi.fn().mockResolvedValue(session),
    requireStaff: vi.fn().mockResolvedValue(session),
    ensureSeedAdmin: vi.fn().mockResolvedValue(null),
    currentUser: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

// Import AFTER vi.mock so the modules pick up the mocked deps.
import { listUnifiedRuns, stopUnifiedRun } from "@/lib/runs";
import { bulkStopRunsAction } from "@/app/admin/actions";

const NOW = () => new Date().toISOString();
const OLD = "2026-07-01T00:00:00.000Z";

async function seedStory(title: string): Promise<string> {
  const id = randomUUID();
  await run(
    "INSERT INTO stories (id, slug, title, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, 'published', ?, ?)",
    [id, `s-${id.slice(0, 6)}`, title, NOW(), NOW()],
  );
  return id;
}

async function seedImageRender(
  ownerId: string,
  status: string,
  opts: { ownerKind?: string; finishedAt?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await run(
    "INSERT INTO image_renders (id, owner_kind, owner_id, asset, status, requested_at, finished_at) " +
      "VALUES (?, ?, ?, 'hero', ?, ?, ?)",
    [id, opts.ownerKind ?? "story", ownerId, status, NOW(), opts.finishedAt ?? null],
  );
  return id;
}

async function seedVoiceRender(storyId: string, status: string): Promise<string> {
  const id = randomUUID();
  await run(
    "INSERT INTO voice_renders (id, story_id, text_hash, status, requested_at) " +
      "VALUES (?, ?, ?, ?, ?)",
    [id, storyId, `hash-${id.slice(0, 8)}`, status, NOW()],
  );
  return id;
}

async function seedShortRender(storyId: string, status: string): Promise<string> {
  const id = randomUUID();
  await run(
    "INSERT INTO short_renders (id, story_id, status, requested_at) " +
      "VALUES (?, ?, ?, ?)",
    [id, storyId, status, NOW()],
  );
  return id;
}

async function seedFinisherJob(
  storyId: string,
  finisherStatus: string,
): Promise<string> {
  const id = randomUUID();
  await run(
    "INSERT INTO story_jobs (id, reddit_id, status, story_id, finisher_status, requested_at) " +
      "VALUES (?, ?, 'done', ?, ?, ?)",
    [id, `1${id.slice(0, 6).replace(/-/g, "0")}`, storyId, finisherStatus, NOW()],
  );
  return id;
}

describe("unified runs", () => {
  beforeEach(async () => {
    for (const table of [
      "image_renders",
      "voice_renders",
      "short_renders",
      "story_jobs",
      "stories",
    ]) {
      await run(`DELETE FROM ${table} WHERE 1=1`, []);
    }
  });

  it("lists every kind with normalized statuses and story titles", async () => {
    const sid = await seedStory("Unified fixture");
    await seedImageRender(sid, "queued");
    await seedVoiceRender(sid, "processing");
    await seedShortRender(sid, "rendering");
    await seedFinisherJob(sid, "pending");
    await run(
      "UPDATE stories SET refresh_assets_state = 'short_pending', " +
        "refresh_assets_started_at = ? WHERE id = ?",
      [NOW(), sid],
    );

    const runs = await listUnifiedRuns();
    const byKind = new Map(runs.map((r) => [r.kind, r]));
    expect(byKind.get("image")?.status).toBe("queued");
    expect(byKind.get("voice")?.status).toBe("running");
    expect(byKind.get("short")?.status).toBe("running");
    expect(byKind.get("finisher")?.status).toBe("queued");
    expect(byKind.get("refresh")?.status).toBe("running");
    // Every row is searchable by the story's title.
    for (const r of runs) expect(r.storyTitle).toBe("Unified fixture");
  });

  it("keeps recently settled rows and drops ones outside the window", async () => {
    const sid = await seedStory("Window fixture");
    const recent = await seedImageRender(sid, "done", { finishedAt: NOW() });
    const old = await seedImageRender(sid, "done", { finishedAt: OLD });
    const runs = await listUnifiedRuns(15);
    const ids = runs.map((r) => r.id);
    expect(ids).toContain(recent);
    expect(ids).not.toContain(old);
  });

  it("stopUnifiedRun cancels a queued row once and reports settled after", async () => {
    const sid = await seedStory("Single stop");
    const vid = await seedVoiceRender(sid, "queued");
    expect(await stopUnifiedRun("voice", vid, "test stop")).toBe(true);
    const row = await one<{ status: string; error: string | null }>(
      "SELECT status, error FROM voice_renders WHERE id = ?",
      [vid],
    );
    expect(row?.status).toBe("cancelled");
    expect(row?.error).toBe("test stop");
    // Already settled — nothing to change.
    expect(await stopUnifiedRun("voice", vid, "test stop")).toBe(false);
  });

  it("bulk stop cancels in-flight work, unarms finishers, clears refresh, and leaves settled rows alone", async () => {
    const sid = await seedStory("Bulk stop");
    const otherSid = await seedStory("Untouched neighbor");
    const img = await seedImageRender(sid, "queued");
    const doneImg = await seedImageRender(sid, "done", { finishedAt: NOW() });
    const voice = await seedVoiceRender(sid, "queued");
    const short = await seedShortRender(sid, "rendering");
    const job = await seedFinisherJob(sid, "pending");
    const neighborImg = await seedImageRender(otherSid, "queued");
    await run(
      "UPDATE stories SET refresh_assets_state = 'hero_pending' WHERE id = ?",
      [sid],
    );

    const result = await bulkStopRunsAction([{ kind: "story", id: sid }]);
    expect(result.counts.images).toBe(1);
    expect(result.counts.voices).toBe(1);
    expect(result.counts.shorts).toBe(1);
    expect(result.counts.finishers).toBe(1);
    expect(result.counts.refreshes).toBe(1);

    const status = async (table: string, id: string) =>
      (
        await one<{ status: string }>(
          `SELECT status FROM ${table} WHERE id = ?`,
          [id],
        )
      )?.status;
    expect(await status("image_renders", img)).toBe("cancelled");
    expect(await status("image_renders", doneImg)).toBe("done");
    expect(await status("voice_renders", voice)).toBe("cancelled");
    expect(await status("short_renders", short)).toBe("cancelled");
    // Selected story's finisher unarmed; the neighbor's queue untouched.
    const fin = await one<{ finisher_status: string | null }>(
      "SELECT finisher_status FROM story_jobs WHERE id = ?",
      [job],
    );
    expect(fin?.finisher_status).toBeNull();
    expect(await status("image_renders", neighborImg)).toBe("queued");
    const refreshed = await one<{ refresh_assets_state: string | null }>(
      "SELECT refresh_assets_state FROM stories WHERE id = ?",
      [sid],
    );
    expect(refreshed?.refresh_assets_state).toBeNull();
  });

  it("bulk stop on an article cancels its image renders only", async () => {
    const articleId = randomUUID();
    const img = await seedImageRender(articleId, "queued", {
      ownerKind: "article",
    });
    const result = await bulkStopRunsAction([
      { kind: "article", id: articleId },
    ]);
    expect(result.counts.images).toBe(1);
    const row = await all<{ status: string }>(
      "SELECT status FROM image_renders WHERE id = ?",
      [img],
    );
    expect(row[0]?.status).toBe("cancelled");
  });
});
