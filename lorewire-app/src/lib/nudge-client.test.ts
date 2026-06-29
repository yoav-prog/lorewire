// @vitest-environment happy-dom

// Coverage for the cross-device nudge snooze primitives. The component
// itself runs inside React; that path is exercised manually in the QA
// pass. This file pins the storage-bound logic that decides "show the
// nudge or stay quiet" so a regression there doesn't quietly re-spam
// users who already said "Maybe later".

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearSnooze,
  hasEverSnoozed,
  isNudgeSnoozed,
  snoozeNudge,
  SNOOZE_DAYS,
} from "./nudge-client";

const SNOOZE_KEY = "lw.prompt_snooze.v1";
const SNOOZED_BEFORE_KEY = "lw.prompt_snoozed_before.v1";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

describe("isNudgeSnoozed", () => {
  it("returns false on a fresh browser with no prior snooze", () => {
    expect(isNudgeSnoozed()).toBe(false);
  });

  it("returns true immediately after snoozeNudge", () => {
    snoozeNudge();
    expect(isNudgeSnoozed()).toBe(true);
  });

  it("returns false once the snooze window has expired", () => {
    // Backdate the stored expiry into the past.
    window.localStorage.setItem(SNOOZE_KEY, String(Date.now() - 1000));
    expect(isNudgeSnoozed()).toBe(false);
  });

  it("treats malformed values as not-snoozed", () => {
    window.localStorage.setItem(SNOOZE_KEY, "garbage");
    expect(isNudgeSnoozed()).toBe(false);
  });
});

describe("hasEverSnoozed", () => {
  it("returns false on a fresh browser", () => {
    expect(hasEverSnoozed()).toBe(false);
  });

  it("returns true after the first snoozeNudge call (sticky)", () => {
    snoozeNudge();
    expect(hasEverSnoozed()).toBe(true);
  });

  it("stays true even after the snooze expiry", () => {
    snoozeNudge();
    window.localStorage.setItem(SNOOZE_KEY, String(Date.now() - 1000));
    expect(isNudgeSnoozed()).toBe(false);
    // The "ever snoozed" stickiness is exactly what prevents a return
    // visitor from getting modal-spammed on the next first-save event.
    expect(hasEverSnoozed()).toBe(true);
  });
});

describe("clearSnooze", () => {
  it("makes isNudgeSnoozed return false but keeps hasEverSnoozed true", () => {
    snoozeNudge();
    expect(isNudgeSnoozed()).toBe(true);
    clearSnooze();
    expect(isNudgeSnoozed()).toBe(false);
    // The "I've seen this before" flag survives — clearSnooze is meant
    // for "user actively chose to sign in", not "wipe the history".
    expect(hasEverSnoozed()).toBe(true);
  });
});

describe("SNOOZE_DAYS contract", () => {
  it("is exactly 7 (locked decision §3)", () => {
    expect(SNOOZE_DAYS).toBe(7);
  });

  it("snooze window lasts roughly SNOOZE_DAYS into the future", () => {
    const before = Date.now();
    snoozeNudge();
    const raw = window.localStorage.getItem(SNOOZE_KEY);
    expect(raw).not.toBeNull();
    const stored = Number(raw);
    const diffMs = stored - before;
    const sevenDaysMs = SNOOZE_DAYS * 24 * 60 * 60 * 1000;
    // Allow a generous test-clock margin.
    expect(diffMs).toBeGreaterThanOrEqual(sevenDaysMs - 2_000);
    expect(diffMs).toBeLessThanOrEqual(sevenDaysMs + 2_000);
  });
});
