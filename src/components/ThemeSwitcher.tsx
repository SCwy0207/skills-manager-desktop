import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { type ThemeMode, useTheme } from "../theme/theme";
import { useI18n } from "../i18n/i18n";
import "./ThemeSwitcher.css";

interface ThemeOption {
  mode: ThemeMode;
  labelKey: string;
  shortLabelKey: string;
  icon: LucideIcon;
}

const options: ThemeOption[] = [
  { mode: "system", labelKey: "theme.system.label", shortLabelKey: "theme.system.short", icon: Monitor },
  { mode: "dark", labelKey: "theme.dark.label", shortLabelKey: "theme.dark.short", icon: Moon },
  { mode: "light", labelKey: "theme.light.label", shortLabelKey: "theme.light.short", icon: Sun },
];

export interface ThemeSwitcherProps {
  compact?: boolean;
  className?: string;
}

export function ThemeSwitcher({
  compact = false,
  className = "",
}: ThemeSwitcherProps) {
  const { t } = useI18n();
  const { mode, resolvedTheme, setMode } = useTheme();
  const resolvedLabel = t(resolvedTheme === "dark" ? "theme.resolved.dark" : "theme.resolved.light");

  return (
    <div
      className={`theme-switcher${compact ? " is-compact" : ""}${className ? ` ${className}` : ""}`}
      role="group"
      aria-label={t(mode === "system" ? "theme.group.system" : "theme.group.fixed", { theme: resolvedLabel })}
      data-resolved-theme={resolvedTheme}
    >
      {options.map(({ mode: optionMode, labelKey, shortLabelKey, icon: Icon }) => {
        const selected = mode === optionMode;
        const label = t(labelKey);
        const title =
          optionMode === "system" ? t("theme.system.title", { theme: resolvedLabel }) : label;

        return (
          <button
            key={optionMode}
            type="button"
            className="theme-switcher-option"
            aria-pressed={selected}
            aria-label={label}
            title={title}
            data-theme-option={optionMode}
            onClick={() => setMode(optionMode)}
          >
            <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{t(shortLabelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
