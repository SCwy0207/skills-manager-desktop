import { useDeferredValue, useEffect, useState } from "react";
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
  DatabaseZap,
  Folder,
  Inbox,
  MessageSquareText,
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

function SessionRow({
  session,
  selected,
  query,
  onSelect,
}: {
  session: SessionSummary;
  selected: boolean;
  query: string;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`session-row ${selected ? "selected" : ""}`}
      onClick={onSelect}
      onKeyDown={handleRovingListKeyDown}
      role="option"
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
        <span className="source-chip">
          <Sparkles size={11} /> Codex
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

export function SessionsView({ project }: { project: Project | null }) {
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
            <p>{project ? project.name : t("sessions.allLocal")}</p>
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

        <div className="list-scroll">
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
            <div className="result-list" role="listbox" aria-label={t("sessions.results.aria")} data-roving-list>
              {sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={session.id === selectedSessionId}
                  query={deferredQuery}
                  onSelect={() => setSelectedSessionId(session.id)}
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
  return (
    <div className="detail-document">
      <header className="detail-header session-detail-header">
        <div className="detail-kicker">
          <span className="agent-mark codex">C</span>
          {t("sessions.detail.codexSession")}
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
