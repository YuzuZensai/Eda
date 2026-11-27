import { t, getLocale } from "@shared/i18n";
import { ProfileAvatar } from "../../components/ui/display/ProfileAvatar";
import { ButtonBase } from "../../components/ui/actions/ButtonBase";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { GraphColumn } from "@shared/preferences/graph-view";
import type {
  CommitDecoration,
  CommitSignatureVerification,
  RepositoryChange,
} from "@shared/repository/repository-read";
import type { DagRow, GraphEmphasis } from "../../repository/dag-layout";
import { ROW_HEIGHT, edgePath, laneColor, laneX } from "../../repository/graph-geometry";
import { referenceLabel } from "../../repository/reference-label";
import { GlobeIcon, MonitorIcon, TagIcon } from "../../components/ui/icons";
import { FileStatusIcon, fileStatusTone } from "../../components/ui/display/FileStatusIcon";
import { CommitSignatureIcon } from "../../components/ui/display/CommitSignatureIcon";
import { useCommitSignature } from "../../repository/hooks/useCommitSignature";
import { CommitTitleInput } from "../../components/ui/forms/CommitTitleInput";

// Use an opaque tint so overlapping line caps at row boundaries do not brighten the lane.
const DIMMED_GRAPH_COLOR = "color-mix(in srgb, currentColor 45%, var(--bg-base))";

export function CommitRow({
  row,
  checkoutRef,
  upstreams,
  loadedChildren,
  linkedWorktrees = [],
  rowHeight = ROW_HEIGHT,
  avatars = true,
  dateStyle = "short",
  columns,
  gutter,
  selected,
  related,
  graphEmphasis,
  vigilantMode = false,
  signature,
  repositoryId,
  workingTreeConnection,
  onSelect,
  onContextMenu,
}: {
  row: DagRow;
  checkoutRef?: string | undefined;
  upstreams?: ReadonlyMap<string, string>;
  rowHeight?: number;
  avatars?: boolean;
  dateStyle?: "short" | "local" | "iso";
  linkedWorktrees?: readonly string[];
  loadedChildren?: readonly string[];
  columns: GraphColumn[];
  gutter: number;
  selected: boolean;
  related: boolean;
  graphEmphasis?: GraphEmphasis | undefined;
  vigilantMode?: boolean;
  signature?: CommitSignatureVerification;
  repositoryId?: string;
  workingTreeConnection?: { lane: number; head: boolean } | undefined;
  onSelect: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const center = rowHeight / 2;
  const isMerge = row.commit.parents.length > 1;
  const emphasis = row.topologyUnavailable ? undefined : graphEmphasis;
  const emphasized = !emphasis || emphasis.commits.has(row.commit.oid);
  const nodeColor = emphasized ? "currentColor" : DIMMED_GRAPH_COLOR;

  return (
    <ButtonBase
      data-tour="history-commit"
      aria-description={
        [
          checkoutRef && t("history.commitRow.checkedOut"),
          loadedChildren &&
            t("commitGraph.loadedChildren", {
              children: loadedChildren.join(", ") || t("common.none"),
            }),
          ...linkedWorktrees,
        ]
          .filter(Boolean)
          .join(". ") || undefined
      }
      aria-pressed={selected}
      title={t("history.commitRow.parents", {
        subject: row.commit.subject,
        name: row.commit.author.name,
        oid: row.commit.oid,
        value4: row.commit.parents.join(", ") || t("history.commitRow.rootOrShallowBoundary"),
      })}
      aria-label={t("history.commitRow.commitDescription", {
        value1: row.commit.stashLabels?.join(". ") ?? row.commit.subject,
        oid: row.commit.oid.slice(0, 8),
        length: row.commit.parents.length,
        value4:
          row.commit.parents.map((oid) => oid.slice(0, 8)).join(", ") ||
          t("history.commitRow.rootOrShallowBoundary"),
      })}
      className={`flex w-full min-w-0 items-center border-b border-border-subtle text-left hover:bg-bg-raised ${selected || related ? "bg-accent-muted" : ""}`}
      style={{ height: rowHeight }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <svg
        width={gutter}
        height={rowHeight}
        className="shrink-0 overflow-visible"
        aria-hidden="true"
      >
        {workingTreeConnection && (
          <path
            d={
              workingTreeConnection.head
                ? `M ${laneX(workingTreeConnection.lane)} 0 C ${laneX(workingTreeConnection.lane)} ${center}, ${laneX(row.lane)} 0, ${laneX(row.lane)} ${center}`
                : `M ${laneX(workingTreeConnection.lane)} 0 V ${rowHeight}`
            }
            fill="none"
            stroke={laneColor(workingTreeConnection.lane)}
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        )}
        {row.segments
          .filter((segment) => segment.continues)
          .map((segment, index) => (
            <path
              key={index}
              d={edgePath(segment, row.lane, center)}
              fill="none"
              style={{
                color: laneColor(segment.fromLane === row.lane ? row.lane : segment.toLane),
              }}
              stroke={
                emphasis && !emphasis.segments.has(segment) ? DIMMED_GRAPH_COLOR : "currentColor"
              }
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          ))}
        {checkoutRef && (
          <circle
            cx={laneX(row.lane)}
            cy={center}
            r="8"
            fill="var(--bg-base)"
            stroke={laneColor(row.lane)}
            strokeWidth="1.5"
          >
            <title>{t("history.commitRow.checkedOut")}</title>
          </circle>
        )}
        <circle
          cx={laneX(row.lane)}
          cy={center}
          r={isMerge ? 4.5 : 3.75}
          style={{ color: laneColor(row.lane) }}
          fill={isMerge ? nodeColor : "var(--bg-base)"}
          stroke={nodeColor}
          strokeWidth="2"
        >
          {checkoutRef && <title>{t("history.commitRow.checkedOut")}</title>}
        </circle>
      </svg>
      <div className="flex min-w-0 flex-1 items-center gap-3 pr-3">
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
          {row.commit.stashLabels?.length ? (
            <span title={row.commit.stashLabels.join("\n")}>
              <span className="mr-2 rounded border border-border-default px-1 text-text-secondary">
                {t("history.commitRow.stash")}
              </span>
              {row.commit.stashLabels.join(", ")}
            </span>
          ) : (
            row.commit.subject
          )}
        </span>
        {linkedWorktrees.length > 0 && (
          <span
            title={linkedWorktrees.join("\n")}
            className="max-w-48 truncate text-xs text-text-secondary"
          >
            {linkedWorktrees.join(", ")}
          </span>
        )}
        <Decorations
          decorations={row.commit.decorations}
          upstreams={upstreams}
          checkoutRef={checkoutRef}
        />
        {columns
          .filter((column) => column.visible)
          .map((column) => (
            <span
              key={column.id}
              style={{ width: column.width }}
              title={
                column.id === "author"
                  ? row.commit.author.email
                  : column.id === "sha"
                    ? row.commit.oid
                    : row.commit.committerTimestamp
              }
              className="hidden shrink-0 truncate text-xs text-text-tertiary @xl:block"
            >
              {column.id === "author" ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  {avatars && (
                    <ProfileAvatar
                      name={row.commit.author.name}
                      email={row.commit.author.email}
                      {...(repositoryId && { repositoryId })}
                      hue={210}
                      compact
                    />
                  )}
                  <span className="truncate">{row.commit.author.name}</span>
                </span>
              ) : column.id === "date" ? (
                formatDate(row.commit.committerTimestamp, dateStyle)
              ) : (
                <span className="flex min-w-0 items-center gap-1">
                  {vigilantMode &&
                    (signature ? (
                      <CommitSignatureIcon signature={signature} focusable={false} />
                    ) : (
                      <HistorySignatureIcon oid={row.commit.oid} />
                    ))}
                  <span className="mono truncate">{row.commit.oid.slice(0, 7)}</span>
                </span>
              )}
            </span>
          ))}
      </div>
    </ButtonBase>
  );
}

export function WorkingTreeRow({
  changes,
  rowHeight = ROW_HEIGHT,
  truncated,
  gutter,
  lane,
  selected,
  title,
  titleDisabled,
  onTitleChange,
  onSelect,
}: {
  rowHeight?: number;
  changes: readonly RepositoryChange[];
  truncated: boolean;
  gutter: number;
  lane: number | undefined;
  selected: boolean;
  title: string;
  titleDisabled: boolean;
  onTitleChange: (title: string) => void;
  onSelect: () => void;
}) {
  const descriptionKey = truncated
    ? "commitChangesPanel.workingTreeChangesTruncated"
    : "commitChangesPanel.workingTreeChanges";
  const description = t(descriptionKey, { count: changes.length });
  const nodeLane = lane ?? 0;
  let conflicts = 0;
  let addedCount = 0;
  let deletedCount = 0;

  for (const change of changes) {
    if (change.kind === "unmerged" || change.index === "U" || change.worktree === "U") {
      conflicts++;
      continue;
    }

    if (change.index === "D" || change.worktree === "D") deletedCount += 1;
    else if (change.kind === "untracked" || change.index === "A" || change.worktree === "?")
      addedCount += 1;
  }

  const otherCount = changes.length - addedCount - deletedCount - conflicts;

  return (
    <div
      data-tour="history-working-tree"
      className={`flex w-full min-w-0 cursor-pointer items-center border-b border-border-subtle text-left hover:bg-bg-raised ${selected ? "bg-accent-muted" : ""}`}
      style={{ height: rowHeight }}
      onClick={onSelect}
    >
      <ButtonBase
        aria-label={t("commitGraph.viewWorkingChanges", { description })}
        aria-pressed={selected}
        title={description}
        className="flex h-full shrink-0 items-center"
      >
        <svg width={gutter} height={rowHeight} className="shrink-0" aria-hidden="true">
          {lane !== undefined && (
            <path
              d={`M ${laneX(lane)} ${rowHeight / 2} V ${rowHeight}`}
              stroke={laneColor(lane)}
              strokeWidth="1.75"
            />
          )}
          <circle
            cx={laneX(nodeLane)}
            cy={rowHeight / 2}
            r="5"
            fill="var(--bg-base)"
            stroke={laneColor(nodeLane)}
            strokeWidth="1.75"
            strokeDasharray="2 2"
          />
        </svg>
      </ButtonBase>

      <div className="w-80 min-w-0 shrink pr-3">
        {conflicts > 0 ? (
          <ButtonBase className="w-full truncate text-left text-xs font-medium text-git-conflict">
            {t("commitGraph.conflictedFiles", { count: conflicts })}
          </ButtonBase>
        ) : (
          <CommitTitleInput
            aria-label={t("commitGraph.workingTreeCommitTitle")}
            placeholder={t("changesPanel.workingTree")}
            style={{ height: rowHeight - 6 }}
            value={title}
            disabled={titleDisabled}
            onChange={onTitleChange}
            onFocus={onSelect}
            onClick={(event) => event.stopPropagation()}
          />
        )}
      </div>

      {(
        [
          {
            count: addedCount,
            status: "A",
            label: t("changesPanel.added"),
          },
          {
            count: otherCount,
            status: "M",
            label: t(descriptionKey, { count: otherCount }),
          },
          {
            count: deletedCount,
            status: "D",
            label: t("changesPanel.deleted"),
          },
        ] as const
      ).map(({ count, status, label }) =>
        count > 0 ? (
          <span
            key={status}
            className={`flex shrink-0 items-center gap-1.5 pr-3 text-sm ${fileStatusTone(status)}`}
            title={label}
          >
            <FileStatusIcon status={status} />
            <span>{truncated ? `${count}+` : count}</span>
          </span>
        ) : null,
      )}
    </div>
  );
}

function HistorySignatureIcon({ oid }: { oid: string }) {
  const signature = useCommitSignature(oid);

  return (
    <CommitSignatureIcon signature={signature} verifying={signature === null} focusable={false} />
  );
}

function Decorations({
  decorations,
  upstreams,
  checkoutRef,
}: {
  decorations: CommitDecoration[];
  checkoutRef: string | undefined;
  upstreams: ReadonlyMap<string, string> | undefined;
}) {
  if (!decorations.length && !checkoutRef) return null;

  const refs: CommitDecoration[] = [];
  if (checkoutRef) refs.push({ type: "head", name: checkoutRef });
  for (const ref of decorations) {
    if ((ref.type === "head" || ref.type === "ref") && ref.name === "HEAD") continue;
    if ((ref.type === "head" || ref.type === "local-branch") && ref.name === checkoutRef) continue;
    refs.push(ref.type === "head" ? { ...ref, type: "local-branch" } : ref);
  }

  const remoteNames = new Set(
    refs.filter((ref) => ref.type === "remote-branch").map((ref) => ref.name),
  );
  const paired = new Map<string, string>();
  for (const ref of refs) {
    if (ref.type !== "head" && ref.type !== "local-branch") continue;
    const upstream = upstreams?.get(ref.name);
    if (upstream && remoteNames.has(upstream) && !upstream.endsWith("/HEAD"))
      paired.set(ref.name, upstream);
  }
  const groupedRemotes = new Set(paired.values());
  const rank = (ref: CommitDecoration) => (ref.type === "head" ? 0 : ref.type === "tag" ? 2 : 1);
  const ordered = refs
    .filter(
      (ref) =>
        ref.type !== "remote-branch" ||
        (!groupedRemotes.has(ref.name) && !ref.name.endsWith("/HEAD")),
    )
    .sort((a, b) => rank(a) - rank(b))
    .map((ref) => {
      const upstream =
        ref.type === "head" || ref.type === "local-branch" ? paired.get(ref.name) : undefined;
      const suffix = "/" + ref.name;
      const remoteLabel = upstream?.endsWith(suffix) ? upstream.slice(0, -suffix.length) : upstream;
      return { ...ref, remoteLabel, title: upstream ? `${ref.name} · ${upstream}` : ref.name };
    });
  if (!ordered.length) return null;
  const shown = ordered.slice(0, 2);
  const overflow = ordered.length - shown.length;

  return (
    <span
      className={`min-w-0 max-w-[32%] items-baseline gap-2 text-xs ${checkoutRef ? "flex" : "hidden @sm:flex"}`}
    >
      {shown.map((decoration) => (
        <span
          key={`${decoration.type}:${decoration.name}`}
          title={decoration.title}
          className={`min-w-0 max-w-48 items-center gap-1 ${decoration.type === "head" ? "inline-flex font-medium text-accent-text" : "hidden text-text-secondary @sm:inline-flex"}`}
        >
          {decoration.type === "head" && (
            <span title={t("history.commitRow.checkedOut")} className="shrink-0">
              <MonitorIcon size={12} aria-hidden />
            </span>
          )}
          {decoration.type === "tag" && <TagIcon size={10} className="shrink-0" aria-hidden />}
          {decoration.type === "remote-branch" && (
            <GlobeIcon size={12} className="shrink-0" aria-hidden />
          )}
          <span className="truncate">
            {(decoration.type === "remote-branch" || decoration.type === "local-branch") &&
            decoration.name.length > 24
              ? referenceLabel(decoration.name).name
              : decoration.name}
          </span>
          {decoration.remoteLabel && (
            <span className="hidden min-w-0 items-center gap-1 font-normal text-text-tertiary @sm:inline-flex">
              {" "}
              <GlobeIcon size={12} className="shrink-0" aria-hidden />
              <span className="truncate">{decoration.remoteLabel}</span>
            </span>
          )}
        </span>
      ))}
      {overflow > 0 && (
        <span
          title={ordered
            .slice(2)
            .map((item) => item.title)
            .join("\n")}
          className="mono hidden shrink-0 text-xs text-text-tertiary @sm:inline"
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

function formatDate(value: string, style: "short" | "local" | "iso"): string {
  const date = new Date(value);

  if (Number.isNaN(date.valueOf())) return value;

  if (style === "iso") return date.toISOString();
  if (style === "local") return date.toLocaleString(getLocale());

  const sameYear = date.getFullYear() === new Date().getFullYear();

  return new Intl.DateTimeFormat(getLocale(), {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "2-digit" }),
  }).format(date);
}
