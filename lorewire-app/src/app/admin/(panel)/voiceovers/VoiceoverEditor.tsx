"use client";

import { useRef, useState } from "react";
import {
  saveVoiceoverAction,
  previewVoiceoverConfigAction,
} from "@/app/admin/actions";

// Local prop types — the source modules (voice-library, repo) are server-only,
// so we can't import their types into a client component. These are structural
// subsets of VoiceEntry / VoiceoverRow, so the server page can pass those rows
// straight in.
type VoiceOption = {
  voice_id: string;
  name: string;
  gender?: string;
  accent?: string;
};
type ModelOption = { id: string; label: string };
type PresetInit = {
  id: string;
  name: string;
  provider: string;
  voice_id: string;
  style_prompt: string | null;
  speaking_rate: number | null;
  hook_pause: number | null;
} | null;

const FIELD =
  "rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
const LABEL = "font-mono text-[11px] uppercase tracking-wider text-muted";

// The preset editor (create + edit). Fields are uncontrolled (defaultValue);
// Save submits via the server action. Preview reads the CURRENT field values
// off the form and synthesizes them, so you can hear a voice before saving.
export default function VoiceoverEditor({
  preset,
  models,
  voices,
}: {
  preset: PresetInit;
  models: ModelOption[];
  voices: VoiceOption[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [previewing, setPreviewing] = useState(false);
  const [audio, setAudio] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onPreview() {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    setPreviewing(true);
    setError(null);
    setAudio(null);
    try {
      const res = await previewVoiceoverConfigAction({
        provider: String(fd.get("provider") ?? ""),
        voice_id: String(fd.get("voice_id") ?? ""),
        style_prompt: String(fd.get("style_prompt") ?? ""),
        speaking_rate: fd.get("speaking_rate")
          ? Number(fd.get("speaking_rate"))
          : null,
        hook_pause: fd.get("hook_pause") === "1",
      });
      if (res.ok) setAudio(res.audio);
      else setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }

  const provider = preset?.provider ?? "google/gemini-25-flash-tts";
  const voiceId = preset?.voice_id ?? voices[0]?.voice_id ?? "";

  return (
    <form ref={formRef} action={saveVoiceoverAction} className="grid gap-3">
      {preset && <input type="hidden" name="id" value={preset.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className={LABEL}>Name</span>
          <input
            name="name"
            required
            defaultValue={preset?.name ?? ""}
            placeholder="House Voice"
            className={FIELD}
          />
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Model</span>
          <select name="provider" defaultValue={provider} className={FIELD}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Voice</span>
          <select name="voice_id" defaultValue={voiceId} className={FIELD}>
            {voices.map((v) => (
              <option key={v.voice_id} value={v.voice_id}>
                {v.name}
                {v.gender ? ` (${v.gender})` : ""}
                {v.accent ? ` — ${v.accent}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={LABEL}>Speaking rate (Chirp only, 0.25–2.0)</span>
          <input
            name="speaking_rate"
            type="number"
            step="0.05"
            min="0.25"
            max="2"
            defaultValue={preset?.speaking_rate ?? 1.2}
            className={FIELD}
          />
        </label>
      </div>
      <label className="grid gap-1">
        <span className={LABEL}>
          Style prompt (Gemini — how the voice should deliver)
        </span>
        <textarea
          name="style_prompt"
          rows={3}
          defaultValue={preset?.style_prompt ?? ""}
          placeholder="You are a lively young social-media creator talking straight to camera. Upbeat, expressive, fast and casual."
          className={`${FIELD} resize-y`}
        />
      </label>
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input
          type="checkbox"
          name="hook_pause"
          value="1"
          defaultChecked={preset ? !!preset.hook_pause : true}
          className="h-4 w-4"
        />
        Pause after the cold-open hook
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button className="rounded-lg bg-accent px-4 py-2 font-semibold text-bg transition-opacity hover:opacity-90">
          {preset ? "Save changes" : "Create voiceover"}
        </button>
        <button
          type="button"
          onClick={onPreview}
          disabled={previewing}
          className="rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink transition-colors hover:border-accent disabled:opacity-60"
        >
          {previewing ? "Synthesizing…" : "Preview voice"}
        </button>
        {audio && <audio controls autoPlay src={audio} className="h-9" />}
        {error && <span className="text-[12px] text-red-400">{error}</span>}
      </div>
    </form>
  );
}
