import type { DagRow, DagSegment } from "./dag-layout";

export const ROW_HEIGHT = 30;
export const GRAPH_LANE_COUNT = 6;

const LANE_WIDTH = 16;
const LANE_ORIGIN = 14;

export const laneColor = (lane: number) => `var(--graph-lane-${lane % GRAPH_LANE_COUNT})`;
export const laneX = (lane: number) => LANE_ORIGIN + lane * LANE_WIDTH;

const rowGraphWidth = (laneCount: number) =>
  Math.max(40, laneCount * LANE_WIDTH + LANE_ORIGIN + 10);

export function graphColumnWidth(rows: readonly DagRow[], minimumLanes = 1): number {
  let widest = minimumLanes;
  for (const row of rows) if (row.laneCount > widest) widest = row.laneCount;
  return rowGraphWidth(widest);
}

export function edgePath(
  segment: Pick<DagSegment, "fromLane" | "toLane" | "incoming">,
  commitLane: number,
  center: number,
): string {
  const from = laneX(segment.fromLane);
  const to = laneX(segment.toLane);

  if (segment.incoming) return `M ${to} 0 L ${to} ${center}`;

  const height = center * 2;
  const startY = segment.fromLane === commitLane ? center : 0;

  return `M ${from} ${startY} C ${from} ${(startY + height) / 2}, ${to} ${(startY + height) / 2}, ${to} ${height}`;
}
