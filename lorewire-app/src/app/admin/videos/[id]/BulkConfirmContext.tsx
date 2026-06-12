"use client";

// Cross-card click coordinator for the storyboard rail. Phase 4 of the
// video editor overhaul (_plans/2026-06-12-video-editor-overhaul.md):
// when an admin fires Regenerate on >= 3 frames inside a 5-second
// window, hold the third click (and every click after) in a buffer
// and surface one confirm modal showing the total estimated spend.
//
// The flow:
//   1. FrameRegenActions calls gate.request(action, { estimateCents })
//      from its onClick.
//   2. Gate records the click timestamp. If it's the 1st or 2nd click
//      in the window, the action runs immediately.
//   3. If it's the 3rd-or-later click AND the user hasn't recently
//      confirmed a burst, the action is buffered and the modal opens.
//   4. Confirm flushes every buffered action AND grants a 5-second
//      "trusted" window so the user can keep going without re-prompting.
//   5. Cancel drops the buffer.
//
// Cap context: this is independent of the per-session hard cap (Phase
// 4 part 1). The hard cap is a server-side rejection; this modal is a
// client-side speed bump. They compose: the user can confirm the
// modal and still hit the server cap a few clicks later.

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

export const BURST_WINDOW_MS = 5000;
export const BURST_THRESHOLD = 3;
export const TRUST_AFTER_CONFIRM_MS = 5000;

// Pure decision function — exposed so unit tests can pin the burst-
// detection contract without spinning up React. Returns the next
// history (pruned of timestamps older than the window) plus whether
// the click should be deferred to the confirm modal.
export function shouldDeferToBurst(args: {
  history: number[];
  now: number;
  confirmedUntil: number;
  burstWindowMs?: number;
  burstThreshold?: number;
}): { defer: boolean; nextHistory: number[] } {
  const windowMs = args.burstWindowMs ?? BURST_WINDOW_MS;
  const threshold = args.burstThreshold ?? BURST_THRESHOLD;
  const recent = args.history.filter((t) => args.now - t < windowMs);
  recent.push(args.now);
  const stillConfirmed = args.confirmedUntil > args.now;
  const defer = recent.length >= threshold && !stillConfirmed;
  return { defer, nextHistory: recent };
}

interface BulkConfirmGate {
  /** Fire the action immediately, or buffer it and open the modal if
   *  the user is currently clicking fast. estimateCents is the cost the
   *  modal accumulates so the user sees "$0.15 total" before
   *  confirming. */
  request: (
    action: () => void,
    meta?: { estimateCents?: number },
  ) => void;
}

const BulkConfirmContext = createContext<BulkConfirmGate | null>(null);

export function useBulkConfirmGate(): BulkConfirmGate {
  const ctx = useContext(BulkConfirmContext);
  if (!ctx) {
    throw new Error(
      "useBulkConfirmGate must be used inside BulkConfirmProvider",
    );
  }
  return ctx;
}

interface PendingAction {
  action: () => void;
  estimateCents: number;
}

export function BulkConfirmProvider({
  children,
  defaultEstimateCents,
}: {
  children: ReactNode;
  /** Used when a request doesn't supply its own estimate. */
  defaultEstimateCents: number;
}) {
  // Refs hold things that change without needing a re-render: the click
  // history (timestamps) and the confirmedUntil deadline.
  const clickHistoryRef = useRef<number[]>([]);
  const confirmedUntilRef = useRef<number>(0);

  // Pending actions live in state so the modal re-renders with the
  // running count + total as new clicks land while it's open.
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);

  const request = useCallback<BulkConfirmGate["request"]>(
    (action, meta) => {
      const now = Date.now();
      const decision = shouldDeferToBurst({
        history: clickHistoryRef.current,
        now,
        confirmedUntil: confirmedUntilRef.current,
      });
      clickHistoryRef.current = decision.nextHistory;

      const estimateCents = meta?.estimateCents ?? defaultEstimateCents;
      if (decision.defer) {
        setPendingActions((prev) => [...prev, { action, estimateCents }]);
        return;
      }
      action();
    },
    [defaultEstimateCents],
  );

  const handleConfirm = () => {
    confirmedUntilRef.current = Date.now() + TRUST_AFTER_CONFIRM_MS;
    // Snapshot the current buffer so flush runs against a stable list
    // even if React batches a new click between the read and the clear.
    const toRun = pendingActions;
    setPendingActions([]);
    toRun.forEach((p) => p.action());
  };

  const handleCancel = () => {
    setPendingActions([]);
  };

  const modalOpen = pendingActions.length > 0;
  const totalCents = pendingActions.reduce((s, p) => s + p.estimateCents, 0);

  return (
    <BulkConfirmContext.Provider value={{ request }}>
      {children}
      {modalOpen && (
        <BulkConfirmModal
          count={pendingActions.length}
          totalCents={totalCents}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </BulkConfirmContext.Provider>
  );
}

function BulkConfirmModal({
  count,
  totalCents,
  onConfirm,
  onCancel,
}: {
  count: number;
  totalCents: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-confirm-title"
      data-testid="bulk-confirm-modal"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(15, 23, 42, 0.6)",
        padding: 24,
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-line bg-bg p-5 shadow-2xl">
        <h2
          id="bulk-confirm-title"
          className="font-mono text-[11px] uppercase tracking-wider text-muted"
        >
          Confirm bulk regen
        </h2>
        <p className="mt-2 text-[14px] text-ink">
          You&apos;re about to regenerate{" "}
          <strong className="text-ink">{count} frame{count === 1 ? "" : "s"}</strong>{" "}
          in a quick burst. Estimated total:{" "}
          <strong className="font-mono text-ink">
            ${(totalCents / 100).toFixed(2)}
          </strong>
          .
        </p>
        <p className="mt-2 text-[12px] text-muted">
          Confirming gives you a 5-second window without another prompt. The
          per-session cap in Settings still applies.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-accent px-4 py-1.5 text-[12px] font-semibold text-bg transition-opacity hover:opacity-90"
            autoFocus
          >
            Regenerate {count}
          </button>
        </div>
      </div>
    </div>
  );
}
