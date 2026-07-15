import { useSyncExternalStore } from "react";

export type UiDensity = "compact" | "comfortable";

const DENSITY_STORAGE_KEY = "skills-manager.density";
type DensityListener = () => void;
type DensityStorage = Pick<Storage, "getItem" | "setItem">;

const listeners = new Set<DensityListener>();
let initialized = false;

function getStorage(): DensityStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function isUiDensity(value: unknown): value is UiDensity {
  return value === "compact" || value === "comfortable";
}

export function readStoredDensity(
  storage: DensityStorage | undefined = getStorage(),
): UiDensity {
  if (!storage) return "comfortable";
  try {
    const value = storage.getItem(DENSITY_STORAGE_KEY);
    return isUiDensity(value) ? value : "comfortable";
  } catch {
    return "comfortable";
  }
}

let density = readStoredDensity();

function applyDensity(value: UiDensity) {
  if (typeof document !== "undefined") document.documentElement.dataset.density = value;
}

function emitChange() {
  listeners.forEach((listener) => listener());
}

function handleStorageChange(event: StorageEvent) {
  if (event.key !== DENSITY_STORAGE_KEY && event.key !== null) return;
  const next = readStoredDensity();
  if (next === density) return;
  density = next;
  applyDensity(density);
  emitChange();
}

export function initializeDensity() {
  applyDensity(density);
  if (typeof window === "undefined" || initialized) return;
  initialized = true;
  window.addEventListener("storage", handleStorageChange);
}

export function setUiDensity(value: UiDensity) {
  if (!isUiDensity(value) || value === density) return;
  density = value;
  try {
    getStorage()?.setItem(DENSITY_STORAGE_KEY, value);
  } catch {
    // Keep the in-memory preference when persistence is unavailable.
  }
  applyDensity(density);
  emitChange();
}

function subscribe(listener: DensityListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDensity() {
  const current = useSyncExternalStore(subscribe, () => density, () => "comfortable");
  return { density: current, setDensity: setUiDensity };
}

initializeDensity();

export const densityStorageKey = DENSITY_STORAGE_KEY;
