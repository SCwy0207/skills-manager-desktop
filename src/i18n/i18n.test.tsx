// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appMessages } from "./messages/app";
import { settingsMessages } from "./messages/settings";
import { skillsMessages } from "./messages/skills";
import type { I18nContextValue, MessageBundle } from "./types";

const STORAGE_KEY = "skills-manager.locale";
const locales = ["zh-CN", "zh-TW", "en-GB"] as const;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = "";
  container = document.createElement("div");
  document.body.append(container);
  // React uses this flag to verify that state updates are wrapped in act().
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function mountProvider(storedLocale?: string) {
  if (storedLocale !== undefined) {
    window.localStorage.setItem(STORAGE_KEY, storedLocale);
  }
  const { I18nProvider, useI18n } = await import("./i18n");
  let context: I18nContextValue | undefined;

  function Probe() {
    const value = useI18n();
    useEffect(() => {
      context = value;
    }, [value]);
    return <span>{value.locale}</span>;
  }

  root = createRoot(container!);
  await act(() => root?.render(<I18nProvider><Probe /></I18nProvider>));
  return () => {
    if (!context) throw new Error("i18n probe did not mount");
    return context;
  };
}

describe("I18nProvider", () => {
  it("defaults to English (UK) when no valid preference is stored", async () => {
    const getContext = await mountProvider();

    expect(getContext().locale).toBe("en-GB");
    expect(document.documentElement.lang).toBe("en-GB");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("ignores an invalid persisted locale and uses English (UK)", async () => {
    const getContext = await mountProvider("en-US");

    expect(getContext().locale).toBe("en-GB");
    expect(document.documentElement.lang).toBe("en-GB");
  });

  it("reads the persisted locale and synchronises document.lang", async () => {
    const getContext = await mountProvider("zh-TW");

    expect(getContext().locale).toBe("zh-TW");
    expect(document.documentElement.lang).toBe("zh-TW");
  });

  it("switches between all supported locales and persists each choice", async () => {
    const getContext = await mountProvider("zh-CN");

    for (const locale of locales) {
      await act(() => getContext().setLocale(locale));
      expect(getContext().locale).toBe(locale);
      expect(document.documentElement.lang).toBe(locale);
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe(locale);
    }
  });

  it("interpolates variables and falls back to the key", async () => {
    const getContext = await mountProvider("en-GB");

    expect(getContext().t("app.status.projects", { count: 3 })).toBe("3 local workspaces");
    expect(getContext().t("missing.translation.key")).toBe("missing.translation.key");
  });
});

describe("message bundles", () => {
  it.each([
    ["app", appMessages],
    ["settings", settingsMessages],
    ["skills", skillsMessages],
  ] as Array<[string, MessageBundle]>)('%s has the same keys in every locale', (_name, bundle) => {
    const expected = Object.keys(bundle["zh-CN"]).sort();
    expect(Object.keys(bundle["zh-TW"]).sort()).toEqual(expected);
    expect(Object.keys(bundle["en-GB"]).sort()).toEqual(expected);
  });
});
