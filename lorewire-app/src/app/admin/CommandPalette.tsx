"use client";

import { useEffect, useState } from "react";

// Cmd-K command palette stub. Reserves the keybind today so muscle memory
// works; the actual command list is a follow-up. When the user (or anyone
// muscle-memorying from Linear/Vercel/Notion) hits Cmd-K or Ctrl-K, a small
// dialog opens with a clear "Coming soon" message describing what the
// palette will eventually do, so it doesn't look broken.
//
// Listens to keydown on the document. Skips the trigger when the user is
// typing in an input/textarea/contenteditable so Cmd-K doesn't fire while
// they're inside the article editor or any other text surface that might
// use it for its own commands.

const TRIGGER_KEY = "k";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === TRIGGER_KEY;
      if (!isCmdK) return;
      // Don't steal the keybind while the user is typing.
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setOpen((o) => !o);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onEsc);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    console.info("[admin command-palette] opened");
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      <button
        type="button"
        aria-label="Close command palette"
        onClick={() => setOpen(false)}
        className="absolute inset-0 bg-black/60"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-[560px] rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted">
              Command palette
            </p>
            <p className="mt-0.5 text-[14px] font-semibold text-ink">
              Coming soon
            </p>
          </div>
          <kbd className="rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11px] text-muted">
            Esc
          </kbd>
        </div>
        <div className="space-y-4 px-5 py-5 text-[13px] text-muted">
          <p>
            Cmd-K will eventually let you jump anywhere in the studio:
            open any article or video by title, switch settings categories,
            enqueue a regenerate, toggle a story&apos;s search visibility,
            sign out — all without leaving the keyboard.
          </p>
          <p>
            For now the keybind is reserved so your muscle memory doesn&apos;t
            land somewhere unexpected. Close this dialog with{" "}
            <kbd className="rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink">
              Esc
            </kbd>{" "}
            or click outside.
          </p>
          <p className="font-mono text-[11px] text-muted">
            Track progress in <code className="text-ink">_plans/</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
