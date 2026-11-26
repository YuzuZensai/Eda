import type { HistoryPage, ObjectId } from "@shared/repository/repository-read";
import { useRepositoryStore } from "../../stores/repository-store";
import { layoutCommitPages, type DagBoundary, type DagRow } from "../dag-layout";
import { laneColor } from "../graph-geometry";

interface HistoryGraph {
  rows: readonly DagRow[];
  commitColors: ReadonlyMap<ObjectId, string>;
}

const emptyGraph: HistoryGraph = { rows: [], commitColors: new Map() };
const graphs = new WeakMap<HistoryPage[], { boundary: DagBoundary; graph: HistoryGraph }>();

function historyGraph(pages: HistoryPage[], boundary: DagBoundary): HistoryGraph {
  const cached = graphs.get(pages);
  if (cached?.boundary === boundary) return cached.graph;

  const rows = layoutCommitPages(
    pages.map((page) => page.commits),
    boundary,
  );
  const commitColors = new Map<ObjectId, string>();
  for (const row of rows) {
    if (!row.topologyUnavailable) commitColors.set(row.commit.oid, laneColor(row.lane));
  }

  const graph = { rows, commitColors };
  graphs.set(pages, { boundary, graph });
  return graph;
}

export function useHistoryGraph(repositoryId: string | null): HistoryGraph {
  return useRepositoryStore((state) =>
    repositoryId !== null && state.repositoryId === repositoryId
      ? historyGraph(state.pages, state.dagBoundary)
      : emptyGraph,
  );
}
