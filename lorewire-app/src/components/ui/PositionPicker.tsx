"use client";

// 2D position picker — drag a dot inside a 9:16 box to set a
// normalized (x, y) pair. Replaces two parallel 0..1 sliders for
// overlay positioning, ken-burns anchors, anything where the user is
// really asking "WHERE on the canvas?".
//
// Phase C of the admin UI overhaul
// (_plans/2026-06-12-admin-ui-overhaul.md).
//
// The visual aspect ratio matches the video composition (1080×1920 =
// 9:16) so the dot's screen position maps directly to where the
// overlay will land in the final MP4. Cream background mirrors the
// composition's AbsoluteFill so the picker reads as a tiny
// stand-in for the actual frame.
//
// Pointer events for mouse + touch + stylus. Click anywhere → dot
// jumps. Drag the dot → live update. Crosshair lines connect the
// dot to the edges so the user can sight-align it.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

const ASPECT_W = 9;
const ASPECT_H = 16;

export interface PositionPickerProps {
  /** Horizontal position. 0 = left, 1 = right. */
  x: number;
  /** Vertical position. 0 = top, 1 = bottom. */
  y: number;
  onChange: (x: number, y: number) => void;
  label?: string;
  disabled?: boolean;
  /** Maximum size in pixels for the picker. Defaults to 180px wide
   *  which renders ~ 320px tall at the 9:16 aspect. */
  maxWidth?: number;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function PositionPicker({
  x,
  y,
  onChange,
  label,
  disabled = false,
  maxWidth = 180,
}: PositionPickerProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const positionToCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const box = boxRef.current;
      if (!box) return { x: 0, y: 0 };
      const rect = box.getBoundingClientRect();
      return {
        x: clamp01((clientX - rect.left) / rect.width),
        y: clamp01((clientY - rect.top) / rect.height),
      };
    },
    [],
  );

  // Document-level move/up so a drag drifting outside the box still
  // tracks the pointer until release.
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: PointerEvent) {
      const next = positionToCoords(e.clientX, e.clientY);
      onChange(next.x, next.y);
    }
    function onUp() {
      setDragging(false);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, positionToCoords, onChange]);

  const handleBoxPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = positionToCoords(e.clientX, e.clientY);
    onChange(next.x, next.y);
    setDragging(true);
  };

  const xPct = clamp01(x) * 100;
  const yPct = clamp01(y) * 100;

  return (
    <div data-testid="position-picker" className={disabled ? "opacity-50" : ""}>
      {label && (
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            {label}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-ink">
            {x.toFixed(2)}, {y.toFixed(2)}
          </span>
        </div>
      )}
      <div
        ref={boxRef}
        onPointerDown={handleBoxPointerDown}
        role="application"
        aria-label={`Position picker, currently x ${x.toFixed(2)}, y ${y.toFixed(2)}`}
        data-testid="position-picker-box"
        className="relative cursor-crosshair select-none overflow-hidden rounded-md border border-line touch-none"
        style={{
          aspectRatio: `${ASPECT_W} / ${ASPECT_H}`,
          maxWidth,
          background: "#fbfaf4",
        }}
      >
        {/* Crosshair from dot to edges */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-accent/40"
          style={{ left: `${xPct}%`, transform: "translateX(-0.5px)" }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 h-px bg-accent/40"
          style={{ top: `${yPct}%`, transform: "translateY(-0.5px)" }}
        />
        {/* Dot */}
        <div
          aria-hidden
          data-testid="position-picker-dot"
          className="pointer-events-none absolute h-3 w-3 rounded-full border-2 border-bg bg-accent shadow-md"
          style={{
            left: `${xPct}%`,
            top: `${yPct}%`,
            transform: "translate(-50%, -50%)",
          }}
        />
        {/* Corner labels — TL / TR / BL / BR — to orient the user */}
        <span className="pointer-events-none absolute left-1 top-1 font-mono text-[8px] uppercase tracking-wider text-muted">
          tl
        </span>
        <span className="pointer-events-none absolute right-1 top-1 font-mono text-[8px] uppercase tracking-wider text-muted">
          tr
        </span>
        <span className="pointer-events-none absolute bottom-1 left-1 font-mono text-[8px] uppercase tracking-wider text-muted">
          bl
        </span>
        <span className="pointer-events-none absolute bottom-1 right-1 font-mono text-[8px] uppercase tracking-wider text-muted">
          br
        </span>
      </div>
    </div>
  );
}
