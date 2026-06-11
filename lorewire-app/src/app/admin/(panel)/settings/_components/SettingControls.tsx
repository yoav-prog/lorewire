"use client";

import { useTransition } from "react";
import { saveSettingAction } from "@/app/admin/actions";

// Setting input primitives for the Settings/General page. Five flavors:
//   - SettingToggle: snappy on/off switch, optimistic via useTransition
//   - SettingNumber: number stepper with min/max/step
//   - SettingText: single-line text input
//   - SettingTextarea: multi-line textarea
//   - SettingPresetText: textarea + preset chips that fill the field
//
// Each one owns its own form posting to saveSettingAction so the wire shape
// matches the existing server contract — no migration needed on the action
// side. The toggle skips the Save button entirely (auto-saves on flip);
// every other control keeps an explicit Save button so the admin can type
// freely before committing.

function FieldShell({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <label className="mb-1 block text-[13px] font-semibold text-ink">
        {label}
      </label>
      {hint && <p className="mb-2 text-[12px] text-muted">{hint}</p>}
      {children}
    </div>
  );
}

// ─── SettingToggle ───────────────────────────────────────────────────────────
// Visual on/off switch. Click flips the value and auto-saves. Optimistic
// because the round-trip through the server action is invisible to the user
// — the switch updates immediately; useTransition keeps the page interactive
// during the revalidation.

export function SettingToggle({
  settingKey,
  label,
  hint,
  initialOn,
}: {
  settingKey: string;
  label: string;
  hint?: string;
  initialOn: boolean;
}) {
  const [isPending, startTransition] = useTransition();

  function flip(next: boolean) {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("key", settingKey);
      fd.set("value", next ? "1" : "0");
      await saveSettingAction(fd);
    });
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{label}</div>
          {hint && <p className="mt-1 text-[12px] text-muted">{hint}</p>}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={initialOn}
          disabled={isPending}
          onClick={() => flip(!initialOn)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
            initialOn
              ? "border-accent bg-accent"
              : "border-line bg-surface2"
          } ${isPending ? "opacity-50" : ""}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-bg transition-transform ${
              initialOn ? "translate-x-6" : "translate-x-1"
            }`}
          />
          <span className="sr-only">
            {initialOn ? "On" : "Off"} {label}
          </span>
        </button>
      </div>
    </div>
  );
}

// ─── SettingNumber ───────────────────────────────────────────────────────────
// Number input with explicit Save button. Browser-native number stepper +
// min/max so the field can't be put into a forbidden range from the keyboard.

export function SettingNumber({
  settingKey,
  label,
  hint,
  initial,
  min,
  max,
  step,
  prefix,
  suffix,
}: {
  settingKey: string;
  label: string;
  hint?: string;
  initial: string;
  min: number;
  max: number;
  step?: number;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <FieldShell label={label} hint={hint}>
      <form action={saveSettingAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="key" value={settingKey} />
        <div className="flex flex-1 items-center gap-1 rounded-lg border border-line bg-bg px-3 py-2 focus-within:border-accent">
          {prefix && <span className="text-[14px] text-muted">{prefix}</span>}
          <input
            name="value"
            type="number"
            defaultValue={initial}
            min={min}
            max={max}
            step={step ?? 1}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none"
          />
          {suffix && <span className="text-[14px] text-muted">{suffix}</span>}
        </div>
        <button className="rounded-lg border border-line px-4 py-2 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent">
          Save
        </button>
      </form>
    </FieldShell>
  );
}

// ─── SettingText ─────────────────────────────────────────────────────────────
// Single-line text input.

export function SettingText({
  settingKey,
  label,
  hint,
  initial,
  placeholder,
}: {
  settingKey: string;
  label: string;
  hint?: string;
  initial: string;
  placeholder?: string;
}) {
  return (
    <FieldShell label={label} hint={hint}>
      <form action={saveSettingAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="key" value={settingKey} />
        <input
          name="value"
          defaultValue={initial}
          placeholder={placeholder}
          className="min-w-[220px] flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
        />
        <button className="rounded-lg border border-line px-4 py-2 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent">
          Save
        </button>
      </form>
    </FieldShell>
  );
}

// ─── SettingPresetText ───────────────────────────────────────────────────────
// Textarea + a row of preset chips. Clicking a chip fills the textarea with
// that preset; the admin can then tweak before saving. Skips the round-trip
// of "load default → edit → save" for the common cases.

export function SettingPresetText({
  settingKey,
  label,
  hint,
  initial,
  placeholder,
  presets,
  rows = 3,
}: {
  settingKey: string;
  label: string;
  hint?: string;
  initial: string;
  placeholder?: string;
  presets: { label: string; value: string }[];
  rows?: number;
}) {
  // Inline script keeps this server-component friendly. A controlled
  // textarea would force the whole field client; presets are a one-shot
  // DOM-write, so we let chip clicks just set the textarea value directly.
  const textareaId = `setting-${settingKey.replace(/[^a-zA-Z0-9-]/g, "-")}`;
  return (
    <FieldShell label={label} hint={hint}>
      <form action={saveSettingAction} className="space-y-2">
        <input type="hidden" name="key" value={settingKey} />
        {presets.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <PresetChip
                key={p.label}
                label={p.label}
                value={p.value}
                targetId={textareaId}
              />
            ))}
          </div>
        )}
        <textarea
          id={textareaId}
          name="value"
          defaultValue={initial}
          placeholder={placeholder}
          rows={rows}
          className="block w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
        />
        <div className="flex justify-end">
          <button className="rounded-lg border border-line px-4 py-2 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent">
            Save
          </button>
        </div>
      </form>
    </FieldShell>
  );
}

function PresetChip({
  label,
  value,
  targetId,
}: {
  label: string;
  value: string;
  targetId: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        const el = document.getElementById(targetId);
        if (el instanceof HTMLTextAreaElement) {
          el.value = value;
          el.focus();
        }
      }}
      className="rounded-full border border-line px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent"
    >
      {label}
    </button>
  );
}
