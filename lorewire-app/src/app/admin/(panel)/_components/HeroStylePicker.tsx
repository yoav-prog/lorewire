// Step 4 of _plans/2026-06-17-hero-style-registry.md.
//
// Shared picker for the hero style registry. Used by:
//   - /admin/settings (global + per-category defaults)
//   - /admin/stories/[id] (per-story override — step 5)
//
// Renders the 6 styles as a thumbnail radio-grid, with an optional
// "Auto / use default" card at the top. Selection submits to
// saveSettingAction via a server-side form (no client JS), so picking
// a style on the settings page persists without a round-trip-through-
// React-state dance. Pure server component.
//
// The picker shows a caption beneath the grid that describes the
// resolution layer producing the currently-displayed pick — the
// user's explicit ask: "Show the resolution source". For settings
// pickers the caption is straightforward ("Pinned" / "Inherited"
// labels), and the per-story picker (step 5) wires in
// `heroStyleSourceLabel` from @/lib/hero-styles for the full
// "Auto-picked from the Drama short-list (neo_noir, painted_realism,
// magazine_editorial)" string.

import { HERO_STYLES, type HeroStyle } from "@/lib/hero-styles";
import { saveSettingAction } from "@/app/admin/actions";

export interface HeroStylePickerProps {
  /** Settings key the chosen value gets written to. Used when no
   *  `formAction` override is supplied — defaults to writing through
   *  `saveSettingAction`. Pass an empty string when overriding via
   *  `formAction` + `formHiddenFields`. */
  settingKey?: string;
  /** Optional override for the form's action. Step 5's per-story
   *  picker passes `saveStoryHeroStyleAction` here so the value flows
   *  into `stories.hero_style_id` instead of the settings table. */
  formAction?: (formData: FormData) => Promise<void> | void;
  /** Hidden inputs added to the form so the action gets whatever
   *  identifier it needs (e.g. `{storyId}` for the per-story action).
   *  Overrides the default `{key: settingKey}` shape when supplied. */
  formHiddenFields?: Record<string, string>;
  /** Already-selected style id, or empty string when "auto / use default". */
  selectedId: string;
  /** GCS URL per style id, or null when step 3's thumbnail gen hasn't
   *  produced one yet. The picker shows a labeled placeholder for null. */
  thumbnails: Record<string, string | null>;
  /** When true, the grid leads with an "Auto-pick / use default" card. */
  includeAutoOption: boolean;
  /** Label for the auto card. Defaults to "Auto-pick". The settings page
   *  uses category-specific copy ("Use the global default"). */
  autoOptionLabel?: string;
  /** Optional one-line description shown directly under the caption.
   *  When omitted, the picker derives a short generic line. */
  captionOverride?: string;
  /** When supplied, replaces the default "Save" CTA copy on the
   *  submit button. */
  saveLabel?: string;
  /** Header label shown above the grid. */
  label: string;
  /** One-line description under `label`. */
  hint?: string;
}

const AUTO_VALUE = "";

export function HeroStylePicker({
  settingKey,
  formAction,
  formHiddenFields,
  selectedId,
  thumbnails,
  includeAutoOption,
  autoOptionLabel = "Auto-pick",
  captionOverride,
  saveLabel = "Save",
  label,
  hint,
}: HeroStylePickerProps) {
  const selected = selectedId === "" ? AUTO_VALUE : selectedId;
  const caption =
    captionOverride ??
    (selected === AUTO_VALUE
      ? "Falls through to the next layer in the resolver chain."
      : `Pinned to "${HERO_STYLES.find((s) => s.id === selected)?.label ?? selected}".`);

  // Default action posts to saveSettingAction with `key=settingKey` —
  // step 4's settings-page contract. Step 5's per-story picker overrides
  // both `formAction` and `formHiddenFields` so the value lands on
  // `stories.hero_style_id` instead of the settings table.
  const action = formAction ?? saveSettingAction;
  const hiddenFields =
    formHiddenFields ?? (settingKey ? { key: settingKey } : {});

  // For the test selector + form persistence we need ONE stable testid
  // marker on the caption + ONE consistent hidden field set. Picker
  // consumers passing formAction must also pass formHiddenFields so
  // the wire-shape matches their action's expected fields.
  const captionTestId = settingKey ? `${settingKey}-caption` : "hero-style-caption";

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-semibold uppercase tracking-wider text-ink/85">
          {label}
        </span>
        {hint ? (
          <span className="text-[12.5px] text-ink/65">{hint}</span>
        ) : null}
      </div>

      <form action={action} className="space-y-3">
        {Object.entries(hiddenFields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <div
          role="radiogroup"
          aria-label={label}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3"
        >
          {includeAutoOption ? (
            <HeroStyleAutoCard
              fieldName="value"
              selected={selected === AUTO_VALUE}
              label={autoOptionLabel}
            />
          ) : null}
          {HERO_STYLES.map((style) => (
            <HeroStyleRadioCard
              key={style.id}
              fieldName="value"
              style={style}
              thumbnailUrl={thumbnails[style.id] ?? null}
              selected={selected === style.id}
            />
          ))}
        </div>

        <div className="flex items-center justify-between gap-3">
          <p
            data-testid={captionTestId}
            className="text-[12px] text-ink/55"
          >
            {caption}
          </p>
          <button
            type="submit"
            className="rounded-lg border border-line px-4 py-1.5 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent"
          >
            {saveLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function HeroStyleRadioCard({
  fieldName,
  style,
  thumbnailUrl,
  selected,
}: {
  fieldName: string;
  style: HeroStyle;
  thumbnailUrl: string | null;
  selected: boolean;
}) {
  return (
    <label
      data-testid={`hero-style-card-${style.id}`}
      data-selected={selected ? "true" : "false"}
      className={`group relative flex cursor-pointer flex-col gap-2 rounded-lg border p-2 transition-colors ${
        selected
          ? "border-accent bg-accent/5"
          : "border-line bg-bg hover:border-accent/60"
      }`}
    >
      <input
        type="radio"
        name={fieldName}
        value={style.id}
        defaultChecked={selected}
        className="sr-only"
      />
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded bg-line/30">
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- GCS URL, no Next/Image perf gain
          <img
            src={thumbnailUrl}
            alt={`${style.label} preview`}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-center text-[10px] uppercase tracking-wider text-ink/40">
            preview pending
          </div>
        )}
        {selected ? (
          <span
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white"
          >
            ✓
          </span>
        ) : null}
      </div>
      <span className="text-[12.5px] font-medium leading-tight text-ink/90">
        {style.label}
      </span>
    </label>
  );
}

function HeroStyleAutoCard({
  fieldName,
  selected,
  label,
}: {
  fieldName: string;
  selected: boolean;
  label: string;
}) {
  return (
    <label
      data-testid="hero-style-card-auto"
      data-selected={selected ? "true" : "false"}
      className={`group relative flex cursor-pointer flex-col gap-2 rounded-lg border p-2 transition-colors ${
        selected
          ? "border-accent bg-accent/5"
          : "border-line bg-bg hover:border-accent/60"
      }`}
    >
      <input
        type="radio"
        name={fieldName}
        value=""
        defaultChecked={selected}
        className="sr-only"
      />
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded border border-dashed border-line/60 bg-bg">
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-2 text-center">
          <span className="text-[20px] leading-none text-ink/40">⤓</span>
          <span className="text-[10px] uppercase tracking-wider text-ink/50">
            auto
          </span>
        </div>
        {selected ? (
          <span
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white"
          >
            ✓
          </span>
        ) : null}
      </div>
      <span className="text-[12.5px] font-medium leading-tight text-ink/90">
        {label}
      </span>
    </label>
  );
}
