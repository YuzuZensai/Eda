import { GraphColumnHeader } from "./GraphColumnHeader";
import { useLinkedWorktrees } from "./useLinkedWorktrees";
import { lazyRepositoryDialog } from "../repository-dialogs.lazy";
import { errorAction, errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  DiffIcon,
  SearchIcon,
  CircleDashedIcon,
  UsersRoundIcon,
  GitCommitHorizontalIcon as GitCommitHorizontal,
} from "../../components/ui/icons";
import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type Ref,
} from "react";
import { PanelHeader } from "../../components/layout/PanelHeader";
import { usePanel } from "../../components/layout/hooks/usePanel";
import { useLayoutTransition } from "../../components/layout/hooks/useLayoutTransition";
import { VirtualRows } from "../../components/ui/display/VirtualRows";
import { Skeleton } from "../../components/ui/feedback/Skeleton";
import { ButtonBase, ErrorDialog, IconButton, TextButton } from "../../components/ui/index";
import { checkoutAncestry, firstParentPaths } from "../../repository/dag-layout";
import { ROW_HEIGHT, graphColumnWidth } from "../../repository/graph-geometry";
import { useHistoryGraph } from "../../repository/hooks/useHistoryGraph";
import { useRepositoryStore } from "../../stores/repository-store";
import { usePreferencesStore } from "../../stores/preferences-store";
import { useLayoutStore } from "../../stores/layout-store";
import type { CommitMenuTarget } from "./CommitMenu";
import { CommitRow, WorkingTreeRow } from "./CommitRow";
import { useGraphColumns } from "./useGraphColumns";
import { GraphVisibilityMenu } from "./GraphVisibilityMenu";
import { useCommitMessage } from "../../repository/hooks/useCommitMessage";

const HistorySearch = lazyRepositoryDialog("HistorySearch");
const ContributorsDialog = lazyRepositoryDialog("ContributorsDialog");
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

  const graphColumns = useGraphColumns(repositoryId, pending);
  const { columns, refsWidth } = graphColumns;
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
  const [contributorsOpen, setContributorsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  const hoveredRefOid = useRepositoryStore((state) => state.hoveredRefOid);
  const status = useRepositoryStore((state) => state.status);
  const branches = useRepositoryStore((state) => state.branches);
  const upstreams = useMemo(() => {
    const map = new Map<string, string>();
    for (const branch of branches) {
      if (!branch.remote && branch.upstream) map.set(branch.name, branch.upstream);
    }
    return map;
  }, [branches]);

  const { linkedChanges, openLinkedChanges, linkedByOid, worktreeError, setWorktreeError } =
    useLinkedWorktrees(repositoryId, identityId, status, pending);
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

  const { rows } = useHistoryGraph(repositoryId);
  const headOid = status?.branch.oid;
  const selectedOid = selection?.kind === "commit" ? selection.oid : undefined;
  const pathBoundary = useRepositoryStore((state) => state.dagBoundary.paths);
  const ancestryBoundary = useRepositoryStore((state) => state.dagBoundary.ancestry);
  const checkoutCommits = useMemo(
    () => checkoutAncestry(rows, headOid, ancestryBoundary)?.commits,
    [rows, headOid, ancestryBoundary],
  );
  const graphEmphasis = useMemo(
    () => firstParentPaths(rows, [headOid, selectedOid, hoveredRefOid], pathBoundary),
    [rows, headOid, selectedOid, hoveredRefOid, pathBoundary],
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
    return { lane, color: rows[headIndex]!.color, headIndex };
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
      style={{ "--history-refs-width": `${refsWidth}px` } as CSSProperties}
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
          icon={<UsersRoundIcon />}
          aria-label={t("contributors.title")}
          title={t("contributors.title")}
          disabled={pending || !repositoryId}
          onClick={() => setContributorsOpen(true)}
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

      <GraphColumnHeader
        graphColumns={graphColumns}
        disabled={pending || !repositoryId}
        gutter={gutter}
        shaHeader={shaHeader}
      />

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
              <span className="history-ref-column" />
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
            measureRows
            measurementKey={refsWidth}
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
                  checkoutRef={
                    headOid === row.commit.oid ? (status?.branch.head ?? "HEAD") : undefined
                  }
                  upstreams={upstreams}
                  selected={selectedOid === row.commit.oid}
                  outsideCheckout={
                    checkoutCommits !== undefined && !checkoutCommits.has(row.commit.oid)
                  }
                  related={hoveredRefOid === row.commit.oid}
                  graphEmphasis={graphEmphasis}
                  vigilantMode={vigilantMode && shaColumnVisible}
                  workingTreeConnection={
                    workingConnection && index - workingRowCount <= workingConnection.headIndex
                      ? {
                          lane: workingConnection.lane,
                          color: workingConnection.color,
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
                  color={workingConnection?.color}
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

          {contributorsOpen && repositoryId && (
            <Suspense fallback={null}>
              <ContributorsDialog
                key={repositoryId}
                repositoryId={repositoryId}
                onClose={() => setContributorsOpen(false)}
              />
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
