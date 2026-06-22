"use client";

import { useState, useTransition } from "react";
import {
  previewVoiceoverConfigAction,
  setDefaultVoiceoverAction,
  deleteVoiceoverAction,
} from "@/app/admin/actions";
import VoiceoverEditor from "./VoiceoverEditor";

type VoiceOption = {
  voice_id: string;
  name: string;
  gender?: string;
  accent?: string;
};
type ModelOption = { id: string; label: string };
type Preset = {
  id: string;
  name: string;
  provider: string;
  voice_id: string;
  style_prompt: string | null;
  speaking_rate: number | null;
  hook_pause: number | null;
};

// A short ~2-3s line for a fast audition. The editor's "Preview voice" uses the
// fuller default sample; here we want speed, and a 1s hook pause inside a 3s
// clip is awkward, so the quick preview turns the pause off.
const QUICK_SAMPLE = "Okay — you are not going to believe what just happened.";

// One preset as a compact row that expands to edit. Replaces the old
// permanent-box-per-preset layout. Quick preview + make-default + delete all
// give live feedback (useTransition), so a click never feels like a no-op.
export default function VoiceoverPresetRow({
  preset,
  models,
  voices,
  isDefault,
}: {
  preset: Preset;
  models: ModelOption[];
  voices: VoiceOption[];
  isDefault: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [audio, setAudio] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [settingDefault, startDefault] = useTransition();
  const [deleting, startDelete] = useTransition();

  const voice = voices.find((v) => v.voice_id === preset.voice_id);
  const model = models.find((m) => m.id === preset.provider);

  async function quickPreview() {
    setPreviewing(true);
    setPreviewError(null);
    setAudio(null);
    try {
      const res = await previewVoiceoverConfigAction({
        provider: preset.provider,
        voice_id: preset.voice_id,
        style_prompt: preset.style_prompt,
        speaking_rate: preset.speaking_rate,
        hook_pause: false,
        text: QUICK_SAMPLE,
      });
      if (res.ok) setAudio(res.audio);
      else setPreviewError(res.error);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  }

  function makeDefault() {
    const fd = new FormData();
    fd.set("id", preset.id);
    startDefault(() => setDefaultVoiceoverAction(fd));
  }

  function remove() {
    if (!confirm(`Delete the "${preset.name}" voiceover?`)) return;
    const fd = new FormData();
    fd.set("id", preset.id);
    startDelete(() => deleteVoiceoverAction(fd));
  }

  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-3 p-3">
        <button
          type="button"
          onClick={quickPreview}
          disabled={previewing}
          aria-label={`Preview ${preset.name}`}
          title="Quick preview"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
        >
          {previewing ? <Spinner /> : <PlayIcon />}
        </button>

        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-x-2 gap-y-1 text-left"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-semibold text-ink">{preset.name}</span>
            {isDefault && <DefaultBadge />}
            <span className="flex items-center gap-1.5 text-[12px] text-muted">
              <span>{voice?.name ?? preset.voice_id}</span>
              {voice?.gender && <GenderDot gender={voice.gender} />}
              <span aria-hidden>·</span>
              <span className="truncate">{model?.label ?? preset.provider}</span>
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {!isDefault && (
            <button
              type="button"
              onClick={makeDefault}
              disabled={settingDefault}
              className="rounded-md px-2 py-1 text-[12px] text-muted transition-colors hover:text-accent disabled:opacity-60"
            >
              {settingDefault ? "Setting…" : "Make default"}
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink transition-colors hover:text-accent"
          >
            Edit
            <Chevron open={expanded} />
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={deleting}
            className="rounded-md px-2 py-1 text-[12px] text-muted transition-colors hover:text-red-400 disabled:opacity-60"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      {previewError && (
        <p className="px-3 pb-2 text-[12px] text-red-400">{previewError}</p>
      )}
      {audio && (
        <div className="px-3 pb-3">
          <audio
            autoPlay
            controls
            src={audio}
            className="h-8 w-full max-w-sm"
          />
        </div>
      )}

      {expanded && (
        <div className="border-t border-line p-4">
          <VoiceoverEditor preset={preset} models={models} voices={voices} />
        </div>
      )}
    </div>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
      <path d="M6 4.5v11l9-5.5z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 animate-spin" aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M17 10a7 7 0 0 0-7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
      aria-hidden="true"
    >
      <path
        d="M5 7.5 10 12.5 15 7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DefaultBadge() {
  return (
    <span className="shrink-0 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink">
      default
    </span>
  );
}

function GenderDot({ gender }: { gender: string }) {
  const female = gender === "Female";
  return (
    <span
      className={`inline-flex h-4 w-4 items-center justify-center rounded-full border text-[9px] font-medium ${
        female
          ? "border-pink-400/25 bg-pink-400/10 text-pink-200"
          : "border-sky-400/25 bg-sky-400/10 text-sky-200"
      }`}
      title={gender}
    >
      {female ? "F" : "M"}
    </span>
  );
}
