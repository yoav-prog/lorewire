// @vitest-environment happy-dom

// Tests for the PosterMeta corner chips
// (_plans/2026-07-02-poster-meta-corner-split.md). The old inline
// badges let a long granular label ("Money & Inheritance") wrap into
// the top-right duration badge on 132px mobile posters; these tests
// pin the properties that prevent a regression:
//   - the category chip is single-line (truncate) and width-capped so
//     it can never wrap or spill past the card edge
//   - the duration chip is anchored bottom-right, off the category row
//   - each chip renders only when its value is present
//   - the chip is colour-keyed to the category, with the neutral
//     fallback for labels the taxonomy doesn't know

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import PosterMeta from "@/components/PosterMeta";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(ui: React.ReactElement): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** The category chip is the truncating span; the duration chip is the
 *  tabular-nums div. Selecting by those classes keeps the tests
 *  independent of DOM order. */
function categoryChip(el: HTMLElement): HTMLElement | null {
  return el.querySelector(".truncate");
}
function durationChip(el: HTMLElement): HTMLElement | null {
  return el.querySelector(".tabular-nums");
}

describe("PosterMeta", () => {
  it("renders both chips when category and duration are present", () => {
    const el = render(<PosterMeta cat="Money & Inheritance" dur="0:57" />);
    expect(categoryChip(el)?.textContent).toBe("Money & Inheritance");
    expect(durationChip(el)?.textContent).toBe("0:57");
  });

  it("keeps the category on a single truncating line capped to the card width", () => {
    const el = render(<PosterMeta cat="Malicious Compliance" dur="1:12" />);
    const chip = categoryChip(el);
    expect(chip).not.toBeNull();
    // truncate = whitespace-nowrap + overflow-hidden + ellipsis: the
    // one-line guarantee that fixes the mobile wrap.
    expect(chip!.className).toContain("truncate");
    expect(chip!.parentElement!.className).toContain("max-w-[calc(100%-16px)]");
  });

  it("anchors the chips to opposite corners so they cannot collide", () => {
    const el = render(<PosterMeta cat="Friendship Fallouts" dur="0:54" />);
    const catBox = categoryChip(el)!.parentElement!;
    expect(catBox.className).toContain("left-2");
    expect(catBox.className).toContain("top-2");
    const dur = durationChip(el)!;
    expect(dur.className).toContain("right-2");
    expect(dur.className).toContain("bottom-2");
  });

  it("keys the chip border to the category colour", () => {
    const el = render(<PosterMeta cat="Money & Inheritance" dur="0:57" />);
    // #8A7A2E from GRANULAR_CATEGORIES; happy-dom may serialise as hex or rgb.
    expect(categoryChip(el)!.style.borderLeft).toMatch(/#8a7a2e|rgb\(138,\s*122,\s*46\)/i);
  });

  it("falls back to the neutral colour for an unknown category", () => {
    const el = render(<PosterMeta cat="Brand New Admin Category" dur="0:30" />);
    const chip = categoryChip(el)!;
    expect(chip.textContent).toBe("Brand New Admin Category");
    expect(chip.style.borderLeft).toMatch(/#6b6b6b|rgb\(107,\s*107,\s*107\)/i);
  });

  it("renders nothing for an absent or empty value", () => {
    const el = render(<PosterMeta cat="" dur="" />);
    expect(categoryChip(el)).toBeNull();
    expect(durationChip(el)).toBeNull();
  });

  it("renders duration alone when the category chip is suppressed (kicker=false)", () => {
    const el = render(<PosterMeta dur="2:14" />);
    expect(categoryChip(el)).toBeNull();
    expect(durationChip(el)?.textContent).toBe("2:14");
  });
});
