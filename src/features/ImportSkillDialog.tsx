import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FolderInput,
  GitBranch,
  Link2,
  Upload,
  X,
} from "lucide-react";

import { desktopApi, isTauriRuntime } from "../lib/ipc";
import { useI18n } from "../i18n/i18n";
import { useUiStore } from "../store/ui";
import type { ImportSkillRequest, Project, SkillAgentType } from "../types";

const agents: Array<{ id: SkillAgentType; label: string; short: string }> = [
  { id: "codex", label: "Codex", short: "C" },
  { id: "claude", label: "Claude Code", short: "A" },
  { id: "cursor", label: "Cursor", short: ">" },
];

export function ImportSkillDialog({
  open,
  onClose,
  project,
}: {
  open: boolean;
  onClose: () => void;
  project: Project | null;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const beginCriticalOperation = useUiStore((state) => state.beginCriticalOperation);
  const endCriticalOperation = useUiStore((state) => state.endCriticalOperation);
  const [sourcePath, setSourcePath] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<SkillAgentType[]>(["codex"]);
  const [scope, setScope] = useState<"user" | "project">("user");
  const [allowCopyFallback, setAllowCopyFallback] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const pendingRef = useRef(false);

  const request = useMemo<ImportSkillRequest>(
    () => ({
      sourcePath: sourcePath.trim(),
      targets: selectedAgents.map((agentType) => ({
        agentType,
        scopeKind: scope,
        projectId: scope === "project" ? project?.id ?? null : null,
      })),
      allowCopyFallback,
    }),
    [allowCopyFallback, project?.id, scope, selectedAgents, sourcePath],
  );

  const importMutation = useMutation({
    mutationFn: async () => {
      const operationId = `skill-import:${crypto.randomUUID()}`;
      beginCriticalOperation(operationId, t("skills.import.inProgress"));
      try {
        return await desktopApi.importSkill(request);
      } finally {
        endCriticalOperation(operationId);
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["skills"] }),
        queryClient.invalidateQueries({ queryKey: ["audit-logs"] }),
      ]);
    },
  });
  pendingRef.current = importMutation.isPending;

  useEffect(() => {
    if (!project?.trusted && scope === "project") setScope("user");
  }, [project, scope]);

  useEffect(() => {
    if (open) return;
    setSourcePath("");
    setSelectedAgents(["codex"]);
    setScope("user");
    setAllowCopyFallback(false);
    importMutation.reset();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!pendingRef.current) onClose();
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
  }, [onClose, open]);

  if (!open) return null;

  const toggleAgent = (agent: SkillAgentType) => {
    setSelectedAgents((current) =>
      current.includes(agent)
        ? current.filter((candidate) => candidate !== agent)
        : [...current, agent],
    );
  };

  const canSubmit =
    Boolean(sourcePath.trim()) &&
    selectedAgents.length > 0 &&
    (scope === "user" || Boolean(project?.trusted));
  const requestClose = () => {
    if (!importMutation.isPending) onClose();
  };

  const chooseDirectory = async () => {
    if (!isTauriRuntime) return;
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t("skills.import.chooseDirectory"),
    });
    if (typeof selected === "string") setSourcePath(selected);
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={requestClose}>
      <div
        ref={dialogRef}
        className="dialog import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-skill-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <span className="dialog-icon"><Upload size={19} /></span>
            <div>
              <h2 id="import-skill-title">{t("skills.import.title")}</h2>
              <p>{t("skills.import.description")}</p>
            </div>
          </div>
          <button type="button" className="dialog-close" onClick={requestClose} aria-label={t("skills.common.close")} disabled={importMutation.isPending}>
            <X size={17} />
          </button>
        </div>

        {importMutation.isSuccess ? (
          <div className="import-success">
            <span className="import-success-icon"><CheckCircle2 size={25} /></span>
            <h3>{importMutation.data.name} · {t("skills.import.imported")}</h3>
            <p>{t("skills.import.deployedCount", { count: importMutation.data.bindings.length })}</p>
            <div className="binding-results">
              {importMutation.data.bindings.map((binding) => (
                <div key={binding.id}>
                  <span className={`mini-agent ${binding.agentType}`}>
                    {binding.agentType === "codex" ? "C" : binding.agentType === "claude" ? "A" : ">"}
                  </span>
                  <code title={binding.linkPath}>{binding.linkPath}</code>
                  <span>{binding.linkMode}</span>
                </div>
              ))}
            </div>
            <button type="button" className="button primary" onClick={onClose} autoFocus>{t("skills.common.done")}</button>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) importMutation.mutate();
            }}
          >
            <label className="form-field">
              <span>{t("skills.import.directory")}</span>
              <div className="path-input">
                <FolderInput size={15} />
                <input
                  value={sourcePath}
                  onChange={(event) => setSourcePath(event.currentTarget.value)}
                  placeholder="D:\\Skills\\my-skill"
                  autoFocus
                  spellCheck={false}
                />
                {isTauriRuntime && (
                  <button type="button" className="path-browse-button" onClick={chooseDirectory}>
                    {t("skills.import.browse")}
                  </button>
                )}
              </div>
              <small>{t("skills.import.directoryHint")}</small>
            </label>

            <fieldset className="import-fieldset">
              <legend>{t("skills.import.targetAgents")}</legend>
              <div className="import-agent-grid">
                {agents.map((agent) => {
                  const selected = selectedAgents.includes(agent.id);
                  return (
                    <button
                      type="button"
                      key={agent.id}
                      className={selected ? "selected" : ""}
                      aria-pressed={selected}
                      onClick={() => toggleAgent(agent.id)}
                    >
                      <span className={`agent-mark ${agent.id}`}>{agent.short}</span>
                      <span>{agent.label}</span>
                      <span className="agent-check"><Check size={11} /></span>
                    </button>
                  );
                })}
              </div>
              {selectedAgents.length === 0 && <small className="field-warning">{t("skills.import.selectAgent")}</small>}
            </fieldset>

            <fieldset className="import-fieldset">
              <legend>{t("skills.import.deploymentScope")}</legend>
              <div className="scope-choice-grid">
                <button
                  type="button"
                  className={scope === "user" ? "selected" : ""}
                  onClick={() => setScope("user")}
                >
                  <span><Link2 size={15} /></span>
                  <span><strong>{t("skills.import.userScope")}</strong><small>{t("skills.import.userScopeDescription")}</small></span>
                  <span className="radio-dot" />
                </button>
                <button
                  type="button"
                  className={scope === "project" ? "selected" : ""}
                  onClick={() => project?.trusted && setScope("project")}
                  disabled={!project?.trusted}
                  title={
                    project?.trusted
                      ? project.rootPath
                      : project
                      ? t("skills.import.trustProjectFirst")
                        : t("skills.import.selectProjectFirst")
                  }
                >
                  <span><GitBranch size={15} /></span>
                  <span>
                    <strong>{project ? project.name : t("skills.import.currentProject")}</strong>
                    <small>
                      {project?.trusted
                        ? t("skills.import.projectScopeDescription")
                        : project
                          ? t("skills.import.availableAfterTrust")
                          : t("skills.import.availableAfterSelect")}
                    </small>
                  </span>
                  <span className="radio-dot" />
                </button>
              </div>
            </fieldset>

            <label className="check-field copy-fallback-field">
              <input
                type="checkbox"
                checked={allowCopyFallback}
                onChange={(event) => setAllowCopyFallback(event.currentTarget.checked)}
              />
              <span className="checkbox-visual"><Check size={12} /></span>
              <span>
                <strong>{t("skills.import.copyFallback")}</strong>
                <small>{t("skills.import.copyFallbackDescription")}</small>
              </span>
            </label>

            {allowCopyFallback && (
              <div className="copy-fallback-warning">
                <AlertTriangle size={14} /> {t("skills.import.copyFallbackWarning")}
              </div>
            )}

            {importMutation.isError && (
              <div className="form-error"><AlertTriangle size={14} />{importMutation.error.message}</div>
            )}

            <div className="dialog-footer">
              <button type="button" className="button secondary" onClick={requestClose} disabled={importMutation.isPending}>{t("skills.common.cancel")}</button>
              <button type="submit" className="button primary" disabled={!canSubmit || importMutation.isPending}>
                {importMutation.isPending ? t("skills.import.validating") : t("skills.import.actionSkill")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
