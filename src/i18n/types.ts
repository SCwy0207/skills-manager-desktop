export type Locale = "zh-CN" | "zh-TW" | "en-GB";

export type TranslationValue = string | number;
export type TranslationVariables = Record<string, TranslationValue>;
export type Messages = Record<string, string>;
export type MessageBundle = Record<Locale, Messages>;

export type Translate = (key: string, variables?: TranslationVariables) => string;

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}
