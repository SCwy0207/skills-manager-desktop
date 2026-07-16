import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ChevronDown,
  CircleHelp,
  FolderGit2,
  HardDrive,
  Layers3,
  LockKeyhole,
  MessageSquareText,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { CommandPalette } from "./components/CommandPalette";
import { BrandMark } from "./components/BrandMark";
import { WindowTitlebar } from "./components/WindowTitlebar";
import { SessionsView } from "./features/SessionsView";
import { SkillsView } from "./features/SkillsView";
import { CustomSkillsSettingsSection, CustomSkillsView } from "./features/CustomSkillsView";
import {
  ActivityView,
  AddProjectDialog,
  ProjectsView,
  SettingsView,
} from "./features/UtilityViews";
import { desktopApi, isTauriRuntime } from "./lib/ipc";
import { useI18n } from "./i18n/i18n";
import { useUiStore } from "./store/ui";
import type { Section } from "./types";

const navigation: Array<{
  groupKey: string;
  items: Array<{
    id: Section;
    labelKey: string;
    icon: typeof MessageSquareText;
    badge?: string;
    shortcut?: string;
  }>;
}> = [
  {
    groupKey: "app.nav.manage",
    items: [
      { id: "sessions", labelKey: "app.section.sessions", icon: MessageSquareText, shortcut: "Ctrl 1" },
      { id: "skills", labelKey: "app.section.skills", icon: Layers3, shortcut: "Ctrl 2" },
      { id: "customSkills", labelKey: "app.section.customSkills", icon: Sparkles, shortcut: "Ctrl 3" },
    ],
  },
  {
    groupKey: "app.nav.workspace",
    items: [
      { id: "projects", labelKey: "app.section.projects", icon: FolderGit2, shortcut: "Ctrl 4" },
      { id: "activity", labelKey: "app.section.activity", icon: Activity, shortcut: "Ctrl 5" },
    ],
  },
];

const sectionNameKeys: Record<Section, string> = {
  sessions: "app.section.sessions",
  skills: "app.section.skills",
  customSkills: "app.section.customSkills",
  projects: "app.section.projects",
  activity: "app.section.activity",
  settings: "app.section.settings",
};

const sectionDescriptionKeys: Record<Section, string> = {
  sessions: "app.section.sessions.description",
  skills: "app.section.skills.description",
  customSkills: "app.section.customSkills.description",
  projects: "app.section.projects.description",
  activity: "app.section.activity.description",
  settings: "app.section.settings.description",
};

const sectionIcons: Record<Section, typeof MessageSquareText> = {
  sessions: MessageSquareText,
  skills: Layers3,
  customSkills: Sparkles,
  projects: FolderGit2,
  activity: Activity,
  settings: Settings,
};

export default function App() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const {
    section,
    setSection,
    contextProjectId,
    setContextProjectId,
    skillEditorDirty,
  } = useUiStore();
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [refreshingSection, setRefreshingSection] = useState(false);

  const capabilitiesQuery = useQuery({
    queryKey: ["capabilities"],
    queryFn: desktopApi.getCapabilities,
    staleTime: 30_000,
  });

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: desktopApi.listProjects,
  });

  const aiSettingsQuery = useQuery({
    queryKey: ["ai-description-settings"],
    queryFn: desktopApi.getAiDescriptionSettings,
    staleTime: 15_000,
  });

  const aiJobQuery = useQuery({
    queryKey: ["skill-description-job", "active"],
    queryFn: () => desktopApi.getSkillDescriptionJob(),
    refetchInterval: (query) => {
      const job = query.state.data;
      return job && (job.status === "queued" || job.status === "running") ? 800 : 4_000;
    },
  });

  // Agent-owned session stores can change while this app is closed.
  // Sync once per Skills Manager launch so every session consumer starts from
  // the same current local index, and again after the app regains focus.
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let lastSyncAt = 0;
    const syncSessions = () => {
      if (inFlight || Date.now() - lastSyncAt < 5_000) return;
      inFlight = true;
      lastSyncAt = Date.now();
      void desktopApi.indexSessions()
        .then(() => {
          if (active) {
            return Promise.all([
              queryClient.invalidateQueries({ queryKey: ["sessions"] }),
              queryClient.invalidateQueries({ queryKey: ["session"] }),
            ]);
          }
        })
        .catch(() => {
          // The Sessions view exposes a retryable error for manual indexing; a
          // background refresh must not prevent the rest of the app loading.
        })
        .finally(() => {
          inFlight = false;
        });
    };
    syncSessions();
    window.addEventListener("focus", syncSessions);
    return () => {
      active = false;
      window.removeEventListener("focus", syncSessions);
    };
  }, [queryClient]);

  const projects = projectsQuery.data ?? [];
  const currentProject =
    contextProjectId === "all"
      ? null
      : projects.find((project) => project.id === contextProjectId) ?? null;
  const CurrentSectionIcon = sectionIcons[section];
  const runtimeLabel = capabilitiesQuery.isLoading
    ? t("app.runtime.checkingLabel")
    : capabilitiesQuery.isError
      ? t("app.runtime.localServiceLabel")
      : capabilitiesQuery.data?.appServerAvailable
        ? t("app.runtime.appServerLabel")
        : capabilitiesQuery.data?.codexCliAvailable
          ? t("app.runtime.codexCliLabel")
          : t("app.runtime.filesystemLabel");
  const searchShortcutLabel =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
      ? "⌘ K"
      : "Ctrl K";

  const focusCurrentSearch = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>(
      ".view-host .search-field input",
    );
    input?.focus();
    input?.select();
  }, []);

  const confirmDiscardSkillDraft = useCallback(() => {
    if (!skillEditorDirty) return true;
    if (!window.confirm(t("app.confirm.discardSkill"))) return false;
    window.dispatchEvent(new Event("ccc:skill-editor:discard"));
    return true;
  }, [skillEditorDirty, t]);

  const navigateToSection = useCallback((target: Section) => {
    if (target === section) return true;
    if (!confirmDiscardSkillDraft()) return false;
    setSection(target);
    return true;
  }, [confirmDiscardSkillDraft, section, setSection]);

  const changeContextProject = useCallback((projectId: string) => {
    if (projectId === contextProjectId) return;
    if (!confirmDiscardSkillDraft()) return;
    setContextProjectId(projectId);
  }, [confirmDiscardSkillDraft, contextProjectId, setContextProjectId]);

  const refreshCurrentSection = useCallback(async () => {
    if (refreshingSection) return;
    const queryKeys: Record<Section, readonly string[][]> = {
      sessions: [["sessions"]],
      skills: [["skills"], ["skill"]],
      customSkills: [["sessions"], ["openapi-search-profiles"], ["custom-skills-settings"]],
      projects: [["projects"]],
      activity: [["audit-logs"]],
      settings: [["capabilities"], ["ai-description-settings"]],
    };
    setRefreshingSection(true);
    try {
      if (section === "sessions" || section === "customSkills") {
        await desktopApi.indexSessions();
      }
      await Promise.all(
        queryKeys[section].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    } finally {
      setRefreshingSection(false);
    }
  }, [queryClient, refreshingSection, section]);

  useEffect(() => {
    if (
      contextProjectId !== "all" &&
      projectsQuery.isSuccess &&
      !projects.some((project) => project.id === contextProjectId)
    ) {
      setContextProjectId("all");
    }
  }, [contextProjectId, projects, projectsQuery.isSuccess, setContextProjectId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      const key = event.key.toLocaleLowerCase();
      if (event.key === "F5" || ((event.ctrlKey || event.metaKey) && key === "r" && !event.shiftKey)) {
        event.preventDefault();
        void refreshCurrentSection();
        return;
      }
      if (!event.ctrlKey && !event.metaKey) return;
      if (key === "k" || (event.shiftKey && key === "p")) {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (key === "f") {
        const hasSearch = Boolean(document.querySelector(".view-host .search-field input"));
        if (hasSearch) {
          event.preventDefault();
          focusCurrentSearch();
        }
        return;
      }
      if (key === ",") {
        event.preventDefault();
        navigateToSection("settings");
        return;
      }
      if (!isTauriRuntime) return;
      const shortcutSections: Partial<Record<string, Section>> = {
        "1": "sessions",
        "2": "skills",
        "3": "customSkills",
        "4": "projects",
        "5": "activity",
      };
      const targetSection = shortcutSections[key];
      if (targetSection) {
        event.preventDefault();
        navigateToSection(targetSection);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusCurrentSearch, navigateToSection, refreshCurrentSection]);

  return (
    <>
    <WindowTitlebar />
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-symbol">
            <BrandMark />
            <span className="brand-pulse" aria-hidden="true" />
          </span>
          <div className="brand-copy">
            <strong>Skills</strong>
            <span>Manager</span>
          </div>
          <span className="brand-edition" title={t("app.brand.localTitle")}>LOCAL</span>
        </div>

        <nav className="primary-navigation" aria-label={t("app.nav.primary")}>
          {navigation.map((group) => (
            <div className="nav-group" key={group.groupKey}>
              <span className="nav-group-label">{t(group.groupKey)}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                const label = t(item.labelKey);
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={section === item.id ? "active" : ""}
                    onClick={() => navigateToSection(item.id)}
                    aria-current={section === item.id ? "page" : undefined}
                    aria-keyshortcuts={item.shortcut?.replace(" ", "+")}
                    title={`${label}${item.shortcut ? ` · ${item.shortcut}` : ""}`}
                  >
                    <span className="nav-icon"><Icon size={17} strokeWidth={1.8} /></span>
                    <span>{label}</span>
                    {item.shortcut && <kbd className="nav-shortcut">{item.shortcut.replace("Ctrl ", "⌃")}</kbd>}
                    {item.badge && <span className="nav-badge" title={t("app.nav.needsAttention")}>{item.badge}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <button
            type="button"
            className={section === "settings" ? "active" : ""}
            onClick={() => navigateToSection("settings")}
            aria-keyshortcuts="Control+,"
            title={t("app.settings.title")}
          >
            <span className="nav-icon"><Settings size={17} /></span>
            <span>{t("app.section.settings")}</span>
            <kbd className="nav-shortcut">⌃,</kbd>
          </button>
          <button type="button" disabled title={t("app.help.unavailable")}>
            <span className="nav-icon"><CircleHelp size={17} /></span>
            <span>{t("app.help.label")}</span>
          </button>
          <div className="local-core-card" title={t("app.localCore.title")}>
            <span className="local-core-icon"><ShieldCheck size={15} /></span>
            <span className="local-core-copy">
              <strong>LOCAL CORE</strong>
              <small>{t("app.localCore.telemetry")}</small>
            </span>
            <span className="local-core-signal" aria-label={t("app.localCore.healthy")} />
          </div>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="topbar-title">
            <span className="topbar-section-icon"><CurrentSectionIcon size={15} /></span>
            <span className="topbar-title-copy">
              <strong>{t(sectionNameKeys[section])}</strong>
              <small>{t(sectionDescriptionKeys[section])}</small>
            </span>
          </div>

          <div className="topbar-actions">
            <button
              type="button"
              className="command-trigger"
              onClick={() => setCommandPaletteOpen(true)}
              title={t("app.command.openWithShortcut", { shortcut: searchShortcutLabel })}
              aria-label={t("app.command.open")}
            >
              <Search size={14} />
              <span>{t("app.command.label")}</span>
              <kbd>{searchShortcutLabel}</kbd>
            </button>
            {(section === "sessions" || section === "skills") && (
              <label className="project-context" title={t("app.project.current")}>
                <FolderGit2 size={14} />
                <select
                  aria-label={t("app.project.currentAria")}
                  value={contextProjectId}
                  onChange={(event) => changeContextProject(event.currentTarget.value)}
                  disabled={projectsQuery.isLoading}
                >
                  <option value="all">{t("app.project.all")}</option>
                  {projects.map((project) => (
                    <option value={project.id} key={project.id}>{project.name}</option>
                  ))}
                </select>
                <ChevronDown size={13} aria-hidden="true" />
              </label>
            )}
            {import.meta.env.DEV && !isTauriRuntime && <span className="preview-badge">{t("app.previewData")}</span>}
          </div>
        </header>

        <div className="view-host">
          {section === "sessions" && <SessionsView project={currentProject} projects={projects} />}
          {section === "skills" && <SkillsView projects={projects} project={currentProject} />}
          {section === "customSkills" && <CustomSkillsView />}
          {section === "projects" && (
            <ProjectsView
              projects={projects}
              loading={projectsQuery.isLoading}
              error={projectsQuery.error}
              refetch={() => void projectsQuery.refetch()}
            />
          )}
          {section === "activity" && <ActivityView />}
          {section === "settings" && (
            <SettingsView
              capabilities={capabilitiesQuery.data}
              loading={capabilitiesQuery.isLoading}
              error={capabilitiesQuery.error}
              onRetry={() => void capabilitiesQuery.refetch()}
              customSkillsSection={<CustomSkillsSettingsSection />}
            />
          )}
        </div>

        <footer className="statusbar">
          <span className="statusbar-primary">
            <Sparkles className={refreshingSection ? "spin" : ""} size={12} />
            {refreshingSection
              ? t("app.status.refreshing", { name: t(sectionNameKeys[section]) })
              : section === "sessions"
              ? t("app.status.sessions")
              : section === "skills"
                ? t("app.status.skills")
                : section === "customSkills"
                  ? t("app.status.customSkills")
                : section === "projects"
                  ? t("app.status.projects", { count: projects.length })
                  : section === "activity"
                    ? t("app.status.activity")
                    : t("app.status.settings")}
          </span>
          {aiSettingsQuery.data?.enabled && (
            <span
              className={`ai-status-pill ${aiSettingsQuery.data.provider}`}
              title={aiSettingsQuery.data.provider === "local" ? t("app.ai.localTitle") : t("app.ai.remoteTitle")}
            >
              {aiSettingsQuery.data.provider === "local" ? t("app.ai.local") : t("app.ai.remoteManual")}
              {aiJobQuery.data && (aiJobQuery.data.status === "queued" || aiJobQuery.data.status === "running") && (
                <span>{aiJobQuery.data.completed}/{aiJobQuery.data.total}</span>
              )}
            </span>
          )}
          <span
            className="connection-state statusbar-connection"
            aria-live="polite"
            title={
              capabilitiesQuery.isLoading
                ? t("app.runtime.checking")
                : capabilitiesQuery.isError
                  ? t("app.runtime.error")
                  : capabilitiesQuery.data?.appServerAvailable
                ? t("app.runtime.appServer")
                : capabilitiesQuery.data?.codexCliAvailable
                  ? t("app.runtime.codexCli")
                  : t("app.runtime.filesystem")
            }
          >
            <span className={capabilitiesQuery.isLoading || capabilitiesQuery.isError ? "compat" : capabilitiesQuery.data?.codexCliAvailable ? "online" : "compat"} />
            <span>{runtimeLabel}</span>
          </span>
          <span className="statusbar-metrics" aria-label={t("app.status.localAria")}>
            <span><span className="metric-light" /> {capabilitiesQuery.isLoading ? t("app.status.indexCheck") : capabilitiesQuery.isError ? t("app.status.indexUnknown") : t("app.status.indexReady")}</span>
            <span><HardDrive size={11} /> {t("app.status.onDevice")}</span>
            <span><LockKeyhole size={11} /> {t("app.status.noTelemetry")}</span>
          </span>
        </footer>
      </main>
      <AddProjectDialog />
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        onNavigate={navigateToSection}
      />
    </div>
    </>
  );
}
