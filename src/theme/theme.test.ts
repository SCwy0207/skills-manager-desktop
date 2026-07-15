import { describe, expect, it } from "vitest";

import {
  isThemeMode,
  readStoredTheme,
  resolveTheme,
  themeStorageKey,
} from "./theme";

function storageWith(value: string | null) {
  return {
    getItem: (key: string) => (key === themeStorageKey ? value : null),
    setItem: () => undefined,
  };
}

describe("theme utilities", () => {
  it("resolves an explicit theme independently from the OS preference", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("resolves system mode from prefers-color-scheme", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("accepts only supported stored values", () => {
    expect(isThemeMode("system")).toBe(true);
    expect(isThemeMode("dark")).toBe(true);
    expect(isThemeMode("light")).toBe(true);
    expect(isThemeMode("midnight")).toBe(false);
  });

  it("falls back to system mode for missing or invalid persistence", () => {
    expect(readStoredTheme(storageWith("dark"))).toBe("dark");
    expect(readStoredTheme(storageWith("midnight"))).toBe("system");
    expect(readStoredTheme(storageWith(null))).toBe("system");
  });
});
