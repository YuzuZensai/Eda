import { MAX_FILE_VIEW_PATHS, type FileView } from "@shared/preferences/file-view";
import { t } from "@shared/i18n";

import type { RepositoryChange } from "@shared/repository/repository-read";
import type { ChangeArea, RepositorySelection } from "../../stores/repository-store";
import { VirtualRows } from "../../components/ui/display/VirtualRows";
import { ChangeRow, DirectoryRow, type ContextMenuPosition } from "./ChangeRows";
import { CHANGE_AREA_LABELS, changeTreePaths, type ChangeListRow } from "./change-list-model";
import { Button, TextButton } from "../../components/ui/index";

export function ChangeList({
  rows,
  files,
  selection,
  writing,
  truncated,
  totalChanges,
  onUpdateFiles,
  onSelectChange,
  onStage,
  onUnstage,
  onOpenMenu,
}: {
  rows: ChangeListRow[];
  files: FileView;
  selection: RepositorySelection;
  writing: boolean;
  truncated: boolean;
  totalChanges: number | undefined;
  onUpdateFiles: (change: Partial<FileView>) => void;
  onSelectChange: (change: RepositoryChange, area: ChangeArea) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onOpenMenu?: (position: ContextMenuPosition, change: RepositoryChange, area: ChangeArea) => void;
}) {
  const checked = new Set(files.selected);
  const collapsedDirs = new Set(files.collapsed);
  const toggleDirectory = (path: string) => {
    const next = new Set(collapsedDirs);
    if (!next.delete(path)) next.add(path);
    onUpdateFiles({ collapsed: [...next] });
  };

  return (
    <div className="min-h-0 flex-1 py-1">
      {rows.length === 0 && totalChanges !== 0 && (
        <p className="px-3 py-4 text-xs text-text-tertiary">
          {t("changes.changeList.noFilesMatchTheCurrentFilters")}
          <TextButton onClick={() => onUpdateFiles({ query: "", status: "" })}>
            {t("changes.changeList.clearFilters")}
          </TextButton>
        </p>
      )}
      {totalChanges === 0 && (
        <p className="px-3 py-4 text-xs text-text-tertiary">
          {t("changes.changeList.workingTreeClean")}
        </p>
      )}
      {rows.length > 0 && (
        <VirtualRows
          ariaLabel={t("changes.changeList.changedFiles")}
          horizontalScroll={false}
          revealIndex={rows.findIndex(
            (row) =>
              row.kind === "change" &&
              selection?.kind === "change" &&
              row.change.path === selection.path &&
              row.area === selection.area,
          )}
          items={rows}
          rowHeight={36}
          className="h-full"
          renderRow={(row, index) =>
            row.kind === "heading" ? (
              <div
                key={`${row.area}:${index}`}
                className="flex h-9 items-center gap-2 px-3 text-xs font-semibold text-text-tertiary"
              >
                <span>{t(CHANGE_AREA_LABELS[row.area])}</span>
                <span className="mono">{row.changes.length}</span>
                {row.area !== "conflicted" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={writing}
                    data-tour={row.area === "unstaged" ? "stage-all" : undefined}
                    onClick={() =>
                      void (row.area === "staged"
                        ? onUnstage(row.changes.map((c) => c.path))
                        : onStage(row.changes.map((c) => c.path)))
                    }
                    className="ml-auto"
                  >
                    {row.area === "staged"
                      ? t("changes.changeList.unstageAll")
                      : t("changes.changeList.stageAll")}
                  </Button>
                )}
              </div>
            ) : row.kind === "directory" ? (
              <DirectoryRow
                key={`${row.area}:dir:${row.node.path}`}
                node={row.node}
                depth={row.depth}
                writing={writing}
                collapsed={collapsedDirs.has(`${row.area}:${row.node.path}`)}
                onToggle={() => toggleDirectory(`${row.area}:${row.node.path}`)}
                onToggleStage={() => {
                  const paths = changeTreePaths(row.node);
                  void (row.area === "staged" ? onUnstage(paths) : onStage(paths));
                }}
                stageable={row.area !== "conflicted"}
                staged={row.area === "staged"}
              />
            ) : (
              <ChangeRow
                key={`${row.area}:${row.change.path}`}
                change={row.change}
                area={row.area}
                depth={row.depth}
                showDirectory={files.mode === "path"}
                checked={checked.has(`${row.area}:${row.change.path}`)}
                onCheck={() => {
                  const next = new Set(checked);
                  const key = `${row.area}:${row.change.path}`;
                  if (!next.delete(key)) next.add(key);
                  onUpdateFiles({ selected: [...next].slice(-MAX_FILE_VIEW_PATHS) });
                }}
                writing={writing}
                selected={
                  selection?.kind === "change" &&
                  selection.path === row.change.path &&
                  selection.area === row.area
                }
                onOpenMenu={(position) => onOpenMenu?.(position, row.change, row.area)}
                onSelect={() => void onSelectChange(row.change, row.area)}
                onToggleStage={() =>
                  void (row.area === "staged"
                    ? onUnstage([row.change.path])
                    : onStage([row.change.path]))
                }
              />
            )
          }
        />
      )}
      {truncated && (
        <p className="px-3 py-2 text-xs text-git-modified">
          {t("changes.changeList.onlyTheFirst5000ChangesAreRetained")}
        </p>
      )}
    </div>
  );
}
