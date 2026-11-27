import type { HistoryCommit, ObjectId } from "@shared/repository/repository-read";
import { allocateGraphColor, DEFAULT_BRANCH_COLOR } from "./graph-colors";

export interface DagBoundary {
  defaultBranchTips?: readonly ObjectId[];
  colors?: { lanes: (number | undefined)[]; recent: number[] };
  lanes: (ObjectId | undefined)[];
  paths?: PathBoundary;
  pinned?: boolean;
  overflow?: boolean;
}

export interface DagSegment {
  color: number;
  fromLane: number;
  toLane: number;
  targetOid: ObjectId;
  continues: boolean;
  incoming?: boolean;
}

export interface DagRow {
  color: number;
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
      color: 0,
      laneCount: 1,
      segments: [],
      topologyUnavailable: true,
    })),
    boundary: { lanes: [], overflow: true },
  });

  if (boundary.overflow || boundary.lanes.length > MAX_DAG_LANES) return textOnly();

  const lanes: (ObjectId | undefined)[] = [...boundary.lanes];
  const recent = [...(boundary.colors?.recent ?? [])];
  const colors: (number | undefined)[] = [...(boundary.colors?.lanes ?? [])];
  if (!boundary.colors) {
    for (const [lane, oid] of lanes.entries()) {
      if (oid !== undefined) colors[lane] = allocateGraphColor(colors, lane, recent);
    }
  }

  const rows: DagRow[] = [];
  let overflow = false;

  const claimLane = (oid: ObjectId, inheritedColor?: number): number => {
    const existing = lanes.indexOf(oid);

    if (existing >= 0) return existing;

    const hole = lanes.indexOf(undefined);
    const lane = hole >= 0 ? hole : lanes.length;
    if (lane >= MAX_DAG_LANES) {
      overflow = true;
      return MAX_DAG_LANES - 1;
    }

    colors[lane] = inheritedColor ?? allocateGraphColor(colors, lane, recent);
    lanes[lane] = oid;
    return lane;
  };

  for (const commit of commits) {
    const hasParentAbove = lanes.includes(commit.oid);
    const lane = claimLane(commit.oid);
    const incomingColor = colors[lane]!;
    const color = boundary.defaultBranchTips?.includes(commit.oid)
      ? DEFAULT_BRANCH_COLOR
      : incomingColor;
    const before = [...lanes];
    const beforeColors = [...colors];
    const parents = commit.parents.filter((parent, index, all) => all.indexOf(parent) === index);

    lanes[lane] = undefined;
    colors[lane] = undefined;

    const parentLanes = parents.map((parent, index) => {
      if (boundary.pinned && lane === 0 && index === 0) {
        const existing = lanes.indexOf(parent);
        const inherited =
          existing >= 0 && colors[existing] === DEFAULT_BRANCH_COLOR ? DEFAULT_BRANCH_COLOR : color;
        if (existing >= 0) {
          lanes[existing] = undefined;
          colors[existing] = undefined;
        }
        colors[0] = inherited;
        lanes[0] = parent;
        return 0;
      }

      const parentLane = claimLane(parent, index === 0 ? color : undefined);
      if (index === 0 && color === DEFAULT_BRANCH_COLOR) colors[parentLane] = color;
      return parentLane;
    });

    const segments: DagSegment[] = [];

    if (hasParentAbove) {
      segments.push({
        color: incomingColor,
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
      segments.push({
        color: beforeColors[fromLane]!,
        fromLane,
        toLane,
        targetOid: oid,
        continues: true,
      });
    }

    for (const [index, toLane] of parentLanes.entries()) {
      segments.push({
        color: index === 0 ? color : colors[toLane]!,
        fromLane: lane,
        toLane,
        targetOid: parents[index]!,
        continues: true,
      });
    }

    const width = Math.max(before.length, lanes.length, 1);

    rows.push({ commit, color, lane, laneCount: width, segments });
  }

  while (lanes.length > 0 && lanes.at(-1) === undefined) lanes.pop();

  if (overflow) return textOnly();

  return {
    rows,
    boundary: {
      lanes,
      colors: { lanes: colors.slice(0, lanes.length), recent },
      ...(boundary.defaultBranchTips && { defaultBranchTips: boundary.defaultBranchTips }),
      ...(boundary.pinned && { pinned: true }),
    },
  };
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

// Each tip keeps its own checkpoint so changing selection or hover can drop just that path.
interface PathCheckpoint {
  next: ObjectId | undefined;
  edgeTargets: ReadonlySet<ObjectId>;
}

type PathBoundary = ReadonlyMap<ObjectId, PathCheckpoint>;

export interface GraphEmphasis {
  commits: ReadonlySet<ObjectId>;
  segments: ReadonlySet<DagSegment>;
  boundary: PathBoundary;
}

export function firstParentPaths(
  rows: readonly DagRow[],
  tips: readonly (ObjectId | null | undefined)[],
  boundary?: PathBoundary,
): GraphEmphasis | undefined {
  const uniqueTips = new Set(tips.filter((tip) => tip != null));
  const paths = [...uniqueTips].map((tip) => {
    const previous = boundary?.get(tip);
    return {
      tip,
      started: !!previous,
      next: previous ? previous.next : tip,
      edgeTargets: new Set(previous?.edgeTargets),
    };
  });
  if (!paths.length) return undefined;

  const commits = new Set<ObjectId>();
  const segments = new Set<DagSegment>();

  // Git returns children before parents. A lane can point at a shared ancestor
  // for many rows before an active child actually joins that lane.
  for (const row of rows) {
    const { oid, parents } = row.commit;
    const active = paths.some((path) => path.next === oid);
    if (active) commits.add(oid);

    for (const segment of row.segments) {
      const leavesCommit = !segment.incoming && segment.fromLane === row.lane;
      if (leavesCommit ? active : paths.some((path) => path.edgeTargets.has(segment.targetOid))) {
        segments.add(segment);
      }
    }

    for (const path of paths) {
      path.edgeTargets.delete(oid);
      if (path.next !== oid) continue;

      path.started = true;
      path.next = parents[0];
      if (!row.topologyUnavailable) {
        for (const parent of parents) path.edgeTargets.add(parent);
      }
    }
  }

  const nextBoundary = new Map<ObjectId, PathCheckpoint>();
  for (const path of paths) {
    if (!path.started) continue;
    if (path.next) commits.add(path.next);
    nextBoundary.set(path.tip, { next: path.next, edgeTargets: path.edgeTargets });
  }
  if (!nextBoundary.size) return undefined;

  for (const segment of segments) {
    if (!commits.has(segment.targetOid)) segments.delete(segment);
  }
  return { commits, segments, boundary: nextBoundary };
}
