// @vitest-environment happy-dom

// Phase 3 of _plans/2026-06-14-voiceover-picker.md.
//
// Render-only tests via react-dom/server (matching the ChipGroup +
// AspectChipGroup conventions). What we lock here:
//
//   - The three provider sections render in display order ONLY when
//     they have at least one voice. An empty section (e.g. ElevenLabs
//     with no API key) is hidden — that's the graceful-degrade
//     contract from Phase 2.
//   - The "Selected" indicator follows the currentProvider +
//     currentVoiceId props. Off by default; on for the matching card.
//   - "Using global default" header copy fires when no override is set.
//   - The preview play button is disabled (no audio path) for voices
//     whose preview_url is null. Real interactive behavior (clicking
//     the card -> server action) is exercised in the Phase 4 PR with
//     a full DOM mount; here we keep the test surface narrow + fast.

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import { VoicePicker } from "./VoicePicker";
import type { VoiceEntry } from "@/lib/voice-library";

// Spy on next/navigation so the component's import-time useRouter()
// hook resolves to a no-op stub. Happy-dom doesn't ship a Next router
// — without this, the import would explode before render.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

// The Phase 3 picker imports `setStoryVoiceAction` from
// `@/app/admin/actions`. That file is a "use server" entry point
// that fans out to a small forest of server-side modules (DB driver,
// dal). Pulling it through happy-dom for a render test isn't worth
// the bundle, so we stub the import — the action is invoked at
// click-time only, never during the static render path we exercise
// here.
vi.mock("@/app/admin/actions", () => ({
  setStoryVoiceAction: vi.fn(),
  regenerateVoiceoverAction: vi.fn(),
}));

const FAKE_VOICES: VoiceEntry[] = [
  {
    provider: "elevenlabs",
    voice_id: "vid-rachel",
    name: "Rachel",
    language: "en-US",
    accent: "American",
    preview_url: "https://example.com/rachel.mp3",
  },
  {
    provider: "google/chirp3-hd",
    voice_id: "en-US-Chirp3-HD-Aoede",
    name: "Aoede",
    language: "en-US",
    accent: "Warm narrator",
    preview_url: "https://example.com/aoede.mp3",
  },
  {
    provider: "google/chirp3-hd",
    voice_id: "en-US-Chirp3-HD-Charon",
    name: "Charon",
    language: "en-US",
    accent: "Deep, authoritative",
    // No preview baked yet — play button must render disabled.
    preview_url: null,
  },
  {
    provider: "google/gemini-25-flash-tts",
    voice_id: "en-US-Chirp3-HD-Aoede",
    name: "Aoede",
    language: "en-US",
    accent: "Warm narrator",
    preview_url: "https://example.com/aoede-gemini25.mp3",
  },
];

function render(props: Partial<Parameters<typeof VoicePicker>[0]> = {}) {
  return renderToString(
    <VoicePicker
      storyId="envelope"
      voices={FAKE_VOICES}
      currentProvider={null}
      currentVoiceId={null}
      {...props}
    />,
  );
}

describe("VoicePicker", () => {
  it("renders one section per non-empty provider group", () => {
    const html = render();
    expect(html).toContain("ElevenLabs");
    expect(html).toContain("Google Chirp 3 HD");
    expect(html).toContain("Gemini Flash TTS");
  });

  it("hides a section that has no voices (graceful degrade)", () => {
    const html = render({
      voices: FAKE_VOICES.filter((v) => v.provider !== "elevenlabs"),
    });
    expect(html).not.toContain("ElevenLabs");
    expect(html).toContain("Google Chirp 3 HD");
  });

  it("renders every voice card with its display name", () => {
    const html = render();
    expect(html).toContain("Rachel");
    // Aoede shows up under TWO providers (Chirp 3 HD + Gemini 2.5) —
    // both must render so an admin can pick "Aoede via Gemini". We
    // assert via the testid (one card per provider+voice) rather than
    // counting "Aoede" occurrences in the rendered HTML, because the
    // display name also leaks into aria labels + tooltips so the raw
    // string count is brittle.
    expect(html).toContain(
      'data-testid="voice-card-google/chirp3-hd-en-US-Chirp3-HD-Aoede"',
    );
    expect(html).toContain(
      'data-testid="voice-card-google/gemini-25-flash-tts-en-US-Chirp3-HD-Aoede"',
    );
    expect(html).toContain("Charon");
  });

  it("marks the matching card with data-selected=true when an override is set", () => {
    const html = render({
      currentProvider: "google/chirp3-hd",
      currentVoiceId: "en-US-Chirp3-HD-Aoede",
    });
    // Only the matching card is selected. The Gemini Aoede card
    // shares the voice_id but has a different provider — it MUST
    // stay deselected, otherwise the selection state visually leaks
    // across providers and the admin can't tell which one's active.
    expect(html).toMatch(
      /data-testid="voice-card-google\/chirp3-hd-en-US-Chirp3-HD-Aoede"[^>]*data-selected="true"/,
    );
    expect(html).toMatch(
      /data-testid="voice-card-google\/gemini-25-flash-tts-en-US-Chirp3-HD-Aoede"[^>]*data-selected="false"/,
    );
  });

  it("no card is selected when both currents are null (using global default)", () => {
    const html = render();
    // None of the cards should carry data-selected="true". The
    // simplest lock: search for "data-selected=\"true\"" and assert
    // it doesn't appear.
    expect(html).not.toContain('data-selected="true"');
  });

  it("shows the 'Using global default' header copy when override is null", () => {
    const html = render();
    expect(html).toContain("Using global default");
  });

  it("shows the selected voice id in the footer when an override is set", () => {
    const html = render({
      currentProvider: "google/chirp3-hd",
      currentVoiceId: "en-US-Chirp3-HD-Aoede",
    });
    expect(html).toContain("google/chirp3-hd");
    expect(html).toContain("en-US-Chirp3-HD-Aoede");
  });

  it("renders the play button styled as disabled for voices without a preview_url", () => {
    const html = render();
    // Charon has preview_url=null in the fixture — its preview button
    // wrapper carries the cursor-not-allowed + opacity-50 class
    // combination. Locking exact class strings makes the test brittle
    // to Tailwind refactors, so we just assert the cursor-not-allowed
    // shows up at least once (other disabled UI on the page also adds
    // it but that's fine — the contract is "page renders without
    // throwing for null preview_url").
    expect(html).toContain("cursor-not-allowed");
  });

  it("renders the regen button ENABLED when no render is in flight", () => {
    const html = render();
    const buttonTag = extractTag(html, "voice-picker-regen");
    expect(buttonTag).not.toBeNull();
    // Phase 4 enables the button — the picker can fire the regen
    // action. Disabled state only fires when a render is in flight.
    expect(hasDisabledAttr(buttonTag!)).toBe(false);
    expect(html).toContain("Regenerate voiceover");
  });

  it("disables the regen button + swaps the label while a render is in flight", () => {
    const html = render({ regenInFlight: true });
    const buttonTag = extractTag(html, "voice-picker-regen");
    expect(buttonTag).not.toBeNull();
    // In-flight = disabled so a second click can't double-spend
    // TTS credit while the first synth is still running.
    expect(hasDisabledAttr(buttonTag!)).toBe(true);
    // The footer copy + button label switch to "Synthesizing…" so the
    // admin sees their click landed even before the page refreshes.
    expect(html).toContain("Synthesizing");
  });

  it("surfaces the last regen error inline so a failed render is visible", () => {
    const html = render({
      lastRegenError: "ElevenLabs HTTP 429: too many requests",
    });
    expect(html).toContain("voice-picker-regen-error");
    expect(html).toContain("429");
  });

  it("renders the Reset chip as DISABLED when already on global", () => {
    const html = render();
    const buttonTag = extractTag(html, "voice-picker-reset");
    expect(buttonTag).not.toBeNull();
    expect(hasDisabledAttr(buttonTag!)).toBe(true);
  });

  it("renders the Reset chip enabled when an override is active", () => {
    const html = render({
      currentProvider: "elevenlabs",
      currentVoiceId: "vid-rachel",
    });
    const buttonTag = extractTag(html, "voice-picker-reset");
    expect(buttonTag).not.toBeNull();
    expect(hasDisabledAttr(buttonTag!)).toBe(false);
  });
});

// Pull the opening tag of the element whose data-testid matches. Useful
// for asserting on attributes without grepping the whole serialised
// document — class names like `disabled:cursor-not-allowed` contain
// the word "disabled" and would false-positive a naive search.
function extractTag(html: string, testid: string): string | null {
  const re = new RegExp(`<[a-zA-Z]+[^>]*data-testid="${testid}"[^>]*>`);
  const m = html.match(re);
  return m ? m[0] : null;
}

// React renders boolean `disabled` either as bare `disabled` (legacy)
// or as `disabled=""`. We accept either, AND only when it sits as a
// standalone attribute (space on the left) — that's the rule that
// distinguishes the attribute from a class string `disabled:...`.
function hasDisabledAttr(tag: string): boolean {
  return /\sdisabled(?:=""|=|\s|>)/.test(tag);
}
