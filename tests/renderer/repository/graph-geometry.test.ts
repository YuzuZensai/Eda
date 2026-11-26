import { edgePath, laneX, ROW_HEIGHT } from "@renderer/repository/graph-geometry";

const CENTER = ROW_HEIGHT / 2;

describe("commit graph edge geometry", () => {
  it("starts an edge leaving the commit at its node, not the row top", () => {
    const path = edgePath({ fromLane: 1, toLane: 0 }, 1, CENTER);
    expect(path.startsWith(`M ${laneX(1)} ${CENTER}`)).toBe(true);
  });

  it("spans the full row for a lane passing this commit by", () => {
    const path = edgePath({ fromLane: 2, toLane: 2 }, 0, CENTER);
    expect(path.startsWith(`M ${laneX(2)} 0`)).toBe(true);
    expect(path.endsWith(`${laneX(2)} ${ROW_HEIGHT}`)).toBe(true);
  });

  it("draws an incoming stub from the row top down to the node only", () => {
    const path = edgePath({ fromLane: 1, toLane: 1, incoming: true }, 1, CENTER);
    expect(path.startsWith(`M ${laneX(1)} 0`)).toBe(true);
    expect(path.endsWith(`${laneX(1)} ${CENTER}`)).toBe(true);
  });

  it("always ends an outgoing edge at the row bottom so it meets the next row", () => {
    for (const [from, to, lane] of [
      [0, 1, 0],
      [1, 0, 1],
      [2, 2, 0],
    ] as const) {
      const path = edgePath({ fromLane: from, toLane: to }, lane, CENTER);
      expect(path.endsWith(String(ROW_HEIGHT))).toBe(true);
    }
  });
});
