import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { appMessages } from "./messages/app";
import { settingsMessages } from "./messages/settings";
import { skillsMessages } from "./messages/skills";
import type {
  I18nContextValue,
  Locale,
  MessageBundle,
  Messages,
  Translate,
  TranslationVariables,
} from "./types";

const STORAGE_KEY = "skills-manager.locale";
const DEFAULT_LOCALE: Locale = "en-GB";
const SUPPORTED_LOCALES: readonly Locale[] = ["zh-CN", "zh-TW", "en-GB"];

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && SUPPORTED_LOCALES.includes(value as Locale);
}

function initialLocale(): Locale {
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isLocale(stored)) return stored;
    } catch {
      // Storage can be unavailable in hardened WebViews; use the product default.
    }
  }
  return DEFAULT_LOCALE;
}

function mergeBundles(...bundles: MessageBundle[]): MessageBundle {
  return SUPPORTED_LOCALES.reduce<MessageBundle>(
    (merged, locale) => {
      merged[locale] = bundles.reduce<Messages>(
        (messages, bundle) => Object.assign(messages, bundle[locale]),
        {},
      );
      return merged;
    },
    { "zh-CN": {}, "zh-TW": {}, "en-GB": {} },
  );
}

const messages = mergeBundles(appMessages, settingsMessages, skillsMessages);
let currentLocale: Locale = initialLocale();

function interpolate(message: string, variables?: TranslationVariables): string {
  if (!variables) return message;
  return message.replace(/\{([^{}]+)\}/g, (match, name: string) => {
    const value = variables[name];
    return value === undefined ? match : String(value);
  });
}

export function getCurrentLocale(): Locale {
  return currentLocale;
}

export function translateNow(key: string, variables?: TranslationVariables): string {
  return interpolate(messages[currentLocale][key] ?? key, variables);
}

const I18nContext = createContext<I18nContextValue>({
  locale: currentLocale,
  setLocale: () => undefined,
  t: translateNow,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  currentLocale = locale;

  const setLocale = useCallback((nextLocale: Locale) => {
    if (!isLocale(nextLocale)) return;
    currentLocale = nextLocale;
    setLocaleState(nextLocale);
    if (typeof document !== "undefined") document.documentElement.lang = nextLocale;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, nextLocale);
      } catch {
        // Keep the in-memory preference when storage is unavailable.
      }
    }
  }, []);

  useEffect(() => {
    currentLocale = locale;
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback<Translate>(
    (key, variables) => interpolate(messages[locale][key] ?? key, variables),
    [locale],
  );
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export type { Locale, MessageBundle, TranslationVariables } from "./types";
