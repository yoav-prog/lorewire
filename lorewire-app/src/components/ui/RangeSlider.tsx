"use client";

// Range slider — two handles + a filled middle band. The trim window
// shape: drag the low handle to set the start, drag the high handle
// to set the end, click anywhere on the track to move the nearer
// handle there. Both handles snap to `step`.
//
// Phase C of the admin UI overhaul
// (_plans/2026-06-12-admin-ui-overhaul.md). The single-Slider
// component still serves single-value fields (Phase B sliders).
// This one specifically replaces the two-separate-sliders shape of
// the Trim panel.
//
// Pointer events drive both handles so mouse + touch + stylus all
// work without separate handlers. role="slider" on each handle so
// screen readers announce "Trim start, 12.30s of 134.00s" etc.
//
// Pure presentational: caller owns the (low, high) pair; the
// onChange returns clamped values that respect step + min/max + the
// constraint that low <= high. Empty `formatValue` falls back to
// `String(n)` so the test suite can rely on the raw number.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

export interface RangeSliderProps {
  low: number;
  high: number;
  min: number;
  max: number;
  step: number;
  onChange: (low: number, high: number) => void;
  /** Mono uppercase label above the slider. Optional. */
  label?: string;
  /** Format the values shown under the handles. Receives the raw
   *  number, returns the display string (e.g. time formatting like
   *  "00:12.30"). Default: `String(n)`. */
  formatValue?: (n: number) => string;
  /** Endpoint labels under the track (e.g. ["START", "END"]). */
  endpoints?: [string, string];
  disabled?: boolean;
  ariaLabelLow?: string;
  ariaLabelHigh?: string;
}

function snap(value: number, min: number, max: number, step: number): number {
  const clamped = Math.max(min, Math.min(max, value));
  if (step <= 0) return clamped;
  const stepped = Math.round((clamped - min) / step) * step + min;
  return Math.max(min, Math.min(max, stepped));
}

export function RangeSlider({
  low,
  high,
  min,
  max,
  step,
  onChange,
  label,
  formatValue = String,
  endpoints,
  disabled = false,
  ariaLabelLow,
  ariaLabelHigh,
}: RangeSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<"low" | "high" | null>(null);

  const range = max - min || 1;
  const lowPct = ((low - min) / range) * 100;
  const highPct = ((high - min) / range) * 100;

  const positionToValue = useCallback(
    (clientX: number): number => {
      const track = trackRef.current;
      if (!track) return min;
      const rect = track.getBoundingClientRect();
      const fraction = (clientX - rect.left) / rect.width;
      return snap(min + fraction * range, min, max, step);
    },
    [min, max, range, step],
  );

  // Pointer-move + pointer-up listeners hang off the document while a
  // drag is in flight so the user can drift outside the track and the
  // slider still tracks them. Cleaned up on drag end / unmount.
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: PointerEvent) {
      const next = positionToValue(e.clientX);
      if (dragging === "low") {
        onChange(Math.min(next, high), high);
      } else {
        onChange(low, Math.max(next, low));
      }
    }
    function onUp() {
      setDragging(null);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, positionToValue, onChange, low, high]);

  const handleTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const next = positionToValue(e.clientX);
    // Pick whichever handle is closer to the click.
    const closer =
      Math.abs(next - low) <= Math.abs(next - high) ? "low" : "high";
    if (closer === "low") {
      onChange(Math.min(next, high), high);
    } else {
      onChange(low, Math.max(next, low));
    }
    setDragging(closer);
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    which: "low" | "high",
  ) => {
    if (disabled) return;
    let delta = 0;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -step;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = step;
    else if (e.key === "PageDown") delta = -step * 10;
    else if (e.key === "PageUp") delta = step * 10;
    else if (e.key === "Home") {
      if (which === "low") onChange(min, high);
      else onChange(low, low);
      e.preventDefault();
      return;
    } else if (e.key === "End") {
      if (which === "low") onChange(high, high);
      else onChange(low, max);
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    if (which === "low") {
      const next = snap(low + delta, min, max, step);
      onChange(Math.min(next, high), high);
    } else {
      const next = snap(high + delta, min, max, step);
      onChange(low, Math.max(next, low));
    }
  };

  return (
    <div data-testid="range-slider" className={disabled ? "opacity-50" : ""}>
      {label && (
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            {label}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-ink">
            {formatValue(low)}
            <span className="mx-1 text-muted">→</span>
            {formatValue(high)}
          </span>
        </div>
      )}
      <div className="relative h-6 select-none touch-none">
        {/* Click target track */}
        <div
          ref={trackRef}
          onPointerDown={handleTrackPointerDown}
          className="absolute inset-x-0 top-1/2 h-6 -translate-y-1/2 cursor-pointer"
          data-testid="range-slider-track"
        />
        {/* Visible track background */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface2"
        />
        {/* Filled middle band */}
        <div
          aria-hidden
          data-testid="range-slider-fill"
          className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent"
          style={{
            left: `${lowPct}%`,
            width: `${Math.max(0, highPct - lowPct)}%`,
          }}
        />
        {/* Low handle */}
        <button
          type="button"
          role="slider"
          aria-label={ariaLabelLow ?? "Range start"}
          aria-valuemin={min}
          aria-valuemax={high}
          aria-valuenow={low}
          aria-valuetext={formatValue(low)}
          disabled={disabled}
          data-testid="range-slider-handle-low"
          onPointerDown={(e) => {
            if (disabled) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging("low");
          }}
          onKeyDown={(e) => handleKeyDown(e, "low")}
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-bg bg-ink shadow-md transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing"
          style={{ left: `${lowPct}%` }}
        />
        {/* High handle */}
        <button
          type="button"
          role="slider"
          aria-label={ariaLabelHigh ?? "Range end"}
          aria-valuemin={low}
          aria-valuemax={max}
          aria-valuenow={high}
          aria-valuetext={formatValue(high)}
          disabled={disabled}
          data-testid="range-slider-handle-high"
          onPointerDown={(e) => {
            if (disabled) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging("high");
          }}
          onKeyDown={(e) => handleKeyDown(e, "high")}
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-bg bg-ink shadow-md transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing"
          style={{ left: `${highPct}%` }}
        />
      </div>
      {endpoints && (
        <div className="mt-1 flex justify-between font-mono text-[9px] uppercase tracking-wider text-muted">
          <span>{endpoints[0]}</span>
          <span>{endpoints[1]}</span>
        </div>
      )}
    </div>
  );
}
