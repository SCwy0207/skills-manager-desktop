import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleSlash2,
  Code2,
  Copy,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Layers3,
  Languages,
  LockKeyhole,
  Pencil,
  PackageOpen,
  Power,
  RefreshCw,
  Save,
  ScanSearch,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import {
  EmptyState,
  ErrorState,
  HighlightText,
  IconButton,
  SearchField,
  SkeletonRows,
  StateBadge,
  compactPath,
  formatRelativeTime,
  handleRovingListKeyDown,
} from "../components/Common";
import { PaneResizeHandle } from "../components/PaneResizeHandle";
import { desktopApi, isTauriRuntime } from "../lib/ipc";
import { sha256Text } from "../lib/hash";
import { useI18n } from "../i18n/i18n";
import { useUiStore } from "../store/ui";
import type { Project, SkillFile, SkillSummary } from "../types";
import { ImportSkillDialog } from "./ImportSkillDialog";
import { SkillDescriptionBatchDialog, SkillDescriptionPanel } from "./AiDescriptionUi";
import { SkillSecurityPanel } from "./SkillSecurityPanel";

const agentLabels: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
};

function normalizeAgent(value: string) {
  const normalized = value.toLocaleLowerCase();
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("cursor")) return "cursor";
  return "codex";
}

function normalizeScope(value: string) {
  const normalized = value.toLocaleLowerCase();
  if (normalized === "project") return "repo";
  return normalized;
}

function skillHasIssue(skill: SkillSummary) {
  return (
    !["healthy", "normal", "ok"].includes(skill.healthStatus.toLocaleLowerCase()) ||
    ["review", "risky", "blocked", "warning"].includes(skill.riskStatus.toLocaleLowerCase()) ||
    skill.duplicateName
  );
}

export function getSkillDisplayDescription(skill: SkillSummary) {
  const localized = skill.descriptionLocalization;
  return localized?.text?.trim() || skill.description;
}

function textIncludesQuery(text: string, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return Boolean(needle) && text.toLocaleLowerCase().includes(needle);
}

function AgentMark({ agent, small = false }: { agent: string; small?: boolean }) {
  const normalized = normalizeAgent(agent);
  return (
    <span className={`agent-mark ${normalized} ${small ? "small" : ""}`} aria-hidden="true">
      {normalized === "codex" ? "C" : normalized === "claude" ? "A" : ">"}
    </span>
  );
}

function SkillRow({
  skill,
  selected,
  query,
  onSelect,
}: {
  skill: SkillSummary;
  selected: boolean;
  query: string;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  const agent = normalizeAgent(skill.agentType);
  const hasIssue = skillHasIssue(skill);
  const displayDescription = getSkillDisplayDescription(skill);
  const originalMatch =
    displayDescription !== skill.description &&
    textIncludesQuery(skill.description, query) &&
    !textIncludesQuery(displayDescription, query);
  return (
    <button
      type="button"
      className={`skill-row ${selected ? "selected" : ""}`}
      onClick={onSelect}
      onKeyDown={handleRovingListKeyDown}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-roving-item
    >
      <AgentMark agent={agent} />
      <div className="skill-row-content">
        <div className="skill-row-topline">
          <span className="skill-name">
            <HighlightText text={skill.displayName || skill.name} query={query} />
          </span>
          {hasIssue ? (
            <AlertTriangle className="status-icon warning" size={14} aria-label={t("skills.status.needsAttention")} />
          ) : skill.enabledState.toLocaleLowerCase() === "disabled" ? (
            <CircleSlash2 className="status-icon muted" size={14} aria-label={t("skills.status.disabled")} />
          ) : (
            <span className="healthy-dot" role="img" aria-label={t("skills.status.healthy")} />
          )}
        </div>
        <p className={skill.descriptionLocalization?.status === "stale" ? "localized-description stale" : "localized-description"}>
          <HighlightText text={displayDescription} query={query} />
          {skill.descriptionLocalization?.status === "stale" && (
            <span className="description-stale-label">{t("skills.description.sourceUpdated")}</span>
          )}
        </p>
        {originalMatch && (
          <p className="original-description-match">
            <span>{t("skills.description.originalMatch")}</span>
            <HighlightText text={skill.description} query={query} />
          </p>
        )}
        <div className="row-metadata skill-meta">
          <span>{agentLabels[agent]}</span>
          <span className="metadata-separator">·</span>
          <span>{t(`skills.scope.${normalizeScope(skill.scopeKind)}`)}</span>
          {skill.readOnly && (
            <span title={t("skills.readOnlySource")}>
              <LockKeyhole size={10} /> {t("skills.readOnly")}
            </span>
          )}
          {skill.duplicateName && <span className="warning-copy">{t("skills.duplicateShort")}</span>}
        </div>
      </div>
    </button>
  );
}

export function SkillsView({
  projects,
  project,
}: {
  projects: Project[];
  project: Project | null;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
  const [batchDescriptionOpen, setBatchDescriptionOpen] = useState(false);
  const {
    selectedSkillId,
    setSelectedSkillId,
    selectedSkillFile,
    setSelectedSkillFile,
    skillQuery,
    setSkillQuery,
    skillAgentFilter,
    setSkillAgentFilter,
    skillScopeFilter,
    setSkillScopeFilter,
    skillStatusFilter,
    setSkillStatusFilter,
    skillEditorDirty,
  } = useUiStore();
  const deferredQuery = useDeferredValue(skillQuery);
  const projectIds = project ? [project.id] : projects.map((candidate) => candidate.id);

  const scanQuery = useQuery({
    queryKey: ["skills", projectIds.join(",")],
    queryFn: () =>
      desktopApi.scanSkills({
        projectIds,
        includePluginCache: true,
      }),
  });

  const skills = useMemo(() => {
    const needle = deferredQuery.trim().toLocaleLowerCase();
    return (scanQuery.data ?? []).filter((skill) => {
      const agent = normalizeAgent(skill.agentType);
      const scope = normalizeScope(skill.scopeKind);
      if (skillAgentFilter !== "all" && agent !== skillAgentFilter) return false;
      if (skillScopeFilter !== "all" && scope !== skillScopeFilter) return false;
      if (skillStatusFilter === "enabled" && skill.enabledState.toLocaleLowerCase() !== "enabled") {
        return false;
      }
      if (skillStatusFilter === "disabled" && skill.enabledState.toLocaleLowerCase() !== "disabled") {
        return false;
      }
      if (skillStatusFilter === "issues" && !skillHasIssue(skill)) return false;
      if (!needle) return true;
      return `${skill.name}\n${skill.displayName}\n${skill.description}\n${skill.descriptionLocalization?.text ?? ""}\n${skill.path}`
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [
    deferredQuery,
    scanQuery.data,
    skillAgentFilter,
    skillScopeFilter,
    skillStatusFilter,
  ]);

  useEffect(() => {
    if (skillEditorDirty) return;
    if (!skills.length) {
      if (selectedSkillId) setSelectedSkillId(null);
      return;
    }
    if (!selectedSkillId || !skills.some((skill) => skill.id === selectedSkillId)) {
      setSelectedSkillId(skills[0].id);
    }
  }, [selectedSkillId, setSelectedSkillId, skillEditorDirty, skills]);

  const detailQuery = useQuery({
    queryKey: ["skill", selectedSkillId],
    queryFn: () => desktopApi.getSkill(selectedSkillId as string),
    enabled: Boolean(selectedSkillId),
  });

  useEffect(() => {
    const files = detailQuery.data?.files;
    if (!files?.length) return;
    if (!files.some((file) => file.path === selectedSkillFile)) {
      if (skillEditorDirty) return;
      const preferred = files.find((file) => file.path === "SKILL.md") ?? files[0];
      setSelectedSkillFile(preferred.path);
    }
  }, [detailQuery.data?.files, selectedSkillFile, setSelectedSkillFile, skillEditorDirty]);

  const fileQuery = useQuery({
    queryKey: ["skill-file", selectedSkillId, selectedSkillFile],
    queryFn: () =>
      desktopApi.readSkillFile(selectedSkillId as string, selectedSkillFile),
    enabled: Boolean(selectedSkillId && selectedSkillFile),
  });

  const issueCount = (scanQuery.data ?? []).filter(skillHasIssue).length;
  const refreshSkills = async () => {
    await scanQuery.refetch();
    await queryClient.invalidateQueries({ queryKey: ["audit-logs"] });
  };
  const closeImport = useCallback(() => setImportOpen(false), []);
  const closeBatchDescription = useCallback(() => setBatchDescriptionOpen(false), []);
  const requestSelectSkill = useCallback((skillId: string) => {
    if (skillId === selectedSkillId) return;
    if (skillEditorDirty && !window.confirm(t("skills.confirm.switchSkill"))) return;
    if (skillEditorDirty) window.dispatchEvent(new Event("ccc:skill-editor:discard"));
    setSelectedSkillId(skillId);
  }, [selectedSkillId, setSelectedSkillId, skillEditorDirty]);
  const requestOpenBatchDescription = useCallback(() => {
    if (skillEditorDirty) {
      window.alert(t("skills.alert.saveBeforeBatch"));
      return;
    }
    setBatchDescriptionOpen(true);
  }, [skillEditorDirty]);

  useEffect(() => {
    window.addEventListener("ccc:skill-description:batch", requestOpenBatchDescription);
    return () => window.removeEventListener("ccc:skill-description:batch", requestOpenBatchDescription);
  }, [requestOpenBatchDescription]);

  return (
    <>
    <div className="workspace-split skill-workspace">
      <section id="skill-list-pane" className="list-pane" aria-label={t("skills.list.ariaLabel")}>
        <div className="pane-header">
          <div>
            <div className="heading-with-count">
              <h2>Skills</h2>
              {!scanQuery.isLoading && <span>{skills.length}</span>}
            </div>
            <p>{project ? `${project.name} · ${t("skills.list.visible")}` : t("skills.list.inventory")}</p>
          </div>
          <div className="pane-header-actions">
            <button type="button" className="button secondary small batch-description-trigger" onClick={requestOpenBatchDescription} disabled={skillEditorDirty} title={skillEditorDirty ? t("skills.editor.saveOrDiscard") : t("skills.description.batchTitle")}>
              <Languages size={13} /> {t("skills.description.chinese")}
            </button>
            <button type="button" className="button primary small" onClick={() => setImportOpen(true)}>
              <Upload size={13} /> {t("skills.import.action")}
            </button>
            <IconButton
              label={t("skills.rescan")}
              onClick={() => void refreshSkills()}
              disabled={scanQuery.isFetching}
            >
              <RefreshCw className={scanQuery.isFetching ? "spin" : ""} size={16} />
            </IconButton>
          </div>
        </div>

        <div className="pane-controls skills-controls">
          <SearchField
            value={skillQuery}
            onChange={setSkillQuery}
            placeholder={t("skills.search.placeholder")}
          />

          <div className="skills-filter-track">
            <div className="agent-filter" role="group" aria-label={t("skills.filter.agentAria")}>
              <button
                type="button"
                className={skillAgentFilter === "all" ? "active" : ""}
                aria-pressed={skillAgentFilter === "all"}
                onClick={() => setSkillAgentFilter("all")}
              >
                {t("skills.filter.all")}
              </button>
              {(["codex", "claude", "cursor"] as const).map((agent) => (
                <button
                  type="button"
                  key={agent}
                  className={skillAgentFilter === agent ? "active" : ""}
                  aria-pressed={skillAgentFilter === agent}
                  onClick={() => setSkillAgentFilter(agent)}
                  title={agentLabels[agent]}
                >
                  <AgentMark agent={agent} small />
                  <span>{agent === "claude" ? "Claude" : agentLabels[agent]}</span>
                </button>
              ))}
            </div>

            <div className="filter-row">
              <label>
                <span>{t("skills.filter.scope")}</span>
                <select
                  aria-label={t("skills.filter.scopeAria")}
                  value={skillScopeFilter}
                  onChange={(event) =>
                    setSkillScopeFilter(event.currentTarget.value as typeof skillScopeFilter)
                  }
                >
                  <option value="all">{t("skills.filter.allScopes")}</option>
                  <option value="user">{t("skills.scope.user")}</option>
                  <option value="repo">{t("skills.scope.repo")}</option>
                  <option value="plugin">{t("skills.scope.plugin")}</option>
                  <option value="system">{t("skills.scope.system")}</option>
                </select>
              </label>
              <label>
                <span>{t("skills.filter.status")}</span>
                <select
                  aria-label={t("skills.filter.statusAria")}
                  value={skillStatusFilter}
                  onChange={(event) =>
                    setSkillStatusFilter(event.currentTarget.value as typeof skillStatusFilter)
                  }
                >
                  <option value="all">{t("skills.filter.allStatuses")}</option>
                  <option value="enabled">{t("skills.status.enabled")}</option>
                  <option value="disabled">{t("skills.status.disabled")}</option>
                  <option value="issues">{t("skills.status.needsAttention")} {issueCount ? `(${issueCount})` : ""}</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <div className="list-scroll">
          {scanQuery.isLoading ? (
            <SkeletonRows count={7} />
          ) : scanQuery.isError ? (
            <ErrorState error={scanQuery.error} onRetry={() => void refreshSkills()} />
          ) : skills.length === 0 ? (
            <EmptyState
              icon={<PackageOpen size={24} />}
              title={skillQuery ? t("skills.empty.noMatch") : t("skills.empty.none")}
              description={
                skillQuery
                  ? t("skills.empty.noMatchDescription")
                  : t("skills.empty.noneDescription")
              }
              action={
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => void refreshSkills()}
                >
                  {t("skills.rescan")}
                </button>
              }
            />
          ) : (
            <div className="result-list skill-list" role="listbox" aria-label={t("skills.list.resultsAria")} data-roving-list>
              {skills.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  selected={skill.id === selectedSkillId}
                  query={skillQuery}
                  onSelect={() => requestSelectSkill(skill.id)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      <PaneResizeHandle
              storageKey="skills-manager:skill-list-width"
        controls="skill-list-pane skill-detail-pane"
        label={t("skills.resize")}
      />

      <section id="skill-detail-pane" className="detail-pane skill-detail-pane" aria-label={t("skills.detail.ariaLabel")}>
        {!selectedSkillId ? (
          <EmptyState
            icon={<Layers3 size={25} />}
            title={t("skills.detail.select")}
            description={t("skills.detail.selectDescription")}
          />
        ) : detailQuery.isLoading ? (
          <div className="detail-loading">
            <span className="skeleton skeleton-kicker" />
            <span className="skeleton skeleton-detail-title" />
            <span className="skeleton skeleton-detail-line" />
            <span className="skeleton skeleton-detail-body" />
          </div>
        ) : detailQuery.isError ? (
          <ErrorState error={detailQuery.error} onRetry={() => detailQuery.refetch()} />
        ) : detailQuery.data ? (
          <SkillDetailContent
            key={`${detailQuery.data.summary.id}:${selectedSkillFile}`}
            detail={detailQuery.data}
            selectedFile={selectedSkillFile}
            onSelectFile={setSelectedSkillFile}
            fileContent={fileQuery.data ?? ""}
            fileLoading={fileQuery.isLoading || fileQuery.isFetching}
            fileError={fileQuery.error}
            retryFile={() => fileQuery.refetch()}
            onRemoved={() => setSelectedSkillId(null)}
          />
        ) : null}
      </section>
    </div>
    <ImportSkillDialog open={importOpen} onClose={closeImport} project={project} />
    {batchDescriptionOpen && (
      <SkillDescriptionBatchDialog
        open
        onClose={closeBatchDescription}
        filteredSkills={skills}
        allSkills={scanQuery.data ?? []}
        project={project}
      />
    )}
    </>
  );
}

function SkillDetailContent({
  detail,
  selectedFile,
  onSelectFile,
  fileContent,
  fileLoading,
  fileError,
  retryFile,
  onRemoved,
}: {
  detail: Awaited<ReturnType<typeof desktopApi.getSkill>>;
  selectedFile: string;
  onSelectFile: (path: string) => void;
  fileContent: string;
  fileLoading: boolean;
  fileError: unknown;
  retryFile: () => void;
  onRemoved: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const setSkillEditorDirty = useUiStore((state) => state.setSkillEditorDirty);
  const beginCriticalOperation = useUiStore((state) => state.beginCriticalOperation);
  const endCriticalOperation = useUiStore((state) => state.endCriticalOperation);
  const { summary } = detail;
  const agent = normalizeAgent(summary.agentType);
  const healthy = !skillHasIssue(summary);
  const disabled = summary.enabledState.toLocaleLowerCase() === "disabled";
  const currentFile = detail.files.find((file) => file.path === selectedFile);
  const canToggleEnabled = agent === "codex" && normalizeScope(summary.scopeKind) !== "plugin";
  const [editing, setEditing] = useState(false);
  const [originalContent, setOriginalContent] = useState(fileContent);
  const [draftContent, setDraftContent] = useState(fileContent);
  const [savedNotice, setSavedNotice] = useState(false);
  const [activeTab, setActiveTab] = useState<"files" | "risk">("files");
  const isDirty = draftContent !== originalContent;

  useEffect(() => {
    setEditing(false);
    setSavedNotice(false);
  }, [selectedFile, summary.id]);

  useEffect(() => {
    if (!editing && !fileLoading && !fileError) {
      setOriginalContent(fileContent);
      setDraftContent(fileContent);
    }
  }, [editing, fileContent, fileError, fileLoading]);

  useEffect(() => {
    const hasUnsavedChanges = editing && isDirty;
    setSkillEditorDirty(hasUnsavedChanges);
    if (!hasUnsavedChanges) return undefined;

    const preventAccidentalReload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventAccidentalReload);
    return () => {
      window.removeEventListener("beforeunload", preventAccidentalReload);
      setSkillEditorDirty(false);
    };
  }, [editing, isDirty, setSkillEditorDirty]);

  const saveMutation = useMutation({
    mutationFn: async (content: string) =>
      desktopApi.writeSkillFile({
        locationId: summary.id,
        relativePath: selectedFile,
        content,
        expectedHash: await sha256Text(originalContent),
      }),
    onSuccess: async (_, savedContent) => {
      queryClient.setQueryData(["skill-file", summary.id, selectedFile], savedContent);
      setOriginalContent(savedContent);
      setDraftContent(savedContent);
      setEditing(false);
      setSavedNotice(true);
      window.setTimeout(() => setSavedNotice(false), 2600);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["skills"] }),
        queryClient.invalidateQueries({ queryKey: ["skill", summary.id] }),
        queryClient.invalidateQueries({ queryKey: ["audit-logs"] }),
      ]);
    },
  });

  const enableMutation = useMutation({
    mutationFn: (enabled: boolean) => desktopApi.setSkillEnabled(summary.id, enabled),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["skills"] }),
        queryClient.invalidateQueries({ queryKey: ["skill", summary.id] }),
        queryClient.invalidateQueries({ queryKey: ["audit-logs"] }),
      ]);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      const operationId = `skill-remove:${summary.id}:${crypto.randomUUID()}`;
      beginCriticalOperation(operationId, `${t("skills.remove.removing")} ${summary.displayName || summary.name}`);
      try {
        return await desktopApi.removeManagedBinding(summary.id);
      } finally {
        endCriticalOperation(operationId);
      }
    },
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ["skill", summary.id] });
      queryClient.removeQueries({ queryKey: ["skill-security", summary.id] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["skills"] }),
        queryClient.invalidateQueries({ queryKey: ["audit-logs"] }),
      ]);
      onRemoved();
    },
  });

  const confirmRemoval = async () => {
    if (saveMutation.isPending) return;
    const discardsDraft = editing && isDirty;
    const message = `${discardsDraft ? `${t("skills.remove.discardWarning")}\n\n` : ""}${t("skills.remove.confirm")}`;
    const confirmed = isTauriRuntime
      ? await confirmDialog(message, {
          title: `${t("skills.remove.title")} ${summary.displayName || summary.name}`,
          kind: "warning",
          okLabel: t("skills.remove.action"),
          cancelLabel: t("skills.common.cancel"),
        })
      : window.confirm(message);
    if (!confirmed) return;
    if (discardsDraft) {
      setDraftContent(originalContent);
      setEditing(false);
      setSkillEditorDirty(false);
      saveMutation.reset();
    }
    removeMutation.mutate();
  };

  const saveDraft = () => {
    if (isDirty && !saveMutation.isPending) saveMutation.mutate(draftContent);
  };
  const cancelEditing = () => {
    setDraftContent(originalContent);
    setEditing(false);
    saveMutation.reset();
  };
  useEffect(() => {
    const discardDraft = () => {
      cancelEditing();
      setSkillEditorDirty(false);
    };
    window.addEventListener("ccc:skill-editor:discard", discardDraft);
    return () => window.removeEventListener("ccc:skill-editor:discard", discardDraft);
  });
  const requestCancelEditing = () => {
    if (isDirty && !window.confirm(t("skills.confirm.discardFile"))) return;
    cancelEditing();
  };
  const selectFile = (path: string) => {
    if (path === selectedFile) return;
    if (editing && isDirty && !window.confirm(t("skills.confirm.switchFile"))) {
      return;
    }
    setEditing(false);
    saveMutation.reset();
    onSelectFile(path);
  };
  const selectTab = (tab: "files" | "risk") => {
    if (tab === activeTab) return;
    if (tab === "risk" && editing && isDirty && !window.confirm(t("skills.confirm.viewRisk"))) {
      return;
    }
    if (tab === "risk") {
      setEditing(false);
      saveMutation.reset();
    }
    setActiveTab(tab);
  };
  const saveErrorMessage = saveMutation.error?.message ?? "";
  const saveConflict = /conflict|changed outside|外部|冲突/i.test(saveErrorMessage);

  return (
    <div className="skill-detail-document">
      <header className="detail-header skill-detail-header">
        <div className="skill-title-block">
          <AgentMark agent={agent} />
          <div>
            <div className="detail-kicker">
              {agentLabels[agent]} · {t(`skills.scope.${normalizeScope(summary.scopeKind)}`)}
              {summary.managed && <span className="managed-label">{t("skills.managed")}</span>}
            </div>
            <h1>{summary.displayName || summary.name}</h1>
          </div>
        </div>
        <div className="detail-actions">
          {canToggleEnabled && (
            <button
              type="button"
              className="button secondary small"
              onClick={() => enableMutation.mutate(disabled)}
              disabled={enableMutation.isPending || saveMutation.isPending}
              title={disabled ? t("skills.enable.title") : t("skills.disable.title")}
            >
              <Power size={13} /> {enableMutation.isPending ? t("skills.common.saving") : disabled ? t("skills.enable.action") : t("skills.disable.action")}
            </button>
          )}
          {summary.managed && (
            <button
              type="button"
              className="button secondary small"
              onClick={() => void confirmRemoval()}
              disabled={removeMutation.isPending || saveMutation.isPending}
              title={t("skills.remove.locationTitle")}
            >
              <Trash2 size={13} /> {removeMutation.isPending ? t("skills.remove.inProgress") : t("skills.remove.action")}
            </button>
          )}
          {summary.readOnly ? (
            <button type="button" className="button secondary small" disabled>
              <LockKeyhole size={13} /> {t("skills.readOnly")}
            </button>
          ) : !editing && activeTab === "files" ? (
            <button
              type="button"
              className="button secondary small"
              onClick={() => {
                setDraftContent(fileContent);
                setOriginalContent(fileContent);
                setEditing(true);
                saveMutation.reset();
              }}
              disabled={fileLoading || Boolean(fileError)}
              title={t("skills.editor.editTitle")}
            >
              <Pencil size={13} /> {t("skills.editor.edit")}
            </button>
          ) : null}
          <IconButton label={t("skills.copyPath")} onClick={() => navigator.clipboard?.writeText(summary.path)}>
            <Copy size={15} />
          </IconButton>
        </div>
        <div className="skill-status-line">
          {disabled ? (
            <StateBadge tone="neutral">{t("skills.status.disabled")}</StateBadge>
          ) : (
            <StateBadge tone="success">{t("skills.status.enabled")}</StateBadge>
          )}
          {healthy ? (
            <StateBadge tone="success">
              <CheckCircle2 size={11} /> {t("skills.status.structureHealthy")}
            </StateBadge>
          ) : (
            <StateBadge tone="warning">
              <AlertTriangle size={11} /> {t("skills.status.needsAttention")}
            </StateBadge>
          )}
          {summary.riskStatus.toLocaleLowerCase() === "safe" ? (
            <StateBadge tone="accent">
              <ShieldCheck size={11} /> {t("skills.security.safe")}
            </StateBadge>
          ) : summary.riskStatus.toLocaleLowerCase() === "unscanned" ? (
            <StateBadge tone="neutral">
              <CircleSlash2 size={11} /> {t("skills.security.unscanned")}
            </StateBadge>
          ) : summary.riskStatus.toLocaleLowerCase() === "blocked" ? (
            <StateBadge tone="warning">
              <AlertTriangle size={11} /> {t("skills.security.blocked")}
            </StateBadge>
          ) : summary.riskStatus.toLocaleLowerCase() === "risky" ? (
            <StateBadge tone="warning">
              <AlertTriangle size={11} /> {t("skills.security.risky")}
            </StateBadge>
          ) : (
            <StateBadge tone="warning">
              <ShieldQuestion size={11} /> {t("skills.security.review")}
            </StateBadge>
          )}
          {summary.duplicateName && <StateBadge tone="purple">{t("skills.duplicate")}</StateBadge>}
        </div>
        <div className="skill-path" title={summary.path}>
          <Folder size={13} />
          <code>{summary.path}</code>
        </div>
        {enableMutation.isError && (
          <div className="detail-action-error"><AlertTriangle size={13} />{enableMutation.error.message}</div>
        )}
        {removeMutation.isError && (
          <div className="detail-action-error"><AlertTriangle size={13} />{removeMutation.error.message}</div>
        )}
      </header>

      <SkillDescriptionPanel skill={summary} hasUnsavedChanges={editing && isDirty} />

      <div className="detail-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={activeTab === "files" ? "active" : ""}
          aria-selected={activeTab === "files"}
          onClick={() => selectTab("files")}
        >
          {t("skills.tabs.files")} <span>{detail.files.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          className={activeTab === "risk" ? "active" : ""}
          aria-selected={activeTab === "risk"}
          onClick={() => selectTab("risk")}
        >
          {t("skills.tabs.risk")}
          {summary.riskStatus !== "unscanned" && (
            <span className={`risk-tab-dot ${summary.riskStatus}`} aria-label={t(`skills.security.${summary.riskStatus.toLocaleLowerCase()}`)} />
          )}
        </button>
      </div>

      {activeTab === "files" ? <div className="file-inspector">
        <aside className="file-tree" aria-label={t("skills.fileTree.ariaLabel")}>
          <div className="file-tree-header">
            <FolderOpen size={14} />
            <span>{summary.name}</span>
          </div>
          <FileTree files={detail.files} selected={selectedFile} onSelect={selectFile} />
          <div className="file-tree-footer">
            <ScanSearch size={13} /> {t("skills.scannedAt")} {formatRelativeTime(summary.updatedAt)}
          </div>
        </aside>

        <div className="code-preview">
          <div className="code-preview-header">
            <span>
              <FileCode2 size={14} /> {selectedFile}
            </span>
            <div className="code-header-actions">
              {savedNotice && <span className="saved-copy"><CheckCircle2 size={12} /> {t("skills.common.saved")}</span>}
              {editing ? (
                <>
                  <button type="button" onClick={requestCancelEditing} disabled={saveMutation.isPending}>
                    <X size={12} /> {t("skills.common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="save"
                    onClick={saveDraft}
                    disabled={!isDirty || saveMutation.isPending}
                  >
                    <Save size={12} /> {saveMutation.isPending ? t("skills.common.saving") : t("skills.common.save")}
                  </button>
                </>
              ) : (
                <span>{currentFile ? formatBytes(currentFile.size) : ""}</span>
              )}
            </div>
          </div>
          {saveMutation.isError && (
            <div className={`editor-error ${saveConflict ? "conflict" : ""}`} role="alert">
              <AlertTriangle size={14} />
              <div>
                <strong>{saveConflict ? t("skills.editor.externalChange") : t("skills.editor.saveFailed")}</strong>
                <span>{saveConflict ? t("skills.editor.externalChangeDescription") : saveErrorMessage}</span>
              </div>
            </div>
          )}
          {fileLoading ? (
            <div className="code-loading">
              {Array.from({ length: 9 }, (_, index) => (
                <span
                  className="skeleton"
                  key={index}
                  style={{ width: `${52 + ((index * 17) % 43)}%` }}
                />
              ))}
            </div>
          ) : fileError ? (
            <ErrorState error={fileError} onRetry={retryFile} />
          ) : editing ? (
            <textarea
              className="code-editor-textarea"
              value={draftContent}
              onChange={(event) => setDraftContent(event.currentTarget.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "s") {
                  event.preventDefault();
                  saveDraft();
                }
                if (event.key === "Escape" && !saveMutation.isPending) requestCancelEditing();
              }}
              aria-label={`${t("skills.editor.edit")} ${selectedFile}`}
              spellCheck={false}
              autoFocus
            />
          ) : (
            <CodeContent content={fileContent} language={currentFile?.kind ?? "text"} />
          )}
        </div>
      </div> : <SkillSecurityPanel skill={summary} />}
    </div>
  );
}

interface TreeNode {
  name: string;
  path: string;
  file?: SkillFile;
  children: TreeNode[];
}

function createTree(files: SkillFile[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let level = root;
    let builtPath = "";
    parts.forEach((part, index) => {
      builtPath = builtPath ? `${builtPath}/${part}` : part;
      let node = level.find((candidate) => candidate.name === part);
      if (!node) {
        node = { name: part, path: builtPath, children: [] };
        level.push(node);
      }
      if (index === parts.length - 1) node.file = file;
      level = node.children;
    });
  }
  return root.sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name));
}

function FileTree({
  files,
  selected,
  onSelect,
}: {
  files: SkillFile[];
  selected: string;
  onSelect: (path: string) => void;
}) {
  const tree = createTree(files);
  const renderNodes = (nodes: TreeNode[], depth = 0) =>
    nodes.map((node) =>
      node.file ? (
        <button
          type="button"
          key={node.path}
          className={`file-node ${selected === node.path ? "selected" : ""}`}
          style={{ paddingLeft: 10 + depth * 15 }}
          onClick={() => onSelect(node.path)}
          aria-current={selected === node.path ? "page" : undefined}
          title={node.path}
        >
          {node.file.kind === "markdown" ? <FileText size={14} /> : node.file.kind === "yaml" ? <Code2 size={14} /> : <File size={14} />}
          <span>{node.name}</span>
        </button>
      ) : (
        <div className="folder-node" key={node.path}>
          <div className="folder-label" style={{ paddingLeft: 8 + depth * 15 }}>
            <ChevronRight size={12} className="folder-chevron open" />
            <FolderOpen size={14} />
            <span>{node.name}</span>
          </div>
          {renderNodes(node.children, depth + 1)}
        </div>
      ),
    );
  return <div className="tree-nodes">{renderNodes(tree)}</div>;
}

function CodeContent({ content, language }: { content: string; language: string }) {
  const lines = content.split("\n");
  return (
    <div className="code-content" data-language={language}>
      {lines.map((line, index) => (
        <div className="code-line" key={`${index}-${line}`}>
          <span className="line-number">{index + 1}</span>
          <code>{colorizeLine(line)}</code>
        </div>
      ))}
    </div>
  );
}

function colorizeLine(line: string) {
  if (line.startsWith("#")) return <span className="syntax-heading">{line}</span>;
  if (line.startsWith("---")) return <span className="syntax-muted">{line}</span>;
  const yamlMatch = line.match(/^(\s*)([\w_-]+):(.*)$/);
  if (yamlMatch) {
    return (
      <>
        {yamlMatch[1]}
        <span className="syntax-key">{yamlMatch[2]}</span>
        <span className="syntax-muted">:</span>
        <span className="syntax-string">{yamlMatch[3]}</span>
      </>
    );
  }
  return line || " ";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}
