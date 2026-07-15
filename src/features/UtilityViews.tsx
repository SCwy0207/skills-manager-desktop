import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm as confirmDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  Folder,
  FolderGit2,
  FilePenLine,
  HardDrive,
  Info,
  Laptop,
  Languages,
  Link2,
  Palette,
  Plus,
  RefreshCw,
  Rows3,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { EmptyState, ErrorState, StateBadge, compactPath, formatRelativeTime } from "../components/Common";
import { DensitySwitcher } from "../components/DensitySwitcher";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { desktopApi, isTauriRuntime } from "../lib/ipc";
import { useI18n } from "../i18n/i18n";
import { useUiStore } from "../store/ui";
import type { AuditLogEntry, CapabilityInfo, Project } from "../types";
import { AiDescriptionSettingsSection } from "./AiDescriptionUi";

export function ProjectsView({
  projects,
  loading,
  error,
  refetch,
}: {
  projects: Project[];
  loading: boolean;
  error: unknown;
  refetch: () => void;
}) {
  const { t } = useI18n();
  const { contextProjectId, setContextProjectId, setAddProjectOpen, setSection } = useUiStore();
  const queryClient = useQueryClient();
  const removeMutation = useMutation({
    mutationFn: desktopApi.removeProject,
    onSuccess: async (_, id) => {
      if (contextProjectId === id) setContextProjectId("all");
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  const confirmProjectRemoval = async (project: Project) => {
    const message = t("projects.remove.confirm", { name: project.name });
    const confirmed = isTauriRuntime
      ? await confirmDialog(message, {
          title: t("projects.remove.title"),
          kind: "warning",
          okLabel: t("projects.remove.ok"),
          cancelLabel: t("common.cancel"),
        })
      : window.confirm(message);
    if (confirmed) removeMutation.mutate(project.id);
  };

  return (
    <div className="utility-page">
      <div className="utility-page-header">
        <div>
          <span className="eyebrow">{t("projects.eyebrow")}</span>
          <h1>{t("projects.title")}</h1>
          <p>{t("projects.description")}</p>
        </div>
        <button type="button" className="button primary" onClick={() => setAddProjectOpen(true)}>
          <Plus size={16} /> {t("projects.add")}
        </button>
      </div>

      <div className="utility-content">
        <div className="section-heading-row">
          <div>
            <h2>{t("projects.registered")}</h2>
            <p>{t(projects.length === 1 ? "projects.directoryCount.one" : "projects.directoryCount.many", { count: projects.length })}</p>
          </div>
        </div>

        {loading ? (
          <div className="project-grid">
            {Array.from({ length: 2 }, (_, index) => (
              <div className="project-card skeleton-card" key={index}>
                <span className="skeleton skeleton-project-title" />
                <span className="skeleton skeleton-project-path" />
              </div>
            ))}
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : projects.length === 0 ? (
          <EmptyState
            icon={<FolderGit2 size={26} />}
            title={t("projects.empty.title")}
            description={t("projects.empty.description")}
            action={
              <button type="button" className="button primary small" onClick={() => setAddProjectOpen(true)}>
                <Plus size={14} /> {t("projects.add")}
              </button>
            }
          />
        ) : (
          <div className="project-grid">
            {projects.map((project) => (
              <article className="project-card" key={project.id}>
                <div className="project-card-top">
                  <div className="project-icon">
                    <FolderGit2 size={21} />
                  </div>
                  <div className="project-card-actions">
                    {project.trusted && (
                      <StateBadge tone="success" dot={false}>
                        <ShieldCheck size={12} /> {t("projects.trusted")}
                      </StateBadge>
                    )}
                    <button
                      type="button"
                      className="ghost-danger"
                      aria-label={t("projects.remove.aria", { name: project.name })}
                      title={t("projects.remove.tooltip")}
                      onClick={() => void confirmProjectRemoval(project)}
                      disabled={removeMutation.isPending}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <h3>{project.name}</h3>
                <p className="project-path" title={project.rootPath}>
                  {compactPath(project.rootPath, 62)}
                </p>
                <div className="project-agent-paths">
                  <span><span className="mini-agent codex">C</span>.agents/skills</span>
                  <span><span className="mini-agent claude">A</span>.claude/skills</span>
                  <span><span className="mini-agent cursor">›</span>.cursor/skills</span>
                </div>
                <div className="project-card-footer">
                  <span>{t("projects.updated", { time: formatRelativeTime(project.updatedAt) })}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setContextProjectId(project.id);
                      setSection("skills");
                    }}
                  >
                    {t("projects.viewSkills")} <ChevronRight size={13} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {removeMutation.isError && (
          <div className="form-error" role="alert">
            <AlertTriangle size={14} /> {t("projects.remove.error", { error: removeMutation.error.message })}
          </div>
        )}
      </div>
    </div>
  );
}

export function AddProjectDialog() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { addProjectOpen, setAddProjectOpen, setContextProjectId } = useUiStore();
  const [path, setPath] = useState("");
  const [trusted, setTrusted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const pendingRef = useRef(false);

  const addMutation = useMutation({
    mutationFn: () => desktopApi.addProject(path, trusted),
    onSuccess: async (project) => {
      setContextProjectId(project.id);
      setPath("");
      setAddProjectOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  pendingRef.current = addMutation.isPending;

  useEffect(() => {
    if (!addProjectOpen) {
      addMutation.reset();
      setPath("");
      setTrusted(false);
    }
  }, [addProjectOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!addProjectOpen) return undefined;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!pendingRef.current) setAddProjectOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled])',
        ) ?? [],
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.removeEventListener("keydown", handleDialogKeys);
      restoreFocusRef.current?.focus({ preventScroll: true });
      restoreFocusRef.current = null;
    };
  }, [addProjectOpen, setAddProjectOpen]);

  const chooseDirectory = async () => {
    if (!isTauriRuntime) return;
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t("addProject.chooseDirectory"),
    });
    if (typeof selected === "string") setPath(selected);
  };
  const requestClose = () => {
    if (!addMutation.isPending) setAddProjectOpen(false);
  };

  if (!addProjectOpen) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={requestClose}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <span className="dialog-icon"><FolderGit2 size={19} /></span>
            <div>
              <h2 id="add-project-title">{t("addProject.title")}</h2>
              <p>{t("addProject.description")}</p>
            </div>
          </div>
          <button type="button" className="dialog-close" onClick={requestClose} aria-label={t("common.close")} disabled={addMutation.isPending}>
            <X size={17} />
          </button>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) addMutation.mutate();
          }}
        >
          <label className="form-field">
            <span>{t("addProject.path.label")}</span>
            <div className="path-input">
              <Folder size={15} />
              <input
                value={path}
                onChange={(event) => setPath(event.currentTarget.value)}
                placeholder="D:\\Projects\\demo-project"
                autoFocus
                spellCheck={false}
              />
              {isTauriRuntime && (
                <button type="button" className="path-browse-button" onClick={chooseDirectory}>
                  {t("common.browse")}
                </button>
              )}
            </div>
            <small>{t("addProject.path.help")}</small>
          </label>

          <label className="check-field">
            <input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.currentTarget.checked)} />
            <span className="checkbox-visual"><Check size={12} /></span>
            <span>
              <strong>{t("addProject.trust.label")}</strong>
              <small>{t("addProject.trust.help")}</small>
            </span>
          </label>

          {addMutation.isError && (
            <div className="form-error"><AlertTriangle size={14} />{t("addProject.error", { error: addMutation.error.message })}</div>
          )}

          <div className="dialog-footer">
            <button type="button" className="button secondary" onClick={requestClose} disabled={addMutation.isPending}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="button primary" disabled={!path.trim() || addMutation.isPending}>
              {addMutation.isPending ? t("addProject.validating") : t("projects.add")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ActivityView() {
  const { t } = useI18n();
  const [recoveryCopyStatus, setRecoveryCopyStatus] = useState<Record<number, "copied" | "failed">>({});
  const logsQuery = useQuery({
    queryKey: ["audit-logs"],
    queryFn: () => desktopApi.listAuditLogs(100),
    refetchOnMount: "always",
  });
  const copyRecoveryPaths = async (entryId: number, paths: string[]) => {
    try {
      if (!navigator.clipboard) throw new Error(t("activity.clipboardUnavailable"));
      await navigator.clipboard.writeText(paths.join("\n"));
      setRecoveryCopyStatus((current) => ({ ...current, [entryId]: "copied" }));
    } catch {
      setRecoveryCopyStatus((current) => ({ ...current, [entryId]: "failed" }));
    }
    window.setTimeout(() => {
      setRecoveryCopyStatus((current) => {
        const next = { ...current };
        delete next[entryId];
        return next;
      });
    }, 2600);
  };

  return (
    <div className="utility-page">
      <div className="utility-page-header">
        <div>
          <span className="eyebrow">{t("activity.eyebrow")}</span>
          <h1>{t("activity.title")}</h1>
          <p>{t("activity.description")}</p>
        </div>
        <button
          type="button"
          className="button secondary small"
          onClick={() => void logsQuery.refetch()}
          disabled={logsQuery.isFetching}
          aria-keyshortcuts="F5"
        >
          <RefreshCw className={logsQuery.isFetching ? "spin" : ""} size={14} />
          {logsQuery.isFetching ? t("common.refreshing") : t("common.refresh")}
        </button>
      </div>
      <div className="utility-content narrow">
        {logsQuery.isLoading ? (
          <div className="timeline-card timeline-loading">
            {Array.from({ length: 4 }, (_, index) => (
              <div className="timeline-item" key={index}>
                <span className="skeleton skeleton-icon" />
                <div><span className="skeleton timeline-skeleton-title" /><span className="skeleton timeline-skeleton-copy" /></div>
              </div>
            ))}
          </div>
        ) : logsQuery.isError ? (
          <ErrorState error={logsQuery.error} onRetry={() => logsQuery.refetch()} />
        ) : !logsQuery.data?.length ? (
          <EmptyState
            icon={<Clock3 size={24} />}
            title={t("activity.empty.title")}
            description={t("activity.empty.description")}
          />
        ) : (
          <div className="timeline-card">
            <div className="timeline-date">{t("activity.recentCount", { count: logsQuery.data.length })}</div>
            {logsQuery.data.map((entry) => {
              const item = describeAuditEntry(entry, t);
              const Icon = item.icon;
              const recoveryPaths = recoveryLinkPaths(entry);
              return (
                <div className="timeline-item" key={entry.id}>
                  <span className={`timeline-icon ${item.tone}`}><Icon size={15} /></span>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                    {entry.actionType === "IMPORT_RECOVERY" && recoveryPaths.length > 0 && (
                      <details className="recovery-paths">
                        <summary>{t(recoveryPaths.length === 1 ? "activity.recovery.viewPaths.one" : "activity.recovery.viewPaths.many", { count: recoveryPaths.length })}</summary>
                        <ul>
                          {recoveryPaths.map((path) => (
                            <li key={path}><code>{path}</code></li>
                          ))}
                        </ul>
                        <div className="recovery-path-actions">
                          <button
                            type="button"
                            className="recovery-copy-button"
                            onClick={() => void copyRecoveryPaths(entry.id, recoveryPaths)}
                            title={t("activity.recovery.copyTooltip")}
                          >
                            <Copy size={12} /> {t("activity.recovery.copyAll")}
                          </button>
                          {recoveryCopyStatus[entry.id] && (
                            <span role="status" className={recoveryCopyStatus[entry.id]}>
                              {recoveryCopyStatus[entry.id] === "copied" ? t("activity.recovery.copied") : t("activity.recovery.copyFailed")}
                            </span>
                          )}
                        </div>
                      </details>
                    )}
                  </div>
                  <time>{formatRelativeTime(entry.createdAt)}</time>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function describeAuditEntry(entry: AuditLogEntry, t: ReturnType<typeof useI18n>["t"]) {
  if (entry.actionType === "IMPORT_RECOVERY") {
    const sourcePath = typeof entry.detail.sourcePath === "string"
      ? entry.detail.sourcePath
      : t("activity.audit.unknownSource");
    const linkPaths = recoveryLinkPaths(entry);
    return {
      icon: AlertTriangle,
      tone: "warning",
      title: t("activity.audit.importRecovery.title"),
      detail: t("activity.audit.importRecovery.detail", {
        path: compactPath(sourcePath, 48),
        targets: linkPaths.length
          ? t(linkPaths.length === 1 ? "activity.audit.importRecovery.targetCount.one" : "activity.audit.importRecovery.targetCount.many", { count: linkPaths.length })
          : t("activity.audit.importRecovery.relatedTargets"),
      }),
    };
  }
  const failed = entry.result.toLocaleLowerCase() !== "success";
  if (failed) {
    return {
      icon: AlertTriangle,
      tone: "warning",
      title: t("activity.audit.failed.title"),
      detail: entry.targetId
        ? t("activity.audit.actionTarget", { action: entry.actionType, target: entry.targetId })
        : entry.actionType,
    };
  }
  switch (entry.actionType) {
    case "SKILL_SCAN":
      return {
        icon: SearchCheck,
        tone: "success",
        title: t("activity.audit.skillScan.title"),
        detail: pluralisedAuditDetail(t, "activity.audit.skillScan.detail", numberDetail(entry, "count")),
      };
    case "SESSION_INDEX":
      return {
        icon: Database,
        tone: "accent",
        title: t("activity.audit.sessionIndex.title"),
        detail: pluralisedAuditDetail(t, "activity.audit.sessionIndex.detail", numberDetail(entry, "changed")),
      };
    case "SKILL_IMPORT":
      return {
        icon: Link2,
        tone: "neutral",
        title: t("activity.audit.skillImport.title"),
        detail: pluralisedAuditDetail(t, "activity.audit.skillImport.detail", numberDetail(entry, "targets")),
      };
    case "SKILL_UNINSTALL":
      return {
        icon: Trash2,
        tone: "warning",
        title: t("activity.audit.skillUninstall.title"),
        detail:
          typeof entry.detail.linkPath === "string"
            ? entry.detail.linkPath
            : typeof entry.detail.path === "string"
              ? entry.detail.path
              : entry.targetId ?? t("activity.audit.localDeployment"),
      };
    case "SKILL_ENABLE": {
      const enabled = entry.detail.enabled === true;
      return {
        icon: enabled ? Check : AlertTriangle,
        tone: enabled ? "success" : "warning",
        title: enabled ? t("activity.audit.skillEnable.enabled") : t("activity.audit.skillEnable.disabled"),
        detail: entry.targetId ?? t("activity.audit.skillEnable.detail"),
      };
    }
    case "SKILL_FILE_WRITE":
      return {
        icon: FilePenLine,
        tone: "accent",
        title: t("activity.audit.skillFileWrite.title"),
        detail: typeof entry.detail.path === "string" ? entry.detail.path : entry.targetId ?? t("activity.audit.localFile"),
      };
    case "SKILL_SECURITY_SCAN": {
      const findings = numberDetail(entry, "findings");
      const rawStatus = typeof entry.detail.status === "string" ? entry.detail.status : "unknown";
      const status = ["pending", "safe", "risky", "blocked"].includes(rawStatus)
        ? t(`activity.audit.status.${rawStatus}`)
        : t("activity.audit.status.unknown");
      return {
        icon: findings > 0 ? AlertTriangle : ShieldCheck,
        tone: findings > 0 ? "warning" : "success",
        title: t("activity.audit.securityScan.title"),
        detail: findings > 0
          ? t(findings === 1 ? "activity.audit.securityScan.findings.one" : "activity.audit.securityScan.findings.many", { status, count: findings })
          : t("activity.audit.securityScan.clean"),
      };
    }
    default:
      return {
        icon: Activity,
        tone: "neutral",
        title: entry.actionType.replaceAll("_", " "),
        detail: entry.targetId ?? t("activity.audit.completed"),
      };
  }
}

function recoveryLinkPaths(entry: AuditLogEntry) {
  return Array.isArray(entry.detail.linkPaths)
    ? entry.detail.linkPaths.filter((path): path is string => typeof path === "string")
    : [];
}

function pluralisedAuditDetail(
  t: ReturnType<typeof useI18n>["t"],
  key: string,
  count: number,
) {
  return t(`${key}.${count === 1 ? "one" : "many"}`, { count });
}

function numberDetail(entry: AuditLogEntry, key: string) {
  const value = entry.detail[key];
  return typeof value === "number" ? value : 0;
}

export function SettingsView({
  capabilities,
  loading = false,
  error,
  onRetry,
  customSkillsSection,
}: {
  capabilities?: CapabilityInfo;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  customSkillsSection?: ReactNode;
}) {
  const { locale, setLocale, t } = useI18n();
  const unknownLabel = loading
    ? t("settings.status.detecting")
    : error
      ? t("settings.status.failed")
      : t("settings.status.unknown");
  const platformLabel = capabilities?.platform === "windows" ? "Windows" : capabilities?.platform === "macos" ? "macOS" : capabilities?.platform || unknownLabel;
  return (
    <div className="utility-page">
      <div className="utility-page-header">
        <div>
          <span className="eyebrow">Skills Manager</span>
          <h1>{t("settings.title")}</h1>
          <p>{t("settings.description")}</p>
        </div>
        {Boolean(error) && onRetry && (
          <button type="button" className="button secondary small" onClick={onRetry}>
            <RefreshCw size={14} /> {t("settings.redetect")}
          </button>
        )}
      </div>
      <div className="utility-content settings-content">
        <section className="settings-section">
          <h2>{t("settings.appearance.title")}</h2>
          <div className="appearance-card">
            <div className="appearance-control-row">
              <span className="appearance-icon"><Palette size={19} /></span>
              <div className="appearance-copy">
                <strong>{t("settings.appearance.theme.label")}</strong>
                <p>{t("settings.appearance.theme.description")}</p>
              </div>
              <ThemeSwitcher />
            </div>
            <div className="density-control-row">
              <span className="appearance-icon density-icon"><Rows3 size={19} /></span>
              <div className="appearance-copy">
                <strong>{t("settings.appearance.density.label")}</strong>
                <p>{t("settings.appearance.density.description")}</p>
              </div>
              <DensitySwitcher />
            </div>
            <div className="language-control-row">
              <span className="appearance-icon language-icon"><Languages size={19} /></span>
              <div className="appearance-copy">
                <label htmlFor="global-language"><strong>{t("settings.appearance.language.label")}</strong></label>
                <p id="global-language-description">{t("settings.appearance.language.description")}</p>
              </div>
              <select
                id="global-language"
                className="language-select"
                value={locale}
                onChange={(event) => setLocale(event.currentTarget.value as typeof locale)}
                aria-describedby="global-language-description"
              >
                <option value="zh-CN">简体中文</option>
                <option value="zh-TW">繁體中文</option>
                <option value="en-GB">English (UK)</option>
              </select>
            </div>
          </div>
        </section>
        <AiDescriptionSettingsSection />
        {customSkillsSection}
        <section className="settings-section">
          <h2>{t("settings.environment.title")}</h2>
          <div className="settings-card">
            <SettingRow icon={<Laptop size={17} />} label={t("settings.environment.platform")} value={platformLabel} />
            <SettingRow
              icon={<Sparkles size={17} />}
              label="Codex CLI"
              value={loading || error ? unknownLabel : capabilities?.codexCliAvailable ? t("settings.status.installed") : t("settings.status.notDetected")}
              status={loading || error ? "warning" : capabilities?.codexCliAvailable ? "success" : "warning"}
            />
            <SettingRow
              icon={<HardDrive size={17} />}
              label={t("settings.environment.sessionSource")}
              value={loading || error ? unknownLabel : capabilities?.sessionSource === "app-server" ? "App Server" : t("settings.environment.localFileIndex")}
            />
            <SettingRow
              icon={<Link2 size={17} />}
              label={t("settings.environment.managedLinks")}
              value={loading || error ? unknownLabel : capabilities?.symlinkSupported ? t("settings.environment.symbolicLink") : capabilities?.junctionSupported ? "NTFS Junction" : t("settings.status.unavailable")}
            />
          </div>
        </section>
        <section className="settings-section">
          <h2>{t("settings.privacy.title")}</h2>
          <div className="privacy-card">
            <span className="privacy-icon"><ShieldCheck size={22} /></span>
            <div>
              <strong>{t("settings.privacy.localFirst")}</strong>
              <p>{t("settings.privacy.description")}</p>
            </div>
            <StateBadge tone="success">{t("settings.status.enabled")}</StateBadge>
          </div>
        </section>
        {import.meta.env.DEV && !isTauriRuntime && (
          <div className="browser-preview-note">
            <Info size={16} />
            <div><strong>{t("settings.browserPreview.title")}</strong><p>{t("settings.browserPreview.description")}</p></div>
          </div>
        )}
      </div>
    </div>
  );
}

function SettingRow({ icon, label, value, status }: { icon: React.ReactNode; label: string; value: string; status?: "success" | "warning" }) {
  return (
    <div className="setting-row">
      <span>{icon}</span>
      <strong>{label}</strong>
      <span className={status ? `setting-status ${status}` : ""}>{value}</span>
    </div>
  );
}
