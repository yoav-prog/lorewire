"use client";

// Phase 3 of _plans/2026-06-14-voiceover-picker.md.
//
// Shared component used by both the story-detail page AND the editor's
// AUDIO tab (Phase 4). Three sections, one per provider, each a
// scrollable row of voice cards. A single shared <audio> element plays
// the preview MP3 of whichever card was clicked last — so a second
// click stops the first cleanly without needing per-card refs.
//
// Selection is auto-save: clicking a voice card fires the server action
// immediately (no separate "Save voice" button). The rationale is rule
// 10 (build for a lazy user): the user clicks the voice they want and
// it's done. Pending state is shown via the useTransition hook so the
// card flashes a "Saving…" badge during the round trip.
//
// "Use global default" is a top-level reset chip. It submits the form
// with empty provider/voice_id, which the server action interprets as
// a NULL write on both columns — the resolution chain in
// pipeline/voice.py:synthesize then falls back to the admin's global
// setting.
//
// The "Regenerate voiceover" button at the bottom is wired in Phase 4.
// It ships disabled here with a tooltip so the picker UI lands before
// the queue + worker side is ready.

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  setStoryVoiceAction,
  regenerateVoiceoverAction,
} from "@/app/admin/actions";
import type { VoiceEntry, VoiceProvider } from "@/lib/voice-library";

export interface VoicePickerProps {
  /** Story whose voice override is being edited. */
  storyId: string;
  /** Full voice catalog from listVoices() — passed in from the server
   *  so the picker is a pure presentation component (easier to test). */
  voices: VoiceEntry[];
  /** Currently-persisted override on `stories.voice_provider`. NULL
   *  when the story uses the global default; in that case no card
   *  shows a "Selected" indicator. */
  currentProvider: string | null;
  /** Currently-persisted override on `stories.voice_id`. */
  currentVoiceId: string | null;
  /** True when a queued OR processing voice_render row exists for this
   *  story. The regen button is disabled while in-flight and the
   *  footer copy switches to "Synthesizing voiceover..." so the admin
   *  knows their click landed. Server passes the result of
   *  `hasActiveVoiceRender(storyId)`. */
  regenInFlight?: boolean;
  /** Last error from the most-recent voice_render row, when status =
   *  'error'. Surfaces under the regen button so a failed render is
   *  visible without opening a console. */
  lastRegenError?: string | null;
}

// Section headers, in display order. The label is what the admin sees;
// the provider key is what we filter the voices prop by.
const SECTIONS: ReadonlyArray<{
  providers: VoiceProvider[];
  label: string;
  blurb: string;
}> = [
  {
    providers: ["elevenlabs"],
    label: "ElevenLabs",
    blurb: "Premium narrators. ~$0.75 per story.",
  },
  {
    providers: ["google/chirp3-hd"],
    label: "Google Chirp 3 HD",
    blurb: "Curated voices, low cost. ~$0.04 per story.",
  },
  {
    providers: [
      "google/gemini-25-flash-tts",
      "google/gemini-31-flash-tts",
    ],
    label: "Gemini Flash TTS",
    blurb: "Same voices, expressive control. ~$0.38 per story.",
  },
];

export function VoicePicker({
  storyId,
  voices,
  currentProvider,
  currentVoiceId,
  regenInFlight = false,
  lastRegenError = null,
}: VoicePickerProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [regenPending, startRegenTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<{
    provider: string | null;
    voice_id: string | null;
  } | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const effectiveProvider = optimistic?.provider ?? currentProvider;
  const effectiveVoiceId = optimistic?.voice_id ?? currentVoiceId;
  const usingGlobal = !effectiveProvider;

  const sections = useMemo(() => {
    return SECTIONS.map((s) => ({
      ...s,
      voices: voices.filter((v) =>
        s.providers.includes(v.provider as VoiceProvider),
      ),
    })).filter((s) => s.voices.length > 0);
  }, [voices]);

  function selectVoice(provider: string, voice_id: string) {
    setError(null);
    setOptimistic({ provider, voice_id });
    const formData = new FormData();
    formData.set("story_id", storyId);
    formData.set("voice_provider", provider);
    formData.set("voice_id", voice_id);
    startTransition(async () => {
      const result = await setStoryVoiceAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Save failed");
        // Roll back optimistic state so the UI re-renders the server's
        // truth on the next refresh.
        setOptimistic(null);
      } else {
        router.refresh();
      }
    });
  }

  function resetToGlobal() {
    setError(null);
    setOptimistic({ provider: null, voice_id: null });
    const formData = new FormData();
    formData.set("story_id", storyId);
    formData.set("voice_provider", "");
    formData.set("voice_id", "");
    startTransition(async () => {
      const result = await setStoryVoiceAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Reset failed");
        setOptimistic(null);
      } else {
        router.refresh();
      }
    });
  }

  function regenerate() {
    setRegenError(null);
    const formData = new FormData();
    formData.set("story_id", storyId);
    startRegenTransition(async () => {
      const result = await regenerateVoiceoverAction(formData);
      if (!result.ok) {
        setRegenError(result.error ?? "Regen failed");
      } else {
        router.refresh();
      }
    });
  }

  function playPreview(key: string, url: string | null) {
    if (!url) return;
    const audio = audioRef.current;
    if (!audio) return;
    // Same card clicked while playing -> pause. Different card -> swap.
    if (playingKey === key && !audio.paused) {
      audio.pause();
      setPlayingKey(null);
      return;
    }
    audio.src = url;
    audio.currentTime = 0;
    void audio.play();
    setPlayingKey(key);
  }

  return (
    <section
      aria-labelledby="voice-picker-heading"
      className="rounded-xl border border-line bg-surface p-4"
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3
            id="voice-picker-heading"
            className="font-display text-[15px] font-semibold text-ink"
          >
            Narrator voice
          </h3>
          <p className="mt-0.5 text-[12px] text-muted">
            Choose a narrator for this story. Preview each by clicking ▶.
            The next render uses the chosen voice; the current audio
            stays until you regenerate.
          </p>
        </div>
        <button
          type="button"
          onClick={resetToGlobal}
          disabled={pending || usingGlobal}
          className="rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="voice-picker-reset"
        >
          {usingGlobal ? "Using global default" : "Reset to global"}
        </button>
      </header>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger"
        >
          {error}
        </div>
      )}

      <div className="space-y-4">
        {sections.map((section) => (
          <div key={section.label}>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h4 className="font-mono text-[11px] uppercase tracking-wider text-muted">
                {section.label}
              </h4>
              <span className="text-[10px] text-muted">{section.blurb}</span>
            </div>
            <ul className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
              {section.voices.map((v) => {
                const key = `${v.provider}::${v.voice_id}`;
                const selected =
                  effectiveProvider === v.provider &&
                  effectiveVoiceId === v.voice_id;
                const isPlaying = playingKey === key;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => selectVoice(v.provider, v.voice_id)}
                      disabled={pending}
                      data-testid={`voice-card-${v.provider}-${v.voice_id}`}
                      data-selected={selected ? "true" : "false"}
                      className={
                        "group flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 " +
                        (selected
                          ? "border-accent bg-accent/10"
                          : "border-line bg-bg hover:border-accent/60")
                      }
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink">
                          {v.name}
                        </span>
                        {v.accent && (
                          <span className="block truncate text-[10px] text-muted">
                            {v.accent}
                          </span>
                        )}
                      </span>
                      <span
                        role="button"
                        aria-label={`Preview ${v.name}`}
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          playPreview(key, v.preview_url);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.stopPropagation();
                            e.preventDefault();
                            playPreview(key, v.preview_url);
                          }
                        }}
                        className={
                          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] transition-colors " +
                          (v.preview_url
                            ? "border-accent/60 text-accent hover:bg-accent/10"
                            : "border-line text-muted opacity-50 cursor-not-allowed")
                        }
                        data-testid={`voice-preview-${v.provider}-${v.voice_id}`}
                      >
                        {isPlaying ? "■" : "▶"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-4 space-y-2 border-t border-line pt-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted">
            {regenInFlight || regenPending
              ? "Synthesizing voiceover..."
              : usingGlobal
                ? "Story uses the global default voice."
                : `Selected: ${effectiveProvider} · ${effectiveVoiceId}`}
          </p>
          <button
            type="button"
            onClick={regenerate}
            disabled={regenInFlight || regenPending}
            className="rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="voice-picker-regen"
          >
            {regenInFlight || regenPending
              ? "Synthesizing…"
              : "Regenerate voiceover"}
          </button>
        </div>
        {(regenError || lastRegenError) && (
          <p
            role="alert"
            className="rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 font-mono text-[10px] text-danger"
            data-testid="voice-picker-regen-error"
          >
            {regenError ?? lastRegenError}
          </p>
        )}
      </div>

      {/* Shared audio element. We control src/play via the refs above so
          a second click stops the first preview cleanly. onEnded clears
          the playingKey so the play button glyph flips back to ▶. */}
      <audio
        ref={audioRef}
        onEnded={() => setPlayingKey(null)}
        onPause={() => {
          if (audioRef.current?.ended) return;
          // External pause (browser DOM) — keep playingKey so the next
          // click on the SAME card resumes vs swap.
        }}
        className="hidden"
        data-testid="voice-picker-audio"
      />
    </section>
  );
}
