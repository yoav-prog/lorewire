// Voice catalog fetchers for the Settings page.
//
// Two providers, one shape: a list of `{ id, label, locale }` triples we can
// drop straight into a <select>. Calls are cached in-process for 1 hour
// (voices change rarely; a server restart re-warms). When credentials are
// missing or the upstream API errors, the helper returns an empty list and
// the Settings page falls back to a plain text input — never blocks the
// admin from configuring something just because the catalog couldn't load.
//
// Security (rule 13): credentials read from env only. No keys logged. Error
// objects from upstream are normalized to status code + first 200 chars of
// body so a stack trace can't leak the bearer token. The Google JWT pattern
// matches src/lib/sheets.ts byte-for-byte so future credential rotations
// touch one helper, not two.

import "server-only";
import { JWT } from "google-auth-library";

export interface VoiceOption {
  id: string;
  label: string;
  locale: string;
}

interface CacheEntry<T> {
  value: T;
  ts: number;
}

// Module-level cache. globalThis-attached so Next's per-route warm pools
// share state. Per-process; cleared on restart, which is fine for voice
// catalogs.
const CACHE_TTL_MS = 60 * 60 * 1000;
type CacheStore = Map<string, CacheEntry<unknown>>;
const cache: CacheStore = (() => {
  const g = globalThis as unknown as { __lwVoiceCache?: CacheStore };
  if (!g.__lwVoiceCache) g.__lwVoiceCache = new Map();
  return g.__lwVoiceCache;
})();

async function cached<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && now - hit.ts < CACHE_TTL_MS) return hit.value;
  const value = await fetcher();
  cache.set(key, { value, ts: now });
  return value;
}

// ─── Google Cloud Text-to-Speech ──────────────────────────────────────────────

function googleJwt(): JWT | null {
  const email = process.env.GOOGLE_TTS_CLIENT_EMAIL;
  const rawKey = process.env.GOOGLE_TTS_PRIVATE_KEY;
  if (!email || !rawKey) return null;
  // Same .env massage as sheets.ts: stored as literal `\n`, PEM needs real
  // newlines.
  const key = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
  return new JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
}

interface GoogleVoiceRaw {
  name: string;
  languageCodes?: string[];
  ssmlGender?: string;
  naturalSampleRateHertz?: number;
}

export async function listGoogleVoices(): Promise<VoiceOption[]> {
  return cached("google", async () => {
    const jwt = googleJwt();
    if (!jwt) {
      console.info("[voice providers] google credentials missing — using empty list");
      return [];
    }
    try {
      const tokenResp = await jwt.getAccessToken();
      const token = tokenResp?.token;
      if (!token) {
        console.warn("[voice providers] google token mint returned empty");
        return [];
      }
      const r = await fetch("https://texttospeech.googleapis.com/v1/voices", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const body = (await r.text()).slice(0, 200);
        console.warn("[voice providers] google list voices failed", {
          status: r.status,
          body,
        });
        return [];
      }
      const data = (await r.json()) as { voices?: GoogleVoiceRaw[] };
      const voices = data.voices ?? [];
      const options: VoiceOption[] = voices
        .map((v) => {
          const locale = v.languageCodes?.[0] ?? "";
          const gender = v.ssmlGender ? v.ssmlGender.toLowerCase() : "";
          const label = gender ? `${v.name} · ${gender}` : v.name;
          return { id: v.name, label, locale };
        })
        // Stable sort: locale then voice name. The page groups by locale so a
        // stable order across renders keeps the dropdown predictable.
        .sort((a, b) =>
          a.locale === b.locale
            ? a.id.localeCompare(b.id)
            : a.locale.localeCompare(b.locale),
        );
      console.info("[voice providers] google list voices", {
        count: options.length,
      });
      return options;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[voice providers] google list voices threw", { msg });
      return [];
    }
  });
}

// ─── ElevenLabs ───────────────────────────────────────────────────────────────

interface ElevenLabsVoiceRaw {
  voice_id: string;
  name: string;
  labels?: Record<string, string>;
  category?: string;
}

export async function listElevenLabsVoices(): Promise<VoiceOption[]> {
  return cached("elevenlabs", async () => {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) {
      console.info("[voice providers] elevenlabs credentials missing — using empty list");
      return [];
    }
    try {
      const r = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": key },
      });
      if (!r.ok) {
        const body = (await r.text()).slice(0, 200);
        console.warn("[voice providers] elevenlabs list voices failed", {
          status: r.status,
          body,
        });
        return [];
      }
      const data = (await r.json()) as { voices?: ElevenLabsVoiceRaw[] };
      const voices = data.voices ?? [];
      const options: VoiceOption[] = voices
        .map((v) => {
          const accent = v.labels?.accent;
          const gender = v.labels?.gender;
          const tags = [gender, accent, v.category].filter(Boolean).join(" · ");
          const label = tags ? `${v.name} · ${tags}` : v.name;
          return { id: v.voice_id, label, locale: accent ?? "" };
        })
        .sort((a, b) => a.label.localeCompare(b.label));
      console.info("[voice providers] elevenlabs list voices", {
        count: options.length,
      });
      return options;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[voice providers] elevenlabs list voices threw", { msg });
      return [];
    }
  });
}

// Test-only: drop the cache so tests can re-stub fetchers. Not exported from
// the production bundle path; do not call from app code.
export function _resetVoiceCache(): void {
  cache.clear();
}
