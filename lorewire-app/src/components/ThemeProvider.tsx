"use client";

// Theme provider + hook. Three values:
//   "dark"   force dark
//   "light"  force light
//   "system" follow OS preference via prefers-color-scheme
//
// Persistence: localStorage["lw-theme"]. The setting is per-browser, not
// per-user — matches typical web app conventions and keeps the server out
// of the loop.
//
// FOUC avoidance: the early-hydration script in app/layout.tsx reads the
// same localStorage key BEFORE React mounts and applies data-theme to the
// html element. By the time this provider hydrates, the document is
// already painted in the right palette. The provider then keeps state +
// reapplies on change.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";

export type ThemeChoice = "dark" | "light" | "system";

const STORAGE_KEY = "lw-theme";

interface ThemeContextValue {
  /** What the user picked (may be "system"). */
  choice: ThemeChoice;
  /** What's actually applied — "system" resolves to dark/light here. */
  resolved: "dark" | "light";
  setChoice: (next: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// Reads the OS preference. Used as the resolved value when choice="system".
function readSystem(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function applyTheme(resolved: "dark" | "light") {
  if (typeof document === "undefined") return;
  if (resolved === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

function readStoredChoice(): ThemeChoice {
  if (typeof window === "undefined") return "dark";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  // Default = dark. Matches the historical shipping value.
  return "dark";
}

// Subscribe to the OS prefers-color-scheme media query so useSyncExternalStore
// re-renders when the user changes their system theme while choice="system".
// Returns a no-op unsubscribe on the server.
function subscribeToSystemMq(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener("change", callback);
  // Also wake up when the persisted choice changes — switching from
  // system to dark/light should re-evaluate the resolved value.
  window.addEventListener("lw-theme-change", callback);
  return () => {
    mq.removeEventListener("change", callback);
    window.removeEventListener("lw-theme-change", callback);
  };
}

// External-store subscription for the persisted choice. Triggers a re-
// render whenever localStorage["lw-theme"] changes (incl. via setChoice).
// We dispatch a custom 'lw-theme-change' event in setChoice so subscribers
// in this and any other tabs/components stay in sync without polling.
function subscribeToThemeStore(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  window.addEventListener("lw-theme-change", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("lw-theme-change", callback);
  };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Persisted user choice. useSyncExternalStore is the React 19 sanctioned
  // way to sync with browser-only state — no setState-in-effect, no
  // hydration mismatch, server snapshot always "dark" so the SSR HTML
  // matches the first client paint (which the pre-hydration script will
  // have flipped to light if needed).
  const choice = useSyncExternalStore<ThemeChoice>(
    subscribeToThemeStore,
    readStoredChoice,
    () => "dark",
  );

  // Resolved = what's actually applied. When choice="system" this tracks
  // the OS preference. We use a separate hook subscription so the OS-side
  // change events trigger a re-render too.
  const resolved = useSyncExternalStore<"dark" | "light">(
    subscribeToSystemMq,
    () => (choice === "system" ? readSystem() : choice),
    () => "dark",
  );

  // Keep the DOM attribute in sync. The pre-hydration script already
  // applied the right value on initial paint; this effect handles the
  // updates after the user clicks Theme. setState-in-effect rule doesn't
  // fire here because we're not calling setState — just touching the DOM.
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  const setChoice = useCallback((next: ThemeChoice) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next);
      window.dispatchEvent(new Event("lw-theme-change"));
    }
    console.info("[theme] set", { choice: next });
  }, []);

  return (
    <ThemeContext.Provider value={{ choice, resolved, setChoice }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Sane fallback during the brief pre-mount window so consumer code
    // doesn't crash if it renders before ThemeProvider hydrates.
    return {
      choice: "dark",
      resolved: "dark",
      setChoice: () => {},
    };
  }
  return ctx;
}

// Inline script string for the root layout. Keep this minimal — it runs
// before React hydration and reading the wrong thing yields a flash of
// dark theme while light is loading (or vice versa). Mirrors the logic
// in readStoredChoice + applyTheme exactly.
export const THEME_INIT_SCRIPT = `
(function() {
  try {
    var raw = localStorage.getItem("lw-theme");
    var resolved = "dark";
    if (raw === "light") resolved = "light";
    else if (raw === "system") {
      resolved = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } else if (raw !== "dark") {
      resolved = "dark";
    } else {
      resolved = "dark";
    }
    if (resolved === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    }
  } catch (e) {
    // Ignore — defaults to dark if localStorage is unavailable.
  }
})();
`.trim();
