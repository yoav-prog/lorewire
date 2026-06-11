// @vitest-environment happy-dom

// Rendering test for the SettingsShell. Verifies the sub-nav contains all
// three categories regardless of which is active, and that the active one
// gets aria-current="page" so screen readers and the visual highlight stay
// in sync.

import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import SettingsShell from "./SettingsShell";

describe("SettingsShell", () => {
  it("renders all four sub-nav entries", () => {
    const html = renderToString(
      <SettingsShell active="general" title="General">
        <p>Body</p>
      </SettingsShell>,
    );
    expect(html).toContain("General");
    expect(html).toContain("Models");
    expect(html).toContain("SEO");
    // React renders the literal '&' as the HTML entity '&amp;'.
    expect(html).toContain("Intros &amp; outros");
    // Captions is intentionally absent from the sub-nav (Phase 3 moves it
    // into the video editor).
    expect(html).not.toContain(">Captions<");
  });

  it("marks the active entry with aria-current=page", () => {
    const generalHtml = renderToString(
      <SettingsShell active="general" title="General">
        <p>Body</p>
      </SettingsShell>,
    );
    const modelsHtml = renderToString(
      <SettingsShell active="models" title="Models">
        <p>Body</p>
      </SettingsShell>,
    );
    const seoHtml = renderToString(
      <SettingsShell active="seo" title="SEO">
        <p>Body</p>
      </SettingsShell>,
    );
    const introsHtml = renderToString(
      <SettingsShell active="intros" title="Intros & outros">
        <p>Body</p>
      </SettingsShell>,
    );

    // Each render has exactly one aria-current="page" — the active entry.
    expect(
      (generalHtml.match(/aria-current="page"/g) ?? []).length,
    ).toBe(1);
    expect((modelsHtml.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect((seoHtml.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect((introsHtml.match(/aria-current="page"/g) ?? []).length).toBe(1);

    // And the right entry is highlighted in each case.
    expect(generalHtml).toMatch(/aria-current="page"[^<]*<span[^>]*>\s*General/);
    expect(modelsHtml).toMatch(/aria-current="page"[^<]*<span[^>]*>\s*Models/);
    expect(seoHtml).toMatch(/aria-current="page"[^<]*<span[^>]*>\s*SEO/);
    expect(introsHtml).toMatch(
      /aria-current="page"[^<]*<span[^>]*>\s*Intros &amp; outros/,
    );
  });

  it("renders the title, optional description, and children", () => {
    const html = renderToString(
      <SettingsShell
        active="general"
        title="General"
        description="Pipeline defaults"
      >
        <p data-testid="body">Body content</p>
      </SettingsShell>,
    );
    expect(html).toContain("General");
    expect(html).toContain("Pipeline defaults");
    expect(html).toContain("Body content");
  });

  it("links each entry to its canonical URL", () => {
    const html = renderToString(
      <SettingsShell active="general" title="General">
        <p>Body</p>
      </SettingsShell>,
    );
    expect(html).toMatch(/href="\/admin\/settings"/);
    expect(html).toMatch(/href="\/admin\/models"/);
    expect(html).toMatch(/href="\/admin\/seo"/);
    expect(html).toMatch(/href="\/admin\/segments"/);
  });
});
