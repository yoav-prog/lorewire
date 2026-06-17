// @vitest-environment happy-dom

// Smoke tests for the hero-style picker. Pins the visible contract:
//   - All 6 styles render as cards with their labels.
//   - The selected card carries data-selected="true" (CSS hook + a11y).
//   - Auto card surfaces only when includeAutoOption=true.
//   - Thumbnail URLs render as <img>; null shows a "preview pending"
//     placeholder so the picker stays usable before step 3 has been run.
//   - The hidden settings-key input is present so the form persists
//     into the right setting on save.
//   - Caption surfaces the resolved style label / "auto" copy so the
//     admin can see WHY a layer landed on this value.
//
// The save-action plumbing itself is exercised by saveSettingAction's
// own validators; this file pins the picker's rendered surface.

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { HeroStylePicker } from "./HeroStylePicker";
import { HERO_STYLES } from "@/lib/hero-styles";

vi.mock("@/app/admin/actions", () => ({
  saveSettingAction: vi.fn(async () => undefined),
}));

const ALL_STYLES_WITH_URLS = Object.fromEntries(
  HERO_STYLES.map((s) => [s.id, `https://gcs.fake/hero-style-thumbnails/${s.id}.png`]),
) as Record<string, string>;

const NO_THUMBNAILS = Object.fromEntries(
  HERO_STYLES.map((s) => [s.id, null]),
) as Record<string, null>;

describe("HeroStylePicker", () => {
  it("renders one card per HERO_STYLES entry, each with its label", () => {
    const html = renderToString(
      <HeroStylePicker
        settingKey="hero.global_style_id"
        label="Global default"
        selectedId=""
        thumbnails={ALL_STYLES_WITH_URLS}
        includeAutoOption
      />,
    );
    for (const style of HERO_STYLES) {
      expect(
        html,
        `style card for ${style.id} should render`,
      ).toContain(`data-testid="hero-style-card-${style.id}"`);
      expect(html).toContain(style.label);
    }
  });

  it("marks the currently-selected card with data-selected=\"true\"", () => {
    const html = renderToString(
      <HeroStylePicker
        settingKey="hero.global_style_id"
        label="Global default"
        selectedId="neo_noir"
        thumbnails={ALL_STYLES_WITH_URLS}
        includeAutoOption
      />,
    );
    // Selected card carries the selected marker; every other card
    // explicitly carries selected=false (no accidental "always selected"
    // path).
    const selectedCount = (html.match(/data-selected="true"/g) ?? []).length;
    expect(selectedCount).toBe(1);
    expect(html).toContain('data-testid="hero-style-card-neo_noir"');
    // The neo_noir block is the one with selected=true. Verify by
    // checking the substring proximity.
    const neoNoirIdx = html.indexOf('data-testid="hero-style-card-neo_noir"');
    const nextSelected = html.indexOf('data-selected="true"', neoNoirIdx - 200);
    expect(nextSelected).toBeGreaterThan(0);
    expect(nextSelected).toBeLessThan(neoNoirIdx + 200);
  });

  it("renders the auto card only when includeAutoOption is true", () => {
    const withAuto = renderToString(
      <HeroStylePicker
        settingKey="hero.global_style_id"
        label="Global default"
        selectedId=""
        thumbnails={ALL_STYLES_WITH_URLS}
        includeAutoOption
        autoOptionLabel="Auto-pick per category"
      />,
    );
    expect(withAuto).toContain('data-testid="hero-style-card-auto"');
    expect(withAuto).toContain("Auto-pick per category");

    const withoutAuto = renderToString(
      <HeroStylePicker
        settingKey="hero.global_style_id"
        label="Global default"
        selectedId="neo_noir"
        thumbnails={ALL_STYLES_WITH_URLS}
        includeAutoOption={false}
      />,
    );
    expect(withoutAuto).not.toContain('data-testid="hero-style-card-auto"');
  });

  it("marks the auto card as selected when selectedId is empty", () => {
    const html = renderToString(
      <HeroStylePicker
        settingKey="hero.global_style_id"
        label="Global default"
        selectedId=""
        thumbnails={ALL_STYLES_WITH_URLS}
        includeAutoOption
      />,
    );
    const autoIdx = html.indexOf('data-testid="hero-style-card-auto"');
    expect(autoIdx).toBeGreaterThan(0);
    const nextSelected = html.indexOf('data-selected="true"', autoIdx - 200);
    expect(nextSelected).toBeGreaterThan(0);
    expect(nextSelected).toBeLessThan(autoIdx + 200);
  });

  it("renders <img src> when a thumbnail URL is present", () => {
    const html = renderToString(
      <HeroStylePicker
        settingKey="hero.global_style_id"
        label="Global default"
        selectedId="neo_noir"
        thumbnails={ALL_STYLES_WITH_URLS}
        includeAutoOption={false}
      />,
    );
    expect(html).toContain(ALL_STYLES_WITH_URLS["neo_noir"]);
    // No "preview pending" placeholder while URLs are populated.
    expect(html).not.toContain("preview pending");
  });

  it("shows a 'preview pending' placeholder when the thumbnail URL is null", () => {
    const html = renderToString(
      <HeroStylePicker
        settingKey="hero.global_style_id"
        label="Global default"
        selectedId=""
        thumbnails={NO_THUMBNAILS}
        includeAutoOption
      />,
    );
    // One placeholder per style.
    const placeholderCount = (html.match(/preview pending/gi) ?? []).length;
    expect(placeholderCount).toBe(HERO_STYLES.length);
  });

  it("carries the hidden settings key so the form posts the right key", () => {
    const html = renderToString(
      <HeroStylePicker
        settingKey="hero.category_default.drama"
        label="Drama default"
        selectedId="neo_noir"
        thumbnails={ALL_STYLES_WITH_URLS}
        includeAutoOption
      />,
    );
    expect(html).toContain('name="key"');
    expect(html).toContain('value="hero.category_default.drama"');
  });

  it("captions a populated selection with the style label", () => {
    const html = renderToString(
      <HeroStylePicker
        settingKey="hero.global_style_id"
        label="Global default"
        selectedId="painted_realism"
        thumbnails={ALL_STYLES_WITH_URLS}
        includeAutoOption
      />,
    );
    // Caption mentions the human-friendly label so the admin doesn't
    // have to read the snake_case id.
    const paintedRealism = HERO_STYLES.find((s) => s.id === "painted_realism");
    expect(paintedRealism).toBeDefined();
    expect(html).toContain(paintedRealism!.label);
  });

  it("captions an empty selection with the fall-through copy", () => {
    const html = renderToString(
      <HeroStylePicker
        settingKey="hero.global_style_id"
        label="Global default"
        selectedId=""
        thumbnails={ALL_STYLES_WITH_URLS}
        includeAutoOption
      />,
    );
    expect(html).toContain("Falls through to the next layer");
  });

  it("honors captionOverride when supplied", () => {
    const html = renderToString(
      <HeroStylePicker
        settingKey="hero.global_style_id"
        label="Global default"
        selectedId="neo_noir"
        thumbnails={ALL_STYLES_WITH_URLS}
        includeAutoOption
        captionOverride="Auto-picked from the Drama short-list (neo_noir, painted_realism)"
      />,
    );
    expect(html).toContain("Auto-picked from the Drama short-list");
    // Default caption replaced; not present.
    expect(html).not.toContain("Pinned to");
  });

  it("renders the requested save button label", () => {
    const html = renderToString(
      <HeroStylePicker
        settingKey="hero.global_style_id"
        label="Global default"
        selectedId=""
        thumbnails={ALL_STYLES_WITH_URLS}
        includeAutoOption
        saveLabel="Apply"
      />,
    );
    expect(html).toContain(">Apply<");
  });
});
