"use client";

// Live preview pane that mirrors the Remotion composition's caption styling.
// Reads the same form inputs the admin is editing so a typed change updates
// the rendered sample on the next keystroke. Sample text is a 4-word phrase
// that auto-sizes to the 96px tier the composition uses for short chunks.

import { useEffect, useState } from "react";

interface Props {
  defaults: Record<string, string>;
}

const SAMPLE_WORDS = ["LIVE", "PREVIEW", "OF", "CAPTIONS"];

export function CaptionTemplatePreview({ defaults }: Props) {
  const [values, setValues] = useState<Record<string, string>>(defaults);
  const [activeIdx, setActiveIdx] = useState(0);

  // Wire to the parent form so live values flow through without prop drilling.
  // useEffect runs after mount; we attach an input listener to the form so any
  // typed/picked change updates the local state used for the preview render.
  useEffect(() => {
    const form = document.querySelector("form");
    if (!form) return;
    const handler = (e: Event) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement | null;
      if (!target || !target.name?.startsWith("caption.")) return;
      setValues((v) => ({ ...v, [target.name]: target.value }));
    };
    form.addEventListener("input", handler);
    form.addEventListener("change", handler);
    return () => {
      form.removeEventListener("input", handler);
      form.removeEventListener("change", handler);
    };
  }, []);

  // Tick the karaoke active word every 500 ms so the highlight effect is
  // visible without playback. Loops over the 4 sample words.
  useEffect(() => {
    const id = setInterval(() => {
      setActiveIdx((i) => (i + 1) % SAMPLE_WORDS.length);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const get = (k: string, fallback: string) => (values[k] ?? "").trim() || fallback;
  const getNum = (k: string, fallback: number) => {
    const v = parseFloat(get(k, String(fallback)));
    return Number.isFinite(v) ? v : fallback;
  };

  const color = get("caption.color", "#facc15");
  const activeColor = get("caption.active_word_color", "#ffffff");
  const spokenColor = get("caption.spoken_word_color", "rgba(250, 204, 21, 0.45)");
  const outlineColor = get("caption.outline_color", "#0f172a");
  const outlineWidth = getNum("caption.outline_width", 6);
  const textTransform = get("caption.text_transform", "uppercase") as
    | "uppercase"
    | "none"
    | "lowercase";
  const letterSpacing = getNum("caption.letter_spacing", -0.5);
  const lineHeight = getNum("caption.line_height", 1.05);
  const fontWeight = getNum("caption.font_weight", 900);
  const paddingX = getNum("caption.padding_x", 64);
  const sizeScale = getNum("caption.size_scale", 1);
  const positionY = getNum("caption.position_y", 0.68);
  const wordHighlight = get("caption.word_highlight", "karaoke");

  // The preview frame is 320x180 (16:9-ish) scaled to look like a video
  // viewport. The composition's actual fontSize math at 1080x1920 is
  // 96 / 80 / 64 px per chunk-word-count tier; for the 4-word sample we use
  // the 96 px tier and scale it down to fit the preview width.
  const PREVIEW_W = 320;
  const PREVIEW_H = 180;
  const fontSize = Math.round(96 * sizeScale * (PREVIEW_W / 1080));

  return (
    <div
      className="relative overflow-hidden rounded-lg"
      style={{
        width: PREVIEW_W,
        height: PREVIEW_H,
        background:
          "linear-gradient(135deg, #15141A 0%, #211F29 50%, #15141A 100%)",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: `${positionY * 100}%`,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          padding: `0 ${(paddingX * PREVIEW_W) / 1080}px`,
          transform: "translateY(-50%)",
        }}
      >
        <div
          style={{
            fontSize,
            fontWeight,
            fontFamily: "Inter, system-ui, sans-serif",
            textTransform,
            letterSpacing: `${letterSpacing}px`,
            lineHeight,
            textAlign: "center",
            color,
            WebkitTextStroke: `${(outlineWidth * PREVIEW_W) / 1080}px ${outlineColor}`,
            maxWidth: "100%",
          }}
        >
          {SAMPLE_WORDS.map((w, i) => {
            const isActive = wordHighlight !== "none" && i === activeIdx;
            const isSpoken = wordHighlight !== "none" && i < activeIdx;
            return (
              <span
                key={i}
                style={{
                  color: isActive ? activeColor : isSpoken ? spokenColor : color,
                  marginRight: i < SAMPLE_WORDS.length - 1 ? 6 : 0,
                  display: "inline-block",
                  transition: "color 80ms ease-out",
                }}
              >
                {w}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
