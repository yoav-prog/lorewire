// Shared presentational helpers for the admin Users area (members list +
// detail + filter bar). Pure — no DB, no secrets — so the client filter bar
// can import the same labels the server pages render.

export const PROVIDER_LABEL: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  facebook: "Facebook",
  reddit: "Reddit",
  magic_link: "Magic link",
  email: "Email",
};

const AVATAR_TONES = [
  "bg-cat-drama/20 text-cat-drama",
  "bg-cat-entitled/20 text-cat-entitled",
  "bg-cat-humor/25 text-cat-humor",
  "bg-cat-wholesome/20 text-cat-wholesome",
  "bg-cat-dating/20 text-cat-dating",
  "bg-cat-roommate/25 text-cat-roommate",
];

// Deterministic accent for the initials avatar — the same id always maps to
// the same hue, so a member is recognizable across the list and detail page.
export function avatarTone(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

export function memberInitials(name: string | null, email: string): string {
  const base = (name && name.trim()) || email;
  const parts = base.split(/[\s@._-]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "");
  return (letters || base[0] || "?").toUpperCase();
}

// Stored timestamps are ISO-8601; the date prefix is locale-free + unambiguous.
export function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}
