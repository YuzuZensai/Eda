import { errorText } from "@shared/error-codes";
import { GitError, type GitErrorData } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  HISTORY_PAGE_SIZE,
  type HistoryPage,
  type HistoryPageRequest,
} from "@shared/repository/repository-read";
import { layoutCommitPage, type DagBoundary } from "../repository/dag-layout";
import { repositoryRequestFailure } from "./repository-state";
import { useSessionStore } from "./session-store";

export const MAX_HISTORY_PAGES = 3;

export interface HistoryWindow {
  pages: HistoryPage[];
  dagBoundary: DagBoundary;
  baseOffset: number;
  nextOffset: number | null;
  historyTip: string | null;
  historyError: GitErrorData | null;
  historyLoading: boolean;
}

export function readHistory(request: HistoryPageRequest) {
  return window.eda.repository
    .history(request)
    .catch(() => repositoryRequestFailure("operations.readHistory"));
}

export function createHistoryPagination(
  get: () => HistoryWindow & { repositoryId: string | null; generation: number },
  set: (patch: Partial<HistoryWindow>) => void,
) {
  const boundaries = new Map<number, DagBoundary>();
  let revision = 0;
  let firstPageKey = "";
  let pending: { offset: number; request: Promise<void> } | null = null;

  function query(repositoryId: string, tip = get().historyTip) {
    if (tip) return { refs: [tip] };
    const filter = useSessionStore.getState().snapshot?.session.views[repositoryId]?.graphFilter;
    return {
      ...(filter && { refs: filter.refs, hiddenRefs: filter.hiddenRefs }),
      showStashes: filter?.showStashes ?? true,
      ...(filter?.showInternalRefs !== undefined && { showInternalRefs: filter.showInternalRefs }),
    };
  }

  function firstBoundary(repositoryId: string, historyTip = get().historyTip): DagBoundary {
    if (historyTip) return { lanes: [] };
    const oid =
      useSessionStore.getState().snapshot?.session.views[repositoryId]?.graphFilter?.pinnedOid;
    return { lanes: oid ? [oid] : [], ...(oid && { pinned: true }) };
  }

  function invalidate() {
    pending = null;
    return ++revision;
  }

  function replaceFirst(page?: HistoryPage) {
    pending = null;
    firstPageKey = page ? JSON.stringify(page) : "";
    boundaries.clear();
  }

  async function load(previous: boolean) {
    const { repositoryId, generation, baseOffset, nextOffset } = get();
    if (!repositoryId || (previous && baseOffset === 0)) return;
    const offset = previous ? Math.max(0, baseOffset - HISTORY_PAGE_SIZE) : nextOffset;
    if (offset === null) return;
    if (pending?.offset === offset) return pending.request;
    if (previous && offset > 0 && !boundaries.has(offset)) {
      set({
        historyError: new GitError({
          kind: "invalid-input",
          operation: t("operations.loadHistory"),
          message: errorText("repositoryStore.earlierGraphCheckpointsHaveLeftTheBoundedCache"),
          suggestedAction: errorText("repositoryStore.useRefreshToReturnToTheBeginningOfHistory"),
        }).toData(),
      });
      return;
    }

    const readRevision = revision;
    set({ historyLoading: true });
    const request: Promise<void> = Promise.resolve().then(async () => {
      const result = await readHistory({
        repositoryId,
        offset,
        limit: HISTORY_PAGE_SIZE,
        ...query(repositoryId),
      });
      if (
        revision !== readRevision ||
        get().generation !== generation ||
        pending?.request !== request
      )
        return;
      if (!result.ok) {
        set({ historyError: result.error, historyLoading: false });
        return;
      }
      const current = get();
      const page = { ...result.value, commits: result.value.commits.slice(0, HISTORY_PAGE_SIZE) };
      if (previous) {
        const pages = [page, ...current.pages];
        const evicted = pages.length > MAX_HISTORY_PAGES ? pages.pop() : undefined;
        set({
          pages,
          baseOffset: offset,
          dagBoundary: boundaries.get(offset) ?? firstBoundary(repositoryId),
          nextOffset: evicted
            ? offset + pages.reduce((n, p) => n + p.commits.length, 0)
            : current.nextOffset,
          historyLoading: false,
          historyError: null,
        });
      } else {
        const pages = [...current.pages, page];
        const evicted = pages.length > MAX_HISTORY_PAGES ? pages.shift() : undefined;
        let dagBoundary = current.dagBoundary;
        if (evicted) {
          boundaries.set(current.baseOffset, dagBoundary);
          if (boundaries.size > 128) boundaries.delete(boundaries.keys().next().value!);
          dagBoundary = layoutCommitPage(evicted.commits, dagBoundary).boundary;
        }
        set({
          pages,
          dagBoundary,
          baseOffset: current.baseOffset + (evicted?.commits.length ?? 0),
          nextOffset: page.nextOffset,
          historyLoading: false,
          historyError: null,
        });
      }
    });
    pending = { offset, request };
    try {
      await request;
    } finally {
      if (pending?.request === request) pending = null;
    }
  }

  return {
    query,
    firstBoundary,
    invalidate,
    replaceFirst,
    isCurrent: (readRevision: number) => readRevision === revision,
    firstPageChanged: (page: HistoryPage) => JSON.stringify(page) !== firstPageKey,
    loadMore: () => load(false),
    loadPrevious: () => load(true),
  };
}
