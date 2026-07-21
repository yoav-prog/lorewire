// Tests for the per-category settings migration to the granular taxonomy
// (plan: _plans/2026-07-02-per-category-settings-granular.md).
//
// Three contracts locked here:
//   1. The key derivations in @/lib/category-settings match what the
//      Python/publisher consumers read (hero key lowercases the label;
//      shorts.auto key keeps it verbatim).
//   2. saveSettingAction validates ANY hero.category_default.* key with
//      the style-id validator (prefix match, not a static six-entry
//      list), so granular categories save and junk still rejects.
//   3. loadHeroStyleSettings snapshots a default slot for every ACTIVE
//      DB category, keyed by the lowercased label.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { one, run } from "@/lib/db";
import {
  heroCategoryDefaultKey,
  shortsAutoCategoryKey,
} from "@/lib/category-settings";
import { GRANULAR_CATEGORIES } from "@/lib/categories/granular";

vi.mock("@/lib/dal", () => {
  const session = {
    userId: "test-user",
    email: "test@lorewire.local",
    role: "admin",
  };
  return {
    requireAdmin: vi.fn().mockResolvedValue(session),
    requireCapability: vi.fn().mockResolvedValue(session),
    requireStaff: vi.fn().mockResolvedValue(session),
    ensureSeedAdmin: vi.fn().mockResolvedValue(null),
    currentUser: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

// Import AFTER vi.mock so the action module picks up the mocked deps.
import { loadHeroStyleSettings, saveSettingAction } from "@/app/admin/actions";

function settingForm(key: string, value: string): FormData {
  const fd = new FormData();
  fd.set("key", key);
  fd.set("value", value);
  return fd;
}

async function settingValue(key: string): Promise<string | null> {
  const row = await one<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [key],
  );
  return row?.value ?? null;
}

beforeEach(async () => {
  await run("DELETE FROM settings WHERE key LIKE 'hero.category_default.%'", []);
});

describe("category-settings key derivations", () => {
  it("hero key lowercases the label (matches pipeline resolve_hero_style)", () => {
    expect(heroCategoryDefaultKey("Wedding Drama")).toBe(
      "hero.category_default.wedding drama",
    );
    expect(heroCategoryDefaultKey("Creepy")).toBe(
      "hero.category_default.creepy",
    );
  });

  it("shorts.auto key keeps the label verbatim (matches shorts_auto.py)", () => {
    expect(shortsAutoCategoryKey("Wedding Drama")).toBe(
      "shorts.auto.category.Wedding Drama",
    );
  });
});

describe("saveSettingAction: hero.category_default.* prefix validation", () => {
  it("accepts a known style id for a granular category key", async () => {
    const key = heroCategoryDefaultKey("Wedding Drama");
    await saveSettingAction(settingForm(key, "neo_noir"));
    expect(await settingValue(key)).toBe("neo_noir");
  });

  it("accepts empty string (= clear the layer)", async () => {
    const key = heroCategoryDefaultKey("Creepy");
    await saveSettingAction(settingForm(key, "neo_noir"));
    await saveSettingAction(settingForm(key, ""));
    expect(await settingValue(key)).toBe("");
  });

  it("rejects an unknown style id on the same key", async () => {
    const key = heroCategoryDefaultKey("Creepy");
    await saveSettingAction(settingForm(key, "totally_made_up_style"));
    expect(await settingValue(key)).toBeNull();
  });
});

describe("loadHeroStyleSettings", () => {
  it("returns a default slot for every active DB category, keyed by lowercased label", async () => {
    await saveSettingAction(
      settingForm(heroCategoryDefaultKey("Bad Bosses"), "comic_book"),
    );
    const snapshot = await loadHeroStyleSettings();
    for (const c of GRANULAR_CATEGORIES) {
      expect(snapshot.categoryDefaults).toHaveProperty(c.label.toLowerCase());
    }
    expect(snapshot.categoryDefaults["bad bosses"]).toBe("comic_book");
    // Retired legacy six are not in the snapshot — the settings page only
    // renders pickers for the active set.
    expect(snapshot.categoryDefaults).not.toHaveProperty("drama");
  });
});
