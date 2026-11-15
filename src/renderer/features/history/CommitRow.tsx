import { t, getLocale } from "@shared/i18n";
import { ProfileAvatar } from "../../components/ui/display/ProfileAvatar";
import { ButtonBase } from "../../components/ui/actions/ButtonBase";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { GraphColumn } from "@shared/preferences/graph-view";
import type {
  CommitDecoration,
  CommitSignatureVerification,
} from "@shared/repository/repository-read";
import type { DagRow } from "../../repository/dag-layout";
import { ROW_HEIGHT, edgePath, laneColor, laneX } from "../../repository/graph-geometry";
import { referenceLabel } from "../../repository/reference-label";
import { TagIcon } from "../../components/ui/index";
import { CommitSignatureIcon } from "../../components/ui/display/CommitSignatureIcon";
import { useCommitSignature } from "../../repository/hooks/useCommitSignature";

export function CommitRow({
  row,
  columns,
  gutter,
  selected,
  related,
  vigilantMode = false,
  signature,
  repositoryId,
  onSelect,
  onContextMenu,
}: {
  row: DagRow;
  columns: GraphColumn[];
  gutter: number;
  selected: boolean;
  related: boolean;
  vigilantMode?: boolean;
  signature?: CommitSignatureVerification;
  repositoryId?: string;
  onSelect: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const center = ROW_HEIGHT / 2;
  const isMerge = row.commit.parents.length > 1;

  return (
    <ButtonBase
      data-tour="history-commit"
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
      style={{ height: ROW_HEIGHT }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <svg
        width={gutter}
        height={ROW_HEIGHT}
        className="shrink-0 overflow-visible"
        aria-hidden="true"
      >
        {row.segments
          .filter((segment) => segment.continues)
          .map((segment, index) => (
            <path
              key={index}
              d={edgePath(segment, row.lane, center)}
              fill="none"
              stroke={laneColor(segment.fromLane === row.lane ? row.lane : segment.toLane)}
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          ))}
        <circle
          cx={laneX(row.lane)}
          cy={center}
          r={isMerge ? 4.5 : 3.75}
          fill={isMerge ? laneColor(row.lane) : "var(--bg-base)"}
          stroke={laneColor(row.lane)}
          strokeWidth="2"
        />
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
        <Decorations decorations={row.commit.decorations} />
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
                  <ProfileAvatar
                    name={row.commit.author.name}
                    email={row.commit.author.email}
                    {...(repositoryId && { repositoryId })}
                    hue={210}
                    compact
                  />
                  <span className="truncate">{row.commit.author.name}</span>
                </span>
              ) : column.id === "date" ? (
                formatDate(row.commit.committerTimestamp)
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

function HistorySignatureIcon({ oid }: { oid: string }) {
  const signature = useCommitSignature(oid);

  return <CommitSignatureIcon signature={signature} verifying={!signature} focusable={false} />;
}

function Decorations({ decorations }: { decorations: CommitDecoration[] }) {
  if (decorations.length === 0) return null;

  const rank = (decoration: CommitDecoration) =>
    decoration.type === "head" ? 0 : decoration.type === "tag" ? 2 : 1;
  const ordered = decorations
    .filter(
      (decoration) => !(decoration.type === "remote-branch" && decoration.name.endsWith("/HEAD")),
    )
    .sort((a, b) => rank(a) - rank(b));
  const shown = ordered.slice(0, 2);
  const overflow = ordered.length - shown.length;

  return (
    <span className="hidden max-w-[32%] shrink-0 items-center gap-1 @sm:flex">
      {shown.map((decoration) => (
        <span
          key={`${decoration.type}:${decoration.name}`}
          title={decoration.name}
          className={`max-w-36 truncate rounded-sm border px-1.5 py-0.5 text-xs leading-tight ${
            decoration.type === "head"
              ? "border-accent-border bg-accent-muted font-medium text-accent-text"
              : decoration.type === "tag"
                ? "border-git-modified/40 bg-git-modified/10 text-git-modified"
                : "border-border-default bg-bg-raised text-text-secondary"
          }`}
        >
          {decoration.type === "head" && t("history.commitRow.head")}
          {decoration.type === "tag" && (
            <TagIcon size={10} className="inline shrink-0 align-[-1px]" aria-hidden />
          )}
          {decoration.type === "tag" ? " " : ""}
          {(decoration.type === "remote-branch" || decoration.type === "local-branch") &&
          decoration.name.length > 24
            ? referenceLabel(decoration.name).name
            : decoration.name}
        </span>
      ))}
      {overflow > 0 && (
        <span
          title={ordered
            .slice(2)
            .map((item) => item.name)
            .join("\n")}
          className="mono shrink-0 text-xs text-text-tertiary"
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.valueOf())) return value;

  const sameYear = date.getFullYear() === new Date().getFullYear();

  return new Intl.DateTimeFormat(getLocale(), {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "2-digit" }),
  }).format(date);
}
