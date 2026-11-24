import { lazyRepositoryDialog } from "../repository-dialogs.lazy";
import { errorAction, errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  DiffIcon,
  SearchIcon,
  CircleDashedIcon,
  GitCommitHorizontalIcon as GitCommitHorizontal,
} from "../../components/ui/icons";
import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type Ref,
} from "react";
import { PanelHeader } from "../../components/layout/PanelHeader";
import { usePanel } from "../../components/layout/hooks/usePanel";
import { useLayoutTransition } from "../../components/layout/hooks/useLayoutTransition";
import { VirtualRows } from "../../components/ui/display/VirtualRows";
import { Skeleton } from "../../components/ui/feedback/Skeleton";
import { ButtonBase, ErrorDialog, IconButton, TextButton } from "../../components/ui/index";
import { layoutCommitPages } from "../../repository/dag-layout";
import { ROW_HEIGHT, graphColumnWidth } from "../../repository/graph-geometry";
import { useRepositoryStore } from "../../stores/repository-store";
import { usePreferencesStore } from "../../stores/preferences-store";
import { useLayoutStore } from "../../stores/layout-store";
import type { CommitMenuTarget } from "./CommitMenu";
import { CommitRow, WorkingTreeRow } from "./CommitRow";
import { showOpenedRepository } from "../../repository/hooks/useRepositoryNavigation";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { useGraphColumns } from "./useGraphColumns";
import { GraphVisibilityMenu } from "./GraphVisibilityMenu";
import { useCommitMessage } from "../../repository/hooks/useCommitMessage";

const HistorySearch = lazyRepositoryDialog("HistorySearch");
const HistoryRecoveryDialog = lazyRepositoryDialog("HistoryRecoveryDialog");
const CommitMenu = lazyRepositoryDialog("CommitMenu");

const GraphFilterDialog = lazyRepositoryDialog("GraphFilterDialog");

export function CommitGraph({
  pending = false,
  ref,
}: {
  pending?: boolean;
  ref?: Ref<HTMLElement>;
}) {
  const repositoryId = useRepositoryStore((state) => state.repositoryId);
  const identityId = useRepositoryStore((state) => state.identityId);
  const vigilantMode = usePreferencesStore((state) => state.values.vigilantMode.value);

  const {
    columns,
    startResize,
    saveWidth,
    moveColumn,
    startReorder,
    previewReorder,
    finishReorder,
    cancelReorder,
    dropTarget,
  } = useGraphColumns(repositoryId, pending);
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

  const [searchOpen, setSearchOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  const dagBoundary = useRepositoryStore((state) => state.dagBoundary);
  const hoveredRefOid = useRepositoryStore((state) => state.hoveredRefOid);
  const pages = useRepositoryStore((state) => state.pages);
  const status = useRepositoryStore((state) => state.status);
  const linkedRequest = useMemo(
    () => (repositoryId && status && !pending ? { repositoryId, status } : null),
    [repositoryId, status, pending],
  );
  const worktrees = useRepositoryRead(
    (request: { repositoryId: string }) => window.eda.repository.worktrees(request.repositoryId),
    linkedRequest,
  );
  const [worktreeError, setWorktreeError] = useState("");
  const linkedChanges = worktrees.value?.filter(
    (entry) => !entry.current && entry.available && !!entry.changedPaths,
  );
  const openLinkedChanges = async (path: string) => {
    if (!repositoryId || !identityId) return;
    try {
      const opened = await window.eda.repository.open(path);
      if (!opened.ok) throw opened.error;
      if (await showOpenedRepository(opened.value, identityId, repositoryId))
        useRepositoryStore.getState().showWorkingTree();
    } catch (error) {
      setWorktreeError(errorMessage(error));
    }
  };
  const linkedByOid = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const entry of worktrees.value ?? []) {
      if (entry.current || entry.bare || !entry.oid) continue;
      const label = t(
        entry.changedPaths === undefined ? "worktrees.graphLocation" : "worktrees.graphChanges",
        { path: entry.path, count: entry.changedPaths ?? 0 },
      );
      const previous = result.get(entry.oid);
      if (previous) previous.push(label);
      else result.set(entry.oid, [label]);
    }
    return result;
  }, [worktrees.value]);
  const selection = useRepositoryStore((state) => state.selection);
  const selectCommit = useRepositoryStore((state) => state.selectCommit);
  const showWorkingTree = useRepositoryStore((state) => state.showWorkingTree);
  const truncatedChanges = useRepositoryStore((state) => state.truncatedChanges);
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
  const canPage = !historyLoading && !historyError;
  const panel = usePanel("graph");
  const transitionLayout = useLayoutTransition();
  const [menu, setMenu] = useState<CommitMenuTarget | null>(null);

  const rows = useMemo(
    () =>
      layoutCommitPages(
        pages.map((page) => page.commits),
        dagBoundary,
      ),
    [pages, dagBoundary],
  );

  const childrenByParent = useMemo(() => {
    const children = new Map<string, string[]>();
    for (const { commit } of rows) {
      for (const parent of commit.parents) {
        const siblings = children.get(parent);
        if (siblings) siblings.push(commit.oid.slice(0, 8));
        else children.set(parent, [commit.oid.slice(0, 8)]);
      }
    }
    return children;
  }, [rows]);

  const rowHeight = usePreferencesStore((state) =>
    state.values.compactHistory.value ? 24 : ROW_HEIGHT,
  );
  const avatars = usePreferencesStore((state) => state.values.historyAvatars.value);
  const dateStyle = usePreferencesStore((state) => state.values.historyDateStyle.value);
  const workingRowCount = status?.changes.length ? 1 : 0;
  const graphRows = useMemo(
    () => (workingRowCount && baseOffset === 0 ? [null, ...rows] : rows),
    [rows, workingRowCount, baseOffset],
  );
  const workingConnection = useMemo(() => {
    if (!workingRowCount || baseOffset > 0 || !status?.branch.oid) return null;
    const headIndex = rows.findIndex((row) => row.commit.oid === status.branch.oid);
    if (headIndex < 0 || rows.slice(0, headIndex + 1).some((row) => row.topologyUnavailable))
      return null;

    const lane = headIndex === 0 ? rows[0]!.lane : Math.max(...rows.map((row) => row.laneCount));
    return { lane, headIndex };
  }, [rows, workingRowCount, baseOffset, status?.branch.oid]);
  const gutter = useMemo(
    () => graphColumnWidth(rows, workingConnection ? workingConnection.lane + 1 : 1),
    [rows, workingConnection],
  );
  const graphOffset = baseOffset > 0 ? baseOffset + workingRowCount : 0;

  let selectedIndex = workingRowCount && baseOffset === 0 ? 0 : -1;
  if (selection?.kind === "commit")
    selectedIndex = graphRows.findIndex((row) => row?.commit.oid === selection.oid);

  const selectWorkingTree = () => {
    showWorkingTree();

    const layout = useLayoutStore.getState();
    if (!layout.collapsed.rail && layout.maximized !== "graph") return;

    transitionLayout(() => {
      if (layout.collapsed.rail) layout.toggleCollapse("rail");
      if (layout.maximized === "graph") layout.toggleMaximize("graph");
    });
  };

  return (
    <section
      ref={ref}
      data-tour="history"
      data-testid="commit-graph"
      className="history app-surface-panel @container flex h-full w-full min-h-0 min-w-0 flex-col"
      tabIndex={0}
      aria-label={t("commitGraph.commitHistoryUseUpAndDownToSelect")}
      onKeyDown={(event) => {
        if (pending) return;
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
          return;
        if (event.altKey || event.metaKey || event.ctrlKey) return;

        const index =
          event.key === "ArrowDown"
            ? Math.min(graphRows.length - 1, selectedIndex + 1)
            : event.key === "ArrowUp"
              ? Math.max(0, selectedIndex - 1)
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? graphRows.length - 1
                  : -1;

        if (index >= 0 && index < graphRows.length) {
          event.preventDefault();
          const row = graphRows[index];
          if (row) void selectCommit(row.commit.oid);
          else selectWorkingTree();
        }

        if (
          (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) &&
          selectedIndex >= 0 &&
          graphRows[selectedIndex]
        ) {
          event.preventDefault();

          const bounds = event.currentTarget.getBoundingClientRect();

          setMenu({
            oid: graphRows[selectedIndex]!.commit.oid,
            x: bounds.left + 40,
            y: bounds.top + 60,
          });
        }
      }}
    >
      <PanelHeader
        title={t("commitGraph.history")}
        leading={
          <>
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
          </>
        }
        controls={{
          name: t("commitGraph.historyLabel"),
          state: panel.state,
          onToggleMaximize: panel.toggleMaximize,
          onToggleCollapse: panel.toggleCollapse,
          collapseDirection: "up",
        }}
      >
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

        {repositoryId && (
          <GraphVisibilityMenu
            repositoryId={repositoryId}
            disabled={pending}
            onFilter={() => setFilterOpen(true)}
          />
        )}

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

        <IconButton
          size="xs"
          icon={<SearchIcon />}
          aria-label={t("historySearch.title")}
          title={t("historySearch.title")}
          disabled={pending || !repositoryId}
          onClick={() => setSearchOpen(true)}
        />
        <IconButton
          size="xs"
          icon={<CircleDashedIcon />}
          aria-label={t("dangling.title")}
          title={t("dangling.title")}
          disabled={pending || !repositoryId}
          onClick={() => setRecoveryOpen(true)}
        />
        <IconButton
          size="xs"
          icon={<DiffIcon />}
          aria-label={t("comparison.title")}
          title={t("comparison.title")}
          disabled={pending || !repositoryId}
          onClick={() => useRepositoryStore.getState().compareRevisions()}
        />
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
                className="relative hidden shrink-0 @xl:block"
                onDragOver={(event) => previewReorder(column.id, event)}
                onDrop={(event) => finishReorder(column.id, event)}
              >
                <ButtonBase
                  draggable={!pending && !!repositoryId}
                  disabled={pending || !repositoryId}
                  aria-label={t("graphColumns.reorderColumn", { id: column.id })}
                  aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
                  title={t("graphColumns.reorderHint")}
                  className={`block w-full cursor-grab truncate rounded-sm text-left uppercase active:cursor-grabbing ${dropTarget === column.id ? "bg-accent-muted text-accent-text" : ""}`}
                  onDragStart={(event) => startReorder(column.id, event)}
                  onDragEnd={cancelReorder}
                  onKeyDown={(event) => {
                    if (
                      !event.altKey ||
                      !event.shiftKey ||
                      !["ArrowLeft", "ArrowRight"].includes(event.key)
                    )
                      return;

                    event.preventDefault();
                    event.stopPropagation();
                    const visible = columns.filter((item) => item.visible);
                    const index = visible.findIndex((item) => item.id === column.id);
                    const target = visible[index + (event.key === "ArrowLeft" ? -1 : 1)];

                    if (target) moveColumn(column.id, target.id);
                  }}
                >
                  {t(`graphColumns.${column.id}`)}
                </ButtonBase>

                <span
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t("graphColumns.columnWidth", { id: column.id })}
                  aria-valuemin={48}
                  aria-valuemax={320}
                  aria-valuenow={column.width}
                  aria-valuetext={t("graphColumns.px", { width: column.width })}
                  aria-disabled={pending || !repositoryId}
                  tabIndex={pending || !repositoryId ? -1 : 0}
                  className="absolute -left-2 top-0 h-full w-2 touch-none cursor-col-resize rounded-sm border-l border-border-default hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
                  onPointerDown={(event) => startResize(column, event)}
                  onKeyDown={(event) => {
                    let width: number;

                    if (event.key === "ArrowLeft") width = column.width + 8;
                    else if (event.key === "ArrowRight") width = column.width - 8;
                    else if (event.key === "Home") width = 48;
                    else if (event.key === "End") width = 320;
                    else return;

                    event.preventDefault();
                    event.stopPropagation();
                    saveWidth(column.id, width);
                  }}
                />
              </span>
            ))}
        </div>
      </div>

      {pending ? (
        <div
          role="status"
          aria-label={t("commitGraph.loadingHistory")}
          className="min-h-0 flex-1 overflow-hidden"
        >
          {Array.from({ length: 16 }, (_, index) => (
            <div
              key={index}
              style={{ height: rowHeight }}
              className="flex items-center border-b border-border-subtle"
            >
              <div style={{ width: gutter }} className="flex shrink-0 justify-center">
                <Skeleton className="size-2 rounded-full" />
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-3 pr-3">
                <div className="flex-1">
                  <Skeleton className={index % 3 ? "w-2/3" : "w-1/3"} />
                </div>
                {columns
                  .filter((column) => column.visible)
                  .map((column) => (
                    <div
                      key={column.id}
                      style={{ width: column.width }}
                      className="hidden shrink-0 @xl:block"
                    >
                      <Skeleton className="w-2/3" />
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
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

          {!!linkedChanges?.length && (
            <ul
              aria-label={t("worktrees.linkedChanges")}
              className="max-h-24 shrink-0 overflow-y-auto border-b border-border-subtle"
            >
              {linkedChanges.map((entry) => (
                <li key={entry.path}>
                  <ButtonBase
                    className="flex w-full items-center gap-2 truncate px-3 py-1 text-left text-xs"
                    onClick={() => void openLinkedChanges(entry.path)}
                  >
                    <DiffIcon size={14} aria-hidden="true" />
                    <span className="truncate">
                      {t("worktrees.graphChanges", {
                        count: entry.changedPaths!,
                        path: entry.path,
                      })}
                    </span>
                    <span className="mono shrink-0 text-text-tertiary">
                      {entry.branch ?? entry.oid?.slice(0, 8)}
                    </span>
                  </ButtonBase>
                </li>
              ))}
            </ul>
          )}
          {worktreeError && (
            <ErrorDialog onDismiss={() => setWorktreeError("")}>{worktreeError}</ErrorDialog>
          )}

          {rows.some((row) => row.topologyUnavailable) && (
            <p role="status" className="px-3 py-1 text-xs text-git-modified">
              {t("commitGraph.thisHistoryExceeds512SimultaneousGraphLanesParentRelationships")}
            </p>
          )}

          {rows.length === 0 && !historyError && !workingRowCount && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-sm text-text-tertiary">
              <GitCommitHorizontal size={22} />
              <p>{t("commitGraph.noCommitsYet")}</p>
              <p className="text-xs">{t("commitGraph.stageChangesToCreateTheFirstCommit")}</p>
            </div>
          )}

          <VirtualRows
            scrollKey={`${identityId}:${repositoryId}:graph`}
            horizontalScroll={false}
            buffered
            revealIndex={selectedIndex >= 0 ? graphOffset + selectedIndex : undefined}
            revealKey={`${historyTip ?? ""}:${selection?.kind === "commit" ? selection.oid : ""}`}
            items={graphRows}
            rowHeight={rowHeight}
            itemOffset={graphOffset}
            className="min-h-0 flex-1 [overflow-anchor:none]"
            onNearEnd={canPage && nextOffset !== null ? loadMore : undefined}
            onNearStart={canPage && baseOffset > 0 ? loadPrevious : undefined}
            renderRow={(row, index) =>
              row ? (
                <CommitRow
                  key={row.commit.oid}
                  row={row}
                  rowHeight={rowHeight}
                  avatars={avatars}
                  dateStyle={dateStyle}
                  linkedWorktrees={linkedByOid.get(row.commit.oid) ?? []}
                  loadedChildren={childrenByParent.get(row.commit.oid) ?? []}
                  {...(repositoryId && { repositoryId })}
                  columns={columns}
                  gutter={gutter}
                  selected={selection?.kind === "commit" && selection.oid === row.commit.oid}
                  related={hoveredRefOid === row.commit.oid}
                  vigilantMode={vigilantMode && shaColumnVisible}
                  workingTreeConnection={
                    workingConnection && index - workingRowCount <= workingConnection.headIndex
                      ? {
                          lane: workingConnection.lane,
                          head: index - workingRowCount === workingConnection.headIndex,
                        }
                      : undefined
                  }
                  onSelect={() => void selectCommit(row.commit.oid)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ oid: row.commit.oid, x: event.clientX, y: event.clientY });
                  }}
                />
              ) : (
                <WorkingTreeDraftRow
                  rowHeight={rowHeight}
                  pending={pending}
                  key="working-tree"
                  changes={status?.changes ?? []}
                  truncated={truncatedChanges}
                  gutter={gutter}
                  lane={workingConnection?.lane}
                  selected={selection?.kind !== "commit"}
                  onSelect={selectWorkingTree}
                />
              )
            }
          />

          {menu && (
            <Suspense fallback={null}>
              <CommitMenu target={menu} onClose={() => setMenu(null)} />
            </Suspense>
          )}

          {recoveryOpen && repositoryId && (
            <Suspense fallback={null}>
              <HistoryRecoveryDialog
                key={repositoryId}
                repositoryId={repositoryId}
                dangling
                onClose={() => setRecoveryOpen(false)}
              />
            </Suspense>
          )}
          {searchOpen && repositoryId && (
            <Suspense fallback={null}>
              <HistorySearch repositoryId={repositoryId} onClose={() => setSearchOpen(false)} />
            </Suspense>
          )}
          {filterOpen && repositoryId && (
            <Suspense fallback={null}>
              <GraphFilterDialog
                key={repositoryId}
                repositoryId={repositoryId}
                onClose={() => setFilterOpen(false)}
              />
            </Suspense>
          )}
        </>
      )}
    </section>
  );
}

function WorkingTreeDraftRow({
  pending,
  ...props
}: Omit<ComponentProps<typeof WorkingTreeRow>, "title" | "titleDisabled" | "onTitleChange"> & {
  pending: boolean;
}) {
  const { title, messageTail, setMessage, disabled } = useCommitMessage(pending);

  return (
    <WorkingTreeRow
      {...props}
      title={title}
      titleDisabled={disabled}
      onTitleChange={(value) => setMessage(`${value}${messageTail}`)}
    />
  );
}
