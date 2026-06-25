import { requireCapability } from "@/lib/dal";
import {
  listVoiceovers,
  getDefaultVoiceoverId,
  getCategoryVoiceoverIds,
} from "@/lib/repo";
import { listVoices } from "@/lib/voice-library";
import { options } from "@/lib/models";
import { CATEGORIES } from "@/app/admin/ui";
import SettingsShell from "@/app/admin/SettingsShell";
import SettingsSection from "@/app/admin/SettingsSection";
import VoiceoverPresetRow from "./VoiceoverPresetRow";
import CategoryVoiceoverSelect from "./CategoryVoiceoverSelect";
import CreateVoiceover from "./CreateVoiceover";

export default async function VoiceoversPage() {
  await requireCapability("settings.manage");

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
      <div className="space-y-3">
        <SettingsSection
          title="Presets"
          description="Saved narrator presets. Each row plays a quick preview, opens to edit, and can be set as the global default."
          status={{ ok: true, label: `${voiceovers.length} saved` }}
        >
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
        </SettingsSection>

        <SettingsSection
          title="Per-category voice"
          description={`Override the default for a category. "Inherit default" uses the preset badged "default" above. Changes save instantly.`}
        >
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
        </SettingsSection>
      </div>
    </SettingsShell>
  );
}
