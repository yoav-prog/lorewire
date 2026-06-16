// Tests for the lane-picker. Mostly diff-detection — does the helper return
// the cheapest correct lane for every combination of edits, and does the
// priority rule (C > B > A > noop) hold?
//
// Plan: _plans/2026-06-16-short-editor-full-parity.md.

import { describe, expect, it } from "vitest";
import { planShortRender } from "@/lib/short-render-plan";
import {
  CURRENT_SHORT_CONFIG_VERSION,
  type ShortConfig,
} from "@/lib/short-config";

function baseProps() {
  return {
    voiceover_url: "https://gcs/voice.mp3",
    script: "Once upon a time",
    character_base_url: "https://gcs/base.png",
    doodle_frames: [
      { id: "frame-00", url: "https://gcs/00.png", image_prompt: "scene a" },
      { id: "frame-01", url: "https://gcs/01.png", image_prompt: "scene b" },
    ],
    captions: [
      { start_ms: 0, end_ms: 2000, text: "Once upon a time" },
      { start_ms: 2000, end_ms: 4500, text: "in an office" },
    ],
  };
}

function configFromProps(over: Partial<ShortConfig> = {}): ShortConfig {
  return {
    config_version: CURRENT_SHORT_CONFIG_VERSION,
    voiceover_url: "https://gcs/voice.mp3",
    script: "Once upon a time",
    character_base_url: "https://gcs/base.png",
    doodle_frames: [
      {
        id: "frame-00",
        url: "https://gcs/00.png",
        caption_chunk_start_index: 0,
        image_prompt: "scene a",
      },
      {
        id: "frame-01",
        url: "https://gcs/01.png",
        caption_chunk_start_index: 3,
        image_prompt: "scene b",
      },
    ],
    captions: [
      { start_ms: 0, end_ms: 2000, text: "Once upon a time" },
      { start_ms: 2000, end_ms: 4500, text: "in an office" },
    ],
    ...over,
  };
}

const baselineJson = JSON.stringify(baseProps());

describe("planShortRender — noop", () => {
  it("returns noop when current matches baseline", () => {
    const plan = planShortRender(configFromProps(), baselineJson);
    expect(plan.lane).toBe("noop");
    expect(plan.estimated_cost_cents).toBe(0);
  });
});

describe("planShortRender — Lane A", () => {
  it("detects a caption text change", () => {
    const cfg = configFromProps({
      captions: [
        { start_ms: 0, end_ms: 2000, text: "EDITED" },
        { start_ms: 2000, end_ms: 4500, text: "in an office" },
      ],
    });
    const plan = planShortRender(cfg, baselineJson);
    expect(plan.lane).toBe("A");
    expect(plan.diffs.captions).toBe(true);
    expect(plan.touched_scene_ids).toEqual([]);
    expect(plan.estimated_cost_cents).toBe(5);
  });

  it("detects a caption timing change", () => {
    const cfg = configFromProps({
      captions: [
        { start_ms: 100, end_ms: 2000, text: "Once upon a time" },
        { start_ms: 2000, end_ms: 4500, text: "in an office" },
      ],
    });
    const plan = planShortRender(cfg, baselineJson);
    expect(plan.lane).toBe("A");
  });

  it("detects an added or removed caption", () => {
    const cfg = configFromProps({
      captions: [
        { start_ms: 0, end_ms: 2000, text: "Once upon a time" },
      ],
    });
    expect(planShortRender(cfg, baselineJson).lane).toBe("A");
  });
});

describe("planShortRender — Lane B", () => {
  it("detects a script change", () => {
    const cfg = configFromProps({ script: "EDITED SCRIPT" });
    const plan = planShortRender(cfg, baselineJson);
    expect(plan.lane).toBe("B");
    expect(plan.diffs.script).toBe(true);
    expect(plan.estimated_cost_cents).toBe(10);
  });

  it("detects a voice override change", () => {
    const cfg = configFromProps({
      voice: { provider: "elevenlabs", voice_id: "different" },
    });
    expect(planShortRender(cfg, baselineJson).lane).toBe("B");
  });

  it("detects a voiceover_url change", () => {
    const cfg = configFromProps({ voiceover_url: "https://gcs/new.mp3" });
    expect(planShortRender(cfg, baselineJson).lane).toBe("B");
  });
});

describe("planShortRender — Lane C", () => {
  it("detects a frame url change", () => {
    const cfg = configFromProps();
    cfg.doodle_frames[0].url = "https://gcs/new-00.png";
    const plan = planShortRender(cfg, baselineJson);
    expect(plan.lane).toBe("C");
    expect(plan.touched_scene_ids).toEqual(["frame-00"]);
    expect(plan.estimated_cost_cents).toBe(5 + 5); // 1 scene + assembly
  });

  it("detects a frame image_prompt change", () => {
    const cfg = configFromProps();
    cfg.doodle_frames[1].image_prompt = "different prompt";
    const plan = planShortRender(cfg, baselineJson);
    expect(plan.lane).toBe("C");
    expect(plan.touched_scene_ids).toEqual(["frame-01"]);
  });

  it("counts multiple touched scenes in the cost estimate", () => {
    const cfg = configFromProps();
    cfg.doodle_frames[0].url = "https://gcs/new-00.png";
    cfg.doodle_frames[1].url = "https://gcs/new-01.png";
    const plan = planShortRender(cfg, baselineJson);
    expect(plan.touched_scene_ids.sort()).toEqual(["frame-00", "frame-01"]);
    expect(plan.estimated_cost_cents).toBe(5 + 5 + 5);
  });
});

describe("planShortRender — priority (C > B > A > noop)", () => {
  it("Lane C wins over B when both have changes", () => {
    const cfg = configFromProps({ script: "EDITED" });
    cfg.doodle_frames[0].url = "https://gcs/new.png";
    expect(planShortRender(cfg, baselineJson).lane).toBe("C");
  });

  it("Lane C wins over A when both have changes", () => {
    const cfg = configFromProps();
    cfg.doodle_frames[0].url = "https://gcs/new.png";
    cfg.captions[0].text = "EDITED caption";
    expect(planShortRender(cfg, baselineJson).lane).toBe("C");
  });

  it("Lane B wins over A when both have changes", () => {
    const cfg = configFromProps({
      script: "EDITED",
      captions: [
        { start_ms: 0, end_ms: 2000, text: "ALSO EDITED" },
        { start_ms: 2000, end_ms: 4500, text: "in an office" },
      ],
    });
    expect(planShortRender(cfg, baselineJson).lane).toBe("B");
  });
});

describe("planShortRender — unparseable baseline", () => {
  it("treats missing baseline like an empty baseline (everything is changed)", () => {
    // No baseline → current has captions + frames → at minimum a Lane C
    // because the diff sees the frames as "new ids not present in baseline."
    const plan = planShortRender(configFromProps(), null);
    expect(plan.lane).toBe("C");
  });

  it("treats unparseable JSON like an empty baseline", () => {
    const plan = planShortRender(configFromProps(), "not json");
    expect(plan.lane).toBe("C");
  });
});

describe("planShortRender — intro/outro segment changes", () => {
  const baselineJson = JSON.stringify(baseProps());

  it("intro change since last render triggers Lane A", () => {
    const cfg = configFromProps({
      _last_rendered_segments: {
        intro_segment_id: "old-intro",
        outro_segment_id: null,
      },
    });
    const plan = planShortRender(cfg, baselineJson, {
      intro_segment_id: "new-intro",
      outro_segment_id: null,
    });
    expect(plan.lane).toBe("A");
    expect(plan.diffs.segments).toBe(true);
    expect(plan.reason).toMatch(/intro\/outro changed/i);
  });

  it("outro change since last render triggers Lane A", () => {
    const cfg = configFromProps({
      _last_rendered_segments: {
        intro_segment_id: "same",
        outro_segment_id: null,
      },
    });
    const plan = planShortRender(cfg, baselineJson, {
      intro_segment_id: "same",
      outro_segment_id: "new-outro",
    });
    expect(plan.lane).toBe("A");
    expect(plan.diffs.segments).toBe(true);
  });

  it("identical segments stay noop", () => {
    const cfg = configFromProps({
      _last_rendered_segments: {
        intro_segment_id: "x",
        outro_segment_id: "y",
      },
    });
    const plan = planShortRender(cfg, baselineJson, {
      intro_segment_id: "x",
      outro_segment_id: "y",
    });
    expect(plan.lane).toBe("noop");
    expect(plan.diffs.segments).toBe(false);
  });

  it("no _last_rendered_segments stamp keeps noop (first-render insurance)", () => {
    // Brand-new short with nothing stamped: planner can't tell if segments
    // changed, so it sticks with noop instead of false-positiving Lane A.
    const cfg = configFromProps();
    const plan = planShortRender(cfg, baselineJson, {
      intro_segment_id: "anything",
      outro_segment_id: null,
    });
    expect(plan.lane).toBe("noop");
    expect(plan.diffs.segments).toBe(false);
  });

  it("segments change combined with captions still surfaces both flags", () => {
    const cfg = configFromProps({
      captions: [
        { start_ms: 0, end_ms: 2000, text: "Once upon EDITED" },
        { start_ms: 2000, end_ms: 4500, text: "in an office" },
      ],
      _last_rendered_segments: {
        intro_segment_id: "old",
        outro_segment_id: null,
      },
    });
    const plan = planShortRender(cfg, baselineJson, {
      intro_segment_id: "new",
      outro_segment_id: null,
    });
    expect(plan.lane).toBe("A");
    expect(plan.diffs.captions).toBe(true);
    expect(plan.diffs.segments).toBe(true);
  });
});
