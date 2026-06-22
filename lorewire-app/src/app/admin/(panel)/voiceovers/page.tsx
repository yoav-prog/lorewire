import { requireAdmin } from "@/lib/dal";
import {
  listVoiceovers,
  getDefaultVoiceoverId,
  getCategoryVoiceoverIds,
  type VoiceoverRow,
} from "@/lib/repo";
import { listVoices, type VoiceEntry } from "@/lib/voice-library";
import { options } from "@/lib/models";
import { CATEGORIES } from "@/app/admin/ui";
import {
  saveVoiceoverAction,
  deleteVoiceoverAction,
  setDefaultVoiceoverAction,
  setCategoryVoiceoverAction,
} from "@/app/admin/actions";
import SettingsShell from "@/app/admin/SettingsShell";
import VoiceoverPreviewButton from "./VoiceoverPreviewButton";

const FIELD =
  "rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";
const LABEL =
  "font-mono text-[11px] uppercase tracking-wider text-muted";
const BTN =
  "rounded-lg bg-accent px-4 py-2 font-semibold text-bg transition-opacity hover:opacity-90";
const BTN_GHOST =
  "rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-muted transition-colors hover:text-ink";

// The editor form, reused for the create row (preset=null) and each saved
// preset. Plain HTML form posting to the server action — no client JS needed
// here; only the preview button is interactive.
function PresetForm({
  preset,
  models,
  voices,
}: {
  preset: VoiceoverRow | null;
  models: { id: string; label: string }[];
  voices: VoiceEntry[];
}) {
  const provider = preset?.provider ?? "google/gemini-25-flash-tts";
  const voiceId = preset?.voice_id ?? voices[0]?.voice_id ?? "";
  return (
    <form action={saveVoiceoverAction} className="grid gap-3">
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
          className="h-4 w-4 accent-[var(--accent,#000)]"
        />
        Pause after the cold-open hook
      </label>
      <div>
        <button className={BTN}>{preset ? "Save changes" : "Create voiceover"}</button>
      </div>
    </form>
  );
}

export default async function VoiceoversPage() {
  await requireAdmin();

  const [voiceovers, defaultId, categoryIds, allVoices] = await Promise.all([
    listVoiceovers(),
    getDefaultVoiceoverId(),
    getCategoryVoiceoverIds(),
    listVoices(),
  ]);
  // Google-only models + voices (the shorts narrator is Google TTS). The Chirp
  // voice names are shared with the Gemini tiers, so this one list covers both.
  const models = options("voice")
    .filter((o) => o.provider === "google")
    .map((o) => ({ id: o.id, label: o.label }));
  const voices = allVoices.filter((v) => v.provider === "google/chirp3-hd");

  return (
    <SettingsShell
      active="voiceovers"
      title="Voiceovers"
      description="Save named narrator presets, pick the default for shorts, and assign a voice per category. The pipeline resolves per-category → default → built-in fallback."
    >
      <div className="space-y-6">
        {/* Global default */}
        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className={LABEL}>Default voiceover</h2>
          <p className="mb-3 mt-1 text-[13px] text-muted">
            Used for every short unless its category overrides it below.
          </p>
          <form
            action={setDefaultVoiceoverAction}
            className="flex flex-wrap items-center gap-2"
          >
            <select name="id" defaultValue={defaultId} className={FIELD}>
              {voiceovers.length === 0 && <option value="">No presets yet</option>}
              {voiceovers.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button className={BTN}>Set default</button>
          </form>
        </section>

        {/* Per-category */}
        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className={LABEL}>Per-category voice</h2>
          <p className="mb-3 mt-1 text-[13px] text-muted">
            Override the default for a category. &quot;Inherit default&quot; uses
            the voiceover above.
          </p>
          <div className="space-y-2">
            {CATEGORIES.map((cat) => (
              <form
                key={cat}
                action={setCategoryVoiceoverAction}
                className="flex flex-wrap items-center gap-2"
              >
                <input type="hidden" name="category" value={cat} />
                <span className="w-24 text-[13px] text-ink">{cat}</span>
                <select
                  name="id"
                  defaultValue={categoryIds[cat] ?? ""}
                  className={FIELD}
                >
                  <option value="">Inherit default</option>
                  {voiceovers.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                <button className={BTN_GHOST}>Save</button>
              </form>
            ))}
          </div>
        </section>

        {/* Presets */}
        <section className="space-y-4">
          <h2 className={LABEL}>Presets</h2>
          {voiceovers.map((v) => (
            <div key={v.id} className="rounded-xl border border-line bg-surface p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink">{v.name}</span>
                  {v.id === defaultId && (
                    <span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink">
                      default
                    </span>
                  )}
                </div>
                <span className="font-mono text-[11px] text-muted">
                  {v.provider} · {v.voice_id}
                </span>
              </div>
              <PresetForm preset={v} models={models} voices={voices} />
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
                <VoiceoverPreviewButton id={v.id} />
                <form action={deleteVoiceoverAction}>
                  <input type="hidden" name="id" value={v.id} />
                  <button className="text-[12px] text-muted transition-colors hover:text-red-400">
                    Delete
                  </button>
                </form>
              </div>
            </div>
          ))}
        </section>

        {/* Create */}
        <section className="rounded-xl border border-dashed border-line bg-surface/50 p-5">
          <h2 className={`${LABEL} mb-3`}>New voiceover</h2>
          {voices.length === 0 ? (
            <p className="text-[13px] text-muted">
              No Google voices are available to pick from. Check the voice
              library configuration.
            </p>
          ) : (
            <PresetForm preset={null} models={models} voices={voices} />
          )}
        </section>
      </div>
    </SettingsShell>
  );
}
