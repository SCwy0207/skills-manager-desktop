import {
  Activity,
  Blocks,
  Check,
  CircleStop,
  FolderKanban,
  MessageSquareText,
  Monitor,
  MoonStar,
  Languages,
  Search,
  Settings2,
  Sun,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useUiStore } from "../store/ui";
import { desktopApi } from "../lib/ipc";
import { useI18n } from "../i18n/i18n";
import { type ThemeMode, useTheme } from "../theme/theme";
import type { Section } from "../types";
import "./CommandPalette.css";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate?: (section: Section) => boolean | void;
}

type CommandGroup = "navigation" | "ai" | "appearance";

interface PaletteCommand {
  id: string;
  group: CommandGroup;
  label: string;
  description: string;
  keywords: string;
  icon: LucideIcon;
  current: boolean;
  run: () => void;
}

const sectionCommands: Array<{
  section: Section;
  labelKey: string;
  descriptionKey: string;
  keywordsKey: string;
  icon: LucideIcon;
}> = [
  {
    section: "sessions",
    labelKey: "app.section.sessions",
    descriptionKey: "command.section.sessions.description",
    keywordsKey: "command.section.sessions.keywords",
    icon: MessageSquareText,
  },
  {
    section: "skills",
    labelKey: "app.section.skills",
    descriptionKey: "command.section.skills.description",
    keywordsKey: "command.section.skills.keywords",
    icon: Blocks,
  },
  {
    section: "projects",
    labelKey: "app.section.projects",
    descriptionKey: "command.section.projects.description",
    keywordsKey: "command.section.projects.keywords",
    icon: FolderKanban,
  },
  {
    section: "activity",
    labelKey: "app.section.activity",
    descriptionKey: "command.section.activity.description",
    keywordsKey: "command.section.activity.keywords",
    icon: Activity,
  },
  {
    section: "settings",
    labelKey: "app.section.settings",
    descriptionKey: "command.section.settings.description",
    keywordsKey: "command.section.settings.keywords",
    icon: Settings2,
  },
];

const themeCommands: Array<{
  mode: ThemeMode;
  labelKey: string;
  descriptionKey: string;
  keywordsKey: string;
  icon: LucideIcon;
}> = [
  {
    mode: "system",
    labelKey: "command.theme.system",
    descriptionKey: "command.theme.system.description",
    keywordsKey: "command.theme.system.keywords",
    icon: Monitor,
  },
  {
    mode: "dark",
    labelKey: "command.theme.dark",
    descriptionKey: "command.theme.dark.description",
    keywordsKey: "command.theme.dark.keywords",
    icon: MoonStar,
  },
  {
    mode: "light",
    labelKey: "command.theme.light",
    descriptionKey: "command.theme.light.description",
    keywordsKey: "command.theme.light.keywords",
    icon: Sun,
  },
];

const groupLabelKeys: Record<CommandGroup, string> = {
  navigation: "command.group.navigation",
  ai: "command.group.ai",
  appearance: "command.group.appearance",
};

function normalizeSearch(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function CommandPalette({ open, onOpenChange, onNavigate }: CommandPaletteProps) {
  const { t } = useI18n();
  const section = useUiStore((state) => state.section);
  const setSection = useUiStore((state) => state.setSection);
  const selectedSkillId = useUiStore((state) => state.selectedSkillId);
  const { mode, setMode } = useTheme();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const listboxId = useId();

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const navigate = useCallback((target: Section) => {
    if (onNavigate) return onNavigate(target);
    setSection(target);
    return true;
  }, [onNavigate, setSection]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const navigation = sectionCommands.map((command) => ({
      id: `navigate-${command.section}`,
      group: "navigation" as const,
      label: t(command.labelKey),
      description: t(command.descriptionKey),
      keywords: t(command.keywordsKey),
      icon: command.icon,
      current: section === command.section,
      run: () => navigate(command.section),
    }));

    const appearance = themeCommands.map((command) => ({
      id: `theme-${command.mode}`,
      group: "appearance" as const,
      label: t(command.labelKey),
      description: t(command.descriptionKey),
      keywords: t(command.keywordsKey),
      icon: command.icon,
      current: mode === command.mode,
      run: () => setMode(command.mode),
    }));

    const openSkillAction = (eventName: "ccc:skill-description:generate" | "ccc:skill-description:batch") => {
      if (navigate("skills") === false) return;
      window.setTimeout(() => window.dispatchEvent(new Event(eventName)), 40);
    };

    const ai: PaletteCommand[] = [
      {
        id: "ai-generate-current",
        group: "ai",
        label: t("command.ai.generateCurrent"),
        description: selectedSkillId ? t("command.ai.generateCurrent.ready") : t("command.ai.generateCurrent.empty"),
        keywords: t("command.ai.generateCurrent.keywords"),
        icon: WandSparkles,
        current: false,
        run: () => openSkillAction("ccc:skill-description:generate"),
      },
      {
        id: "ai-generate-batch",
        group: "ai",
        label: t("command.ai.generateBatch"),
        description: t("command.ai.generateBatch.description"),
        keywords: t("command.ai.generateBatch.keywords"),
        icon: Languages,
        current: false,
        run: () => openSkillAction("ccc:skill-description:batch"),
      },
      {
        id: "ai-settings",
        group: "ai",
        label: t("command.ai.settings"),
        description: t("command.ai.settings.description"),
        keywords: t("command.ai.settings.keywords"),
        icon: Settings2,
        current: false,
        run: () => {
          if (navigate("settings") === false) return;
          window.setTimeout(() => document.querySelector("#ai-description-settings")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
        },
      },
      {
        id: "ai-cancel-batch",
        group: "ai",
        label: t("command.ai.cancel"),
        description: t("command.ai.cancel.description"),
        keywords: t("command.ai.cancel.keywords"),
        icon: CircleStop,
        current: false,
        run: () => {
          void desktopApi.getSkillDescriptionJob().then((job) => {
            if (job && (job.status === "queued" || job.status === "running")) {
              return desktopApi.cancelSkillDescriptionJob(job.id);
            }
            return undefined;
          });
        },
      },
    ];

    return [...navigation, ...ai, ...appearance];
  }, [mode, navigate, section, selectedSkillId, setMode, t]);

  const filteredCommands = useMemo(() => {
    const search = normalizeSearch(query);
    if (!search) return commands;

    const terms = search.split(/\s+/u).filter(Boolean);
    return commands.filter((command) => {
      const haystack = normalizeSearch(
        `${command.label} ${command.description} ${command.keywords}`,
      );
      return terms.every((term) => haystack.includes(term));
    });
  }, [commands, query]);

  const groupedCommands = useMemo(
    () =>
      (["navigation", "ai", "appearance"] as const)
        .map((group) => ({
          group,
          commands: filteredCommands.filter((command) => command.group === group),
        }))
        .filter(({ commands: groupCommands }) => groupCommands.length > 0),
    [filteredCommands],
  );

  useEffect(() => {
    if (!open) return undefined;

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActiveIndex(0);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      restoreFocusRef.current?.focus({ preventScroll: true });
      restoreFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex((current) =>
      filteredCommands.length === 0 ? 0 : Math.min(current, filteredCommands.length - 1),
    );
  }, [filteredCommands.length]);

  const execute = useCallback(
    (command: PaletteCommand) => {
      command.run();
      close();
    },
    [close],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (filteredCommands.length === 0) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(
        (current) =>
          (current + direction + filteredCommands.length) % filteredCommands.length,
      );
      return;
    }

    if (
      event.key === "Enter" &&
      event.target === inputRef.current &&
      filteredCommands[activeIndex]
    ) {
      event.preventDefault();
      execute(filteredCommands[activeIndex]);
      return;
    }

    if (event.key === "Tab") {
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'input:not([disabled]), button:not([disabled]):not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  if (!open) return null;

  const activeCommand = filteredCommands[activeIndex];

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${listboxId}-title`}
        aria-describedby={`${listboxId}-hint`}
        onKeyDown={handleKeyDown}
      >
        <header className="command-palette-header">
          <div className="command-palette-title-row">
            <div>
              <span className="command-palette-kicker">{t("command.kicker")}</span>
              <h2 id={`${listboxId}-title`}>{t("command.title")}</h2>
            </div>
            <button
              type="button"
              className="command-palette-close"
              onClick={close}
              aria-label={t("command.close")}
              title={t("command.closeTitle")}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>

          <label className="command-palette-search">
            <Search size={15} aria-hidden="true" />
            <span className="command-palette-sr-only">{t("command.search")}</span>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveIndex(0);
              }}
              placeholder={t("command.searchPlaceholder")}
              autoComplete="off"
              spellCheck="false"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={
                activeCommand ? `${listboxId}-${activeCommand.id}` : undefined
              }
            />
            {query && (
              <button
                type="button"
                className="command-palette-clear"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                aria-label={t("command.clear")}
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </label>
        </header>

        <div
          id={listboxId}
          className="command-palette-results"
          role="listbox"
          aria-label={t("command.available")}
        >
          {groupedCommands.map(({ group, commands: groupCommands }) => (
            <section
              className="command-palette-group"
              key={group}
              role="group"
              aria-labelledby={`${listboxId}-${group}-label`}
            >
              <div
                className="command-palette-group-label"
                id={`${listboxId}-${group}-label`}
              >
                <span>{t(groupLabelKeys[group])}</span>
                <span>{groupCommands.length}</span>
              </div>
              {groupCommands.map((command) => {
                const commandIndex = filteredCommands.indexOf(command);
                const selected = commandIndex === activeIndex;
                const Icon = command.icon;

                return (
                  <button
                    id={`${listboxId}-${command.id}`}
                    key={command.id}
                    type="button"
                    className="command-palette-option"
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    data-current={command.current || undefined}
                    onMouseMove={() => setActiveIndex(commandIndex)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => execute(command)}
                  >
                    <span className="command-palette-option-icon">
                      <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                    </span>
                    <span className="command-palette-option-copy">
                      <strong>{command.label}</strong>
                      <small>{command.description}</small>
                    </span>
                    {command.current && (
                      <span className="command-palette-current">
                        <Check size={12} strokeWidth={2.2} aria-hidden="true" />
                        {t("command.current")}
                      </span>
                    )}
                    {selected && !command.current && (
                      <kbd className="command-palette-enter">↵</kbd>
                    )}
                  </button>
                );
              })}
            </section>
          ))}

          {filteredCommands.length === 0 && (
            <div className="command-palette-empty" role="status">
              <Search size={19} aria-hidden="true" />
              <strong>{t("command.empty.title")}</strong>
              <span>{t("command.empty.description")}</span>
            </div>
          )}
        </div>

        <footer className="command-palette-footer" id={`${listboxId}-hint`}>
          <span><kbd>↑</kbd><kbd>↓</kbd> {t("command.footer.select")}</span>
          <span><kbd>Enter</kbd> {t("command.footer.run")}</span>
          <span><kbd>Esc</kbd> {t("command.footer.close")}</span>
          <span className="command-palette-local">{t("command.footer.local")}</span>
        </footer>
      </div>
    </div>
  );
}
