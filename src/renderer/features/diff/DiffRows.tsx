import { stateLabel } from "@shared/i18n/labels";
import { t } from "@shared/i18n";
import { ButtonBase } from "../../components/ui/actions/ButtonBase";
import {
  ChevronDownIcon as ChevronDown,
  ChevronRightIcon as ChevronRight,
  FileIcon as File,
  PlusIcon as Plus,
  MinusIcon as Minus,
} from "../../components/ui/icons";
import { useMemo } from "react";
import {
  emphasizeWords,
  highlightLine,
  type SideBySideRow,
  type TextToken,
  type UnifiedRow,
} from "../../repository/diff-model";
import { diffSearchMatches } from "../../repository/diff-search";
import { PartialLineControl } from "../changes/PartialStageControls";

export const DIFF_ROW_HEIGHT = 24;

export function DiffSummaryRow({
  row,
  onToggle,
  onToggleRegion,
  query = "",
  active = false,
}: {
  row: UnifiedRow;
  query?: string;
  active?: boolean;
  onToggleRegion?: (key: string) => void;
  onToggle: (index: number, value: boolean) => void;
}) {
  if (row.contextRegion && onToggleRegion)
    return (
      <ButtonBase
        className="block w-full bg-bg-surface px-3 text-left text-accent-text"
        style={{ height: DIFF_ROW_HEIGHT }}
        aria-expanded={!row.contextRegion.collapsed}
        onClick={() => onToggleRegion(row.key)}
      >
        {t(row.contextRegion.collapsed ? "diff.options.showRegion" : "diff.options.hideRegion", {
          count: row.contextRegion.count,
        })}
      </ButtonBase>
    );
  if (!row.file)
    return (
      <div
        title={row.text}
        className="app-surface-chrome min-w-full bg-bg-surface px-5 text-text-tertiary"
        style={{ height: DIFF_ROW_HEIGHT }}
      >
        <span className="block max-w-[80ch] truncate">
          <Tokens tokens={[{ kind: "plain", text: row.text }]} query={query} active={active} />
        </span>
      </div>
    );

  const content = (
    <>
      {row.file.expandable ? (
        row.file.expanded ? (
          <ChevronDown size={12} />
        ) : (
          <ChevronRight size={12} />
        )
      ) : (
        <File size={12} />
      )}
      <span className="truncate">
        <Tokens tokens={[{ kind: "plain", text: row.text }]} query={query} active={active} />
      </span>
      <span className="ml-auto shrink-0 pl-4 font-normal text-text-tertiary">
        {row.file.summary}
      </span>
      {row.file.expandable && (
        <span className="shrink-0 pl-3 font-normal text-accent-text">
          {row.file.expanded ? t("common.collapse") : t("diff.diffRows.showDiff")}
        </span>
      )}
    </>
  );

  const className =
    "app-surface-chrome flex min-w-full items-center gap-2 border-b border-border-subtle bg-bg-raised px-3 text-left font-semibold text-text-primary";

  return row.file.expandable ? (
    <ButtonBase
      title={row.text}
      aria-label={t("diff.diffRows.diffFor", {
        value1: row.file.expanded ? t("diff.diffRows.collapse") : t("diff.diffRows.expand"),
        text: row.text,
      })}
      aria-expanded={row.file.expanded}
      className={`${className} hover:bg-bg-overlay`}
      style={{ height: DIFF_ROW_HEIGHT }}
      onClick={() => onToggle(row.file!.index, !row.file!.expanded)}
    >
      {content}
    </ButtonBase>
  ) : (
    <div title={row.text} className={className} style={{ height: DIFF_ROW_HEIGHT }}>
      {content}
    </div>
  );
}

export function UnifiedDiffRow({
  row,
  query = "",
  active = false,
  wrap = false,
}: {
  row: UnifiedRow;
  query?: string;
  active?: boolean;
  wrap?: boolean;
}) {
  const lineNumber = row.newLineNumber ?? row.oldLineNumber;
  const tokens = useMemo(
    (): TextToken[] =>
      row.kind === "hunk" ? [{ kind: "plain", text: row.text }] : highlightLine(row.text),
    [row],
  );

  return (
    <div
      className={`flex min-w-full items-center ${rowTone(row.kind)}`}
      style={
        wrap ? { minHeight: DIFF_ROW_HEIGHT } : { height: DIFF_ROW_HEIGHT, width: "max-content" }
      }
    >
      <PartialLineControl row={row} />
      <span
        aria-hidden="true"
        data-diff-gutter
        className="select-none w-10 shrink-0 border-r border-border-subtle px-1.5 text-right text-text-tertiary"
      >
        {row.oldLineNumber}
      </span>
      <span
        aria-hidden="true"
        data-diff-gutter
        className="select-none w-10 shrink-0 border-r border-border-subtle px-1.5 text-right text-text-tertiary"
      >
        {row.newLineNumber}
      </span>
      <ChangeMarker kind={row.kind} />
      <span
        data-diff-text
        className={
          wrap ? "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] px-2" : "whitespace-pre px-2"
        }
        aria-label={`${stateLabel(row.kind)}${lineNumber ? t("diff.diffRows.line", { lineNumber: lineNumber }) : ""}: ${row.text}`}
      >
        <Tokens tokens={tokens} query={query} active={active} />
      </span>
    </div>
  );
}

export function SplitDiffRow({
  row,
  query,
  active,
  wrap,
}: {
  row: SideBySideRow;
  query: string;
  active: boolean;
  wrap: boolean;
}) {
  const [left, right] = useMemo(() => {
    if (row.left?.kind === "deletion" && row.right?.kind === "addition")
      return emphasizeWords(row.left.text, row.right.text);
    const left = row.left ? highlightLine(row.left.text) : [];
    if (row.left === row.right) return [left, left] as const;
    return [left, row.right ? highlightLine(row.right.text) : []] as const;
  }, [row]);

  return (
    <div
      className="grid w-full grid-cols-2"
      style={wrap ? { minHeight: DIFF_ROW_HEIGHT } : { height: DIFF_ROW_HEIGHT }}
    >
      <DiffCell wrap={wrap} row={row.left} tokens={left} side="old" query={query} active={active} />
      <DiffCell
        wrap={wrap}
        row={row.right}
        tokens={right}
        side="new"
        query={query}
        active={active}
      />
    </div>
  );
}

function DiffCell({
  row,
  tokens,
  side,
  query = "",
  active = false,
  wrap = false,
}: {
  row: UnifiedRow | undefined;
  tokens: TextToken[];
  side: "old" | "new";
  query?: string;
  active?: boolean;
  wrap?: boolean;
}) {
  const lineNumber = side === "old" ? row?.oldLineNumber : row?.newLineNumber;

  return row ? (
    <div className={`flex min-w-0 items-center border-r border-border-subtle ${rowTone(row.kind)}`}>
      <PartialLineControl row={row} />
      <span
        aria-hidden="true"
        data-diff-gutter
        className="select-none w-10 shrink-0 px-1.5 text-right text-text-tertiary"
      >
        {lineNumber}
      </span>
      <ChangeMarker kind={row.kind} />
      <span
        data-diff-text
        className={
          wrap
            ? "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] px-2"
            : "truncate whitespace-pre px-2"
        }
        aria-label={`${stateLabel(row.kind)}${lineNumber ? t("diff.diffRows.line", { lineNumber: lineNumber }) : ""}: ${row.text}`}
      >
        <Tokens tokens={tokens} query={query} active={active} />
      </span>
    </div>
  ) : (
    <div className="app-canvas border-r border-border-subtle bg-bg-inset" />
  );
}

function ChangeMarker({ kind }: { kind: UnifiedRow["kind"] }) {
  const Icon = kind === "addition" ? Plus : kind === "deletion" ? Minus : null;

  return (
    <span
      aria-hidden="true"
      data-diff-gutter
      className="flex w-6 shrink-0 select-none justify-center text-text-secondary"
    >
      {Icon && <Icon size={12} />}
    </span>
  );
}

function Tokens({
  tokens,
  query,
  active,
}: {
  tokens: TextToken[];
  query: string;
  active: boolean;
}) {
  const matches = query ? diffSearchMatches(tokens.map((token) => token.text).join(""), query) : [];
  let offset = 0;
  let matchIndex = 0;

  return tokens.map((token, index) => {
    const start = offset;

    offset += token.text.length;

    const parts = [];
    let cursor = start;

    while (matchIndex < matches.length) {
      const match = matches[matchIndex]!;

      if (match.start >= offset) break;

      const from = Math.max(cursor, match.start);
      const to = Math.min(offset, match.end);

      if (from > cursor) parts.push(token.text.slice(cursor - start, from - start));

      parts.push(
        <mark
          key={from}
          data-active-search-match={active || undefined}
          className={
            active
              ? "bg-accent text-text-inverse rounded-xs outline outline-1 outline-text-primary underline decoration-2"
              : "bg-git-modified text-text-inverse rounded-xs"
          }
        >
          {token.text.slice(from - start, to - start)}
        </mark>,
      );
      cursor = to;

      if (match.end > offset) break;

      matchIndex++;
    }

    if (cursor < offset) parts.push(token.text.slice(cursor - start));

    return (
      <span
        key={index}
        className={`${tokenTone(token.kind)} ${token.emphasized ? "bg-accent-muted" : ""}`}
      >
        {parts}
      </span>
    );
  });
}

function rowTone(kind: UnifiedRow["kind"]): string {
  if (kind === "addition") return "bg-[var(--diff-added-bg)]";
  if (kind === "deletion") return "bg-[var(--diff-deleted-bg)]";
  if (kind === "file") return "app-surface-chrome bg-bg-raised font-semibold text-text-primary";
  if (kind === "hunk") return "bg-accent-muted text-accent-text";
  return "text-text-secondary";
}

function tokenTone(kind: TextToken["kind"]): string {
  if (kind === "keyword") return "text-accent-text";
  if (kind === "string") return "text-git-added";
  if (kind === "number") return "text-git-modified";
  if (kind === "comment") return "text-text-tertiary";
  return "";
}
