"use client";

// Phase 3 of _plans/2026-06-14-voiceover-picker.md.
// Redesigned 2026-06-15 (_plans/2026-06-15-voice-picker-dropdown.md): the
// original grid rendered the entire catalog as tiles. In the narrow story
// sidebar AND the editor's AUDIO tab that forced 4 columns of postage-stamp
// cards whose names truncated to a single letter, and the full ElevenLabs
// account (often 50-100+ voices) became an unreadable wall. This is now a
// searchable combobox: a single trigger that opens a panel with an instant
// search box and a grouped, windowed list.
//
// Shared component used by both the story-detail page AND the editor's AUDIO
// tab, so this one change fixes both surfaces.
//
// Laziness: the list is windowed (only the first N filtered rows mount, more
// load as you scroll) and the preview MP3 is fetched only when its ▶ is
// clicked (a single shared <audio> element). Search filters across name,
// accent, and provider so any voice is one or two keystrokes away.
//
// Selection is auto-save: clicking a voice fires the server action
// immediately (rule 10, lazy user) and closes the panel. "Reset to global"
// clears the override; "Regenerate voiceover" re-synthesizes with the
// chosen voice.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
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
   *  when the story uses the global default. */
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
// the provider keys are what we filter the voices prop by. Kept as the
// grouping for the search results so the per-provider cost stays visible
// (rule 8) even inside the dropdown.
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

// How many filtered rows to mount up front, and how many more to reveal
// each time the list is scrolled near its bottom. 40 covers the common
// case (a typed query narrows to a handful) without dumping 100+ rows.
const WINDOW_STEP = 40;

function providerLabel(provider: string): string {
  for (const s of SECTIONS) {
    if (s.providers.includes(provider as VoiceProvider)) return s.label;
  }
  return provider;
}

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

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(WINDOW_STEP);

  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const effectiveProvider = optimistic?.provider ?? currentProvider;
  const effectiveVoiceId = optimistic?.voice_id ?? currentVoiceId;
  const usingGlobal = !effectiveProvider;

  const selectedVoice = useMemo(
    () =>
      voices.find(
        (v) =>
          v.provider === effectiveProvider && v.voice_id === effectiveVoiceId,
      ) ?? null,
    [voices, effectiveProvider, effectiveVoiceId],
  );

  // Filter across name + accent + provider label so a single search box
  // reaches any voice in any provider group ("smart fast easy search").
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return voices;
    return voices.filter(
      (v) =>
        v.name.toLowerCase().includes(q) ||
        (v.accent?.toLowerCase().includes(q) ?? false) ||
        providerLabel(v.provider).toLowerCase().includes(q),
    );
  }, [voices, q]);

  // Window the filtered list, then group the visible slice by provider so
  // empty groups drop out of the panel.
  const shown = filtered.slice(0, visibleCount);
  const groups = useMemo(
    () =>
      SECTIONS.map((s) => ({
        ...s,
        voices: shown.filter((v) => s.providers.includes(v.provider)),
      })).filter((s) => s.voices.length > 0),
    [shown],
  );
  const hasMore = filtered.length > shown.length;

  const closePanel = useCallback(() => setOpen(false), []);

  function openPanel() {
    setQuery("");
    setVisibleCount(WINDOW_STEP);
    setOpen(true);
  }

  // Focus the search box when the panel opens so the admin can type
  // immediately without a second click.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Close on outside click + Escape. Only wired while open so we don't
  // hold a document listener for every picker on the page.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) closePanel();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closePanel();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, closePanel]);

  function onListScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80 && hasMore) {
      setVisibleCount((c) => c + WINDOW_STEP);
    }
  }

  function selectVoice(provider: string, voice_id: string) {
    setError(null);
    setOptimistic({ provider, voice_id });
    closePanel();
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
    // Same row clicked while playing -> pause. Different row -> swap.
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

  const triggerLabel = usingGlobal
    ? "Global default voice"
    : selectedVoice
      ? `${selectedVoice.name} · ${providerLabel(selectedVoice.provider)}`
      : `${effectiveProvider} · ${effectiveVoiceId}`;

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
            Search and preview narrators with ▶. The next render uses the
            chosen voice; the current audio stays until you regenerate.
          </p>
        </div>
        <button
          type="button"
          onClick={resetToGlobal}
          disabled={pending || usingGlobal}
          className="shrink-0 rounded-md border border-line bg-bg px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
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

      {/* Combobox: a single trigger that opens the searchable panel. */}
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => (open ? closePanel() : openPanel())}
          disabled={pending}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-bg px-3 py-2 text-left transition-colors hover:border-accent/60 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="voice-picker-trigger"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-ink">
              {triggerLabel}
            </span>
            <span className="block text-[10px] text-muted">
              {usingGlobal
                ? "Click to choose a narrator for this story"
                : "Click to change"}
            </span>
          </span>
          <span
            aria-hidden="true"
            className={
              "shrink-0 text-[11px] text-muted transition-transform " +
              (open ? "rotate-180" : "")
            }
          >
            ▾
          </span>
        </button>

        <div
          role="listbox"
          aria-label="Narrator voices"
          hidden={!open}
          className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-md border border-line bg-surface shadow-lg"
        >
          <div className="border-b border-line p-2">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setVisibleCount(WINDOW_STEP);
                listRef.current?.scrollTo({ top: 0 });
              }}
              placeholder="Search voices…"
              aria-label="Search voices"
              className="w-full rounded-md border border-line bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
              data-testid="voice-picker-search"
            />
          </div>

          <div
            ref={listRef}
            onScroll={onListScroll}
            className="max-h-72 overflow-auto p-2"
          >
            {groups.length === 0 ? (
              <p className="px-2 py-6 text-center text-[12px] text-muted">
                No voices match “{query}”.
              </p>
            ) : (
              <div className="space-y-3">
                {groups.map((section) => (
                  <div key={section.label}>
                    <div className="mb-1 flex items-baseline justify-between gap-3 px-1">
                      <h4 className="font-mono text-[10px] uppercase tracking-wider text-muted">
                        {section.label}
                      </h4>
                      <span className="text-[10px] text-muted">
                        {section.blurb}
                      </span>
                    </div>
                    <ul className="space-y-1">
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
                              onClick={() =>
                                selectVoice(v.provider, v.voice_id)
                              }
                              disabled={pending}
                              role="option"
                              aria-selected={selected}
                              data-testid={`voice-card-${v.provider}-${v.voice_id}`}
                              data-selected={selected ? "true" : "false"}
                              className={
                                "group flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 " +
                                (selected
                                  ? "border-accent bg-accent/10"
                                  : "border-transparent hover:border-accent/60 hover:bg-bg")
                              }
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-medium text-ink">
                                  {v.name}
                                  {selected && (
                                    <span className="ml-2 text-[10px] text-accent">
                                      ✓ selected
                                    </span>
                                  )}
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
                {hasMore && (
                  <p className="px-1 py-1 text-center text-[10px] text-muted">
                    Showing {shown.length} of {filtered.length} — scroll or
                    keep typing to narrow
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-2 border-t border-line pt-3">
        {/* Stacked, not side-by-side: in the narrow story sidebar a
            justify-between row pushed the long "Regenerate voiceover" label
            past the panel edge and clipped it. The status line truncates on
            its own row and the button goes full-width as the clear primary
            action, so it never clips in either container. */}
        <p className="truncate text-[11px] text-muted">
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
          className="w-full rounded-md bg-accent px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="voice-picker-regen"
        >
          {regenInFlight || regenPending
            ? "Synthesizing…"
            : "Regenerate voiceover"}
        </button>
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
        className="hidden"
        data-testid="voice-picker-audio"
      />
    </section>
  );
}
