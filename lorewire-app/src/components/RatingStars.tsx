"use client";

// Inline 1-5 star picker for a personal rating. Hover previews, click commits.
// Gold fill reads instantly as a rating (vs the app's red accent, which means
// "saved/active" elsewhere). Stateless except for the transient hover preview —
// the committed value is owned by useStoryRatings in the parent.

import { useState, type CSSProperties } from "react";

const STAR_PATH =
  "M12 3.6l2.5 5.1 5.6.8-4 4 1 5.6L12 21.5 6.9 19l1-5.6-4-4 5.6-.8z";

const GOLD = "#F4B740";

/** Compact gold "★N" badge for a rated thumbnail. Renders nothing when unrated
 *  so callers can drop it in unconditionally. */
export function RatingBadge({
  value,
  className = "",
  style,
}: {
  value: number;
  className?: string;
  style?: CSSProperties;
}) {
  if (!value) return null;
  return (
    <div
      className={`flex items-center gap-0.5 rounded px-1.5 py-0.5 ${className}`}
      style={{ background: "rgba(0,0,0,.6)", ...style }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill={GOLD} aria-hidden>
        <path d={STAR_PATH} />
      </svg>
      <span className="font-mono text-[10px] font-semibold" style={{ color: GOLD }}>
        {value}
      </span>
    </div>
  );
}

export interface RatingStarsProps {
  /** Committed rating, 0 (unrated) to 5. */
  value: number;
  onRate: (stars: number) => void;
  /** When provided and value > 0, renders a small Clear affordance. */
  onClear?: () => void;
  size?: number;
}

export default function RatingStars({
  value,
  onRate,
  onClear,
  size = 28,
}: RatingStarsProps) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex items-center gap-1" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => {
          const on = n <= shown;
          return (
            <button
              key={n}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRate(n);
              }}
              onMouseEnter={() => setHover(n)}
              aria-label={`${n} star${n > 1 ? "s" : ""}`}
              aria-pressed={n <= value}
              className="active:scale-90 transition"
              style={{ lineHeight: 0 }}
            >
              <svg
                width={size}
                height={size}
                viewBox="0 0 24 24"
                fill={on ? GOLD : "none"}
                stroke={on ? GOLD : "#8E8A97"}
                strokeWidth={1.6}
                strokeLinejoin="round"
              >
                <path d={STAR_PATH} />
              </svg>
            </button>
          );
        })}
      </div>
      {value > 0 && onClear && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="font-body text-[12px] text-muted hover:text-ink transition"
        >
          Clear
        </button>
      )}
    </div>
  );
}
