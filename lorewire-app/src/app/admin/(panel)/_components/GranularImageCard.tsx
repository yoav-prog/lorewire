"use client";

// Per-image grid card: thumbnail that opens a lightbox modal on click,
// showing the full-size image alongside the prompt that produced it. Lets
// the admin debug "why does this image look unrelated to the article" in
// one click without leaving the panel.
//
// Server-side GranularRegenGrid passes in the pre-resolved thumbnail URL,
// the latest queue row (used to cache-bust the URL after a regen), the
// stored prompt (from doodle_frames[i].image_prompt for scenes), and a
// callback slot for the Regenerate button so the modal can reuse the same
// dispatch the inline button uses.

import { useEffect, useState } from "react";
import type { ImageRenderRow } from "@/lib/image-render-queue";
import { RegenButton } from "./RegenButton";

const TRANSITIONAL = new Set(["queued", "generating"]);

function cacheBust(src: string, latest: ImageRenderRow | null): string {
  if (!latest || !latest.finished_at) return src;
  if (latest.status !== "done") return src;
  const sep = src.includes("?") ? "&" : "?";
  return `${src}${sep}v=${encodeURIComponent(latest.finished_at)}`;
}

function statusBadge(row: ImageRenderRow | null): string | null {
  if (!row) return null;
  if (row.status === "queued") return "Queued";
  if (row.status === "generating") return "Generating";
  if (row.status === "error") return "Failed";
  return null;
}

export interface GranularImageCardProps {
  ownerKind: "story" | "article";
  ownerId: string;
  asset: string;
  src: string;
  label: string;
  meta?: string;
  estimateCents: number;
  latest: ImageRenderRow | null;
  /** Stored prompt that produced this image (frame.image_prompt for
   *  story scenes). Empty string when none captured. */
  prompt: string;
}

export function GranularImageCard({
  ownerKind,
  ownerId,
  asset,
  src,
  label,
  meta,
  estimateCents,
  latest,
  prompt,
}: GranularImageCardProps) {
  const [zoomOpen, setZoomOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const badge = statusBadge(latest);
  const transitional =
    latest !== null && TRANSITIONAL.has(latest.status);
  const bustedSrc = cacheBust(src, latest);

  // Close the modal on ESC. Only mount the listener while open so idle
  // pages don't pay for a global keydown subscription.
  useEffect(() => {
    if (!zoomOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomOpen]);

  function copyPrompt() {
    if (!prompt) return;
    void navigator.clipboard?.writeText(prompt).then(() => {
      setCopied(true);
      // eslint-disable-next-line no-console -- rule 14
      console.info("[granular image card copy]", { asset, owner_id: ownerId });
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <>
      <li className="overflow-hidden rounded-lg border border-line bg-bg">
        <div className="relative aspect-square overflow-hidden bg-surface2">
          {src ? (
            <button
              type="button"
              onClick={() => setZoomOpen(true)}
              aria-label={`Open ${label} full size with its prompt`}
              className="block h-full w-full cursor-zoom-in border-0 p-0"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={bustedSrc}
                alt={label}
                className={`h-full w-full object-cover transition-opacity ${
                  transitional ? "opacity-50" : ""
                }`}
              />
            </button>
          ) : (
            <div className="flex h-full w-full items-center justify-center font-mono text-[10px] text-muted">
              no image
            </div>
          )}
          {badge && (
            <span
              className={`pointer-events-none absolute right-1.5 top-1.5 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
                latest?.status === "error"
                  ? "border-danger/40 bg-danger/15 text-danger"
                  : "border-warn/40 bg-warn/15 text-warn"
              }`}
            >
              {badge}
            </span>
          )}
        </div>
        <div className="space-y-1 p-2">
          <p className="truncate text-[11px] font-semibold text-ink">{label}</p>
          {meta && (
            <p className="truncate font-mono text-[10px] text-muted">{meta}</p>
          )}
          <RegenButton
            ownerKind={ownerKind}
            ownerId={ownerId}
            asset={asset}
            estimateCents={estimateCents}
            label="Redo"
          />
        </div>
      </li>

      {zoomOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={`granular-zoom-${asset}-title`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 p-4"
          onClick={(e) => {
            // Click outside the inner panel = close. Inner panel stops
            // propagation so clicks ON the image / prompt don't dismiss.
            if (e.target === e.currentTarget) setZoomOpen(false);
          }}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-5xl flex-col gap-4 overflow-hidden rounded-2xl border border-line bg-surface p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-start justify-between gap-4">
              <div>
                <h3
                  id={`granular-zoom-${asset}-title`}
                  className="font-display text-[18px] font-bold text-ink"
                >
                  {label}
                </h3>
                <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
                  asset · {asset}
                  {latest?.finished_at && (
                    <> · last regen {formatAgo(latest.finished_at)}</>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setZoomOpen(false)}
                className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted transition-colors hover:border-ink hover:text-ink"
                aria-label="Close"
              >
                Close (Esc)
              </button>
            </header>

            <div className="grid grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="overflow-hidden rounded-xl border border-line bg-bg">
                {src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={bustedSrc}
                    alt={label}
                    className="h-full max-h-[72vh] w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full min-h-[40vh] items-center justify-center font-mono text-[11px] uppercase tracking-wider text-muted">
                    no image yet
                  </div>
                )}
              </div>

              <aside className="flex min-h-0 flex-col gap-2 overflow-hidden">
                <div className="flex items-center justify-between">
                  <h4 className="font-mono text-[10px] uppercase tracking-wider text-muted">
                    Prompt sent to kie
                  </h4>
                  {prompt && (
                    <button
                      type="button"
                      onClick={copyPrompt}
                      className="rounded-md border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-ink hover:text-ink"
                    >
                      {copied ? "Copied" : "Copy"}
                    </button>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-line bg-bg p-3 font-mono text-[11px] leading-relaxed text-ink whitespace-pre-wrap">
                  {prompt ? (
                    prompt
                  ) : (
                    <span className="text-muted">
                      No prompt captured for this image yet. A fresh Rebuild-all
                      will stamp the prompt onto this slot.
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 pt-2">
                  <span className="rounded-full border border-line bg-surface2 px-2 py-0.5 font-mono text-[10px] text-muted">
                    ≈ ${(estimateCents / 100).toFixed(2)}
                  </span>
                  <RegenButton
                    ownerKind={ownerKind}
                    ownerId={ownerId}
                    asset={asset}
                    estimateCents={estimateCents}
                    label="Redo"
                  />
                </div>
              </aside>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function formatAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
