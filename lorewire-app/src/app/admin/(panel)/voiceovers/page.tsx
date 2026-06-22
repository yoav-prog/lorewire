import { requireAdmin } from "@/lib/dal";
import {
  listVoiceovers,
  getDefaultVoiceoverId,
  getCategoryVoiceoverIds,
} from "@/lib/repo";
import { listVoices } from "@/lib/voice-library";
import { options } from "@/lib/models";
import { CATEGORIES } from "@/app/admin/ui";
import SettingsShell from "@/app/admin/SettingsShell";
import VoiceoverPresetRow from "./VoiceoverPresetRow";
import CategoryVoiceoverSelect from "./CategoryVoiceoverSelect";
import CreateVoiceover from "./CreateVoiceover";

const LABEL = "font-mono text-[11px] uppercase tracking-wider text-muted";

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
  const presetOptions = voiceovers.map((v) => ({ id: v.id, name: v.name }));

  return (
    <SettingsShell
      active="voiceovers"
      title="Voiceovers"
      description="Save narrator presets and pick one per category. Tap a row's ▶ for a quick listen, or open it to edit and preview. The pipeline resolves per-category → default → built-in fallback."
    >
      <div className="space-y-6">
        {/* Presets */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className={LABEL}>Presets</h2>
            <span className="text-[11px] text-muted">
              {voiceovers.length} saved
            </span>
          </div>

          {voiceovers.length === 0 ? (
            <p className="rounded-xl border border-line bg-surface p-4 text-[13px] text-muted">
              No voiceovers yet — create your first one below.
            </p>
          ) : (
            <div className="space-y-2">
              {voiceovers.map((v) => (
                <VoiceoverPresetRow
                  key={v.id}
                  preset={v}
                  models={models}
                  voices={voices}
                  isDefault={v.id === defaultId}
                />
              ))}
            </div>
          )}

          {voices.length > 0 ? (
            <CreateVoiceover models={models} voices={voices} />
          ) : (
            <p className="rounded-xl border border-dashed border-line bg-surface/40 p-4 text-[13px] text-muted">
              No Google voices are available to pick from. Check the voice
              library configuration.
            </p>
          )}
        </section>

        {/* Per-category */}
        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className={LABEL}>Per-category voice</h2>
          <p className="mb-3 mt-1 text-[13px] text-muted">
            Override the default for a category. &quot;Inherit default&quot; uses
            the preset badged <span className="text-ink">default</span> above.
            Changes save instantly.
          </p>
          <div className="space-y-2">
            {CATEGORIES.map((cat) => (
              <CategoryVoiceoverSelect
                key={cat}
                category={cat}
                currentId={categoryIds[cat] ?? ""}
                presets={presetOptions}
              />
            ))}
          </div>
        </section>
      </div>
    </SettingsShell>
  );
}
