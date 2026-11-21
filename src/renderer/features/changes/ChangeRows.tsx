import { t } from "@shared/i18n";
import { ButtonBase } from "../../components/ui/actions/ButtonBase";
import { FileStatusIcon, fileStatusTone } from "../../components/ui/display/FileStatusIcon";
import { CHANGE_AREA_LABELS } from "./change-list-model";
import type { RepositoryChange } from "@shared/repository/repository-read";
import type { ChangeArea } from "../../stores/repository-store";
import { collapsedDescendants, type ChangeTreeNode } from "../../repository/change-tree";
import {
  CheckboxControl,
  ChevronDownIcon,
  ChevronRightIcon,
  IconButton,
  MinusIcon,
  PlusIcon,
} from "../../components/ui/index";

export interface ContextMenuPosition {
  x: number;
  y: number;
}

export function DirectoryRow({
  node,
  depth,
  collapsed,
  writing,
  stageable,
  staged,
  onToggle,
  onToggleStage,
}: {
  node: ChangeTreeNode;
  depth: number;
  collapsed: boolean;
  writing: boolean;
  stageable: boolean;
  staged: boolean;
  onToggle: () => void;
  onToggleStage: () => void;
}) {
  return (
    <div
      className="ui-interactive group/row flex h-9 w-full min-w-0 items-center gap-1 pr-1 hover:bg-bg-raised"
      style={{ paddingLeft: `${12 + depth * 12}px` }}
    >
      <ButtonBase
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? t("changes.changeRows.expand") : t("changes.changeRows.collapse")} ${node.path}`}
        className="flex h-full min-w-0 flex-1 items-center gap-1 text-left text-text-secondary"
        title={node.path}
      >
        <span className="shrink-0 text-text-tertiary">
          {collapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
        </span>
        <span className="min-w-0 truncate text-xs">{node.name}</span>
        {collapsed && (
          <span className="mono shrink-0 text-xs text-text-tertiary">
            {collapsedDescendants(node)}
          </span>
        )}
      </ButtonBase>
      {stageable && (
        <IconButton
          size="xs"
          disabled={writing}
          onClick={onToggleStage}
          aria-label={t("changes.changeRows.everythingIn", {
            value1: staged ? t("changes.changeRows.unstage") : t("changes.changeRows.stage"),
            path: node.path,
          })}
          title={
            staged ? t("changes.changeRows.unstageFolder") : t("changes.changeRows.stageFolder")
          }
          className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
          icon={staged ? <MinusIcon size={13} /> : <PlusIcon size={13} />}
        />
      )}
    </div>
  );
}

export function ChangeRow({
  change,
  area,
  depth,
  showDirectory,
  selected,
  writing,
  onSelect,
  onToggleStage,
  checked,
  onCheck,
  onOpenMenu,
}: {
  change: RepositoryChange;
  area: ChangeArea;
  depth: number;
  showDirectory: boolean;
  selected: boolean;
  writing: boolean;
  checked: boolean;
  onCheck: () => void;
  onOpenMenu?: (position: ContextMenuPosition) => void;
  onSelect: () => void;
  onToggleStage: () => void;
}) {
  const name = change.path.split("/").at(-1) ?? change.path;
  const directory = change.path
    .slice(0, Math.max(0, change.path.length - name.length))
    .replace(/\/$/, "");
  const stageable = area !== "conflicted";
  const status =
    area === "staged" ? change.index : change.worktree !== "." ? change.worktree : change.index;

  return (
    <div
      onContextMenu={(event) => {
        if (!onOpenMenu) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (
          onOpenMenu &&
          (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
        ) {
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          onOpenMenu({ x: bounds.left + 24, y: bounds.bottom });
        }
      }}
      className={`ui-interactive group/row flex h-9 w-full min-w-0 items-center gap-2 pr-1 ${selected ? "bg-accent-muted" : "hover:bg-bg-raised"}`}
      style={{ paddingLeft: `${12 + depth * 12}px` }}
    >
      {stageable && (
        <CheckboxControl
          aria-label={t("changes.changeRows.select", { area: area, path: change.path })}
          checked={checked}
          onChange={onCheck}
          className="shrink-0"
        />
      )}
      <ButtonBase
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onSelect}
        title={`${change.path}${change.originalPath ? t("changes.changeRows.from", { originalPath: change.originalPath }) : ""}${change.submodule !== "N..." ? t("changes.changeRows.submodule", { submodule: change.submodule }) : ""}`}
        aria-label={
          area === "conflicted"
            ? t("changes.changeRows.resolveConflict", { path: change.path })
            : t("changes.changeRows.status", {
                value1: t(CHANGE_AREA_LABELS[area]),
                path: change.path,
                value3: area === "staged" ? change.index : change.worktree,
                value4: change.originalPath
                  ? t("changes.changeRows.renamedFrom", { originalPath: change.originalPath })
                  : "",
              })
        }
      >
        <span
          aria-hidden="true"
          className={`mono flex w-3.5 shrink-0 items-center justify-center text-xs font-semibold ${area === "conflicted" ? "text-git-conflict" : fileStatusTone(status)}`}
        >
          <FileStatusIcon status={status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-text-primary">{name}</span>
          {showDirectory && directory && (
            <span className="block truncate text-xs text-text-tertiary">{directory}</span>
          )}
        </span>
      </ButtonBase>
      {stageable && (
        <IconButton
          size="xs"
          disabled={writing}
          onClick={onToggleStage}
          aria-label={`${area === "staged" ? t("changes.changeRows.unstage") : t("changes.changeRows.stage")} ${change.path}`}
          title={
            area === "staged" ? t("changes.changeRows.unstage") : t("changes.changeRows.stage")
          }
          className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100"
          icon={area === "staged" ? <MinusIcon size={13} /> : <PlusIcon size={13} />}
        />
      )}
    </div>
  );
}
