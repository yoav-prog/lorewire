"use client";

import { useState } from "react";
import { previewVoiceoverAction } from "@/app/admin/actions";

// Plays a synthesized sample for a saved preset so the admin picks by ear.
// Calls the server action (which proxies to the Python TTS endpoint) and plays
// the returned data: URL. Preview needs the Google creds, so it only works on a
// deployed environment — the error path says so plainly rather than hanging.
export default function VoiceoverPreviewButton({ id }: { id: string }) {
  const [loading, setLoading] = useState(false);
  const [audio, setAudio] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onPreview() {
    setLoading(true);
    setError(null);
    setAudio(null);
    try {
      const res = await previewVoiceoverAction(id);
      if (res.ok) setAudio(res.audio);
      else setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onPreview}
        disabled={loading}
        className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink transition-colors hover:border-accent disabled:opacity-60"
      >
        {loading ? "Synthesizing…" : "Preview"}
      </button>
      {audio && <audio controls autoPlay src={audio} className="h-9" />}
      {error && <span className="text-[12px] text-red-400">{error}</span>}
    </div>
  );
}
