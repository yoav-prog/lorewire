"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { saveSettingAction } from "@/app/admin/actions";
import {
  AutoSaveStatus,
  ChipGroup,
  ColorPicker,
  Slider,
  useDebouncedSave,
  type ChipOption,
} from "@/components/ui";

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
  status,
  children,
}: {
  label: string;
  hint?: string;
  /** Optional autosave-status pill rendered to the right of the label.
   *  Used by SettingText / SettingPresetText to show idle / saving /
   *  saved / error feedback (matches the SettingSlider layout). */
  status?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <label className="block text-[13px] font-semibold text-ink">
          {label}
        </label>
        {status}
      </div>
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
// Phase D of the admin UI overhaul: replaced with a polished Slider +
// auto-save. The prefix arg (e.g. "$") + numeric stepper combo is gone
// — the Slider's value display + optional unit covers both. Caller API
// is the same shape so existing call sites work after a one-line
// rename (SettingNumber → SettingSlider).
//
// Kept as a thin wrapper for backwards compatibility during the
// migration. Once every call site moves to SettingSlider this becomes
// a one-liner forwarder we can delete in a follow-up.

export function SettingNumber(props: {
  settingKey: string;
  label: string;
  hint?: string;
  initial: string;
  min: number;
  max: number;
  step?: number;
  /** Legacy: rendered as the Slider's `unit` suffix (e.g. "$", "px"). */
  prefix?: string;
  suffix?: string;
}) {
  return (
    <SettingSlider
      settingKey={props.settingKey}
      label={props.label}
      hint={props.hint}
      initial={props.initial}
      min={props.min}
      max={props.max}
      step={props.step}
      // Map legacy prefix/suffix to the new unit on the value display.
      unit={props.suffix ?? props.prefix}
    />
  );
}

// ─── SettingSlider ───────────────────────────────────────────────────────────
// Slider-based numeric setting with 500ms-debounced auto-save. Uses
// the Phase A UI library's Slider + AutoSaveStatus + useDebouncedSave
// hook so the visual + behaviour matches the video editor's panels.
//
// Save callback wraps `saveSettingAction` (which is `Promise<void>`)
// and converts thrown errors into a structured result the
// useDebouncedSave hook can surface via the AutoSaveStatus pill.

export function SettingSlider({
  settingKey,
  label,
  hint,
  initial,
  min,
  max,
  step,
  unit,
  tickValue,
  endpoints,
}: {
  settingKey: string;
  label: string;
  hint?: string;
  initial: string;
  min: number;
  max: number;
  step?: number;
  /** Suffix on the value display (e.g. "px", "dB", "$"). */
  unit?: string;
  /** Optional tick mark for the default value. */
  tickValue?: number;
  /** Optional endpoint labels (e.g. ["MIN", "MAX"]). */
  endpoints?: [string, string];
}) {
  const parsed = parseFloat(initial);
  const safeInitial = Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : min;
  const [value, setValue] = useState(safeInitial);

  const save = useDebouncedSave(
    async (next: number) => {
      try {
        const fd = new FormData();
        fd.set("key", settingKey);
        fd.set("value", String(next));
        await saveSettingAction(fd);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "save-failed",
        };
      }
    },
    { debounceMs: 500 },
  );

  function update(next: number) {
    setValue(next);
    save.request(next);
  }

  // Slider's value display only renders when its own `label` prop is
  // set. We render the label inside this card so the inner Slider gets
  // none — surface the live numeric value (with the unit) here next
  // to the save status instead.
  const stepDecimals = (() => {
    const s = step ?? 1;
    if (s >= 1) return 0;
    if (s >= 0.1) return 1;
    if (s >= 0.01) return 2;
    return 3;
  })();
  const displayValue = `${value.toFixed(stepDecimals)}${unit ? unit : ""}`;

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <label className="text-[13px] font-semibold text-ink">{label}</label>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[12px] tabular-nums text-ink">
            {displayValue}
          </span>
          <AutoSaveStatus
            state={save.state}
            detail={save.lastError ?? undefined}
          />
        </div>
      </div>
      {hint && <p className="mb-3 text-[12px] text-muted">{hint}</p>}
      <Slider
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        unit={unit}
        tickValue={tickValue}
        endpoints={endpoints}
        onChange={update}
        ariaLabel={label}
      />
    </div>
  );
}

// ─── SettingColor ────────────────────────────────────────────────────────────
// Phase E: color picker setting with 500ms-debounced auto-save. Wraps the
// Phase A ColorPicker so the SEO theme color (and any future hex setting)
// gets the polished swatch + palette + recents popover instead of a raw
// text field.
//
// The picker stores hex with a leading '#'. The auto-save pipeline writes
// the literal string into settings_kv via saveSettingAction.

export function SettingColor({
  settingKey,
  label,
  hint,
  initial,
  placeholder = "#000000",
}: {
  settingKey: string;
  label: string;
  hint?: string;
  initial: string;
  /** Used when the stored value is empty so the swatch isn't an undefined
   *  color. Doesn't get written until the user picks something. */
  placeholder?: string;
}) {
  const startValue = initial.trim() || placeholder;
  const [value, setValue] = useState(startValue);

  const save = useDebouncedSave(
    async (next: string) => {
      try {
        const fd = new FormData();
        fd.set("key", settingKey);
        fd.set("value", next);
        await saveSettingAction(fd);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "save-failed",
        };
      }
    },
    { debounceMs: 500 },
  );

  function update(next: string) {
    setValue(next);
    save.request(next);
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <label className="text-[13px] font-semibold text-ink">{label}</label>
        <AutoSaveStatus
          state={save.state}
          detail={save.lastError ?? undefined}
        />
      </div>
      {hint && <p className="mb-3 text-[12px] text-muted">{hint}</p>}
      <ColorPicker value={value} onChange={update} ariaLabel={label} />
    </div>
  );
}

// ─── SettingChipGroup ────────────────────────────────────────────────────────
// Phase E: visual chip-group setting with auto-save. Wraps the Phase A
// ChipGroup so an enumerated setting (e.g. seo.twitter_card_type) becomes
// a row of visual chips with mini-previews instead of a dropdown.
//
// Generic over the option id type — caller passes `ChipOption<T>[]` and
// gets a typed `onChange(next: T)` back through the auto-save pipeline.

export function SettingChipGroup<T extends string>({
  settingKey,
  label,
  hint,
  initial,
  options,
}: {
  settingKey: string;
  label: string;
  hint?: string;
  initial: T;
  options: ChipOption<T>[];
}) {
  const [value, setValue] = useState<T>(initial);

  const save = useDebouncedSave(
    async (next: T) => {
      try {
        const fd = new FormData();
        fd.set("key", settingKey);
        fd.set("value", next);
        await saveSettingAction(fd);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "save-failed",
        };
      }
    },
    { debounceMs: 500 },
  );

  function update(next: T) {
    setValue(next);
    save.request(next);
  }

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <label className="text-[13px] font-semibold text-ink">{label}</label>
        <AutoSaveStatus
          state={save.state}
          detail={save.lastError ?? undefined}
        />
      </div>
      {hint && <p className="mb-3 text-[12px] text-muted">{hint}</p>}
      <ChipGroup
        value={value}
        options={options}
        onChange={update}
        ariaLabel={label}
      />
    </div>
  );
}

// ─── SettingText ─────────────────────────────────────────────────────────────
// Single-line text input with 500ms-debounced auto-save. Matches the
// SettingSlider / SettingToggle pattern (no manual Save button — the
// AutoSaveStatus pill next to the label shows idle / saving / saved /
// error feedback). `flush` fires on blur so a user clicking away
// without waiting still persists the value.

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
  const [value, setValue] = useState(initial);
  const save = useDebouncedSave(
    async (next: string) => {
      try {
        const fd = new FormData();
        fd.set("key", settingKey);
        fd.set("value", next);
        await saveSettingAction(fd);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "save-failed",
        };
      }
    },
    { debounceMs: 500 },
  );

  function update(next: string) {
    setValue(next);
    save.request(next);
  }

  return (
    <FieldShell
      label={label}
      hint={hint}
      status={
        <AutoSaveStatus
          state={save.state}
          detail={save.lastError ?? undefined}
        />
      }
    >
      <input
        value={value}
        onChange={(e) => update(e.target.value)}
        onBlur={save.flush}
        placeholder={placeholder}
        className="block w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
      />
    </FieldShell>
  );
}

// ─── SettingPresetText ───────────────────────────────────────────────────────
// Textarea + a row of preset chips with 500ms-debounced auto-save.
// Clicking a chip fills the textarea with that preset; the admin can
// tweak inline and the change autosaves like SettingText. No manual
// Save button — the AutoSaveStatus pill shows idle / saving / saved /
// error feedback.

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
  const [value, setValue] = useState(initial);
  const save = useDebouncedSave(
    async (next: string) => {
      try {
        const fd = new FormData();
        fd.set("key", settingKey);
        fd.set("value", next);
        await saveSettingAction(fd);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "save-failed",
        };
      }
    },
    { debounceMs: 500 },
  );

  function update(next: string) {
    setValue(next);
    save.request(next);
  }

  return (
    <FieldShell
      label={label}
      hint={hint}
      status={
        <AutoSaveStatus
          state={save.state}
          detail={save.lastError ?? undefined}
        />
      }
    >
      <div className="space-y-2">
        {presets.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <PresetChip
                key={p.label}
                label={p.label}
                onPick={() => update(p.value)}
              />
            ))}
          </div>
        )}
        <textarea
          value={value}
          onChange={(e) => update(e.target.value)}
          onBlur={save.flush}
          placeholder={placeholder}
          rows={rows}
          className="block w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
        />
      </div>
    </FieldShell>
  );
}

function PresetChip({
  label,
  onPick,
}: {
  label: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="rounded-full border border-line px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted transition-colors hover:border-accent hover:text-accent"
    >
      {label}
    </button>
  );
}

// ─── SettingSelect ───────────────────────────────────────────────────────────
// Dropdown for an enumerated set of options sourced from an API. Used for the
// voice fields (Google + ElevenLabs). When `options` is empty (API
// unreachable or credentials missing), falls back to a plain text input so
// the admin can still configure things by typing the id directly.
//
// Options are grouped by `group` (typically locale or accent) so a long list
// stays scannable. The current value is preserved even if it isn't in the
// options list (e.g. a custom voice the user pasted in before the API came
// online).

export interface SelectOption {
  id: string;
  label: string;
  group?: string;
}

export function SettingSelect({
  settingKey,
  label,
  hint,
  initial,
  options,
  placeholder,
  emptyHint,
}: {
  settingKey: string;
  label: string;
  hint?: string;
  initial: string;
  options: SelectOption[];
  placeholder?: string;
  emptyHint?: string;
}) {
  // Empty option list -> fall back to free text input.
  if (options.length === 0) {
    return (
      <FieldShell
        label={label}
        hint={
          emptyHint
            ? `${hint ? `${hint} ` : ""}${emptyHint}`
            : hint
        }
      >
        <form
          action={saveSettingAction}
          className="flex flex-wrap items-center gap-2"
        >
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

  // Group options for readability. `Map` insertion order matters — options
  // arrive pre-sorted from the provider helper so a stable map iteration
  // produces stable group order.
  const groups = new Map<string, SelectOption[]>();
  for (const o of options) {
    const g = o.group ?? "";
    const arr = groups.get(g) ?? [];
    arr.push(o);
    groups.set(g, arr);
  }

  const currentIsKnown = options.some((o) => o.id === initial);

  return (
    <FieldShell label={label} hint={hint}>
      <form action={saveSettingAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="key" value={settingKey} />
        <select
          name="value"
          defaultValue={initial}
          className="min-w-[260px] flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
        >
          {!currentIsKnown && initial !== "" && (
            <option value={initial}>{initial} (custom)</option>
          )}
          {placeholder && <option value="">— pick one —</option>}
          {Array.from(groups.entries()).map(([groupLabel, opts]) =>
            groupLabel ? (
              <optgroup key={groupLabel} label={groupLabel}>
                {opts.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ) : (
              opts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))
            ),
          )}
        </select>
        <button className="rounded-lg border border-line px-4 py-2 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent">
          Save
        </button>
      </form>
    </FieldShell>
  );
}

// ─── SettingAutocomplete ─────────────────────────────────────────────────────
// Text input that shows suggestions as the admin types. Used for the
// default subreddit field. Hits `/api/admin/subreddit-suggest?q=...` with
// a 250ms debounce so we don't hammer the upstream Reddit endpoint on every
// keystroke. Suggestions are clickable and fill the input; the input still
// accepts any free-text value so an obscure or new subreddit not in the
// autocomplete index can still be saved.

export interface AutocompleteSuggestion {
  /** Value to fill the input with. */
  value: string;
  /** Display label (defaults to value). */
  label?: string;
  /** Optional secondary line (e.g. subscriber count). */
  meta?: string;
}

export function SettingAutocomplete({
  settingKey,
  label,
  hint,
  initial,
  placeholder,
  endpoint,
  mapResponse,
  minQueryLength = 2,
}: {
  settingKey: string;
  label: string;
  hint?: string;
  initial: string;
  placeholder?: string;
  endpoint: string;
  /** Map the JSON response shape to a slim suggestion list. */
  mapResponse: (json: unknown) => AutocompleteSuggestion[];
  minQueryLength?: number;
}) {
  const [value, setValue] = useState(initial);
  const [suggestions, setSuggestions] = useState<AutocompleteSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Skip fetching when there's nothing to fetch. Clearing of suggestions
    // for short values happens in the change handler (rule: don't setState
    // synchronously inside an effect).
    if (!open || value.length < minQueryLength) return;
    let cancelled = false;
    debounceRef.current = setTimeout(async () => {
      try {
        const url = new URL(endpoint, window.location.origin);
        url.searchParams.set("q", value);
        const r = await fetch(url.toString(), { credentials: "same-origin" });
        if (cancelled) return;
        if (!r.ok) {
          setSuggestions([]);
          return;
        }
        const json = await r.json();
        if (cancelled) return;
        setSuggestions(mapResponse(json));
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, open, endpoint, minQueryLength, mapResponse]);

  // Click outside closes the dropdown.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function pick(s: AutocompleteSuggestion) {
    setValue(s.value);
    setOpen(false);
  }

  return (
    <FieldShell label={label} hint={hint}>
      <form
        action={saveSettingAction}
        className="flex flex-wrap items-center gap-2"
      >
        <input type="hidden" name="key" value={settingKey} />
        <div ref={containerRef} className="relative min-w-[220px] flex-1">
          <input
            name="value"
            value={value}
            onChange={(e) => {
              const next = e.target.value;
              setValue(next);
              setOpen(true);
              // Clear stale suggestions immediately when the query becomes
              // too short — the effect won't refetch, so we'd otherwise
              // show old results against a new prefix.
              if (next.length < minQueryLength) setSuggestions([]);
            }}
            onFocus={() => setOpen(true)}
            placeholder={placeholder}
            autoComplete="off"
            className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent"
          />
          {open && suggestions.length > 0 && (
            <ul
              role="listbox"
              className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 max-h-60 overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg"
            >
              {suggestions.map((s) => (
                <li key={s.value}>
                  <button
                    type="button"
                    onClick={() => pick(s)}
                    className="block w-full rounded-md px-3 py-1.5 text-left transition-colors hover:bg-surface2"
                  >
                    <div className="text-[13px] text-ink">{s.label ?? s.value}</div>
                    {s.meta && (
                      <div className="font-mono text-[10px] text-muted">
                        {s.meta}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className="rounded-lg border border-line px-4 py-2 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent">
          Save
        </button>
      </form>
    </FieldShell>
  );
}
