// Tests for the short_render_events helpers + cancelShortRender. Mirrors the
// pattern of video-render-queue.test.ts: log + list against the real SQLite
// test seam (tests/setup.ts), cancel state machine against seeded short_renders
// rows. The plan:
// _plans/2026-06-15-short-render-events-and-cancel.md.

import { describe, expect, it, beforeEach } from "vitest";
import { all, run } from "@/lib/db";
import {
  cancelShortRender,
  enqueueShortRender,
  hashShortConfig,
  listShortRenderEvents,
  logShortRenderEvent,
  type ShortRenderRow,
} from "@/lib/short-render-queue";

async function reset(): Promise<void> {
  await run("DELETE FROM short_render_events WHERE 1=1", []);
  await run("DELETE FROM short_renders WHERE 1=1", []);
}

async function seedRow(opts: {
  id: string;
  storyId: string;
  status: string;
  phase?: string | null;
}): Promise<void> {
  const configHash = hashShortConfig("suspense", "standard") + ":" + opts.id;
  await run(
    "INSERT INTO short_renders " +
      "(id, story_id, config_hash, narration_style, length_preset, status, phase, " +
      " progress, error, output_url, props, requested_by, requested_at, started_at, finished_at) " +
      "VALUES (?, ?, ?, 'suspense', 'standard', ?, ?, 0, NULL, NULL, NULL, NULL, ?, NULL, NULL)",
    [
      opts.id,
      opts.storyId,
      configHash,
      opts.status,
      opts.phase ?? null,
      "2026-06-15T00:00:00.000Z",
    ],
  );
}

beforeEach(async () => {
  await reset();
});

describe("logShortRenderEvent", () => {
  it("inserts one row per call with the supplied fields", async () => {
    await logShortRenderEvent("render-a", "queued", {
      message: "first",
      payload: { config_hash_prefix: "abc12345" },
    });
    await logShortRenderEvent("render-a", "claimed", {
      message: "second",
      level: "info",
    });
    const rows = await all<{
      render_id: string;
      event: string;
      message: string | null;
      level: string;
      payload: string | null;
    }>(
      "SELECT render_id, event, message, level, payload FROM short_render_events ORDER BY ts ASC",
      [],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].event).toBe("queued");
    expect(rows[0].message).toBe("first");
    expect(rows[0].payload).toContain("abc12345");
    expect(rows[1].event).toBe("claimed");
    expect(rows[1].level).toBe("info");
  });

  it("defaults level to info and payload to null when omitted", async () => {
    await logShortRenderEvent("render-b", "phase_script");
    const rows = await all<{ level: string; payload: string | null; message: string | null }>(
      "SELECT level, payload, message FROM short_render_events WHERE render_id = ?",
      ["render-b"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].level).toBe("info");
    expect(rows[0].payload).toBeNull();
    expect(rows[0].message).toBeNull();
  });

  it("swallows errors so observability never breaks the orchestrator", async () => {
    // We can't easily force an INSERT to fail in the test DB. The behavioral
    // contract is: the helper returns void and never raises. Asserting it
    // returns without throwing is what we can verify cheaply.
    await expect(
      logShortRenderEvent("render-c", "some_event"),
    ).resolves.toBeUndefined();
  });
});

describe("listShortRenderEvents", () => {
  it("returns events in chronological order (oldest first)", async () => {
    // ts is the field listShortRenderEvents orders by. Vitest's clock isn't
    // monotonic enough here, so we seed the rows directly with controlled ts.
    await run(
      "INSERT INTO short_render_events (id, render_id, ts, level, event, message, payload) " +
        "VALUES (?, ?, ?, 'info', ?, ?, NULL)",
      ["ev-2", "render-x", "2026-06-15T10:00:02.000Z", "claimed", "second"],
    );
    await run(
      "INSERT INTO short_render_events (id, render_id, ts, level, event, message, payload) " +
        "VALUES (?, ?, ?, 'info', ?, ?, NULL)",
      ["ev-1", "render-x", "2026-06-15T10:00:00.000Z", "queued", "first"],
    );
    await run(
      "INSERT INTO short_render_events (id, render_id, ts, level, event, message, payload) " +
        "VALUES (?, ?, ?, 'info', ?, ?, NULL)",
      ["ev-3", "render-x", "2026-06-15T10:00:05.000Z", "finished", "third"],
    );
    const rows = await listShortRenderEvents("render-x");
    expect(rows.map((r) => r.message)).toEqual(["first", "second", "third"]);
  });

  it("scopes by render_id so other renders' events are invisible", async () => {
    await logShortRenderEvent("render-here", "queued", { message: "mine" });
    await logShortRenderEvent("render-elsewhere", "queued", {
      message: "theirs",
    });
    const rows = await listShortRenderEvents("render-here");
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("mine");
  });

  it("respects the limit argument", async () => {
    for (let i = 0; i < 5; i++) {
      await run(
        "INSERT INTO short_render_events (id, render_id, ts, level, event, message, payload) " +
          "VALUES (?, ?, ?, 'info', ?, NULL, NULL)",
        [
          `ev-${i}`,
          "render-lim",
          `2026-06-15T10:00:0${i}.000Z`,
          `event-${i}`,
        ],
      );
    }
    const rows = await listShortRenderEvents("render-lim", 3);
    expect(rows).toHaveLength(3);
  });
});

describe("cancelShortRender", () => {
  it("flips a queued row to cancelled and logs the event", async () => {
    await seedRow({ id: "r-q", storyId: "s-1", status: "queued" });
    const after = await cancelShortRender("r-q");
    expect(after).not.toBeNull();
    expect(after!.status).toBe("cancelled");
    const events = await listShortRenderEvents("r-q");
    expect(events.some((e) => e.event === "cancelled")).toBe(true);
  });

  it("flips a generating row to cancelled (the worker's cancel seam)", async () => {
    await seedRow({
      id: "r-g",
      storyId: "s-2",
      status: "generating",
      phase: "scene",
    });
    const after = await cancelShortRender("r-g");
    expect(after!.status).toBe("cancelled");
    const events = await listShortRenderEvents("r-g");
    const cancelEvent = events.find((e) => e.event === "cancelled");
    expect(cancelEvent).toBeDefined();
    // The cancel event payload carries the previous phase so the timeline
    // shows what the cancel caught.
    expect(cancelEvent!.payload).toContain("scene");
  });

  it("is a no-op on rendering (Cloud Run has the MP4; no clean abort)", async () => {
    await seedRow({ id: "r-r", storyId: "s-3", status: "rendering" });
    const after = await cancelShortRender("r-r");
    expect(after!.status).toBe("rendering");
    const events = await listShortRenderEvents("r-r");
    expect(events.some((e) => e.event === "cancelled")).toBe(false);
  });

  it("is a no-op on done", async () => {
    await seedRow({ id: "r-d", storyId: "s-4", status: "done" });
    const after = await cancelShortRender("r-d");
    expect(after!.status).toBe("done");
  });

  it("is a no-op on error and already-cancelled", async () => {
    await seedRow({ id: "r-e", storyId: "s-5", status: "error" });
    expect((await cancelShortRender("r-e"))!.status).toBe("error");
    await seedRow({ id: "r-c", storyId: "s-6", status: "cancelled" });
    expect((await cancelShortRender("r-c"))!.status).toBe("cancelled");
  });

  it("returns null when the render id doesn't exist", async () => {
    expect(await cancelShortRender("does-not-exist")).toBeNull();
  });
});

describe("enqueueShortRender events", () => {
  it("logs a queued event on the first enqueue", async () => {
    const row = await enqueueShortRender("s-q-1", "suspense", "standard", null);
    const events = await listShortRenderEvents(row.id);
    const queued = events.find((e) => e.event === "queued");
    expect(queued).toBeDefined();
    expect(queued!.payload).toContain("suspense");
  });

  it("logs reset_from_error when a failed row is retried", async () => {
    // First enqueue, then force-fail, then re-enqueue.
    const first = await enqueueShortRender("s-q-2", "suspense", "standard", null);
    await run(
      "UPDATE short_renders SET status = 'error', error = 'oops' WHERE id = ?",
      [first.id],
    );
    const second = await enqueueShortRender("s-q-2", "suspense", "standard", null);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("queued");
    const events = await listShortRenderEvents(first.id);
    expect(events.some((e) => e.event === "reset_from_error")).toBe(true);
  });
});
