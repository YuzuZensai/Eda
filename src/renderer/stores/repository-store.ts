import { ok, type Result, type GitErrorData } from "@shared/errors";
import { t, type MessageKey } from "@shared/i18n";
import {
  HISTORY_PAGE_SIZE,
  type HistoryPage,
  type RepositoryStatus,
} from "@shared/repository/repository-read";
import { create } from "zustand";
import type { DagBoundary } from "../repository/dag-layout";
import { defaultBranchTips } from "../repository/branch-order";
import { categorizeChanges, successorPaths } from "../repository/working-changes";
import { createHistoryPagination, readHistory } from "./history-pagination";
import { createRepositoryDiff } from "./repository-diff";

import { useLayoutStore } from "./layout-store";
import { useSessionStore } from "./session-store";

export { HISTORY_PAGE_SIZE } from "@shared/repository/repository-read";
export { MAX_HISTORY_PAGES } from "./history-pagination";
export const MAX_STATUS_CHANGES = 5_000;

export type { ChangeArea } from "@shared/repository/repository-read";
export type { RepositorySelection } from "./repository-state";

import {
  sameSelection,
  repositoryRequestFailure,
  type RepositoryReadState,
  type RepositorySelection,
} from "./repository-state";

let openRequest: Promise<void> | null = null;

const emptyState = {
  commandDialog: null,
  historyTip: null,
  repositoryId: null,
  identityId: null,
  phase: "idle" as const,
  status: null,
  branches: [],
  pages: [] as HistoryPage[],
  dagBoundary: { lanes: [] } as DagBoundary,
  hoveredRefOid: null,
  watchWarning: null,
  baseOffset: 0,
  nextOffset: null,
  historyLoading: false,
  selection: null,
  contentView: "history" as const,
  commitFilePath: null,
  commitFileDiff: null,
  commitFileLoading: false,
  commitFileError: null,
  navigation: [] as Exclude<RepositorySelection, null>[],
  navigationIndex: -1,
  diff: null,
  diffLoading: false,
  error: null,
  historyError: null,
  truncatedChanges: false,
  writing: false,
  writeError: null,
  commitNotice: null,
  stashNotice: null,
};

function boundedStatus(status: RepositoryStatus) {
  const changes = status.changes.slice(0, MAX_STATUS_CHANGES);

  return {
    status: { ...status, changes },
    truncatedChanges: changes.length < status.changes.length,
  };
}

function boundedHistory(page: HistoryPage): HistoryPage {
  return { ...page, commits: page.commits.slice(0, HISTORY_PAGE_SIZE) };
}

function statusFailure(error: GitErrorData) {
  return {
    phase: error.kind === "not-a-repository" ? ("missing" as const) : ("error" as const),
    error,
  };
}

export const useRepositoryStore = create<RepositoryReadState>((set, get) => {
  const diff = createRepositoryDiff(get, set);
  const loadDiff = diff.load;
  const history = createHistoryPagination(get, set);

  const readFirstPage = (repositoryId: string, resetHistory = false) =>
    Promise.all([
      window.eda.repository
        .status(repositoryId)
        .catch(() => repositoryRequestFailure("operations.readStatus")),
      window.eda.repository
        .listBranches(repositoryId)
        .catch(() => repositoryRequestFailure("operations.listBranches")),
      readHistory({
        repositoryId,
        offset: 0,
        limit: HISTORY_PAGE_SIZE,
        ...history.query(repositoryId, resetHistory ? null : undefined),
      }),
    ]);

  const load = async (
    repositoryId: string,
    identityId: string,
    available: boolean,
    force = false,
  ): Promise<void> => {
    if (
      !force &&
      get().repositoryId === repositoryId &&
      get().identityId === identityId &&
      get().phase !== "idle" &&
      available === (get().phase !== "missing")
    ) {
      if (openRequest) await openRequest;
      return;
    }

    openRequest = null;

    history.invalidate();
    history.replaceFirst();

    const generation = get().generation + 1;

    diff.invalidate();

    set({
      ...emptyState,
      dagBoundary: history.firstBoundary(repositoryId, null, []),
      repositoryId,
      identityId,
      generation,
      phase: available ? "loading" : "missing",
    });

    if (!available) return;

    const request = (async () => {
      const [statusResult, branchResult, historyResult] = await readFirstPage(repositoryId);

      if (get().generation !== generation || get().repositoryId !== repositoryId) return;

      if (!statusResult.ok) {
        set(statusFailure(statusResult.error));

        return;
      }

      const bounded = boundedStatus(statusResult.value);
      const branches = branchResult.ok ? branchResult.value : [];

      if (!historyResult.ok) {
        set({
          phase: "ready",
          ...bounded,
          branches,
          historyError: historyResult.error,
        });

        return;
      }

      history.replaceFirst(historyResult.value);

      set({
        phase: "ready",
        ...bounded,
        branches,
        dagBoundary: history.firstBoundary(repositoryId, null, defaultBranchTips(branches)),
        pages: [boundedHistory(historyResult.value)],
        nextOffset: historyResult.value.nextOffset,
      });

      const session = useSessionStore.getState().snapshot;

      const selection =
        session?.context.profileId === identityId
          ? session.session.views[repositoryId]?.selection
          : null;

      if (selection?.kind === "commit") {
        await loadDiff(selection);

        if (
          get().generation === generation &&
          get().repositoryId === repositoryId &&
          get().selection === selection &&
          get().error?.code === "main.git.gitService.theCommitIsNoLongerAvailable"
        ) {
          set({ selection: null, error: null });

          if (useSessionStore.getState().snapshot?.context.profileId === identityId)
            useSessionStore.getState().setView(repositoryId, { selection: null });
        }
      } else if (
        selection?.kind === "change" &&
        categorizeChanges(bounded.status.changes)[selection.area].some(
          (change) => change.path === selection.path,
        )
      )
        await loadDiff(selection);
    })();

    openRequest = request;

    await request.finally(() => {
      if (openRequest === request) openRequest = null;
    });
  };

  const reload = async (repositoryId: string, resetHistory = false): Promise<boolean> => {
    const { generation } = get();
    const revision = history.invalidate();

    const [statusResult, branchResult, historyResult] = await readFirstPage(
      repositoryId,
      resetHistory,
    );

    if (
      get().generation !== generation ||
      get().repositoryId !== repositoryId ||
      !history.isCurrent(revision)
    )
      return false;

    if (!statusResult.ok) {
      set(statusFailure(statusResult.error));

      return false;
    }

    const branches = branchResult.ok ? branchResult.value : get().branches;
    const tips = defaultBranchTips(branches);
    const previousTips = get().dagBoundary.defaultBranchTips ?? [];
    const defaultsChanged =
      tips.length !== previousTips.length || tips.some((oid) => !previousTips.includes(oid));
    const replaceHistory =
      historyResult.ok &&
      (resetHistory || defaultsChanged || history.firstPageChanged(historyResult.value));

    if (replaceHistory) {
      history.replaceFirst(historyResult.value);
    }

    set({
      phase: "ready",
      historyLoading: false,
      historyError: historyResult.ok ? null : historyResult.error,
      ...boundedStatus(statusResult.value),
      branches,
      ...(historyResult.ok &&
        replaceHistory && {
          pages: [boundedHistory(historyResult.value)],
          baseOffset: 0,
          historyTip: resetHistory ? null : get().historyTip,
          dagBoundary: history.firstBoundary(repositoryId, resetHistory ? null : undefined, tips),
          nextOffset: historyResult.value.nextOffset,
          historyError: null,
        }),
    });

    const selected = get().selection;

    if (selected && !get().writing) {
      diff.invalidate();
      await loadDiff({ ...selected }, { background: resetHistory });
    }

    return true;
  };

  const revealCommit = async (oid: string) => {
    if (get().pages.some((page) => page.commits.some((commit) => commit.oid === oid))) return;

    const { repositoryId, generation, selection, historyTip } = get();

    if (!repositoryId || selection?.kind !== "commit" || selection.oid !== oid) return;

    const revision = history.invalidate();

    set({ historyLoading: true });

    const result = await readHistory({
      repositoryId,
      refs: [oid],
      offset: 0,
      limit: HISTORY_PAGE_SIZE,
    });

    if (get().generation !== generation || !history.isCurrent(revision)) return;

    if (get().selection !== selection) {
      set({ historyLoading: false });
      return;
    }

    if (!result.ok) {
      set({ historyTip, historyLoading: false, historyError: result.error });
      return;
    }

    history.replaceFirst(result.value);

    set({
      historyTip: oid,
      pages: [result.value],
      dagBoundary: history.firstBoundary(repositoryId, oid),
      baseOffset: 0,
      nextOffset: result.value.nextOffset,
      historyLoading: false,
      historyError: null,
    });
  };

  const runWrite = async (
    operation: MessageKey,
    call: (repositoryId: string) => Promise<Result<unknown>>,
  ) => {
    const { repositoryId, identityId, generation } = get();

    if (!repositoryId || !identityId || get().writing) return false;

    const before = get().selection;
    const successors =
      before?.kind === "change" ? successorPaths(get().status?.changes ?? [], before) : [];

    set({ writing: true, writeError: null });

    try {
      const result = await call(repositoryId).catch(() => repositoryRequestFailure(operation));

      if (get().generation !== generation) return result.ok;

      if (!result.ok) {
        set({ writeError: result.error });
        return false;
      }

      const refreshed = await reload(repositoryId);

      if (
        refreshed &&
        get().generation === generation &&
        before?.kind === "change" &&
        get().selection === before
      )
        await advanceSelection(before, successors);

      return true;
    } finally {
      if (get().generation === generation) set({ writing: false });
    }
  };

  const advanceSelection = async (
    previous: Extract<RepositorySelection, { kind: "change" }>,
    successors: string[],
  ): Promise<void> => {
    const remaining = new Set(
      categorizeChanges(get().status?.changes ?? [])[previous.area].map((change) => change.path),
    );

    if (remaining.has(previous.path)) {
      diff.invalidate();
      return loadDiff({ ...previous });
    }

    const next = successors.find((path) => remaining.has(path));

    if (next !== undefined) return loadDiff({ kind: "change", path: next, area: previous.area });
    get().showWorkingTree();
  };

  const remember = (selection: Exclude<RepositorySelection, null>) => {
    const { navigation, navigationIndex } = get();
    const previous = navigation[navigationIndex];
    if (sameSelection(previous, selection)) return;
    const next = [...navigation.slice(0, navigationIndex + 1), selection].slice(-100);
    set({ navigation: next, navigationIndex: next.length - 1 });
  };

  const runStash = async (pop: boolean, paths?: string[]) => {
    const { generation, status, writing, phase } = get();

    if (writing || phase !== "ready" || status?.capabilities?.write === false) return;

    set({ stashNotice: null });

    await runWrite(pop ? "stashActions.pop" : "stashActions.stash", async (repositoryId) => {
      if (!pop)
        return await window.eda.stashes.create(
          repositoryId,
          t("stashActions.defaultName", {
            branch: status?.branch.head ?? status?.branch.oid?.slice(0, 7),
          }),
          "untracked",
          paths ? { paths } : undefined,
        );

      const list = await window.eda.stashes.list(repositoryId);
      if (!list.ok) return list;
      if (get().generation !== generation) return ok(undefined);

      const latest = list.value.entries[0];

      if (!latest) {
        set({ stashNotice: t("stashActions.noSavedStashes") });
        return ok(undefined);
      }

      const inspected = await window.eda.stashes.inspect(repositoryId, latest.selector, latest.oid);
      if (!inspected.ok) return inspected;
      if (get().generation !== generation) return ok(undefined);

      const result = await window.eda.stashes.apply(
        repositoryId,
        inspected.value.token,
        true,
        false,
      );

      if (result.ok && get().generation === generation) {
        let notice = t("stashActions.popped");
        if (!result.value.applied) notice = t("stashActions.conflictsKept");
        else if (result.value.kept) notice = t("stashActions.appliedKept");
        set({ stashNotice: notice });
      }

      return result;
    });
  };

  return {
    ...emptyState,
    generation: 0,
    open: load,
    async refresh() {
      const { repositoryId, identityId, phase } = get();
      if (!repositoryId || !identityId) return;

      if (phase === "ready") await reload(repositoryId, true);
      else await load(repositoryId, identityId, phase !== "missing", true);
    },
    async syncFromDisk() {
      const { repositoryId, phase } = get();
      if (repositoryId && phase === "ready") await reload(repositoryId);
    },
    loadMore: history.loadMore,
    loadPrevious: history.loadPrevious,
    selectChange(change, area, openConflict = true) {
      const focused = area !== "conflicted" || openConflict;
      set({ contentView: focused ? "diff" : "history", commitFilePath: null });
      useLayoutStore.getState().reveal(focused ? "diff" : "graph");
      const selection = { kind: "change" as const, path: change.path, area };
      remember(selection);
      return loadDiff(selection, { openConflict });
    },
    selectCommit(oid) {
      set({ contentView: "history", commitFilePath: null });
      useLayoutStore.getState().reveal("graph");
      const selection = { kind: "commit" as const, oid };
      remember(selection);
      return loadDiff(selection);
    },
    selectCommitFile: diff.selectFile,
    async retryDiff() {
      const { selection, commitFilePath } = get();
      if (selection?.kind === "commit" && commitFilePath) await diff.selectFile(commitFilePath);
      else if (selection) await loadDiff(selection);
    },
    showHistory() {
      set({ contentView: "history" });
      useLayoutStore.getState().reveal("graph");
    },

    compareRevisions(left = "", right) {
      const { selection } = get();
      const target = right ?? (selection?.kind === "commit" ? selection.oid : "HEAD");
      set({ contentView: { kind: "comparison", left, right: target } });
    },
    showWorkingTree() {
      diff.invalidate();

      set({
        selection: null,
        diff: null,
        diffLoading: false,
        commitFilePath: null,
        commitFileDiff: null,
        commitFileLoading: false,
        commitFileError: null,
        contentView: "history",
      });

      const repositoryId = get().repositoryId;

      if (
        repositoryId &&
        get().identityId === useSessionStore.getState().snapshot?.context.profileId
      )
        useSessionStore.getState().setView(repositoryId, { selection: null });

      useLayoutStore.getState().reveal("graph");
    },
    async jumpToCommit(oid) {
      await get().selectCommit(oid);
      await revealCommit(oid);
    },
    async navigate(direction) {
      const index = get().navigationIndex + direction;
      const selection = get().navigation[index];

      if (!selection) return;

      set({
        navigationIndex: index,
        contentView: selection.kind === "commit" ? "history" : "diff",
        commitFilePath: null,
      });

      useLayoutStore.getState().reveal(selection.kind === "commit" ? "graph" : "diff");
      await loadDiff(selection);

      if (selection.kind === "commit") await revealCommit(selection.oid);
    },

    applyPartial(token) {
      return runWrite("operations.partialStaging", (repositoryId) =>
        window.eda.repository.applyPartial(repositoryId, token),
      );
    },
    async stage(paths) {
      await runWrite("operations.stageChanges", (repositoryId) =>
        window.eda.repository.stage({ repositoryId, ...(paths ? { paths } : {}) }),
      );
    },

    async unstage(paths) {
      await runWrite("operations.unstageChanges", (repositoryId) =>
        window.eda.repository.unstage({ repositoryId, ...(paths ? { paths } : {}) }),
      );
    },

    stash: (paths) => runStash(false, paths),
    popStash: () => runStash(true),

    async commit(message, options = {}) {
      const generation = get().generation;

      set({ commitNotice: null });

      return runWrite("operations.commit", async (repositoryId) => {
        const result = await window.eda.repository.commit({
          repositoryId,
          message,
          ...(options.amend ? { amend: true } : {}),
          ...(options.skipCommitHooks ? { skipCommitHooks: true } : {}),
          ...(options.signOff ? { signOff: true } : {}),
          ...(options.stagePaths ? { stagePaths: options.stagePaths } : {}),
        });

        if (
          result.ok &&
          result.value.publishedCommits &&
          get().generation === generation &&
          get().repositoryId === repositoryId
        )
          set({
            commitNotice: t(
              "repositoryStore.amendmentCompletedAndReplacedPublishedHistoryNothingWas",
            ),
          });

        return result;
      });
    },
    clear() {
      const generation = get().generation + 1;
      openRequest = null;
      history.invalidate();
      diff.invalidate();
      set({ ...emptyState, generation });
    },
  };
});

export { categorizeChanges, successorPaths } from "../repository/working-changes";
