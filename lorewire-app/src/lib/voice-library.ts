// Phase 2 of _plans/2026-06-14-voiceover-picker.md.
//
// Returns the catalog of voices the picker UI surfaces. Three providers,
// each with its own discovery strategy:
//
//   - ElevenLabs: live GET /v1/voices. The API response already carries
//     a `preview_url` per voice (a hosted 6-10s sample) so we can wire the
//     UI's <audio> play button without paying for a synth. Falls back to
//     [] when ELEVENLABS_API_KEY is missing — the picker simply omits the
//     section rather than rendering a broken state.
//
//   - Google Chirp 3 HD: hardcoded curated list (the API doesn't return
//     audition clips). preview_url points at a GCS object we lazily bake
//     once per (provider, voice_id) using pipeline/voice.py's synthesize
//     helper with a fixed short sample. The bake step itself lives in a
//     separate one-off script (Phase 2.b); listVoices() returns the
//     constructed URL whether or not the file exists yet so the UI can
//     show a "loading" state on first play of an unbaked voice.
//
//   - Gemini Flash TTS: same voice names as Chirp 3 HD but separate
//     provider key because the Gemini API expressive control changes the
//     timbre even when the voice name matches. Preview URL points at a
//     parallel GCS folder so the bake doesn't collide.
//
// Memoization: 24h server-side. The ElevenLabs library changes rarely
// (~once a quarter) and the Google/Gemini sets are hardcoded; a stale
// cache is cheaper than hitting ElevenLabs on every picker open.

import "server-only";

export type VoiceProvider =
  | "elevenlabs"
  | "google/chirp3-hd"
  | "google/gemini-25-flash-tts"
  | "google/gemini-31-flash-tts";

export interface VoiceEntry {
  provider: VoiceProvider;
  /** Provider-native id. ElevenLabs: GUID (e.g. "21m00Tcm4TlvDq8ikWAM").
   *  Google + Gemini: full Chirp 3 HD voice name
   *  (e.g. "en-US-Chirp3-HD-Aoede"). */
  voice_id: string;
  /** Human-friendly display name for the picker. */
  name: string;
  /** Language tag in BCP 47 form (e.g. "en-US", "en-GB"). */
  language: string;
  /** Short accent / style descriptor for the card subtitle. */
  accent?: string;
  /** Short MP3 sample URL. Null when no preview is available yet (Google
   *  voices that haven't been baked into GCS — the picker should disable
   *  the play button or trigger an on-demand bake). */
  preview_url: string | null;
}

// 24h: the ElevenLabs catalog changes roughly quarterly, the hardcoded
// Google sets never change without a code deploy, so this TTL is a
// comfortable balance between freshness and rate-limit pressure on
// ElevenLabs. Exported as MS for tests to override.
export const VOICE_LIBRARY_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  voices: VoiceEntry[];
  fetchedAt: number;
}

declare global {
  // Stored on globalThis so dev HMR doesn't blow away the cache on every
  // file save. The pattern matches the GCS access-token cache in
  // lib/gcs.ts. Reset by setting `__lwVoiceLibraryCache = undefined`
  // (tests do exactly that).
  // eslint-disable-next-line no-var
  var __lwVoiceLibraryCache: CacheEntry | undefined;
}

/** Override hooks for tests. Production code never passes these. */
export interface ListVoicesOpts {
  /** Force a refresh ignoring the cache. Tests set this when they want
   *  to assert the live fetch path; production callers omit. */
  forceRefresh?: boolean;
  /** Override the cache TTL. Tests use a few ms; production omits. */
  ttlMs?: number;
}

export async function listVoices(
  opts: ListVoicesOpts = {},
): Promise<VoiceEntry[]> {
  const ttlMs = opts.ttlMs ?? VOICE_LIBRARY_TTL_MS;
  const now = Date.now();
  if (!opts.forceRefresh && globalThis.__lwVoiceLibraryCache) {
    const age = now - globalThis.__lwVoiceLibraryCache.fetchedAt;
    if (age < ttlMs) {
      console.info("[voice library] cache hit", {
        age_ms: age,
        count: globalThis.__lwVoiceLibraryCache.voices.length,
      });
      return globalThis.__lwVoiceLibraryCache.voices;
    }
    console.info("[voice library] cache expired", { age_ms: age });
  } else if (opts.forceRefresh) {
    console.info("[voice library] cache bypass (forceRefresh)");
  } else {
    console.info("[voice library] cache miss");
  }

  const [elevenlabs, chirp3, gemini25, gemini31] = await Promise.all([
    listElevenLabs(),
    Promise.resolve(listGoogleChirp3HD()),
    Promise.resolve(listGoogleGemini("google/gemini-25-flash-tts")),
    Promise.resolve(listGoogleGemini("google/gemini-31-flash-tts")),
  ]);

  const voices: VoiceEntry[] = [
    ...elevenlabs,
    ...chirp3,
    ...gemini25,
    ...gemini31,
  ];
  globalThis.__lwVoiceLibraryCache = { voices, fetchedAt: now };
  console.info("[voice library] refresh", {
    elevenlabs: elevenlabs.length,
    chirp3_hd: chirp3.length,
    gemini_25: gemini25.length,
    gemini_31: gemini31.length,
    total: voices.length,
  });
  return voices;
}

/** Reset the in-memory cache. Exported for tests AND for the Phase 4
 *  admin "Refresh voice library" action when a new ElevenLabs voice is
 *  added mid-day and the admin doesn't want to wait for TTL expiry. */
export function clearVoiceLibraryCache(): void {
  globalThis.__lwVoiceLibraryCache = undefined;
}

// ─── ElevenLabs ─────────────────────────────────────────────────────────────

interface ElevenLabsVoice {
  voice_id?: string;
  name?: string;
  preview_url?: string;
  labels?: {
    accent?: string;
    description?: string;
    gender?: string;
    age?: string;
    use_case?: string;
  };
  // ElevenLabs voices don't always return a language tag; we fall back
  // to en-US in the absence of one because every published voice they
  // ship today is English. Adjust if non-English voices land in the
  // listing.
  language?: string;
}

async function listElevenLabs(): Promise<VoiceEntry[]> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    console.info("[voice library] elevenlabs skipped (no api key)");
    return [];
  }
  try {
    const resp = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key },
      // The voices list endpoint is light; a 10s timeout is generous.
      // We don't retry — a transient ElevenLabs blip just hides the
      // section until the next picker open.
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn("[voice library] elevenlabs HTTP error", {
        status: resp.status,
      });
      return [];
    }
    const data = (await resp.json()) as { voices?: ElevenLabsVoice[] };
    const out: VoiceEntry[] = [];
    for (const v of data.voices ?? []) {
      if (!v.voice_id || !v.name) continue;
      out.push({
        provider: "elevenlabs",
        voice_id: v.voice_id,
        name: v.name,
        language: v.language ?? "en-US",
        accent: v.labels?.accent ?? v.labels?.description,
        preview_url: v.preview_url ?? null,
      });
    }
    return out;
  } catch (e) {
    console.warn("[voice library] elevenlabs fetch failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

// ─── Google Chirp 3 HD ──────────────────────────────────────────────────────

// Curated set of Google Chirp 3 HD voices known to narrate well at
// article-length text. The full Chirp 3 HD catalog is ~30 voices but
// most are tuned for short-form (digital assistant) prompts — these nine
// hold up across 2-3 minute narrations. Autonoe is first because it is
// the codified house shorts narrator (pipeline/shorts_narration.py
// SHORTS_VOICE_NAME).
//
// VERIFY-BEFORE-PHASE-3: each entry's voice_id MUST match a real Google
// Chirp 3 HD voice name. Run a single TTS call against each id at deploy
// time (or the bake script lands first) — Google rejects unknown names
// with a 400, so the bake is the integration test for this list.
const GOOGLE_CHIRP3_HD_VOICES: ReadonlyArray<{
  voice_id: string;
  name: string;
  accent: string;
}> = [
  { voice_id: "en-US-Chirp3-HD-Autonoe", name: "Autonoe", accent: "Warm, even-paced (house voice)" },
  { voice_id: "en-US-Chirp3-HD-Aoede", name: "Aoede", accent: "Warm narrator" },
  { voice_id: "en-US-Chirp3-HD-Charon", name: "Charon", accent: "Deep, authoritative" },
  { voice_id: "en-US-Chirp3-HD-Fenrir", name: "Fenrir", accent: "Dramatic, low" },
  { voice_id: "en-US-Chirp3-HD-Kore", name: "Kore", accent: "Clear, even" },
  { voice_id: "en-US-Chirp3-HD-Leda", name: "Leda", accent: "Soft, gentle" },
  { voice_id: "en-US-Chirp3-HD-Puck", name: "Puck", accent: "Playful, lighter" },
  { voice_id: "en-US-Chirp3-HD-Achernar", name: "Achernar", accent: "Neutral, steady" },
  { voice_id: "en-US-Chirp3-HD-Vindemiatrix", name: "Vindemiatrix", accent: "Warm, conversational" },
];

function listGoogleChirp3HD(): VoiceEntry[] {
  return GOOGLE_CHIRP3_HD_VOICES.map((v) => ({
    provider: "google/chirp3-hd" as const,
    voice_id: v.voice_id,
    name: v.name,
    language: "en-US",
    accent: v.accent,
    preview_url: previewUrlFor("google/chirp3-hd", v.voice_id),
  }));
}

// ─── Gemini Flash TTS ───────────────────────────────────────────────────────

// Same voice catalog as Chirp 3 HD (Google reuses the names); Gemini
// only differs in expressive control via voice.google_style_prompt.
// The picker shows them as a separate provider so the admin can pick
// "Aoede via Gemini-2.5" vs "Aoede via Chirp 3 HD" — the timbre is
// the same but the expressive layer is different.
function listGoogleGemini(
  provider: "google/gemini-25-flash-tts" | "google/gemini-31-flash-tts",
): VoiceEntry[] {
  return GOOGLE_CHIRP3_HD_VOICES.map((v) => ({
    provider,
    voice_id: v.voice_id,
    name: v.name,
    language: "en-US",
    accent: v.accent,
    preview_url: previewUrlFor(provider, v.voice_id),
  }));
}

// ─── Preview URL construction ───────────────────────────────────────────────

// Build the GCS URL where the lazy-baked preview MP3 lives. We don't
// HEAD-check existence here — that would mean an extra round trip per
// voice on every cache miss. The picker's <audio> element surfaces a
// 404 cleanly, and Phase 2.b's bake script populates the missing
// objects. Returns null when GCS isn't configured (dev without a
// bucket) so the UI can hide the play button instead of trying to play
// a broken URL.
function previewUrlFor(
  provider: VoiceProvider,
  voice_id: string,
): string | null {
  const bucket = process.env.GCS_BUCKET;
  if (!bucket) return null;
  // URL-safe segment for the provider — we keep the forward-slash
  // hierarchy in the folder structure (`google/chirp3-hd/`) so the GCS
  // object browser groups them logically, but we encode the segment
  // here so a future provider key with characters like `+` doesn't
  // corrupt the URL.
  const providerSegment = provider
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  const idSegment = encodeURIComponent(voice_id);
  return `https://storage.googleapis.com/${encodeURIComponent(bucket)}/voice-previews/${providerSegment}/${idSegment}.mp3`;
}

// Exported for the Phase 2.b bake script + tests — the script needs to
// know exactly where to write so listVoices() can find it.
export function _previewUrlFor(
  provider: VoiceProvider,
  voice_id: string,
): string | null {
  return previewUrlFor(provider, voice_id);
}
