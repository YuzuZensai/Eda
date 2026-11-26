import type { HistoryCommit, ObjectId } from "@shared/repository/repository-read";

export interface DagBoundary {
  lanes: (ObjectId | undefined)[];
  pinned?: boolean;
  overflow?: boolean;
}

export interface DagSegment {
  fromLane: number;
  toLane: number;
  targetOid: ObjectId;
  continues: boolean;
  incoming?: boolean;
}

export interface DagRow {
  commit: HistoryCommit;
  lane: number;
  laneCount: number;
  segments: DagSegment[];
  topologyUnavailable?: boolean;
}

export interface DagLayout {
  rows: DagRow[];
  boundary: DagBoundary;
}

export const EMPTY_DAG_BOUNDARY: DagBoundary = { lanes: [] };
export const MAX_DAG_LANES = 512;

export function layoutCommitPage(
  commits: readonly HistoryCommit[],
  boundary: DagBoundary = EMPTY_DAG_BOUNDARY,
): DagLayout {
  const textOnly = (): DagLayout => ({
    rows: commits.map((commit) => ({
      commit,
      lane: 0,
      laneCount: 1,
      segments: [],
      topologyUnavailable: true,
    })),
    boundary: { lanes: [], overflow: true },
  });

  if (boundary.overflow || boundary.lanes.length > MAX_DAG_LANES) return textOnly();

  const lanes: (ObjectId | undefined)[] = [...boundary.lanes];
  const rows: DagRow[] = [];
  let overflow = false;

  const claimLane = (oid: ObjectId): number => {
    const existing = lanes.indexOf(oid);

    if (existing >= 0) return existing;

    const hole = lanes.indexOf(undefined);

    if (hole >= 0) {
      lanes[hole] = oid;
      return hole;
    }

    if (lanes.length >= MAX_DAG_LANES) {
      overflow = true;
      return MAX_DAG_LANES - 1;
    }

    return lanes.push(oid) - 1;
  };

  for (const commit of commits) {
    const hasParentAbove = lanes.includes(commit.oid);
    const lane = claimLane(commit.oid);
    const before = [...lanes];
    const parents = commit.parents.filter((parent, index, all) => all.indexOf(parent) === index);

    lanes[lane] = undefined;

    const parentLanes = parents.map((parent, index) => {
      if (boundary.pinned && lane === 0 && index === 0) {
        const existing = lanes.indexOf(parent);
        if (existing >= 0) lanes[existing] = undefined;
        lanes[0] = parent;
        return 0;
      }

      return claimLane(parent);
    });

    const segments: DagSegment[] = [];

    if (hasParentAbove) {
      segments.push({
        fromLane: lane,
        toLane: lane,
        targetOid: commit.oid,
        continues: true,
        incoming: true,
      });
    }

    for (const [fromLane, oid] of before.entries()) {
      if (oid === undefined) continue;
      if (fromLane === lane) continue;
      const toLane = lanes.indexOf(oid);
      if (toLane < 0) continue;
      segments.push({ fromLane, toLane, targetOid: oid, continues: true });
    }

    for (const [index, toLane] of parentLanes.entries()) {
      segments.push({ fromLane: lane, toLane, targetOid: parents[index]!, continues: true });
    }

    const width = Math.max(before.length, lanes.length, 1);

    rows.push({ commit, lane, laneCount: width, segments });
  }

  while (lanes.length > 0 && lanes.at(-1) === undefined) lanes.pop();

  if (overflow) return textOnly();

  return { rows, boundary: { lanes, ...(boundary.pinned && { pinned: true }) } };
}

export function layoutCommitPages(
  pages: readonly (readonly HistoryCommit[])[],
  initial = EMPTY_DAG_BOUNDARY,
): DagRow[] {
  let boundary = initial;
  const rows: DagRow[] = [];

  for (const page of pages) {
    const layout = layoutCommitPage(page, boundary);
    rows.push(...layout.rows);
    boundary = layout.boundary;
  }

  return rows;
}

export function firstParentPaths(
  rows: readonly DagRow[],
  ...tips: (ObjectId | null | undefined)[]
): ReadonlySet<ObjectId> | undefined {
  const firstParents = new Map(rows.map(({ commit }) => [commit.oid, commit.parents[0]]));
  const emphasized = new Set<ObjectId>();

  for (const tip of tips) {
    if (!tip || !firstParents.has(tip)) continue;

    let oid: ObjectId | undefined = tip;
    while (oid !== undefined && !emphasized.has(oid)) {
      emphasized.add(oid);
      oid = firstParents.get(oid);
    }
  }

  return emphasized.size > 0 ? emphasized : undefined;
}
