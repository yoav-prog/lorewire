// Smoke tests for the short-segments resolver chain. Verifies the override
// tier wins over story columns, the skip flag short-circuits, and the
// fallback to resolveSegmentsForStory still emits the same shape.
//
// Plan: per-short intro/outro override.

import { describe, expect, it, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { run } from "@/lib/db";
import { resolveShortSegments } from "@/lib/short-segments";
import type { ShortConfig } from "@/lib/short-config";

const NOW = "2026-06-16T00:00:00.000Z";

async function seedSegment(opts: {
  id?: string;
  kind: "intro" | "outro";
  label?: string;
  aspect?: "9:16" | "16:9";
  enabled?: boolean;
  normalizedUrl?: string;
}): Promise<string> {
  const id = opts.id ?? randomUUID();
  await run(
    "INSERT INTO video_segments " +
      "(id, kind, label, source_url, normalized_url, duration_ms, enabled, " +
      " status, error, uploaded_at, aspect, created_at, updated_at) " +
      "VALUES (?, ?, ?, NULL, ?, 2000, ?, 'ready', NULL, ?, ?, ?, ?)",
    [
      id,
      opts.kind,
      opts.label ?? `seg-${id.slice(0, 6)}`,
      opts.normalizedUrl ?? `https://gcs/${id}.mp4`,
      opts.enabled === false ? 0 : 1,
      NOW,
      opts.aspect ?? "9:16",
      NOW,
      NOW,
    ],
  );
  return id;
}

async function setSetting(key: string, value: string): Promise<void> {
  await run(
    "INSERT INTO settings (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

async function reset(): Promise<void> {
  await run("DELETE FROM video_segments WHERE 1=1", []);
  await run(
    "DELETE FROM settings WHERE key LIKE 'video.active_%' OR key = 'video.intro_outro_enabled'",
    [],
  );
}

const emptyStory = {
  intro_segment_id: null,
  outro_segment_id: null,
  skip_intro: 0,
  skip_outro: 0,
  video_config: null,
};

beforeEach(async () => {
  await reset();
});

describe("resolveShortSegments", () => {
  it("falls through to global active when no override is set", async () => {
    const introId = await seedSegment({ kind: "intro", label: "Brand intro" });
    await setSetting("video.active_intro_id_9x16", introId);
    const out = await resolveShortSegments(null, emptyStory);
    expect(out.intro.segment?.label).toBe("Brand intro");
    expect(out.intro.source).toBe("story");
    expect(out.intro.reason).toBe("global-active");
  });

  it("uses the short_config override over the global active", async () => {
    const globalId = await seedSegment({ kind: "intro", label: "Global intro" });
    const overrideId = await seedSegment({ kind: "intro", label: "Short-only intro" });
    await setSetting("video.active_intro_id_9x16", globalId);
    const config: ShortConfig = {
      doodle_frames: [],
      captions: [],
      intro_segment_id: overrideId,
    };
    const out = await resolveShortSegments(config, emptyStory);
    expect(out.intro.segment?.label).toBe("Short-only intro");
    expect(out.intro.source).toBe("short_config");
    expect(out.intro.reason).toBe("pinned");
  });

  it("hard-skips when short_config.skip_intro is true", async () => {
    const globalId = await seedSegment({ kind: "intro" });
    await setSetting("video.active_intro_id_9x16", globalId);
    const config: ShortConfig = {
      doodle_frames: [],
      captions: [],
      skip_intro: true,
    };
    const out = await resolveShortSegments(config, emptyStory);
    expect(out.intro.segment).toBeNull();
    expect(out.intro.reason).toBe("skip-flag");
    expect(out.intro.source).toBe("short_config");
  });

  it("drops a 16:9 override with aspect-mismatch reason", async () => {
    const wideId = await seedSegment({
      kind: "intro",
      aspect: "16:9",
      label: "Wide intro",
    });
    const config: ShortConfig = {
      doodle_frames: [],
      captions: [],
      intro_segment_id: wideId,
    };
    const out = await resolveShortSegments(config, emptyStory);
    expect(out.intro.segment).toBeNull();
    expect(out.intro.reason).toBe("aspect-mismatch");
    expect(out.intro.source).toBe("short_config");
  });

  it("intro and outro overrides are independent", async () => {
    const introOverride = await seedSegment({ kind: "intro", label: "Override intro" });
    const outroGlobal = await seedSegment({ kind: "outro", label: "Global outro" });
    await setSetting("video.active_outro_id_9x16", outroGlobal);
    const config: ShortConfig = {
      doodle_frames: [],
      captions: [],
      intro_segment_id: introOverride,
    };
    const out = await resolveShortSegments(config, emptyStory);
    expect(out.intro.segment?.label).toBe("Override intro");
    expect(out.intro.source).toBe("short_config");
    expect(out.outro.segment?.label).toBe("Global outro");
    expect(out.outro.source).toBe("story");
  });
});
