"use client";

// Concurrency banner for the short editor. Direct port of the video
// editor's pattern (admin/videos/[id]/EditorClient.tsx readOnly +
// foreign-banner state). Phase 5 of
// _plans/2026-06-16-short-editor-full-parity.md.
//
// The banner renders only when the page's server render detected a
// foreign live session and passed `foreignOwnerEmail`. Clicking "Take
// over" calls claimShortEditSession (overwriting the foreign session)
// and refreshes the page so the heartbeat hook in ShortEditorClient
// starts on the new owner. Until then, autosaves + render clicks return
// 'session-stolen' from the action layer.
//
// We deliberately don't include a close button: closing the banner and
// then writing would silently clobber another admin's edits, which is
// the failure mode the whole primitive is here to prevent.

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { claimShortEditSession } from "./actions";

export function EditSessionBanner({
  storyId,
  foreignOwnerEmail,
}: {
  storyId: string;
  /** Email of the other admin who currently owns a fresh session, or null
   *  when this user holds the session (or no session exists yet). The
   *  banner is suppressed when null. */
  foreignOwnerEmail: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (!foreignOwnerEmail) return null;

  function takeOver() {
    startTransition(async () => {
      const result = await claimShortEditSession(storyId);
      if (!result.ok) {
        // The action would only fail for transient reasons here (the
        // foreign session was already detected via the page render; the
        // claim itself writes unconditionally). Log so console-grepping
        // diagnostics catches the case.
        // eslint-disable-next-line no-console -- rule 14
        console.warn("[short editor session take-over failed]", {
          storyId,
          error: result.error,
        });
        return;
      }
      // eslint-disable-next-line no-console -- rule 14
      console.info("[short editor session take-over]", { storyId });
      router.refresh();
    });
  }

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-warn bg-warn/10 px-3 py-2 text-[12px] text-ink"
    >
      <span className="font-mono text-[10px] uppercase tracking-wider text-warn">
        Foreign session
      </span>
      <span className="flex-1">
        <span className="font-medium text-ink">{foreignOwnerEmail}</span>{" "}
        is currently editing this short. Your edits won&apos;t save until you
        take over.
      </span>
      <button
        type="button"
        onClick={takeOver}
        disabled={pending}
        className="rounded-md border border-warn bg-bg px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-warn transition-colors hover:bg-warn/10 disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? "Taking over…" : "Take over"}
      </button>
    </div>
  );
}
