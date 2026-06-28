// Unit tests for the pure pipeline-state helpers. These don't touch the
// DB — they pin down the truth table of:
//
//   computePipelineState  — story / short / hero / publish per-row state
//   computeOverallState   — single-word summary
//   isPipelineInFlight    — server-side "active" predicate
//   computeLastSettledAt  — grace-window anchor for finished jobs
//
// Plan: _plans/2026-06-28-live-runs-multistage-pipeline.md.

import { describe, expect, it } from "vitest";
import {
  computeLastSettledAt,
  computeOverallState,
  computePipelineState,
  isJobActive,
  isJobFinished,
  isPipelineInFlight,
  type ActiveJobView,
  type PipelineStateInput,
} from "@/lib/story-jobs-live-shared";

function input(over: Partial<PipelineStateInput> = {}): PipelineStateInput {
  return {
    story_status: "queued",
    with_media: 1,
    full_pipeline: 0,
    finisher_status: null,
    auto_publish_status: null,
    short: null,
    ...over,
  };
}

function statesById(stages: ReturnType<typeof computePipelineState>) {
  return Object.fromEntries(stages.map((s) => [s.id, s.state]));
}

describe("computePipelineState — story stage", () => {
  it("queued → pending", () => {
    expect(statesById(computePipelineState(input({ story_status: "queued" }))).story).toBe(
      "pending",
    );
  });

  it("processing → running", () => {
    expect(
      statesById(computePipelineState(input({ story_status: "processing" }))).story,
    ).toBe("running");
  });

  it("done → done", () => {
    expect(statesById(computePipelineState(input({ story_status: "done" }))).story).toBe(
      "done",
    );
  });

  it("error → failed", () => {
    expect(statesById(computePipelineState(input({ story_status: "error" }))).story).toBe(
      "failed",
    );
  });

  it("cancelled → cancelled", () => {
    expect(
      statesById(computePipelineState(input({ story_status: "cancelled" }))).story,
    ).toBe("cancelled");
  });

  it("unknown status → pending (defensive)", () => {
    expect(
      statesById(computePipelineState(input({ story_status: "frob" }))).story,
    ).toBe("pending");
  });
});

describe("computePipelineState — short stage", () => {
  it("with_media=0 → skipped regardless of story state", () => {
    for (const s of ["queued", "processing", "done", "error", "cancelled"]) {
      expect(
        statesById(
          computePipelineState(input({ story_status: s, with_media: 0 })),
        ).short,
      ).toBe("skipped");
    }
  });

  it("story cancelled → skipped", () => {
    expect(
      statesById(computePipelineState(input({ story_status: "cancelled" }))).short,
    ).toBe("skipped");
  });

  it("story failed → skipped", () => {
    expect(
      statesById(computePipelineState(input({ story_status: "error" }))).short,
    ).toBe("skipped");
  });

  it("story still in flight → pending", () => {
    for (const s of ["queued", "processing"]) {
      expect(
        statesById(computePipelineState(input({ story_status: s }))).short,
      ).toBe("pending");
    }
  });

  it("story done + no short row yet → pending (transient window)", () => {
    expect(
      statesById(
        computePipelineState(input({ story_status: "done", short: null })),
      ).short,
    ).toBe("pending");
  });

  it("short queued/generating/rendering → running", () => {
    for (const s of ["queued", "generating", "rendering"]) {
      const stages = computePipelineState(
        input({ story_status: "done", short: { status: s, phase: null } }),
      );
      expect(statesById(stages).short).toBe("running");
    }
  });

  it("short done → done", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            short: { status: "done", phase: "done" },
          }),
        ),
      ).short,
    ).toBe("done");
  });

  it("short error/cancelled → failed", () => {
    for (const s of ["error", "cancelled"]) {
      expect(
        statesById(
          computePipelineState(
            input({ story_status: "done", short: { status: s, phase: null } }),
          ),
        ).short,
      ).toBe("failed");
    }
  });

  it("short running carries the phase as sub_label", () => {
    const stages = computePipelineState(
      input({
        story_status: "done",
        short: { status: "generating", phase: "build_props" },
      }),
    );
    const short = stages.find((s) => s.id === "short");
    expect(short?.sub_label).toBe("build_props");
  });
});

describe("computePipelineState — hero stage", () => {
  it("short skipped → hero skipped (no scenes to finish from)", () => {
    expect(
      statesById(
        computePipelineState(input({ story_status: "done", with_media: 0 })),
      ).hero,
    ).toBe("skipped");
  });

  it("story cancelled/failed → hero skipped", () => {
    for (const s of ["cancelled", "error"]) {
      expect(
        statesById(computePipelineState(input({ story_status: s }))).hero,
      ).toBe("skipped");
    }
  });

  it("short in flight → hero pending", () => {
    const stages = computePipelineState(
      input({
        story_status: "done",
        short: { status: "rendering", phase: null },
      }),
    );
    expect(statesById(stages).hero).toBe("pending");
  });

  it("short failed → hero skipped", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            short: { status: "error", phase: null },
          }),
        ),
      ).hero,
    ).toBe("skipped");
  });

  it("short done + finisher NULL → hero pending", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            short: { status: "done", phase: "done" },
            finisher_status: null,
          }),
        ),
      ).hero,
    ).toBe("pending");
  });

  it("short done + finisher pending → hero pending", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            short: { status: "done", phase: "done" },
            finisher_status: "pending",
          }),
        ),
      ).hero,
    ).toBe("pending");
  });

  it("short done + finisher running → hero running", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            short: { status: "done", phase: "done" },
            finisher_status: "running",
          }),
        ),
      ).hero,
    ).toBe("running");
  });

  it("short done + finisher done → hero done", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            short: { status: "done", phase: "done" },
            finisher_status: "done",
          }),
        ),
      ).hero,
    ).toBe("done");
  });

  it("short done + finisher failed → hero failed", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            short: { status: "done", phase: "done" },
            finisher_status: "failed",
          }),
        ),
      ).hero,
    ).toBe("failed");
  });
});

describe("computePipelineState — publish stage", () => {
  it("full_pipeline=0 → skipped regardless", () => {
    for (const fp of [0, null]) {
      expect(
        statesById(
          computePipelineState(
            input({
              story_status: "done",
              full_pipeline: fp,
              short: { status: "done", phase: "done" },
              finisher_status: "done",
            }),
          ),
        ).publish,
      ).toBe("skipped");
    }
  });

  it("story cancelled/failed → skipped", () => {
    for (const s of ["cancelled", "error"]) {
      expect(
        statesById(
          computePipelineState(
            input({ story_status: s, full_pipeline: 1 }),
          ),
        ).publish,
      ).toBe("skipped");
    }
  });

  it("hero not done yet → publish pending", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            full_pipeline: 1,
            short: { status: "rendering", phase: null },
          }),
        ),
      ).publish,
    ).toBe("pending");
  });

  it("hero skipped (short failed) → publish skipped", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            full_pipeline: 1,
            short: { status: "error", phase: null },
          }),
        ),
      ).publish,
    ).toBe("skipped");
  });

  it("hero done + auto_publish NULL → publish pending (transient)", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            full_pipeline: 1,
            short: { status: "done", phase: "done" },
            finisher_status: "done",
            auto_publish_status: null,
          }),
        ),
      ).publish,
    ).toBe("pending");
  });

  it("hero done + auto_publish pending → publish running", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            full_pipeline: 1,
            short: { status: "done", phase: "done" },
            finisher_status: "done",
            auto_publish_status: "pending",
          }),
        ),
      ).publish,
    ).toBe("running");
  });

  it("hero done + auto_publish done → publish done", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            full_pipeline: 1,
            short: { status: "done", phase: "done" },
            finisher_status: "done",
            auto_publish_status: "done",
          }),
        ),
      ).publish,
    ).toBe("done");
  });

  it("hero done + auto_publish failed → publish failed", () => {
    expect(
      statesById(
        computePipelineState(
          input({
            story_status: "done",
            full_pipeline: 1,
            short: { status: "done", phase: "done" },
            finisher_status: "done",
            auto_publish_status: "failed",
          }),
        ),
      ).publish,
    ).toBe("failed");
  });
});

describe("computeOverallState", () => {
  it("story cancelled → cancelled (highest precedence)", () => {
    const stages = computePipelineState(input({ story_status: "cancelled" }));
    expect(computeOverallState(stages)).toBe("cancelled");
  });

  it("any failed stage → failed", () => {
    const stages = computePipelineState(
      input({
        story_status: "done",
        short: { status: "error", phase: null },
      }),
    );
    expect(computeOverallState(stages)).toBe("failed");
  });

  it("any running stage → running", () => {
    const stages = computePipelineState(
      input({
        story_status: "done",
        short: { status: "rendering", phase: null },
      }),
    );
    expect(computeOverallState(stages)).toBe("running");
  });

  it("story queued and nothing else → queued", () => {
    const stages = computePipelineState(input({ story_status: "queued" }));
    expect(computeOverallState(stages)).toBe("queued");
  });

  it("story done + downstream pending but no running → running (between stages)", () => {
    const stages = computePipelineState(
      input({
        story_status: "done",
        short: { status: "queued", phase: null },
      }),
    );
    // short is in the SHORT_RUNNING set per the implementation, so this
    // actually returns running. Adjust the scenario to exercise the
    // pending-after-done path: short row not yet written.
    expect(computeOverallState(stages)).toBe("running");
  });

  it("transient window after story done before short row exists → running", () => {
    const stages = computePipelineState(
      input({ story_status: "done", short: null }),
    );
    // short stage is pending, hero pending — overall is "running" so
    // the admin knows movement is expected (not "queued" which would
    // imply story stage hasn't started).
    expect(computeOverallState(stages)).toBe("running");
  });

  it("everything green → done", () => {
    const stages = computePipelineState(
      input({
        story_status: "done",
        full_pipeline: 1,
        short: { status: "done", phase: "done" },
        finisher_status: "done",
        auto_publish_status: "done",
      }),
    );
    expect(computeOverallState(stages)).toBe("done");
  });

  it("with_media=0 success path → done", () => {
    const stages = computePipelineState(
      input({ story_status: "done", with_media: 0 }),
    );
    expect(computeOverallState(stages)).toBe("done");
  });
});

describe("isPipelineInFlight", () => {
  it("true when any stage pending", () => {
    const stages = computePipelineState(input({ story_status: "queued" }));
    expect(isPipelineInFlight(stages)).toBe(true);
  });
  it("true when any stage running", () => {
    const stages = computePipelineState(
      input({ story_status: "processing" }),
    );
    expect(isPipelineInFlight(stages)).toBe(true);
  });
  it("false when every stage settled (with_media=0)", () => {
    const stages = computePipelineState(
      input({ story_status: "done", with_media: 0 }),
    );
    expect(isPipelineInFlight(stages)).toBe(false);
  });
  it("false on a full-pipeline success", () => {
    const stages = computePipelineState(
      input({
        story_status: "done",
        full_pipeline: 1,
        short: { status: "done", phase: "done" },
        finisher_status: "done",
        auto_publish_status: "done",
      }),
    );
    expect(isPipelineInFlight(stages)).toBe(false);
  });
});

describe("computeLastSettledAt", () => {
  const T1 = "2026-06-28T12:00:00.000Z";
  const T2 = "2026-06-28T12:05:00.000Z";

  it("returns null when the pipeline is still in flight", () => {
    const stages = computePipelineState(input({ story_status: "queued" }));
    expect(
      computeLastSettledAt({
        stages,
        storyJobFinishedAt: null,
        shortFinishedAt: null,
      }),
    ).toBeNull();
  });

  it("returns story finished_at when short is null (with_media=0 path)", () => {
    const stages = computePipelineState(
      input({ story_status: "done", with_media: 0 }),
    );
    const ts = computeLastSettledAt({
      stages,
      storyJobFinishedAt: T1,
      shortFinishedAt: null,
    });
    expect(ts).toBe(T1);
  });

  it("returns the max of story finished_at and short finished_at", () => {
    const stages = computePipelineState(
      input({
        story_status: "done",
        full_pipeline: 1,
        short: { status: "done", phase: "done" },
        finisher_status: "done",
        auto_publish_status: "done",
      }),
    );
    const ts = computeLastSettledAt({
      stages,
      storyJobFinishedAt: T1,
      shortFinishedAt: T2,
    });
    expect(ts).toBe(T2);
  });
});

describe("isJobActive / isJobFinished consumer contract", () => {
  function view(overall: ActiveJobView["overall"]): ActiveJobView {
    return {
      job_id: "j",
      reddit_id: "r",
      status: "ignored-by-predicates",
      progress: null,
      error: null,
      story_id: null,
      requested_at: "2026-06-28T12:00:00.000Z",
      started_at: null,
      finished_at: null,
      title: null,
      subreddit: null,
      with_media: 1,
      full_pipeline: 0,
      finisher_status: null,
      auto_publish_status: null,
      short: null,
      stages: [],
      overall,
      last_settled_at: null,
      events: [],
    };
  }

  it("queued / running → active", () => {
    expect(isJobActive(view("queued"))).toBe(true);
    expect(isJobActive(view("running"))).toBe(true);
  });

  it("done / failed / cancelled → finished", () => {
    expect(isJobFinished(view("done"))).toBe(true);
    expect(isJobFinished(view("failed"))).toBe(true);
    expect(isJobFinished(view("cancelled"))).toBe(true);
  });

  it("predicates are mutually exclusive", () => {
    for (const o of ["queued", "running", "done", "failed", "cancelled"] as const) {
      const v = view(o);
      expect(isJobActive(v) && isJobFinished(v)).toBe(false);
    }
  });
});
