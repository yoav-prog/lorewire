// World bible inspection panel for the story edit page.
//
// 2026-06-14 Option C: scene generation now consults a structured
// per-story bible of characters, sub-characters, locations, and items.
// This panel surfaces what the pipeline built so an admin debugging
// "why does this scene look wrong" can see exactly which entities the
// scene call referenced — and which ones still lack a canonical
// reference image (the load-bearing piece for visual consistency).
//
// Read-only v1. Editing fields lands later (see the plan's open
// questions). The panel renders nothing when no bible has been built
// yet, so an empty story page stays clean.

import { readWorldBible, type BibleCharacter, type WorldBible } from "@/lib/world-bible";

const PANEL_CONTAINER = "rounded-xl border border-line bg-surface p-4";
const SECTION_HEAD = "font-mono text-[11px] uppercase tracking-wider text-muted";
const ENTITY_CARD =
  "rounded-lg border border-line bg-bg p-3 flex gap-3 items-start";

export function WorldBiblePanel({
  videoConfigJson,
}: {
  videoConfigJson: string | null;
}) {
  const bible = readWorldBible(videoConfigJson);
  if (!bible) {
    return (
      <div className={PANEL_CONTAINER}>
        <h3 className={SECTION_HEAD}>World bible</h3>
        <p className="mt-1 text-[12px] text-muted">
          Not built yet. The first scene regeneration on this story will
          build the bible from the article body, generate one reference
          image per character, and persist everything here.
        </p>
      </div>
    );
  }

  const refsTotal = bible.characters.length + bible.sub_characters.length;
  const refsReady =
    bible.characters.filter((c) => c.reference_image_url).length
    + bible.sub_characters.filter((c) => c.reference_image_url).length;

  return (
    <div className={PANEL_CONTAINER}>
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className={SECTION_HEAD}>World bible</h3>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
          {bible.characters.length} chars · {bible.sub_characters.length} subs ·
          {" "}{bible.locations.length} locs · {bible.items.length} items
          {" · "}refs {refsReady}/{refsTotal}
        </span>
      </header>

      <p className="mb-3 text-[12px] text-muted">
        Scene calls pass each on-screen character&apos;s reference image to
        kie so identity holds across scenes. Missing refs fall back to
        text-only (cues still embedded, but face won&apos;t pin).
      </p>

      <BibleSection title="Characters">
        {bible.characters.length === 0 && (
          <EmptyRow text="No characters identified. Scene calls won&apos;t pass any image refs." />
        )}
        {bible.characters.map((c) => (
          <CharacterCard key={c.id} character={c} kind="char" />
        ))}
      </BibleSection>

      {bible.sub_characters.length > 0 && (
        <BibleSection title="Sub-characters">
          {bible.sub_characters.map((c) => (
            <CharacterCard key={c.id} character={c} kind="sub" />
          ))}
        </BibleSection>
      )}

      {bible.locations.length > 0 && (
        <BibleSection title="Locations">
          {bible.locations.map((l) => (
            <div key={l.id} className={ENTITY_CARD}>
              <RefThumb url={l.reference_image_url} alt={l.name} aspect="16 / 9" />
              <div className="min-w-0 flex-1">
                <EntityHeader id={l.id} name={l.name} />
                <p className="mt-1 text-[12px] text-ink">{l.visual_cues}</p>
              </div>
            </div>
          ))}
        </BibleSection>
      )}

      {bible.items.length > 0 && (
        <BibleSection title="Items">
          {bible.items.map((i) => (
            <div key={i.id} className={ENTITY_CARD}>
              <div
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-line bg-surface2 font-mono text-[10px] uppercase tracking-wider text-muted"
                aria-hidden
              >
                item
              </div>
              <div className="min-w-0 flex-1">
                <EntityHeader id={i.id} name={i.name} />
                <p className="mt-1 text-[12px] text-ink">{i.visual_cues}</p>
              </div>
            </div>
          ))}
        </BibleSection>
      )}
    </div>
  );
}

function BibleSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-3">
      <h4 className={`${SECTION_HEAD} mb-1.5`}>{title}</h4>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function CharacterCard({
  character,
  kind,
}: {
  character: BibleCharacter;
  kind: "char" | "sub";
}) {
  return (
    <div className={ENTITY_CARD}>
      <RefThumb
        url={character.reference_image_url}
        alt={character.name}
        aspect="3 / 4"
      />
      <div className="min-w-0 flex-1">
        <EntityHeader id={character.id} name={character.name}>
          <RoleChip role={character.role} kind={kind} />
        </EntityHeader>
        <p className="mt-1 text-[12px] text-ink">{character.visual_cues}</p>
      </div>
    </div>
  );
}

function EntityHeader({
  id,
  name,
  children,
}: {
  id: string;
  name: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-ink">{name}</p>
        <p className="truncate font-mono text-[10px] uppercase tracking-wider text-muted">
          {id}
        </p>
      </div>
      {children}
    </div>
  );
}

function RoleChip({
  role,
  kind,
}: {
  role: "lead" | "supporting" | "background";
  kind: "char" | "sub";
}) {
  const tone =
    role === "lead"
      ? "border-accent/40 bg-accent/10 text-accent"
      : "border-line bg-surface2 text-muted";
  const label = kind === "sub" ? `${role} (sub)` : role;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}
    >
      {label}
    </span>
  );
}

function RefThumb({
  url,
  alt,
  aspect,
}: {
  url: string | null;
  alt: string;
  aspect: string;
}) {
  if (!url) {
    return (
      <div
        className="flex h-16 w-12 shrink-0 items-center justify-center rounded-md border border-warn/40 bg-warn/10 font-mono text-[9px] uppercase tracking-wider text-warn"
        style={{ aspectRatio: aspect }}
      >
        no ref
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      className="h-16 w-12 shrink-0 rounded-md border border-line object-cover"
      style={{ aspectRatio: aspect }}
    />
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-bg p-3 text-[12px] text-muted">
      {text}
    </div>
  );
}
