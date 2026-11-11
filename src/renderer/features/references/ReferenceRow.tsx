import { t } from "@shared/i18n";
import type { BranchSummary } from "@shared/repository/repository-write";
import { cx, ListItemButton } from "../../components/ui/index";
import { useRepositoryStore } from "../../stores/repository-store";
import type { TagReference } from "./hooks/useTagReferences";
import type { ReferenceTarget } from "./ReferenceMenu";

export function ReferenceRow({
  item,
  selected,
  onActions,
  onCheckout,
}: {
  item: BranchSummary | TagReference;
  selected: boolean;
  onActions: (target: ReferenceTarget) => void;
  onCheckout: (branch: BranchSummary) => void;
}) {
  const tag = "isHead" in item ? null : item;

  const tagTarget = tag
    ? {
        kind: "tag" as const,
        ref: tag,
        local: tag.local,
        remoteNames: tag.remotes.map((remote) => remote.name),
        ...(!tag.local && tag.remotes[0]
          ? { remoteName: tag.remotes[0].name, remoteOid: tag.remotes[0].oid }
          : {}),
      }
    : null;

  const openActions = (position: { x: number; y: number }) => {
    onActions(
      "isHead" in item
        ? { kind: "branch", ref: item, ...position }
        : { ...tagTarget!, ...position },
    );
  };

  const tagStatus = tag
    ? [
        tag.local ? t("referenceSidebar.localTagIndicator") : "",
        tag.remotes.length
          ? t("referenceSidebar.remoteTagIndicator", {
              remotes: tag.remotes.map((remote) => remote.name).join(", "),
            })
          : "",
        tag.remoteStatusUnavailable ? t("referenceSidebar.remoteTagStatusUnavailable") : "",
        tag.unknownRemotes.length
          ? t("referenceSidebar.remoteTagUnavailable", {
              remotes: tag.unknownRemotes.join(", "),
            })
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const head = "isHead" in item && item.isHead === true;
  const displayName =
    tag && !tag.local && tag.remotes[0] ? `${tag.remotes[0].name}/${item.name}` : item.name;

  return (
    <ListItemButton
      title={[
        t("referenceSidebar.inspect", {
          name: item.name,
          value2: head ? t("referenceSidebar.currentBranch") : "",
          oid: item.oid.slice(0, 8),
        }),
        tagStatus,
      ]
        .filter(Boolean)
        .join("\n")}
      aria-label={t("referenceSidebar.inspectReference", {
        value1: tag !== null ? t("referenceSidebar.tag") : t("referenceSidebar.branch"),
        name: item.name,
      })}
      aria-pressed={selected}
      onClick={(event) => {
        if (tagTarget && !tagTarget.local) {
          const bounds = event.currentTarget.getBoundingClientRect();
          openActions({ x: bounds.right, y: bounds.top });
        } else void useRepositoryStore.getState().jumpToCommit(item.oid);
      }}
      onDoubleClick={() => {
        if ("isHead" in item && !item.remote && !item.isHead && !item.worktreePath)
          onCheckout(item);
      }}
      onMouseEnter={() => useRepositoryStore.setState({ hoveredRefOid: item.oid })}
      onMouseLeave={() => useRepositoryStore.setState({ hoveredRefOid: null })}
      onFocus={() => useRepositoryStore.setState({ hoveredRefOid: item.oid })}
      onBlur={() => useRepositoryStore.setState({ hoveredRefOid: null })}
      onContextMenu={(event) => {
        event.preventDefault();
        openActions({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          openActions({ x: bounds.right, y: bounds.top });
        }
      }}
      selected={selected}
      className="py-1.5 pl-[51px] text-xs"
    >
      <span className={cx("min-w-0 flex-1 truncate", head && "font-medium text-accent-text")}>
        {displayName}
      </span>

      {tag?.localOnly && (
        <span
          className="shrink-0 rounded-sm bg-bg-raised px-1.5 py-0.5 text-xs leading-none text-text-secondary"
          title={tagStatus}
        >
          {t("referenceSidebar.localLocation")}
        </span>
      )}
    </ListItemButton>
  );
}
