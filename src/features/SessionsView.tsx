import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Archive,
  Braces,
  CalendarClock,
  ChevronRight,
  DatabaseZap,
  Folder,
  FolderGit2,
  Inbox,
  MessageSquareText,
  Pencil,
  RefreshCw,
  Sparkles,
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
  formatDateTime,
  formatRelativeTime,
  handleRovingListKeyDown,
} from "../components/Common";
import { PaneResizeHandle } from "../components/PaneResizeHandle";
import { desktopApi } from "../lib/ipc";
import { useI18n } from "../i18n/i18n";
import { useUiStore } from "../store/ui";
import type { Project, SessionSummary } from "../types";

const SESSION_PAGE_SIZE = 100;

type SessionTreeBranch = {
  id: string;
  label: string;
  path?: string;
  sessions: SessionSummary[];
  kind: "project" | "workspace" | "unassigned";
};

type SessionAgent = SessionSummary["agentType"];

type SessionAgentGroup = {
  agent: SessionAgent;
  branches: SessionTreeBranch[];
  count: number;
};

const SESSION_AGENTS: SessionAgent[] = ["codex", "claude", "cursor"];

const SESSION_AGENT_META: Record<SessionAgent, { label: string; glyph: string }> = {
  codex: { label: "Codex", glyph: "C" },
  claude: { label: "Claude Code", glyph: "A" },
  cursor: { label: "Cursor", glyph: "◈" },
};

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function projectForSession(session: SessionSummary, projects: Project[]) {
  const cwd = session.cwd?.trim();
  if (!cwd) return undefined;
  const normalizedCwd = normalizePath(cwd);
  return projects
    .filter((project) => {
      const root = normalizePath(project.rootPath);
      return normalizedCwd === root || normalizedCwd.startsWith(`${root}/`);
    })
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
}

function workspaceLabel(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || path;
}

function groupSessionsByAgentAndWorkspace(
  sessions: SessionSummary[],
  projects: Project[],
): SessionAgentGroup[] {
  const branchesByAgent = new Map<SessionAgent, Map<string, SessionTreeBranch>>(
    SESSION_AGENTS.map((agent) => [agent, new Map()]),
  );

  for (const session of sessions) {
    const branches = branchesByAgent.get(session.agentType)!;
    const project = projectForSession(session, projects);
    if (project) {
      const key = `project:${project.id}`;
      const existing = branches.get(key) ?? {
        id: `agent:${session.agentType}:${key}`,
        label: project.name,
        path: project.rootPath,
        sessions: [],
        kind: "project" as const,
      };
      existing.sessions.push(session);
      branches.set(key, existing);
      continue;
    }

    const path = session.cwd?.trim() ?? "";
    const key = path ? normalizePath(path) : "unassigned";
    const branchKey = `workspace:${key}`;
    const existing = branches.get(branchKey) ?? {
      id: `agent:${session.agentType}:${branchKey}`,
      label: path ? workspaceLabel(path) : "",
      path: path || undefined,
      sessions: [],
      kind: path ? "workspace" as const : "unassigned" as const,
    };
    existing.sessions.push(session);
    branches.set(branchKey, existing);
  }

  return SESSION_AGENTS.map((agent) => {
    const branches = Array.from(branchesByAgent.get(agent)!.values())
      .sort((left, right) => {
        if (left.kind === "project" && right.kind !== "project") return -1;
        if (left.kind !== "project" && right.kind === "project") return 1;
        return (right.sessions[0]?.updatedAt ?? 0) - (left.sessions[0]?.updatedAt ?? 0);
      });
    return {
      agent,
      branches,
      count: branches.reduce((total, branch) => total + branch.sessions.length, 0),
    };
  });
}

function SessionRow({
  session,
  selected,
  query,
  onSelect,
  onRequestRename,
  treeItem = false,
}: {
  session: SessionSummary;
  selected: boolean;
  query: string;
  onSelect: () => void;
  onRequestRename: (session: SessionSummary, x: number, y: number) => void;
  treeItem?: boolean;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`session-row ${selected ? "selected" : ""}`}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect();
        onRequestRename(session, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === "F2" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          onRequestRename(session, 32, 96);
          return;
        }
        handleRovingListKeyDown(event);
      }}
      role={treeItem ? "treeitem" : "option"}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-roving-item
    >
      <div className="session-row-topline">
        <span className="session-title">
          <HighlightText text={session.title} query={query} />
        </span>
        <time>{formatRelativeTime(session.updatedAt)}</time>
      </div>
      <p>
        <HighlightText text={session.preview} query={query} />
      </p>
      <div className="row-metadata">
        <span className={`source-chip ${session.agentType}`}>
          <Sparkles size={11} /> {SESSION_AGENT_META[session.agentType].label}
        </span>
        {session.archived && (
          <span>
            <Archive size={11} /> {t("sessions.archived")}
          </span>
        )}
        {session.cwd && (
          <span className="row-path" title={session.cwd}>
            {compactPath(session.cwd, 35)}
          </span>
        )}
      </div>
    </button>
  );
}

function SessionTreeBranch({
  branch,
  selectedSessionId,
  query,
  onSelect,
  onRequestRename,
  collapsed,
  onToggle,
  unassignedLabel,
}: {
  branch: SessionTreeBranch;
  selectedSessionId: string | null;
  query: string;
  onSelect: (id: string) => void;
  onRequestRename: (session: SessionSummary, x: number, y: number) => void;
  collapsed: boolean;
  onToggle: () => void;
  unassignedLabel: string;
}) {
  const label = branch.kind === "unassigned" ? unassignedLabel : branch.label;
  const BranchIcon = branch.kind === "project" ? FolderGit2 : Folder;
  return (
    <div className="session-tree-branch" role="group">
      <button
        type="button"
        className="session-tree-toggle"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={branch.path ?? label}
      >
        <ChevronRight className={collapsed ? "" : "expanded"} size={14} aria-hidden="true" />
        <BranchIcon size={15} aria-hidden="true" />
        <span>{label}</span>
        <small>{branch.sessions.length}</small>
      </button>
      {!collapsed && (
        <div className="session-tree-children" role="group">
          {branch.sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={session.id === selectedSessionId}
              query={query}
              treeItem
              onSelect={() => onSelect(session.id)}
              onRequestRename={onRequestRename}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionAgentTreeGroup({
  group,
  selectedSessionId,
  query,
  collapsedNodes,
  onToggleNode,
  onSelect,
  onRequestRename,
  unassignedLabel,
  emptyLabel,
}: {
  group: SessionAgentGroup;
  selectedSessionId: string | null;
  query: string;
  collapsedNodes: Set<string>;
  onToggleNode: (id: string) => void;
  onSelect: (id: string) => void;
  onRequestRename: (session: SessionSummary, x: number, y: number) => void;
  unassignedLabel: string;
  emptyLabel: string;
}) {
  const nodeId = `agent:${group.agent}`;
  const collapsed = collapsedNodes.has(nodeId);
  const meta = SESSION_AGENT_META[group.agent];
  return (
    <section className="session-agent-group" data-agent={group.agent}>
      <button
        type="button"
        className="session-agent-toggle"
        onClick={() => onToggleNode(nodeId)}
        aria-expanded={!collapsed}
      >
        <ChevronRight className={collapsed ? "" : "expanded"} size={14} aria-hidden="true" />
        <span className={`agent-mark ${group.agent}`}>{meta.glyph}</span>
        <strong>{meta.label}</strong>
        <small>{group.count}</small>
      </button>
      {!collapsed && <div className="session-agent-children" role="group">
        {group.branches.length ? group.branches.map((branch) => (
          <SessionTreeBranch
            key={branch.id}
            branch={branch}
            selectedSessionId={selectedSessionId}
            query={query}
            onSelect={onSelect}
            onRequestRename={onRequestRename}
            collapsed={collapsedNodes.has(branch.id)}
            onToggle={() => onToggleNode(branch.id)}
            unassignedLabel={unassignedLabel}
          />
        )) : <p className="session-agent-empty">{emptyLabel}</p>}
      </div>}
    </section>
  );
}

export function SessionsView({ project, projects }: { project: Project | null; projects: Project[] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const {
    sessionQuery,
    setSessionQuery,
    sessionArchiveFilter,
    setSessionArchiveFilter,
    selectedSessionId,
    setSelectedSessionId,
  } = useUiStore();
  const deferredQuery = useDeferredValue(sessionQuery);
  const [indexMessage, setIndexMessage] = useState<string | null>(null);
  const [collapsedTreeNodes, setCollapsedTreeNodes] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<{ session: SessionSummary; x: number; y: number } | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const lastScrollSyncAt = useRef(0);

  const sessionsQuery = useInfiniteQuery({
    queryKey: ["sessions", deferredQuery, sessionArchiveFilter, project?.rootPath ?? "all"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      desktopApi.searchSessions({
        query: deferredQuery,
        archived:
          sessionArchiveFilter === "all" ? null : sessionArchiveFilter === "archived",
        cwd: project?.rootPath ?? null,
        limit: SESSION_PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage, pages) =>
      lastPage.length === SESSION_PAGE_SIZE
        ? pages.reduce((total, page) => total + page.length, 0)
        : undefined,
    placeholderData: keepPreviousData,
  });

  const sessions = sessionsQuery.data?.pages.flat() ?? [];
  const sessionTree = useMemo(
    () => groupSessionsByAgentAndWorkspace(sessions, project ? [project] : projects),
    [project, projects, sessions],
  );
  const visibleAgentGroups = sessionTree.filter((group) => group.count > 0);

  const toggleTreeBranch = (id: string) => {
    setCollapsedTreeNodes((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    if (!sessions.length) {
      if (selectedSessionId) setSelectedSessionId(null);
      return;
    }
    if (!selectedSessionId || !sessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(sessions[0].id);
    }
  }, [sessions, selectedSessionId, setSelectedSessionId]);

  const detailQuery = useQuery({
    queryKey: ["session", selectedSessionId],
    queryFn: () => desktopApi.getSession(selectedSessionId as string),
    enabled: Boolean(selectedSessionId),
  });

  const indexMutation = useMutation({
    mutationFn: desktopApi.indexSessions,
    onSuccess: async (count) => {
      setIndexMessage(t(count === 1 ? "sessions.index.updated.one" : "sessions.index.updated.many", { count }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["audit-logs"] }),
      ]);
      window.setTimeout(() => setIndexMessage(null), 3200);
    },
  });

  const renameMutation = useMutation({
    mutationFn: () => desktopApi.renameSession({ id: renameTarget!.id, title: renameTitle }),
    onSuccess: async (summary) => {
      setIndexMessage(t("sessions.rename.success"));
      setRenameTarget(null);
      setContextMenu(null);
      queryClient.setQueryData(["session", summary.id], (current: Awaited<ReturnType<typeof desktopApi.getSession>> | undefined) =>
        current ? { ...current, summary } : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["session", summary.id] }),
        queryClient.invalidateQueries({ queryKey: ["audit-logs"] }),
      ]);
      window.setTimeout(() => setIndexMessage(null), 3200);
    },
  });

  const requestRenameMenu = (session: SessionSummary, x: number, y: number) => {
    setContextMenu({
      session,
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 190)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 90)),
    });
  };

  const openRenameDialog = (session: SessionSummary) => {
    if (!session.canRename) return;
    setRenameTarget(session);
    setRenameTitle(session.title);
    setContextMenu(null);
    renameMutation.reset();
  };

  const normalizedRenameTitle = renameTitle.trim();
  const renameValidationKey = !normalizedRenameTitle
    ? "sessions.rename.validation.empty"
    : normalizedRenameTitle.length > 120 || /[\r\n\u0000-\u001f\u007f]/.test(normalizedRenameTitle)
      ? "sessions.rename.validation.tooLong"
      : null;

  const loadNextPageOnScroll = (scrollTop: number, clientHeight: number, scrollHeight: number) => {
    const nearEnd = scrollHeight - scrollTop - clientHeight < 160;
    if (!nearEnd) return;
    if (sessionsQuery.hasNextPage && !sessionsQuery.isFetchingNextPage) {
      void sessionsQuery.fetchNextPage();
    }
    // Reaching the end is the natural desktop equivalent of pull-to-refresh.
    // Keep it silent and rate-limited so a user can browse long histories
    // without repeatedly rescanning every Codex rollout file.
    if (Date.now() - lastScrollSyncAt.current >= 15_000) {
      lastScrollSyncAt.current = Date.now();
      void desktopApi.indexSessions()
        .then(() => queryClient.invalidateQueries({ queryKey: ["sessions"] }))
        .catch(() => {
          lastScrollSyncAt.current = 0;
        });
    }
  };

  return (
    <div className="workspace-split">
      <section id="session-list-pane" className="list-pane" aria-label={t("sessions.list.aria")}>
        <div className="pane-header">
          <div>
            <div className="heading-with-count">
              <h2>{t("sessions.title")}</h2>
              {!sessionsQuery.isLoading && (
                <span title={sessionsQuery.hasNextPage ? t("sessions.count.more") : t("sessions.count.all")}>
                  {sessions.length}{sessionsQuery.hasNextPage ? "+" : ""}
                </span>
              )}
            </div>
          </div>
          <IconButton
            label={t("sessions.index.rebuild")}
            onClick={() => indexMutation.mutate()}
            disabled={indexMutation.isPending}
          >
            {indexMutation.isPending ? (
              <RefreshCw className="spin" size={16} />
            ) : (
              <DatabaseZap size={16} />
            )}
          </IconButton>
        </div>

        <div className="pane-controls">
          <SearchField
            value={sessionQuery}
            onChange={setSessionQuery}
            placeholder={t("sessions.search.placeholder")}
          />
          <div className="segmented-control compact" aria-label={t("sessions.archiveFilter.aria")}>
            {(
              [
                ["active", t("sessions.archiveFilter.active")],
                ["archived", t("sessions.archiveFilter.archived")],
                ["all", t("sessions.archiveFilter.all")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={sessionArchiveFilter === value ? "active" : ""}
                aria-pressed={sessionArchiveFilter === value}
                onClick={() => setSessionArchiveFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {indexMessage && <div className="toast-inline">{indexMessage}</div>}
          {indexMutation.isError && (
            <div className="toast-inline error">{t("sessions.index.failed")}</div>
          )}
          {sessionsQuery.isFetching && !sessionsQuery.isLoading && !sessionsQuery.isFetchingNextPage && (
            <div className="list-query-status" role="status">{t("sessions.results.updating")}</div>
          )}
        </div>

        <div
          className="list-scroll"
          onScroll={(event) => loadNextPageOnScroll(
            event.currentTarget.scrollTop,
            event.currentTarget.clientHeight,
            event.currentTarget.scrollHeight,
          )}
        >
          {sessionsQuery.isLoading ? (
            <SkeletonRows count={6} />
          ) : sessionsQuery.isError ? (
            <ErrorState error={sessionsQuery.error} onRetry={() => sessionsQuery.refetch()} />
          ) : sessions.length === 0 ? (
            <EmptyState
              icon={<Inbox size={23} />}
              title={sessionQuery ? t("sessions.empty.noMatches") : t("sessions.empty.none")}
              description={
                sessionQuery
                  ? t("sessions.empty.searchHint")
                  : sessionArchiveFilter === "archived"
                    ? t("sessions.empty.noArchived")
                    : t("sessions.empty.indexHint")
              }
              action={
                !sessionQuery && sessionArchiveFilter !== "archived" ? (
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => indexMutation.mutate()}
                    disabled={indexMutation.isPending}
                  >
                    {indexMutation.isPending ? t("sessions.index.building") : t("sessions.index.build")}
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div
              className="result-list session-tree"
              role="tree"
              aria-label={t("sessions.results.aria")}
              data-roving-list
            >
              {visibleAgentGroups.map((group) => (
                <SessionAgentTreeGroup
                  key={group.agent}
                  group={group}
                  selectedSessionId={selectedSessionId}
                  query={deferredQuery}
                  collapsedNodes={collapsedTreeNodes}
                  onToggleNode={toggleTreeBranch}
                  onSelect={setSelectedSessionId}
                  onRequestRename={requestRenameMenu}
                  unassignedLabel={t("sessions.tree.unassigned")}
                  emptyLabel={t("sessions.agent.empty")}
                />
              ))}
              {sessionsQuery.hasNextPage && (
                <button
                  type="button"
                  className="load-more-row"
                  onClick={() => void sessionsQuery.fetchNextPage()}
                  disabled={sessionsQuery.isFetchingNextPage}
                >
                  {sessionsQuery.isFetchingNextPage ? t("sessions.results.loadingMore") : t("sessions.results.loadMore")}
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      <PaneResizeHandle
              storageKey="skills-manager:session-list-width"
        defaultWidth={400}
        controls="session-list-pane session-detail-pane"
        label={t("sessions.resizeHandle")}
      />

      <section id="session-detail-pane" className="detail-pane" aria-label={t("sessions.detail.aria")}>
        {!selectedSessionId ? (
          <EmptyState
            icon={<MessageSquareText size={25} />}
            title={t("sessions.detail.selectTitle")}
            description={t("sessions.detail.selectDescription")}
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
          <SessionDetailContent
            detail={detailQuery.data}
            query={deferredQuery}
          />
        ) : null}
      </section>

      {contextMenu && (
        <>
          <button
            type="button"
            className="session-context-menu-backdrop"
            aria-label={t("sessions.rename.cancel")}
            onClick={() => setContextMenu(null)}
          />
          <div
            className="session-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            data-agent={contextMenu.session.agentType}
          >
            <button
              type="button"
              role="menuitem"
              disabled={!contextMenu.session.canRename}
              title={!contextMenu.session.canRename ? t("sessions.rename.unsupported") : undefined}
              onClick={() => openRenameDialog(contextMenu.session)}
            >
              <Pencil size={14} />
              <span>{t("sessions.rename.action")}</span>
            </button>
            {!contextMenu.session.canRename && (
              <small>{t("sessions.rename.unsupported")}</small>
            )}
          </div>
        </>
      )}

      {renameTarget && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !renameMutation.isPending) {
              setRenameTarget(null);
            }
          }}
        >
          <div className="dialog session-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="session-rename-title">
            <div className="dialog-header">
              <div>
                <span className={`agent-mark ${renameTarget.agentType}`}>
                  {SESSION_AGENT_META[renameTarget.agentType].glyph}
                </span>
                <div>
                  <h2 id="session-rename-title">{t("sessions.rename.title")}</h2>
                  <p>{t("sessions.rename.description", { agent: SESSION_AGENT_META[renameTarget.agentType].label })}</p>
                </div>
              </div>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!renameValidationKey && !renameMutation.isPending) renameMutation.mutate();
              }}
            >
              <label className="form-field">
                <span>{t("sessions.rename.label")}</span>
                <input
                  autoFocus
                  value={renameTitle}
                  maxLength={121}
                  onChange={(event) => setRenameTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && !renameMutation.isPending) setRenameTarget(null);
                  }}
                  aria-invalid={Boolean(renameValidationKey)}
                />
              </label>
              {renameValidationKey && <p className="form-error">{t(renameValidationKey)}</p>}
              {renameMutation.isError && <p className="form-error">{t("sessions.rename.failed")}</p>}
              <div className="dialog-footer">
                <button
                  type="button"
                  className="button secondary"
                  disabled={renameMutation.isPending}
                  onClick={() => setRenameTarget(null)}
                >
                  {t("sessions.rename.cancel")}
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={Boolean(renameValidationKey) || renameMutation.isPending || normalizedRenameTitle === renameTarget.title}
                >
                  {renameMutation.isPending ? t("sessions.rename.saving") : t("sessions.rename.save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionDetailContent({
  detail,
  query,
}: {
  detail: Awaited<ReturnType<typeof desktopApi.getSession>>;
  query: string;
}) {
  const { t } = useI18n();
  const meta = SESSION_AGENT_META[detail.summary.agentType];
  return (
    <div className="detail-document">
      <header className="detail-header session-detail-header">
        <div className="detail-kicker">
          <span className={`agent-mark ${detail.summary.agentType}`}>{meta.glyph}</span>
          {t("sessions.detail.agentSession", { agent: meta.label })}
          {detail.summary.archived && <StateBadge tone="neutral">{t("sessions.archived")}</StateBadge>}
        </div>
        <h1>
          <HighlightText text={detail.summary.title} query={query} />
        </h1>
        <div className="detail-subline">
          <span title={formatDateTime(detail.summary.updatedAt)}>
            <CalendarClock size={14} /> {t("sessions.detail.updated", { time: formatRelativeTime(detail.summary.updatedAt) })}
          </span>
          {detail.summary.cwd && (
            <span title={detail.summary.cwd}>
              <Folder size={14} /> {compactPath(detail.summary.cwd, 48)}
            </span>
          )}
        </div>
      </header>

      <div className="detail-tabs" role="tablist">
        <button type="button" className="active" role="tab" aria-selected="true">
          {t("sessions.detail.conversation")}
        </button>
        <button type="button" role="tab" aria-selected="false" disabled>
          {t("sessions.detail.metadata")}
        </button>
      </div>

      <div className="conversation-body">
        <div className="conversation-copy">
          <HighlightText text={detail.content} query={query} />
        </div>
      </div>

      <footer className="source-footer">
        <Braces size={14} />
        <span>{t("sessions.detail.localSource")}</span>
        <code title={detail.filePath}>{compactPath(detail.filePath, 76)}</code>
      </footer>
    </div>
  );
}
