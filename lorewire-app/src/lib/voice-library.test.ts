// Phase 2 of _plans/2026-06-14-voiceover-picker.md.
//
// Covers:
//   - listVoices() returns the right per-provider counts when keys exist.
//   - ElevenLabs section degrades cleanly (returns []) when the API key
//     is missing OR the live fetch errors. The picker shows a section
//     header per provider; an empty section is the contract for "no
//     voices available right now".
//   - 24h cache: hit, miss-on-expiry, force-refresh bypass.
//   - Google + Gemini preview URLs point at the right GCS path.
//   - Google + Gemini lists have the SAME voice ids (Gemini reuses the
//     Chirp 3 HD voice name catalog). This is a parity guard — drift
//     between the two would mean an admin picks "Aoede via Gemini" and
//     gets a Gemini error because the voice id was hallucinated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearVoiceLibraryCache,
  listVoices,
  _previewUrlFor,
  type VoiceEntry,
} from "./voice-library";

const FAKE_ELEVENLABS_VOICES = {
  voices: [
    {
      voice_id: "vid-rachel",
      name: "Rachel",
      preview_url: "https://elevenlabs.example/rachel.mp3",
      labels: { accent: "american" },
    },
    {
      voice_id: "vid-domi",
      name: "Domi",
      preview_url: "https://elevenlabs.example/domi.mp3",
      labels: { description: "strong" },
    },
  ],
};

function mockEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      vi.stubEnv(k, "");
    } else {
      vi.stubEnv(k, v);
    }
  }
}

describe("listVoices", () => {
  beforeEach(() => {
    clearVoiceLibraryCache();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    clearVoiceLibraryCache();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns ElevenLabs + Chirp3 + Gemini-25 + Gemini-31 sections when keys + bucket are set", async () => {
    mockEnv({
      ELEVENLABS_API_KEY: "test-key",
      GCS_BUCKET: "test-bucket",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(FAKE_ELEVENLABS_VOICES), { status: 200 }),
    );
    const voices = await listVoices({ forceRefresh: true });
    const byProvider = countByProvider(voices);
    expect(byProvider.elevenlabs).toBe(2);
    // Hardcoded Google list is 9 voices (Autonoe, the house shorts voice,
    // plus 8 narration picks); same set reused for both Gemini variants.
    // Locked here because adding/removing a voice ought to be a deliberate
    // code change with a test update.
    expect(byProvider["google/chirp3-hd"]).toBe(9);
    expect(byProvider["google/gemini-25-flash-tts"]).toBe(9);
    expect(byProvider["google/gemini-31-flash-tts"]).toBe(9);
    expect(voices).toHaveLength(2 + 9 + 9 + 9);
  });

  it("drops the ElevenLabs section when the API key is missing", async () => {
    mockEnv({ ELEVENLABS_API_KEY: undefined, GCS_BUCKET: "test-bucket" });
    // No fetch should fire — the no-key short-circuit returns [].
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const voices = await listVoices({ forceRefresh: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    const byProvider = countByProvider(voices);
    expect(byProvider.elevenlabs).toBeUndefined();
    // Other providers still surface — graceful degrade is per-section.
    expect(byProvider["google/chirp3-hd"]).toBe(9);
  });

  it("drops the ElevenLabs section when the live fetch returns non-200", async () => {
    mockEnv({
      ELEVENLABS_API_KEY: "test-key",
      GCS_BUCKET: "test-bucket",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );
    const voices = await listVoices({ forceRefresh: true });
    expect(countByProvider(voices).elevenlabs).toBeUndefined();
    // Google sections unaffected — section failures are isolated.
    expect(countByProvider(voices)["google/chirp3-hd"]).toBe(9);
  });

  it("drops the ElevenLabs section when fetch throws (network error)", async () => {
    mockEnv({
      ELEVENLABS_API_KEY: "test-key",
      GCS_BUCKET: "test-bucket",
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED"),
    );
    const voices = await listVoices({ forceRefresh: true });
    expect(countByProvider(voices).elevenlabs).toBeUndefined();
    expect(countByProvider(voices)["google/chirp3-hd"]).toBe(9);
  });

  it("caches the result and serves the cached list on subsequent calls", async () => {
    mockEnv({
      ELEVENLABS_API_KEY: "test-key",
      GCS_BUCKET: "test-bucket",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(FAKE_ELEVENLABS_VOICES), { status: 200 }),
      );

    // First call populates cache.
    const first = await listVoices();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call hits cache — ElevenLabs is NOT re-fetched.
    const second = await listVoices();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("re-fetches when forceRefresh is true even with a warm cache", async () => {
    mockEnv({
      ELEVENLABS_API_KEY: "test-key",
      GCS_BUCKET: "test-bucket",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(FAKE_ELEVENLABS_VOICES), { status: 200 }),
      );

    await listVoices();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await listVoices({ forceRefresh: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after TTL expiry", async () => {
    mockEnv({
      ELEVENLABS_API_KEY: "test-key",
      GCS_BUCKET: "test-bucket",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(FAKE_ELEVENLABS_VOICES), { status: 200 }),
      );

    // 1 ms TTL forces every call to bypass the cache — proves the TTL
    // path actually fires, not just that forceRefresh works.
    await listVoices({ ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    await listVoices({ ttlMs: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("preview URL", () => {
  beforeEach(() => {
    clearVoiceLibraryCache();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    clearVoiceLibraryCache();
    vi.unstubAllEnvs();
  });

  it("constructs a GCS URL grouped by provider segments", () => {
    mockEnv({ GCS_BUCKET: "test-bucket" });
    const url = _previewUrlFor(
      "google/chirp3-hd",
      "en-US-Chirp3-HD-Aoede",
    );
    // We rely on the picker's <audio> element pointing at the same
    // bucket the bake script writes to. Lock the path shape so the
    // two sides can't silently disagree.
    expect(url).toBe(
      "https://storage.googleapis.com/test-bucket/voice-previews/google/chirp3-hd/en-US-Chirp3-HD-Aoede.mp3",
    );
  });

  it("returns null when GCS_BUCKET is missing (dev without bucket)", () => {
    mockEnv({ GCS_BUCKET: undefined });
    // Empty string here matches what vi.stubEnv() does with undefined —
    // process.env values are always strings. The library treats
    // empty-string GCS_BUCKET as "not configured" so an admin clearing
    // the var in .env.local doesn't poison the URL builder.
    expect(
      _previewUrlFor("google/gemini-25-flash-tts", "en-US-Chirp3-HD-Aoede"),
    ).toBeNull();
  });

  it("keeps Gemini's preview path separate from Chirp3-HD's", () => {
    mockEnv({ GCS_BUCKET: "test-bucket" });
    const chirp = _previewUrlFor(
      "google/chirp3-hd",
      "en-US-Chirp3-HD-Aoede",
    );
    const gemini = _previewUrlFor(
      "google/gemini-25-flash-tts",
      "en-US-Chirp3-HD-Aoede",
    );
    expect(chirp).not.toEqual(gemini);
    expect(chirp).toContain("/chirp3-hd/");
    expect(gemini).toContain("/gemini-25-flash-tts/");
  });
});

describe("provider parity", () => {
  beforeEach(() => {
    clearVoiceLibraryCache();
    vi.unstubAllEnvs();
  });

  it("Chirp3-HD and Gemini variants share the same voice id catalog", async () => {
    mockEnv({
      ELEVENLABS_API_KEY: undefined,
      GCS_BUCKET: "test-bucket",
    });
    const voices = await listVoices({ forceRefresh: true });
    const ids = (provider: string) =>
      voices
        .filter((v) => v.provider === provider)
        .map((v) => v.voice_id)
        .sort();
    const chirp3 = ids("google/chirp3-hd");
    const gemini25 = ids("google/gemini-25-flash-tts");
    const gemini31 = ids("google/gemini-31-flash-tts");
    expect(gemini25).toEqual(chirp3);
    expect(gemini31).toEqual(chirp3);
  });
});

function countByProvider(voices: VoiceEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of voices) {
    out[v.provider] = (out[v.provider] ?? 0) + 1;
  }
  return out;
}
