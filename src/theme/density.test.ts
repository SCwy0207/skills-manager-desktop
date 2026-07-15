import { describe, expect, it } from "vitest";

import { densityStorageKey, isUiDensity, readStoredDensity } from "./density";

function storageWith(value: string | null) {
  return {
    getItem: (key: string) => (key === densityStorageKey ? value : null),
    setItem: () => undefined,
  };
}

describe("density utilities", () => {
  it("accepts only supported desktop density values", () => {
    expect(isUiDensity("compact")).toBe(true);
    expect(isUiDensity("comfortable")).toBe(true);
    expect(isUiDensity("dense")).toBe(false);
  });

  it("persists a valid preference and defaults to comfortable", () => {
    expect(readStoredDensity(storageWith("compact"))).toBe("compact");
    expect(readStoredDensity(storageWith("dense"))).toBe("comfortable");
    expect(readStoredDensity(storageWith(null))).toBe("comfortable");
  });
});
