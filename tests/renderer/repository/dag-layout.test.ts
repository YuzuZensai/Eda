import { graphColor } from "@renderer/repository/graph-colors";
import type { HistoryCommit } from "@shared/repository/repository-read";
import {
  checkoutAncestry,
  firstParentPaths,
  layoutCommitPage,
  layoutCommitPages,
  MAX_DAG_LANES,
} from "@renderer/repository/dag-layout";

const commit = (oid: string, parents: string[]): HistoryCommit => ({
  oid,
  parents,
  author: { name: "A", email: "a@example.com", timestamp: "2026-01-01T00:00:00Z" },
  committerTimestamp: "2026-01-01T00:00:00Z",
  subject: oid,
  body: "",
  decorations: [],
});

describe("incremental DAG layout", () => {
  it("bounds extremely wide topology without drawing false connections", () => {
    const result = layoutCommitPage([
      commit(
        "wide",
        Array.from({ length: MAX_DAG_LANES + 1 }, (_, index) => `parent-${index}`),
      ),
    ]);

    expect(result.boundary).toEqual({ lanes: [], overflow: true });
    expect(result.rows[0]?.segments).toEqual([]);
    expect(result.rows[0]?.topologyUnavailable).toBe(true);
    expect(
      layoutCommitPage([commit("parent-0", [])], result.boundary).rows[0]?.topologyUnavailable,
    ).toBe(true);
  });

  it("keeps a pinned first-parent ancestry in lane zero when another tip reaches it first", () => {
    const pages = [[commit("other", ["base"]), commit("pin", ["base"])], [commit("base", [])]];
    const first = layoutCommitPage(pages[0]!, { lanes: ["pin"], pinned: true });
    const second = layoutCommitPage(pages[1]!, first.boundary);

    expect(first.rows.find((row) => row.commit.oid === "pin")?.lane).toBe(0);
    expect(second.rows[0]?.lane).toBe(0);
    expect([...first.rows, ...second.rows]).toEqual(
      layoutCommitPages(pages, { lanes: ["pin"], pinned: true }),
    );
  });

  it("is deterministic and preserves lanes across page boundaries", () => {
    const pages = [
      [commit("m", ["a", "b"]), commit("a", ["root"])],
      [commit("b", ["root"]), commit("root", [])],
    ];
    const first = layoutCommitPage(pages[0]!);
    const second = layoutCommitPage(pages[1]!, first.boundary);

    expect([...first.rows, ...second.rows]).toEqual(layoutCommitPages(pages));
    expect(second.boundary.lanes).toEqual([]);
    expect(first.rows[0]?.laneCount).toBe(2);
  });

  it("accents the default tip and its first-parent history across pages, including a shared ancestor", () => {
    const boundary = { lanes: [], defaultBranchTips: ["trunk"] };
    const rows = layoutCommitPages(
      [
        [commit("feature", ["base"]), commit("trunk", ["parent", "side"])],
        [commit("side", ["base"]), commit("parent", ["base"]), commit("base", [])],
      ],
      boundary,
    );
    const [feature, trunk, side, parent, base] = rows;
    expect(graphColor(trunk!.color)).toBe("var(--accent)");
    expect(graphColor(feature!.color)).not.toBe("var(--accent)");
    expect(graphColor(side!.color)).not.toBe("var(--accent)");
    expect(parent!.color).toBe(trunk!.color);
    expect(base!.color).toBe(trunk!.color);
    expect(trunk!.segments.find((edge) => edge.targetOid === "side")?.color).toBe(side!.color);
    expect(trunk!.segments.find((edge) => edge.targetOid === "parent")?.color).toBe(trunk!.color);
  });

  it("cycles through the fixed palette when unrelated tips reuse the same lane across pages", () => {
    const tips = Array.from({ length: 16 }, (_, index) => commit(String(index), []));
    const rows = layoutCommitPages([tips.slice(0, 5), tips.slice(5)]);
    expect(rows.every((row) => row.lane === 0)).toBe(true);
    expect(new Set(rows.slice(0, 8).map((row) => row.color)).size).toBe(8);
    expect(new Set(rows.map((row) => row.color)).size).toBe(8);
    expect(rows).toEqual(layoutCommitPage(tips).rows);
  });

  it("gives concurrent paths distinct colors before reuse and preserves them when lanes move", () => {
    const parents = Array.from({ length: 9 }, (_, index) => String(index));
    const rows = layoutCommitPages([
      [commit("merge", parents)],
      parents.map((id) => commit(id, [id + "-parent"])),
    ]);
    const edges = rows[0]!.segments;
    expect(new Set(edges.slice(0, 8).map((edge) => edge.color)).size).toBe(8);
    expect(edges[8]!.color).not.toBe(edges[7]!.color);
    expect(rows.slice(1).map((row) => row.color)).toEqual(edges.map((edge) => edge.color));

    const [root, child, parent] = layoutCommitPages(
      [[commit("root", []), commit("child", ["parent"])], [commit("parent", [])]],
      { lanes: ["root", "child"] },
    );
    expect(child!.lane).not.toBe(parent!.lane);
    expect(child!.color).toBe(parent!.color);
    expect(root!.color).not.toBe(child!.color);
  });

  it("ends a root commit lane instead of bending it into lane 0", () => {
    const boundary = { lanes: ["main", "side"] };
    const layout = layoutCommitPage([commit("side", [])], boundary);
    const row = layout.rows[0]!;

    expect(row.lane).toBe(1);
    expect(row.segments.filter((segment) => segment.continues && !segment.incoming)).toEqual([
      { color: 0, fromLane: 0, toLane: 0, targetOid: "main", continues: true },
    ]);
  });

  it("draws exactly one edge per parent from a merge commit", () => {
    const layout = layoutCommitPage([commit("m", ["a", "b"])], { lanes: ["m"] });
    const edges = layout.rows[0]!.segments.filter(
      (segment) => segment.continues && !segment.incoming,
    );

    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((edge) => edge.toLane)).size).toBe(2);
    expect(edges.map((edge) => edge.targetOid)).toEqual(["a", "b"]);
  });

  it("preserves an unrelated lane while advancing another branch", () => {
    const layout = layoutCommitPage([commit("tip", ["next"])], { lanes: ["tip", "other"] });
    const row = layout.rows[0]!;
    const other = row.segments.find((segment) => segment.fromLane === 1);

    expect(other).toEqual({
      color: 4,
      fromLane: 1,
      toLane: 1,
      targetOid: "other",
      continues: true,
    });
    expect(layout.boundary.lanes[1]).toBe("other");
  });

  it("holds an untouched lane in place when a root commit ends its own lane", () => {
    const layout = layoutCommitPage([commit("root", [])], { lanes: ["root", "x"] });
    const passthrough = layout.rows[0]!.segments.find((segment) => segment.fromLane === 1);

    expect(passthrough).toEqual({
      color: 4,
      fromLane: 1,
      toLane: 1,
      targetOid: "x",
      continues: true,
    });
    expect(layout.boundary.lanes[1]).toBe("x");
  });

  it("connects a commit to the lane arriving from the row above", () => {
    const layout = layoutCommitPage([commit("tip", ["parent"])], { lanes: ["tip"] });
    const row = layout.rows[0]!;

    expect(row.segments).toContainEqual({
      color: row.color,
      fromLane: 0,
      toLane: 0,
      targetOid: "tip",
      continues: true,
      incoming: true,
    });
  });

  it("does not draw an incoming edge for a branch tip with no commits above it", () => {
    const layout = layoutCommitPage([commit("tip", ["parent"])]);

    expect(layout.rows[0]!.segments.some((segment) => segment.incoming)).toBe(false);
  });

  it("does not mutate commits or incoming boundary state", () => {
    const boundary = { lanes: ["tip"] };
    const input = [commit("tip", ["parent"])];
    layoutCommitPage(input, boundary);
    expect(boundary).toEqual({ lanes: ["tip"] });
    expect(input[0]?.parents).toEqual(["parent"]);
  });

  it("tracks first-parent paths by commit across page boundaries and lane reuse", () => {
    const rows = layoutCommitPages([
      [commit("merge", ["main", "side"]), commit("main", ["base"])],
      [commit("side", ["base"]), commit("base", ["older"]), commit("unrelated", [])],
    ]);

    expect(firstParentPaths(rows, ["merge"])?.commits).toEqual(
      new Set(["merge", "main", "base", "older"]),
    );
    expect(firstParentPaths(rows, ["merge", "side"])?.commits).toEqual(
      new Set(["merge", "main", "base", "older", "side"]),
    );
    expect(firstParentPaths(rows, ["not-loaded"])).toBeUndefined();
  });

  it("keeps both sides of a checkout's merge in its ancestry across pages", () => {
    const first = layoutCommitPage([commit("head", ["main", "topic"]), commit("main", ["base"])]);
    const next = layoutCommitPage(
      [commit("other", ["base"]), commit("topic", ["base"]), commit("base", [])],
      first.boundary,
    );
    const checkpoint = checkoutAncestry(first.rows, "head")?.boundary;

    expect(checkoutAncestry(next.rows, "head", checkpoint)?.commits).toEqual(
      new Set(["topic", "base"]),
    );
    expect(checkoutAncestry(next.rows, "other", checkpoint)?.commits).toEqual(
      new Set(["other", "base"]),
    );
  });
});
