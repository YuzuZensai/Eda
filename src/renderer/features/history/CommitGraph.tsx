import { errorAction, errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { defaultGraphColumns } from "@shared/preferences/graph-view";
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  GitCommitHorizontalIcon as GitCommitHorizontal,
} from "../../components/ui/icons";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { PanelHeader } from "../../components/layout/PanelHeader";
import { usePanel } from "../../components/layout/hooks/usePanel";
import { VirtualRows } from "../../components/ui/display/VirtualRows";
import { LoadingContent, Skeleton } from "../../components/ui/feedback/Skeleton";
import { ErrorDialog, IconButton, TextButton } from "../../components/ui/index";
import { layoutCommitPages } from "../../repository/dag-layout";
import { ROW_HEIGHT, graphColumnWidth } from "../../repository/graph-geometry";
import { useRepositoryStore } from "../../stores/repository-store";
import { usePreferencesStore } from "../../stores/preferences-store";
import { useSessionStore } from "../../stores/session-store";
import type { CommitMenuTarget } from "./CommitMenu";
import { CommitRow } from "./CommitRow";
import { GraphColumnsDialog } from "./GraphColumnsDialog";

const CommitMenu = lazy(() =>
  import("../repository-dialogs").then((module) => ({ default: module.CommitMenu })),
);

const GraphFilterDialog = lazy(() =>
  import("../repository-dialogs").then((module) => ({ default: module.GraphFilterDialog })),
);

export function CommitGraph({ pending = false }: { pending?: boolean }) {
  const repositoryId = useRepositoryStore((state) => state.repositoryId);
  const identityId = useRepositoryStore((state) => state.identityId);
  const vigilantMode = usePreferencesStore((state) => state.values.vigilantMode.value);

  const savedColumns = useSessionStore((state) =>
    repositoryId ? state.snapshot?.session.views[repositoryId]?.graphColumns : undefined,
  );

  const columns = savedColumns ?? defaultGraphColumns();
  const shaColumnShown = columns.some((column) => column.id === "sha" && column.visible);
  const shaHeader = useRef<HTMLSpanElement>(null);
  const [shaColumnVisible, setShaColumnVisible] = useState(false);

  useEffect(() => {
    const header = shaHeader.current;
    if (!vigilantMode || !shaColumnShown || !header) {
      setShaColumnVisible(false);
      return;
    }

    // Follow the column's container-query visibility without duplicating its CSS breakpoint.
    const observer = new ResizeObserver(([entry]) => {
      setShaColumnVisible(!!entry && entry.contentRect.width > 0 && entry.contentRect.height > 0);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [vigilantMode, shaColumnShown]);

  const [columnsOpen, setColumnsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  const graphFilter = useSessionStore((state) =>
    repositoryId ? state.snapshot?.session.views[repositoryId]?.graphFilter : undefined,
  );

  const dagBoundary = useRepositoryStore((state) => state.dagBoundary);
  const hoveredRefOid = useRepositoryStore((state) => state.hoveredRefOid);
  const pages = useRepositoryStore((state) => state.pages);
  const status = useRepositoryStore((state) => state.status);
  const selection = useRepositoryStore((state) => state.selection);
  const selectCommit = useRepositoryStore((state) => state.selectCommit);
  const historyTip = useRepositoryStore((state) => state.historyTip);
  const navigationIndex = useRepositoryStore((state) => state.navigationIndex);
  const navigationLength = useRepositoryStore((state) => state.navigation.length);
  const navigate = useRepositoryStore((state) => state.navigate);
  const loadMore = useRepositoryStore((state) => state.loadMore);
  const historyLoading = useRepositoryStore((state) => state.historyLoading);
  const nextOffset = useRepositoryStore((state) => state.nextOffset);
  const baseOffset = useRepositoryStore((state) => state.baseOffset);
  const loadPrevious = useRepositoryStore((state) => state.loadPrevious);
  const historyError = useRepositoryStore((state) => state.historyError);
  const panel = usePanel("graph");
  const [menu, setMenu] = useState<CommitMenuTarget | null>(null);

  const rows = useMemo(
    () =>
      layoutCommitPages(
        pages.map((page) => page.commits),
        dagBoundary,
      ),
    [pages, dagBoundary],
  );

  const gutter = useMemo(() => graphColumnWidth(rows), [rows]);

  const selectedIndex =
    selection?.kind === "commit" ? rows.findIndex((row) => row.commit.oid === selection.oid) : -1;

  return (
    <section
      data-tour="history"
      data-testid="commit-graph"
      className="app-surface-panel @container flex h-full w-full min-h-0 min-w-0 flex-col"
      tabIndex={0}
      aria-label={t("commitGraph.commitHistoryUseUpAndDownToSelect")}
      onKeyDown={(event) => {
        if (pending) return;
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
          return;
        if (event.altKey || event.metaKey || event.ctrlKey) return;

        const index =
          event.key === "ArrowDown"
            ? Math.min(rows.length - 1, selectedIndex + 1)
            : event.key === "ArrowUp"
              ? Math.max(0, selectedIndex - 1)
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? rows.length - 1
                  : -1;

        if (index >= 0 && rows[index]) {
          event.preventDefault();
          void selectCommit(rows[index].commit.oid);
        }

        if (
          (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) &&
          selectedIndex >= 0
        ) {
          event.preventDefault();

          const bounds = event.currentTarget.getBoundingClientRect();

          setMenu({
            oid: rows[selectedIndex]!.commit.oid,
            x: bounds.left + 40,
            y: bounds.top + 60,
          });
        }
      }}
    >
      <PanelHeader
        title={t("commitGraph.history")}
        controls={{
          name: t("commitGraph.historyLabel"),
          state: panel.state,
          onToggleMaximize: panel.toggleMaximize,
          onToggleCollapse: panel.toggleCollapse,
          collapseDirection: "up",
        }}
      >
        <IconButton
          size="xs"
          aria-label={t("commitGraph.backInSelectionHistory")}
          title={t("common.back")}
          disabled={pending || navigationIndex <= 0}
          onClick={() => void navigate(-1)}
          icon={<ArrowLeft size={14} aria-hidden="true" />}
        />

        <IconButton
          size="xs"
          aria-label={t("commitGraph.forwardInSelectionHistory")}
          title={t("commitGraph.forward")}
          disabled={pending || navigationIndex + 1 >= navigationLength}
          onClick={() => void navigate(1)}
          icon={<ArrowRight size={14} aria-hidden="true" />}
        />

        <TextButton
          aria-label={t("commitGraph.jumpToHead")}
          disabled={pending || !status?.branch.oid}
          onClick={() => {
            if (status?.branch.oid)
              void useRepositoryStore.getState().jumpToCommit(status.branch.oid);
          }}
        >
          {t("commitGraph.head")}
        </TextButton>

        <TextButton disabled={pending} onClick={() => setFilterOpen(true)}>
          {graphFilter?.refs.length || graphFilter?.hiddenRefs.length
            ? t("commitGraph.filteredGraph")
            : t("commitGraph.allBranches")}
        </TextButton>

        <span className="mono ml-auto text-xs text-text-tertiary">
          {pending ? (
            <Skeleton className="w-16" />
          ) : rows.length ? (
            t("commitGraph.to", { value1: baseOffset + 1, value2: baseOffset + rows.length })
          ) : (
            t("commitGraph.noCommits")
          )}

          {pending || nextOffset === null ? "" : "+"}
        </span>

        <TextButton disabled={pending} onClick={() => setColumnsOpen(true)}>
          {t("commitGraph.columns")}
        </TextButton>
      </PanelHeader>

      <div
        role="row"
        className="app-surface-chrome flex h-6 shrink-0 items-center border-b border-border-subtle bg-bg-surface text-xs font-medium uppercase tracking-wide text-text-tertiary"
      >
        <span className="shrink-0" style={{ width: gutter }} />

        <div className="flex min-w-0 flex-1 items-center gap-3 pr-3">
          <span className="min-w-0 flex-1 truncate">{t("commitGraph.commit")}</span>

          {columns
            .filter((column) => column.visible)
            .map((column) => (
              <span
                key={column.id}
                ref={column.id === "sha" ? shaHeader : undefined}
                style={{ width: column.width }}
                className="hidden shrink-0 truncate @xl:block"
              >
                {column.id}
              </span>
            ))}
        </div>
      </div>

      {pending ? (
        <LoadingContent label={t("commitGraph.loadingHistory")} rows={12} />
      ) : (
        <>
          {historyError && (
            <ErrorDialog
              title={t("commitGraph.couldNotLoadHistory")}
              actions={
                <TextButton onClick={() => void useRepositoryStore.getState().refresh()}>
                  {t("commitGraph.retryHistory")}
                </TextButton>
              }
            >
              <p>{errorMessage(historyError)}</p>
              <p>{errorAction(historyError)}</p>
            </ErrorDialog>
          )}

          {historyTip && (
            <p className="px-3 py-1 text-xs text-text-tertiary">
              {t("commitGraph.ancestryOf", { historyTip: historyTip.slice(0, 8) })}

              <TextButton
                className="underline"
                onClick={() => void useRepositoryStore.getState().refresh()}
              >
                {t("commitGraph.returnToSavedGraphView")}
              </TextButton>
            </p>
          )}

          {rows.some((row) => row.topologyUnavailable) && (
            <p role="status" className="px-3 py-1 text-xs text-git-modified">
              {t("commitGraph.thisHistoryExceeds512SimultaneousGraphLanesParentRelationships")}
            </p>
          )}

          {rows.length === 0 && !historyError && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-sm text-text-tertiary">
              <GitCommitHorizontal size={22} />
              <p>{t("commitGraph.noCommitsYet")}</p>
              <p className="text-xs">{t("commitGraph.stageChangesToCreateTheFirstCommit")}</p>
            </div>
          )}

          <VirtualRows
            scrollKey={`${identityId}:${repositoryId}:graph`}
            horizontalScroll={false}
            revealIndex={selectedIndex >= 0 ? baseOffset + selectedIndex : undefined}
            items={rows}
            rowHeight={ROW_HEIGHT}
            itemOffset={baseOffset}
            totalCount={nextOffset ?? baseOffset + rows.length}
            className="min-h-0 flex-1"
            {...(nextOffset !== null && !historyLoading
              ? { onNearEnd: () => void loadMore() }
              : {})}
            {...(baseOffset > 0 && !historyLoading
              ? { onNearStart: () => void loadPrevious() }
              : {})}
            renderRow={(row) => (
              <CommitRow
                key={row.commit.oid}
                row={row}
                columns={columns}
                gutter={gutter}
                selected={selection?.kind === "commit" && selection.oid === row.commit.oid}
                related={hoveredRefOid === row.commit.oid}
                vigilantMode={vigilantMode && shaColumnVisible}
                onSelect={() => void selectCommit(row.commit.oid)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ oid: row.commit.oid, x: event.clientX, y: event.clientY });
                }}
              />
            )}
          />

          {menu && (
            <Suspense fallback={null}>
              <CommitMenu target={menu} onClose={() => setMenu(null)} />
            </Suspense>
          )}

          {filterOpen && repositoryId && (
            <Suspense fallback={null}>
              <GraphFilterDialog repositoryId={repositoryId} onClose={() => setFilterOpen(false)} />
            </Suspense>
          )}

          {columnsOpen && repositoryId && (
            <GraphColumnsDialog
              repositoryId={repositoryId}
              columns={columns}
              onClose={() => setColumnsOpen(false)}
            />
          )}
        </>
      )}
    </section>
  );
}
