import { saveSettingAction } from "@/app/admin/actions";

// Slightly fancier text field than the General page's SettingText:
//   - inputType lets a URL field opt into browser-native URL validation +
//     keyboard hint on mobile (`type="url"`).
//   - multiline swaps the <input> for a small <textarea> when the value
//     is a list (e.g. comma-separated same-as URLs).
// Server component — same form-action contract as every other setting
// control on this surface.

export function SettingTextField({
  settingKey,
  label,
  hint,
  initial,
  placeholder,
  inputType = "text",
  multiline = false,
}: {
  settingKey: string;
  label: string;
  hint?: string;
  initial: string;
  placeholder?: string;
  inputType?: "text" | "url" | "email";
  multiline?: boolean;
}) {
  const inputClass =
    "min-w-[220px] flex-1 rounded-lg border border-line bg-bg px-3 py-2 text-[14px] text-ink outline-none focus:border-accent";

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <label className="mb-1 block text-[13px] font-semibold text-ink">
        {label}
      </label>
      {hint && <p className="mb-2 text-[12px] text-muted">{hint}</p>}
      <form
        action={saveSettingAction}
        className="flex flex-wrap items-start gap-2"
      >
        <input type="hidden" name="key" value={settingKey} />
        {multiline ? (
          <textarea
            name="value"
            defaultValue={initial}
            placeholder={placeholder}
            rows={2}
            className={`${inputClass} resize-y`}
          />
        ) : (
          <input
            name="value"
            type={inputType}
            defaultValue={initial}
            placeholder={placeholder}
            className={inputClass}
          />
        )}
        <button className="rounded-lg border border-line px-4 py-2 text-[13px] text-ink transition-colors hover:border-accent hover:text-accent">
          Save
        </button>
      </form>
    </div>
  );
}
