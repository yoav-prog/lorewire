// The granular category taxonomy introduced in PR3
// (_plans/2026-07-01-category-taxonomy-multitag.md). Seeded into the
// `categories` table (seedGranularCategories in db.ts) and, once the legacy
// six are retired to status='legacy', becomes the classifier's "active"
// option set.
//
// This is DATA, not a type. Unlike the PR1 manifest (the closed six-item
// `Cat` union that still drives today's read path), these do NOT widen any
// compile-time union — the read path flips to the DB-driven set in PR5. Until
// then this only feeds the seed + the Python classifier (which reads the
// active categories from the DB, so admin-added categories are picked up
// automatically).
//
// `slug` is PERMANENT (join key in story_tags + the /c/<slug> URL). `color`
// is a hand-picked hex for rails and a starting value for the rest (all
// editable via admin CRUD in PR4). `description` guides the classifier and
// seeds the future SEO landing copy. `railTitle` is the public rail header
// used when isRail.

export interface GranularCategory {
  slug: string;
  label: string;
  glyph: string;
  color: string;
  isRail: boolean;
  railTitle: string | null;
  description: string;
}

export const GRANULAR_CATEGORIES: readonly GranularCategory[] = [
  {
    slug: "entitled-people",
    label: "Entitled People",
    glyph: "$",
    color: "#C06234",
    isRail: true,
    railTitle: "The Audacity",
    description:
      "Demanding, self-important people who expect special treatment: entitled parents, choosing beggars, 'do you know who I am' scenes.",
  },
  {
    slug: "family-feuds",
    label: "Family Feuds",
    glyph: "*",
    color: "#9B3A30",
    isRail: true,
    railTitle: "Family Feuds",
    description:
      "Conflict among blood family: parents, siblings, estrangement, favoritism, family blowups (excludes in-laws).",
  },
  {
    slug: "cheating-betrayal",
    label: "Cheating & Betrayal",
    glyph: "~",
    color: "#8E2F3A",
    isRail: true,
    railTitle: "Cheating & Betrayal",
    description:
      "Infidelity, affairs, and discovering a partner or close person's betrayal.",
  },
  {
    slug: "wedding-drama",
    label: "Wedding Drama",
    glyph: "&",
    color: "#A8466A",
    isRail: true,
    railTitle: "Wedding Disasters",
    description:
      "Weddings gone wrong: bridezillas, guest demands, ruined ceremonies, fights at the reception.",
  },
  {
    slug: "workplace",
    label: "Workplace Nightmares",
    glyph: "%",
    color: "#3E6B8A",
    isRail: true,
    railTitle: "Workplace Nightmares",
    description:
      "Toxic jobs, coworkers, HR, and quitting stories. Use bad-bosses when the story is mainly about a terrible manager.",
  },
  {
    slug: "dating-disasters",
    label: "Dating Disasters",
    glyph: "?",
    color: "#C2603F",
    isRail: true,
    railTitle: "Dating Disasters",
    description:
      "Bad dates, dating-app horror stories, and red flags while a relationship is ongoing (use breakups for the aftermath).",
  },
  {
    slug: "revenge-karma",
    label: "Revenge & Karma",
    glyph: "^",
    color: "#B4502A",
    isRail: true,
    railTitle: "Revenge & Karma",
    description:
      "Satisfying comeuppance: petty revenge, sweet payback, and instant karma.",
  },
  {
    slug: "wholesome-wins",
    label: "Wholesome Wins",
    glyph: "+",
    color: "#2C7E78",
    isRail: true,
    railTitle: "Wholesome Wins",
    description: "Kind, heartwarming, faith-in-humanity moments.",
  },
  {
    slug: "public-freakouts",
    label: "Public Freakouts",
    glyph: "!",
    color: "#C0452F",
    isRail: false,
    railTitle: null,
    description:
      "Public meltdowns, confrontations, and 'Karen' scenes out in the world.",
  },
  {
    slug: "in-laws",
    label: "In-Laws from Hell",
    glyph: "@",
    color: "#7A3B5E",
    isRail: false,
    railTitle: null,
    description:
      "Conflict specifically with in-laws: mothers-in-law, meddling, boundary-stomping.",
  },
  {
    slug: "money-inheritance",
    label: "Money & Inheritance",
    glyph: "=",
    color: "#8A7A2E",
    isRail: false,
    railTitle: null,
    description: "Fights over money, debt, wills, and inheritance.",
  },
  {
    slug: "bad-bosses",
    label: "Bad Bosses",
    glyph: ">",
    color: "#2F5570",
    isRail: false,
    railTitle: null,
    description: "Stories centered on a terrible manager or boss specifically.",
  },
  {
    slug: "neighbor-wars",
    label: "Neighbor Wars",
    glyph: "#",
    color: "#5E7A3B",
    isRail: false,
    railTitle: null,
    description: "Disputes with neighbors: noise, property lines, HOA, parking.",
  },
  {
    slug: "roommate-hell",
    label: "Roommate Hell",
    glyph: "/",
    color: "#5B3B8A",
    isRail: false,
    railTitle: null,
    description: "Roommate conflicts: rent, chores, boundaries, moving out.",
  },
  {
    slug: "breakups",
    label: "Breakups",
    glyph: "-",
    color: "#5A6B7E",
    isRail: false,
    railTitle: null,
    description: "Breakups and their aftermath, after a relationship ends.",
  },
  {
    slug: "friendship-fallouts",
    label: "Friendship Fallouts",
    glyph: ":",
    color: "#3F8577",
    isRail: false,
    railTitle: null,
    description: "Falling out with friends: betrayal, drifting, group drama.",
  },
  {
    slug: "malicious-compliance",
    label: "Malicious Compliance",
    glyph: "\\",
    color: "#C9A227",
    isRail: false,
    railTitle: null,
    description:
      "Doing exactly what was demanded, knowing it will backfire on the person who demanded it.",
  },
];
