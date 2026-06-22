"use client";

// Our own share UI — replaces the OS share panel (the Web Share API hands off
// to the Windows share flyout on desktop, which is off-brand). A centered,
// dark-themed sheet with the canonical link, a one-tap copy, and explicit
// per-platform deep links. Used by both detail modals and the Wires card.
//
// Only ever fed the PUBLIC /v/[slug] URL (built by storyShareUrl) — never an
// internal id or a signed media URL.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  copyToClipboard,
  shareTargets,
  type ShareTargetId,
} from "@/lib/share";

// Per-platform white glyphs sitting on the brand-coloured chip. Kept as simple
// recognisable marks so nothing renders as a broken logo.
function Glyph({ id }: { id: ShareTargetId }) {
  switch (id) {
    case "whatsapp":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff" aria-hidden>
          <path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1 0 12 2Zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-2.9.8.8-2.8-.2-.3A8 8 0 1 1 12 20Zm4.5-5.6c-.2-.1-1.4-.7-1.7-.8s-.4-.1-.5.1-.6.8-.8 1-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.6-1.2a.5.5 0 0 0 0-.5l-.7-1.7c-.2-.5-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1 4.9 4.9 0 0 0 1 2.6 11 11 0 0 0 4.3 3.8c2 .8 2 .6 2.4.5a2.4 2.4 0 0 0 1.6-1.1 2 2 0 0 0 .1-1.1c0-.1-.2-.2-.4-.3Z" />
        </svg>
      );
    case "x":
      return (
        <svg width="19" height="19" viewBox="0 0 24 24" fill="#fff" aria-hidden>
          <path d="M18.9 2H22l-7.5 8.6L23 22h-6.8l-5.3-7-6.1 7H1.7l8-9.2L1 2h7l4.8 6.4L18.9 2Zm-1.2 18h1.9L7.1 4H5l12.7 16Z" />
        </svg>
      );
    case "facebook":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff" aria-hidden>
          <path d="M14 7h2V4h-2.5C11.6 4 10 5.6 10 7.5V9H8v3h2v8h3v-8h2.2l.4-3H13V7.6c0-.4.3-.6.7-.6Z" />
        </svg>
      );
    case "telegram":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff" aria-hidden>
          <path d="M21.9 4.3 18.6 20c-.2 1-.9 1.3-1.7.8l-4.6-3.4-2.2 2.1c-.3.3-.5.5-1 .5l.3-4.8 8.7-7.9c.4-.3-.1-.5-.6-.2L6.7 13.5l-4.6-1.4c-1-.3-1-1 .2-1.5l18-7c.8-.3 1.6.2 1.6 1.7Z" />
        </svg>
      );
    case "linkedin":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" aria-hidden>
          <path d="M6.9 8.2H4V20h2.9V8.2ZM5.4 3.5a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4ZM20 13.4c0-2.8-1.5-4.1-3.5-4.1a3 3 0 0 0-2.7 1.5V8.2H9v11.8h2.9v-6c0-1.4.6-2.2 1.7-2.2s1.5.7 1.5 2.2v6H20v-6.6Z" />
        </svg>
      );
    case "email":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7 9 6 9-6" />
        </svg>
      );
  }
}

const LinkIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 12h6M10.5 8H8a4 4 0 0 0 0 8h2.5M13.5 8H16a4 4 0 0 1 0 8h-2.5" />
  </svg>
);
const CheckIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m5 12 5 5L20 7" />
  </svg>
);
const CloseIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export interface ShareSheetProps {
  /** Public canonical URL to share. */
  url: string;
  /** Title used as the share text / email subject. */
  title: string;
  onClose: () => void;
}

export default function ShareSheet({ url, title, onClose }: ShareSheetProps) {
  const [copied, setCopied] = useState(false);
  const targets = shareTargets(url, title);

  // Escape closes, matching the detail modals' keyboard contract.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onCopy = async () => {
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Portal to <body> so the overlay is always viewport-correct, even when the
  // trigger lives inside a transformed ancestor (the scroll-snap Wires feed),
  // where position:fixed would otherwise anchor to the transformed parent.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center scrim-in"
      style={{ background: "rgba(0,0,0,.62)" }}
      onClick={(e) => {
        // Stop the click from bubbling to the detail modal's own scrim handler,
        // which would otherwise close the modal underneath the sheet.
        e.stopPropagation();
        onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Share"
    >
      <div
        className="modal-in w-full sm:max-w-[400px] rounded-t-2xl sm:rounded-2xl border border-line p-5"
        style={{
          background: "#15141A",
          boxShadow: "0 30px 90px rgba(0,0,0,.6)",
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 20px)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-display font-black uppercase tracking-tight text-ink" style={{ fontSize: 17 }}>
            Share
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-full text-muted hover:text-ink transition"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Canonical link + one-tap copy. */}
        <div className="mt-4 flex items-center gap-2 rounded-[11px] border border-line p-2 pl-3" style={{ background: "#0A0A0C" }}>
          <span className="min-w-0 flex-1 truncate font-body text-[13px] text-ink/80" title={url}>
            {url}
          </span>
          <button
            onClick={onCopy}
            className="flex shrink-0 items-center gap-1.5 rounded-[8px] px-3 py-2 font-display text-[12px] font-bold uppercase tracking-tight transition active:scale-95"
            style={{
              background: copied ? "rgba(232,70,43,.16)" : "#F5F3EF",
              color: copied ? "#E8462B" : "#0A0A0C",
            }}
            aria-label={copied ? "Link copied" : "Copy link"}
          >
            {copied ? <CheckIcon size={16} /> : <LinkIcon size={16} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        {/* Per-platform deep links. */}
        <div className="mt-5 grid grid-cols-3 gap-x-2 gap-y-4">
          {targets.map((t) => (
            <a
              key={t.id}
              href={t.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onClose}
              className="flex flex-col items-center gap-1.5 active:scale-95 transition"
            >
              <span className="grid h-12 w-12 place-items-center rounded-full" style={{ background: t.color }}>
                <Glyph id={t.id} />
              </span>
              <span className="font-body text-[11px] text-ink/80">{t.label}</span>
            </a>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
