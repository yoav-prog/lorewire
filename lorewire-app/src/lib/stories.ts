// Sample story data for the validation build. Replaces the in-browser design
// data. Later this comes from Postgres via the pipeline; the shape stays stable.

import { PUBLISHED } from "@/data/published";

export type Cat = "Drama" | "Entitled" | "Humor" | "Wholesome" | "Dating" | "Roommate";

export interface AlignedWord {
  word: string;
  start: number;
  end: number;
}

export interface Story {
  id: string;
  title: string;
  cat: Cat;
  dur: string;
  match: number;
  year: number;
  glyph: string;
  tags: string[];
  syn: string;
  body?: string;
  source_url?: string;
  // Pipeline-generated media (3.1 + 3.2). All optional — UI components fall
  // back to their CSS treatments when these are unset.
  heroImage?: string;
  images?: string[];
  audioUrl?: string;
  videoUrl?: string;
  alignment?: AlignedWord[];
}

export const CAT: Record<Cat, string> = {
  Drama: "#9B3A30",
  Entitled: "#C06234",
  Humor: "#C9A227",
  Wholesome: "#2C7E78",
  Dating: "#A8466A",
  Roommate: "#5B3B8A",
};

export const STORIES: Story[] = [
  { id: "envelope", title: "THE $800 ENVELOPE", cat: "Entitled", dur: "2:14", match: 97, year: 2024, glyph: "$", tags: ["True Story", "Workplace", "Karma"], syn: "A coworker collects cash for the boss's retirement gift, then the envelope quietly disappears, and so does her story." },
  { id: "replyall", title: "SHE REPLIED ALL", cat: "Humor", dur: "1:48", match: 94, year: 2025, glyph: "!", tags: ["True Story", "Office", "Cringe"], syn: "One typo, four thousand recipients, and a thread that refused to die before lunch." },
  { id: "fence", title: "THE NEIGHBOR'S FENCE", cat: "Drama", dur: "2:51", match: 91, year: 2024, glyph: "/", tags: ["True Story", "Neighbors", "Property"], syn: "He built it eight inches over the line. She had the survey. Then the lawn furniture started moving." },
  { id: "wrongnumber", title: "WRONG NUMBER, RIGHT GUY", cat: "Dating", dur: "2:30", match: 96, year: 2025, glyph: "?", tags: ["True Story", "Heartwarming", "Texting"], syn: "A misdialed 'you up?' turns into eleven months of the best conversations of her life." },
  { id: "groupghost", title: "THE GROUP PROJECT GHOST", cat: "Humor", dur: "1:39", match: 89, year: 2024, glyph: "0", tags: ["True Story", "College", "Petty"], syn: "Five names on the slide deck. One person who actually opened it. Finals week receipts inside." },
  { id: "fridge", title: "DECONSTRUCTING THE FRIDGE", cat: "Roommate", dur: "2:05", match: 88, year: 2025, glyph: "#", tags: ["True Story", "Roommates", "Notes"], syn: "A war fought entirely in sticky notes, escalating from 'whose milk?' to a 14-point house manifesto." },
  { id: "seat", title: "GIVE ME YOUR SEAT", cat: "Entitled", dur: "1:55", match: 90, year: 2024, glyph: "↑", tags: ["True Story", "Travel", "Entitled"], syn: "'My kids need to sit together.' The window seat she paid extra for had other plans." },
  { id: "parking", title: "THE PARKING SPOT WAR", cat: "Entitled", dur: "2:22", match: 86, year: 2024, glyph: "P", tags: ["True Story", "Neighbors", "Cones"], syn: "He saved a public spot with a lawn chair for nine years. The new tenant had a tow truck on speed dial." },
  { id: "birthday", title: "IT'S MY BIRTHDAY MONTH", cat: "Entitled", dur: "1:44", match: 84, year: 2025, glyph: "*", tags: ["True Story", "Friends", "Audacity"], syn: "Thirty-one days of mandatory celebration, one shared bill, and a friend group quietly doing math." },
  { id: "landlord", title: "THE LANDLORD'S NEW RULE", cat: "Entitled", dur: "2:38", match: 82, year: 2024, glyph: "L", tags: ["True Story", "Tenants", "Receipts"], syn: "A surprise clause about 'guest air' appears in the lease. The tenants brought a lawyer and a printer." },
  { id: "stranger", title: "THE STRANGER WHO PAID", cat: "Wholesome", dur: "1:52", match: 95, year: 2025, glyph: "+", tags: ["True Story", "Kindness", "Anonymous"], syn: "A declined card at the register, a tap on the shoulder, and a note she still keeps in her wallet." },
  { id: "wifi", title: "I NAMED MY WIFI", cat: "Humor", dur: "1:30", match: 88, year: 2025, glyph: "~", tags: ["True Story", "Petty", "Neighbors"], syn: "A passive-aggressive network name starts a slow-burn rivalry visible to the entire apartment block." },
  { id: "wrongmom", title: "THE TEXT SENT TO THE WRONG MOM", cat: "Drama", dur: "2:47", match: 93, year: 2025, glyph: "@", tags: ["True Story", "Family", "Mixup"], syn: "One contact saved wrong, a secret out early, and a Sunday dinner nobody will ever forget." },
  { id: "wedding", title: "THE WEDDING CRASHER", cat: "Drama", dur: "3:01", match: 92, year: 2024, glyph: "◆", tags: ["True Story", "Family", "Wedding"], syn: "An uninvited aunt, a seating chart with no mercy, and a toast that went badly off-script." },
  { id: "rules", title: "MY ROOMMATE'S 3AM RULES", cat: "Roommate", dur: "2:09", match: 85, year: 2025, glyph: "3", tags: ["True Story", "Roommates", "Quiet"], syn: "A laminated quiet-hours schedule, a contraband kettle, and the night the rules finally broke." },
  { id: "bill", title: "HE SPLIT THE BILL BY ITEMS", cat: "Dating", dur: "1:58", match: 79, year: 2024, glyph: "=", tags: ["True Story", "Dating", "Cringe"], syn: "A calculator at the table, a charge for 'half the appetizer she touched,' and a second date that never came." },
];

// Published CMS content is overlaid at the end of this module (see CMS overlay).

export const byId = (id: string): Story => {
  const s = STORIES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown story id: ${id}`);
  return s;
};

export const CONTINUE: { id: string; p: number }[] = [
  { id: "wedding", p: 67 },
  { id: "rules", p: 30 },
  { id: "bill", p: 88 },
  { id: "fence", p: 52 },
];
export const TOP10 = ["envelope", "replyall", "fence", "wrongnumber", "groupghost", "fridge", "wifi", "seat", "wrongmom", "stranger"];
export const ENTITLED_ROW = ["seat", "parking", "birthday", "landlord", "envelope", "bill"];
export const NEW_ROW = ["stranger", "wifi", "wrongmom", "wrongnumber", "replyall", "groupghost"];
export const PILLS = ["All", "Drama", "Entitled", "Humor", "Wholesome", "Dating", "Roommate"];

// --- CMS overlay -----------------------------------------------------------
// Published stories (src/data/published.ts, generated by the pipeline). For a
// story that already exists in the sample catalog we take over only the article
// body, keeping the curated title, synopsis, and poster styling. Brand-new
// published stories are appended so they appear in search, browse, and the New
// rail. Title/synopsis generation for new stories is a pipeline follow-up.
const GLYPH: Record<Cat, string> = {
  Drama: "/",
  Entitled: "$",
  Humor: "!",
  Wholesome: "+",
  Dating: "?",
  Roommate: "#",
};

for (const p of PUBLISHED) {
  const cat: Cat = (Object.keys(CAT) as Cat[]).includes(p.cat as Cat)
    ? (p.cat as Cat)
    : "Drama";
  const existing = STORIES.find((s) => s.id === p.id);
  if (existing) {
    existing.body = p.body;
    if (p.source_url) existing.source_url = p.source_url;
    if (p.heroImage) existing.heroImage = p.heroImage;
    if (p.images) existing.images = p.images;
    if (p.audioUrl) existing.audioUrl = p.audioUrl;
    if (p.videoUrl) existing.videoUrl = p.videoUrl;
    if (p.alignment) existing.alignment = p.alignment;
  } else {
    STORIES.push({
      id: p.id,
      title: p.title || p.id,
      cat,
      dur: p.dur || "2:00",
      match: 90,
      year: p.year || 2026,
      glyph: GLYPH[cat],
      tags: ["True Story", cat],
      syn: p.syn || "",
      body: p.body,
      source_url: p.source_url,
      heroImage: p.heroImage,
      images: p.images,
      audioUrl: p.audioUrl,
      videoUrl: p.videoUrl,
      alignment: p.alignment,
    });
    if (!NEW_ROW.includes(p.id)) NEW_ROW.unshift(p.id);
  }
}
