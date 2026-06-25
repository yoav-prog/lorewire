"use client";

// Client half of the Settings page. Holds every section's controls
// and reads / writes via the existing pref hooks (no new fetches, no
// new state shape — just UI on top of stores that already exist).
//
// Sections (v1):
//   - Playback    — Wires prefs + Stories prefs (auto-advance + dwell)
//   - Privacy     — Reset viewed stories (destructive, confirm-gated)
//   - Account     — cross-link to /auth/account when signed in
//
// Plan: _plans/2026-06-25-user-settings-page.md.

import Link from "next/link";
import { useState } from "react";

import { useWirePrefs } from "@/components/wires/useWirePrefs";
import {
  STORIES_IMAGE_DWELL_CHOICES,
  useStoriesAutoAdvance,
  useStoriesImageDwellMs,
} from "@/components/stories/use-stories-prefs";
import { useViewedWires } from "@/components/stories/use-viewed-wires";

export interface SettingsClientProps {
  /** Whether the request carried a valid user session cookie. Drives
   *  the Account section's cross-link rendering. */
  hasSession: boolean;
}

export default function SettingsClient({ hasSession }: SettingsClientProps) {
  const wires = useWirePrefs();
  const { autoAdvance, setAutoAdvance } = useStoriesAutoAdvance();
  const { imageDwellMs, setImageDwellMs } = useStoriesImageDwellMs();
  const { viewed: viewedWireIds, clearViewed } = useViewedWires();
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  return (
    <div className="mt-8 flex flex-col gap-6">
      <Section
        title="Playback"
        description="How wires and stories autoplay, advance, and sound by default."
      >
        <ToggleRow
          label="Autoplay wires"
          description="Start playing each wire as it comes into view."
          value={wires.autoplay}
          onChange={(v) => settingsLog("wires.autoplay", wires.autoplay, v, wires.setAutoplay)}
        />
        <ToggleRow
          label="Start muted"
          description="Wires and stories begin muted. Tap the speaker to unmute."
          value={wires.muted}
          onChange={(v) => settingsLog("wires.muted", wires.muted, v, wires.setMuted)}
        />
        <ToggleRow
          label="Slow mode"
          description="Play wires and stories at 0.75× speed for an easier, calmer pace."
          value={wires.slow}
          onChange={(v) => settingsLog("wires.slow", wires.slow, v, wires.setSlow)}
        />
        <SegmentedRow
          label="When a wire ends"
          description="Whether to move to the next wire or loop the current one."
          value={wires.advance ? "advance" : "loop"}
          choices={[
            { value: "advance", label: "Next wire" },
            { value: "loop", label: "Loop" },
          ]}
          onChange={(v) =>
            settingsLog(
              "wires.advance",
              wires.advance,
              v === "advance",
              wires.setAdvance,
            )
          }
        />

        <Divider />

        <ToggleRow
          label="Auto-advance stories"
          description="When off, stories stay on screen until you tap or swipe."
          value={autoAdvance}
          onChange={(v) =>
            settingsLog("stories.autoadvance", autoAdvance, v, setAutoAdvance)
          }
        />
        <SegmentedRow
          label="Image stories — how long they stay"
          description="Video stories always advance when they end."
          value={String(imageDwellMs)}
          choices={STORIES_IMAGE_DWELL_CHOICES.map((ms) => ({
            value: String(ms),
            label: `${ms / 1000}s`,
          }))}
          onChange={(v) => {
            const next = Number.parseInt(v, 10);
            settingsLog("stories.image_dwell_ms", imageDwellMs, next, () =>
              setImageDwellMs(next),
            );
          }}
        />
      </Section>

      <Section
        title="Privacy & data"
        description="Reset what this browser has saved locally."
      >
        <ResetRow
          label="Reset viewed stories"
          description={
            viewedWireIds.length === 0
              ? "Nothing to reset — no stories marked as viewed yet."
              : `${viewedWireIds.length} ${viewedWireIds.length === 1 ? "story" : "stories"} marked as viewed.`
          }
          disabled={viewedWireIds.length === 0}
          confirmOpen={resetConfirmOpen}
          onAskConfirm={() => setResetConfirmOpen(true)}
          onCancel={() => setResetConfirmOpen(false)}
          onConfirm={() => {
            const count = viewedWireIds.length;
            clearViewed();
            setResetConfirmOpen(false);
            // eslint-disable-next-line no-console -- rule 14
            console.info("[settings reset]", {
              what: "viewed_stories",
              count_cleared: count,
            });
          }}
        />
      </Section>

      <Section
        title="Account"
        description={
          hasSession
            ? "Manage how your account appears across LoreWire."
            : "Sign in to sync your saved list, likes, and ratings across devices."
        }
      >
        {hasSession ? (
          <Link
            href="/auth/account"
            className="inline-flex items-center gap-2 self-start rounded-md bg-ink/10 px-4 py-2 text-sm font-semibold text-ink hover:bg-ink/20 transition"
          >
            Open account &amp; preferences →
          </Link>
        ) : (
          <Link
            href="/auth/signin?next=%2Fsettings"
            className="inline-flex items-center gap-2 self-start rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg hover:opacity-90 transition"
            style={{ color: "var(--color-bg)" }}
          >
            Sign in
          </Link>
        )}
      </Section>
    </div>
  );
}

/* --------------------------- Section primitives -------------------------- */

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="rounded-lg border p-5"
      style={{
        background: "var(--color-surface)",
        borderColor: "var(--color-line)",
      }}
    >
      <h2 className="font-display text-base font-bold uppercase tracking-tight text-ink">
        {title}
      </h2>
      <p className="mt-1 text-xs text-muted">{description}</p>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Divider() {
  return (
    <hr className="my-1 border-0 h-px" style={{ background: "var(--color-line)" }} />
  );
}

function ToggleRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-ink">{label}</div>
        <div className="text-xs text-muted mt-0.5">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className="relative shrink-0 w-11 h-6 rounded-full transition-colors"
        style={{
          background: value ? "var(--color-accent)" : "var(--color-surface2)",
          border: `1px solid ${value ? "var(--color-accent)" : "var(--color-line)"}`,
        }}
      >
        <span
          className="absolute top-[2px] block w-[18px] h-[18px] rounded-full bg-white shadow-sm transition-transform"
          style={{ left: value ? "calc(100% - 20px)" : "2px" }}
        />
      </button>
    </div>
  );
}

function SegmentedRow({
  label,
  description,
  value,
  choices,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  choices: { value: string; label: string }[];
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-sm font-semibold text-ink">{label}</div>
        <div className="text-xs text-muted mt-0.5">{description}</div>
      </div>
      <div
        className="inline-flex self-start rounded-full p-0.5"
        style={{
          background: "var(--color-surface2)",
          border: "1px solid var(--color-line)",
        }}
        role="radiogroup"
        aria-label={label}
      >
        {choices.map((c) => {
          const active = c.value === value;
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(c.value)}
              className="px-3.5 py-1.5 rounded-full text-xs font-semibold transition"
              style={{
                background: active ? "var(--color-ink)" : "transparent",
                color: active ? "var(--color-bg)" : "var(--color-muted)",
              }}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ResetRow({
  label,
  description,
  disabled,
  confirmOpen,
  onAskConfirm,
  onCancel,
  onConfirm,
}: {
  label: string;
  description: string;
  disabled: boolean;
  confirmOpen: boolean;
  onAskConfirm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink">{label}</div>
          <div className="text-xs text-muted mt-0.5">{description}</div>
        </div>
        {!confirmOpen && (
          <button
            type="button"
            disabled={disabled}
            onClick={onAskConfirm}
            className="shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: "var(--color-surface2)",
              color: "var(--color-ink)",
              border: "1px solid var(--color-line)",
            }}
          >
            Reset
          </button>
        )}
      </div>
      {confirmOpen && (
        <div className="flex items-center justify-end gap-2 mt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs font-semibold text-muted hover:text-ink transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md px-3 py-1.5 text-xs font-semibold transition"
            style={{ background: "var(--color-danger)", color: "var(--color-bg)" }}
          >
            Yes, reset
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ logging ------------------------------ */

/** Wraps any setter call with a [settings change] log entry per
 *  rule 14. Keeps the call sites tight while still emitting the
 *  from→to pair needed for diagnostic walks ("I flipped X and it
 *  still doesn't work" → grep the console). */
function settingsLog<T>(
  key: string,
  from: T,
  to: T,
  setter: (v: T) => void,
): void {
  // eslint-disable-next-line no-console -- rule 14
  console.info("[settings change]", { key, from, to });
  setter(to);
}
