import { useSyncExternalStore } from "react";

export type ThemeMode = "system" | "dark" | "light";
export type ResolvedTheme = Exclude<ThemeMode, "system">;

export interface ThemeSnapshot {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
}

const THEME_STORAGE_KEY = "skills-manager.theme";
const DARK_THEME_QUERY = "(prefers-color-scheme: dark)";

type ThemeListener = () => void;
type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

const listeners = new Set<ThemeListener>();
let mediaQuery: MediaQueryList | null = null;
let initialized = false;

function getStorage(): ThemeStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function prefersDarkTheme() {
  if (mediaQuery) return mediaQuery.matches;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(DARK_THEME_QUERY).matches;
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "dark" || value === "light";
}

export function readStoredTheme(storage: ThemeStorage | undefined = getStorage()): ThemeMode {
  if (!storage) return "system";
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

let snapshot: ThemeSnapshot = {
  mode: readStoredTheme(),
  resolvedTheme: "light",
};
snapshot = {
  ...snapshot,
  resolvedTheme: resolveTheme(snapshot.mode, prefersDarkTheme()),
};

function applyTheme(nextSnapshot: ThemeSnapshot) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = nextSnapshot.resolvedTheme;
  root.dataset.themeMode = nextSnapshot.mode;
  root.style.colorScheme = nextSnapshot.resolvedTheme;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute(
      "content",
      nextSnapshot.resolvedTheme === "dark" ? "#080b12" : "#e9eef7",
    );
}

function emitChange() {
  listeners.forEach((listener) => listener());
}

function updateSnapshot(mode: ThemeMode, notify = true) {
  const nextSnapshot: ThemeSnapshot = {
    mode,
    resolvedTheme: resolveTheme(mode, prefersDarkTheme()),
  };
  const changed =
    snapshot.mode !== nextSnapshot.mode ||
    snapshot.resolvedTheme !== nextSnapshot.resolvedTheme;

  snapshot = nextSnapshot;
  applyTheme(snapshot);
  if (changed && notify) emitChange();
}

function handleSystemThemeChange() {
  if (snapshot.mode === "system") updateSnapshot("system");
}

function handleStorageChange(event: StorageEvent) {
  if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
  updateSnapshot(readStoredTheme());
}

/**
 * Starts the app-lifetime theme controller. Calling this more than once is safe.
 * Importers may call it before React mounts to avoid a light/dark paint flash.
 */
export function initializeTheme() {
  if (typeof window === "undefined" || initialized) {
    applyTheme(snapshot);
    return;
  }

  initialized = true;
  mediaQuery =
    typeof window.matchMedia === "function"
      ? window.matchMedia(DARK_THEME_QUERY)
      : null;

  updateSnapshot(readStoredTheme(), false);
  mediaQuery?.addEventListener("change", handleSystemThemeChange);
  window.addEventListener("storage", handleStorageChange);
}

export function setThemeMode(mode: ThemeMode) {
  if (!isThemeMode(mode)) return;

  const storage = getStorage();
  try {
    storage?.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // A locked-down WebView may deny storage; the in-memory preference still works.
  }
  updateSnapshot(mode);
}

export function getThemeSnapshot(): ThemeSnapshot {
  return snapshot;
}

function subscribe(listener: ThemeListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const serverSnapshot: ThemeSnapshot = {
  mode: "system",
  resolvedTheme: "light",
};

export function useTheme() {
  const current = useSyncExternalStore(subscribe, getThemeSnapshot, () => serverSnapshot);
  return {
    ...current,
    setMode: setThemeMode,
  };
}

// Applying at module evaluation prevents an incorrect first paint when the module
// is imported from the application's entry point.
initializeTheme();

export const themeStorageKey = THEME_STORAGE_KEY;
