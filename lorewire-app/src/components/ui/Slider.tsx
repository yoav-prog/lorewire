"use client";

// Horizontal range slider for the admin UI. Wraps a native
// <input type="range"> so keyboard navigation, accessibility, and
// touch support come for free — we just style the track + thumb to
// match the dark editor aesthetic and overlay a live value display.
//
// Plan: _plans/2026-06-12-admin-ui-overhaul.md (Phase A).
//
// Visual contract:
//   - Track is a 4px bar in `bg-surface2`. Filled portion (left of
//     thumb) is `bg-accent`.
//   - Thumb is a 14px circle in `bg-ink` with a 2px accent ring on
//     focus. Drags + responds to keyboard arrows.
//   - Endpoint labels (e.g. TOP / BOTTOM) appear under the track if
//     supplied.
//   - Current value renders to the right of the label, in mono.
//   - Optional "tick" marker (e.g. the default value of 1.0) renders
//     as a vertical line on the track.
//
// Pure presentational — caller owns state. Auto-save plumbing lives
// in `useDebouncedSave`, not here.

import { type ChangeEvent } from "react";

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  /** Short label rendered above the track. Mono uppercase. */
  label?: string;
  /** Unit suffix on the value display (e.g. "px", "dB"). */
  unit?: string;
  /** Number of decimal places when displaying value. Defaults to a
   *  sensible heuristic based on the step. */
  precision?: number;
  /** Optional endpoint labels (e.g. ["TOP", "BOTTOM"], ["S", "L"]). */
  endpoints?: [string, string];
  /** Optional tick value rendered as a vertical mark on the track
   *  (e.g. the default value, 1.0 for scale, 0 for letter-spacing). */
  tickValue?: number;
  disabled?: boolean;
  ariaLabel?: string;
}

function defaultPrecision(step: number): number {
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  if (step >= 0.01) return 2;
  return 3;
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  label,
  unit,
  precision,
  endpoints,
  tickValue,
  disabled = false,
  ariaLabel,
}: SliderProps) {
  const decimals = precision ?? defaultPrecision(step);
  const fractionFilled =
    max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  const tickFraction =
    tickValue !== undefined && max > min
      ? Math.max(0, Math.min(1, (tickValue - min) / (max - min)))
      : null;
  const displayValue = value.toFixed(decimals);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = parseFloat(e.target.value);
    if (Number.isFinite(next)) onChange(next);
  };

  return (
    <div data-testid="slider" className={disabled ? "opacity-50" : ""}>
      {label && (
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
            {label}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-ink">
            {displayValue}
            {unit && <span className="ml-0.5 text-muted">{unit}</span>}
          </span>
        </div>
      )}
      <div className="relative h-4 w-full">
        {/* Track background */}
        <div
          aria-hidden
          className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface2"
        />
        {/* Filled portion */}
        <div
          aria-hidden
          className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent transition-[width] duration-75"
          style={{ width: `${fractionFilled * 100}%` }}
        />
        {/* Default tick */}
        {tickFraction !== null && (
          <div
            aria-hidden
            data-testid="slider-tick"
            className="absolute top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-muted/60"
            style={{ left: `${tickFraction * 100}%` }}
          />
        )}
        {/* Native range input — invisible but interactive */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          aria-label={ariaLabel ?? label}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent outline-none [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-bg [&::-moz-range-thumb]:bg-ink [&::-moz-range-thumb]:shadow-md [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-bg [&::-webkit-slider-thumb]:bg-ink [&::-webkit-slider-thumb]:shadow-md focus-visible:[&::-moz-range-thumb]:ring-2 focus-visible:[&::-moz-range-thumb]:ring-accent focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-accent"
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
