// Guards for the canonical category manifest.
//
// The five TS category lists now DERIVE from manifest.ts, so they can't
// drift. Two copies still live in separate files that this manifest can't
// import at build time:
//   1. pipeline/stages.py  (STORY_CATEGORIES + SUBREDDIT_CATEGORY) — a
//      different runtime, deployed separately.
//   2. globals.css         (--color-cat-* design tokens) — Tailwind reads
//      these statically at build, so they can't be generated per-slug.
// This test re-reads both files and asserts they match the manifest, so
// editing the manifest without updating them fails CI instead of shipping
// a drifted category set / palette.
//
// Plan: _plans/2026-07-01-category-taxonomy-multitag.md.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CATEGORY_DEFS,
  CATEGORY_GLYPHS,
  CATEGORY_LABELS,
  CATEGORY_MANIFEST,
  CATEGORY_RAIL_ENTRIES,
  CAT_COLORS,
  SUBREDDIT_CATEGORY,
  isCategoryLabel,
  type Cat,
} from "@/lib/categories/manifest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** Walk up from the test dir until `<dir>/pipeline/stages.py` exists so
 *  the parity check works from the repo root or any git worktree. */
function findRepoFile(...segments: string[]): string {
  let dir = TEST_DIR;
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, ...segments);
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, "..");
  }
  throw new Error(`could not locate ${segments.join("/")} walking up from ${TEST_DIR}`);
}

/** Slice the text between the first `open` after `marker` and its matching
 *  `close`, honoring nesting. Good enough for the flat literals in
 *  stages.py (a tuple of strings and a dict of string:string). */
function extractBlock(src: string, marker: string, open: string, close: string): string {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const openIdx = src.indexOf(open, start);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  throw new Error(`unterminated ${open}${close} block for ${marker}`);
}

describe("category manifest internal consistency", () => {
  it("has a manifest entry per label, keyed by its own label", () => {
    for (const label of CATEGORY_LABELS) {
      expect(CATEGORY_MANIFEST[label].label).toBe(label);
    }
    expect(Object.keys(CATEGORY_MANIFEST).sort()).toEqual(
      [...CATEGORY_LABELS].sort(),
    );
  });

  it("has unique labels and unique kebab slugs", () => {
    expect(new Set(CATEGORY_LABELS).size).toBe(CATEGORY_LABELS.length);
    const slugs = CATEGORY_DEFS.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("derives color + glyph maps that cover every label", () => {
    for (const label of CATEGORY_LABELS) {
      expect(CAT_COLORS[label]).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(CATEGORY_GLYPHS[label]).toBeTruthy();
    }
  });

  it("exposes one rail entry per category with unique surfaces", () => {
    const cats = CATEGORY_RAIL_ENTRIES.map((e) => e.cat);
    expect(new Set(cats)).toEqual(new Set(CATEGORY_LABELS));
    const surfaces = CATEGORY_RAIL_ENTRIES.map((e) => e.surface);
    expect(new Set(surfaces).size).toBe(surfaces.length);
  });

  it("maps every subreddit to a real category label", () => {
    for (const cat of Object.values(SUBREDDIT_CATEGORY)) {
      expect(isCategoryLabel(cat)).toBe(true);
    }
  });

  it("guards membership with isCategoryLabel", () => {
    expect(isCategoryLabel("Drama")).toBe(true);
    expect(isCategoryLabel("drama")).toBe(false);
    expect(isCategoryLabel("Politics")).toBe(false);
    expect(isCategoryLabel(null)).toBe(false);
  });
});

describe("category manifest parity with pipeline/stages.py", () => {
  const stagesSrc = readFileSync(findRepoFile("pipeline", "stages.py"), "utf-8");

  // Strip Python `#` line comments before matching quoted strings so a
  // future inline comment containing quotes can't corrupt the parse.
  const stripComments = (s: string) => s.replace(/#.*$/gm, "");

  it("STORY_CATEGORIES matches CATEGORY_LABELS in order", () => {
    const block = stripComments(
      extractBlock(stagesSrc, "STORY_CATEGORIES = (", "(", ")"),
    );
    const pyCategories = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(pyCategories).toEqual([...CATEGORY_LABELS]);
  });

  it("SUBREDDIT_CATEGORY matches the manifest (order-independent)", () => {
    const block = stripComments(
      extractBlock(stagesSrc, "SUBREDDIT_CATEGORY = {", "{", "}"),
    );
    const pyMap: Record<string, string> = {};
    for (const m of block.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) {
      pyMap[m[1]] = m[2];
    }
    expect(pyMap).toEqual(SUBREDDIT_CATEGORY as Record<string, Cat>);
  });
});

describe("category manifest parity with globals.css tokens", () => {
  const cssSrc = readFileSync(findRepoFile("lorewire-app", "src", "app", "globals.css"), "utf-8");

  it("each category has a --color-cat-<slug> token matching its manifest color", () => {
    for (const def of CATEGORY_DEFS) {
      const match = cssSrc.match(
        new RegExp(`--color-cat-${def.slug}:\\s*(#[0-9A-Fa-f]{6})`),
      );
      expect(match, `missing --color-cat-${def.slug} in globals.css`).toBeTruthy();
      expect(match![1].toLowerCase()).toBe(def.color.toLowerCase());
    }
  });
});
