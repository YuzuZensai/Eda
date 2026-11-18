import type { MessageKey } from "@shared/i18n";
import type { FileView } from "@shared/preferences/file-view";
import type { ChangeArea, RepositoryChange } from "@shared/repository/repository-read";
import {
  buildChangeTree,
  flattenChangeTree,
  type ChangeTreeNode,
} from "../../repository/change-tree";

export const CHANGE_AREA_LABELS = {
  conflicted: "changes.changeListModel.conflicts",
  staged: "changes.changeListModel.staged",
  unstaged: "changes.changeListModel.unstaged",
  untracked: "changes.changeListModel.untracked",
} satisfies Record<ChangeArea, MessageKey>;

export type ChangeListRow =
  | { kind: "heading"; area: ChangeArea; changes: RepositoryChange[] }
  | { kind: "change"; area: ChangeArea; change: RepositoryChange; depth: number }
  | { kind: "directory"; area: ChangeArea; node: ChangeTreeNode; depth: number };

export function buildChangeRows(
  categories: Record<ChangeArea, RepositoryChange[]>,
  files: FileView,
): ChangeListRow[] {
  const collapsedDirs = new Set(files.collapsed);
  const untracked = new Set(categories.untracked);
  const sections = ["conflicted", "staged", "unstaged"] as const;

  return sections.flatMap((area): ChangeListRow[] => {
    const changes =
      area === "unstaged" ? [...categories.unstaged, ...categories.untracked] : categories[area];

    if (changes.length === 0) return [];

    const heading = { kind: "heading" as const, area, changes };
    const changeArea = (change: RepositoryChange): ChangeArea =>
      area === "unstaged" && untracked.has(change) ? "untracked" : area;

    if (files.mode !== "tree") {
      return [
        heading,
        ...changes.map((change) => ({
          kind: "change" as const,
          area: changeArea(change),
          change,
          depth: 0,
        })),
      ];
    }

    const collapsedForArea = new Set(
      [...collapsedDirs]
        .filter((key) => key.startsWith(`${area}:`))
        .map((key) => key.slice(area.length + 1)),
    );

    return [
      heading,
      ...flattenChangeTree(buildChangeTree(changes), collapsedForArea, 0).map((row) =>
        row.node.kind === "file"
          ? {
              kind: "change" as const,
              area: changeArea(row.node.change),
              change: row.node.change,
              depth: row.depth,
            }
          : { kind: "directory" as const, area, node: row.node, depth: row.depth },
      ),
    ];
  });
}

export function changeTreePaths(node: ChangeTreeNode): string[] {
  if (node.kind === "file") return [node.path];
  return node.children.flatMap(changeTreePaths);
}
