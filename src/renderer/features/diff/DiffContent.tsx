import type { DiffMode, UnifiedDiff } from "@shared/repository/repository-read";
import { t, getLocale } from "@shared/i18n";
import { useMemo, useState } from "react";
import { ArrowDownIcon as ArrowDown, ArrowUpIcon as ArrowUp } from "../../components/ui/icons";

import {
  type UnifiedRow,
  groupUnchangedRows,
  toSideBySideRows,
  toUnifiedRows,
} from "../../repository/diff-model";
import { diffSearchMatches } from "../../repository/diff-search";

import { useRepositoryStore } from "../../stores/repository-store";
import { VirtualRows } from "../../components/ui/display/VirtualRows";
import { PartialStageProvider } from "../changes/PartialStageControls";
import { DIFF_ROW_HEIGHT, DiffCell, DiffSummaryRow, UnifiedDiffRow } from "./DiffRows";
import { IconButton, SearchField } from "../../components/ui/index";

export function DiffContent({
  diff,
  mode,
  readOnly = false,
  wrap = false,
  groupContext = false,
}: {
  diff: UnifiedDiff;
  mode: DiffMode;
  readOnly?: boolean;
  wrap?: boolean;
  groupContext?: boolean;
}) {
  const selectionKey = useRepositoryStore(
    (state) =>
      `${state.identityId}:${state.repositoryId}:${JSON.stringify(state.selection)}:${mode}`,
  );
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRegion = (key: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const searching = query.length > 0;
  const unified = useMemo(() => {
    const rows = toUnifiedRows(diff, expanded);
    return groupContext && !searching ? groupUnchangedRows(rows, collapsed) : rows;
  }, [diff, expanded, groupContext, searching, collapsed]);
  const split = useMemo(() => (mode === "split" ? toSideBySideRows(unified) : []), [mode, unified]);
  const searchEntries = useMemo(() => {
    if (!searching) return [];

    const rows = toUnifiedRows(diff, new Map(diff.files.map((_, index) => [index, true])));
    let fileIndex = 0;
    const owners = new Map<string, number>();

    for (const row of rows) {
      if (row.file) fileIndex = row.file.index;
      owners.set(row.key, fileIndex);
    }

    const entries =
      mode === "unified"
        ? rows.map((row) => ({ key: row.key, rows: [row] }))
        : toSideBySideRows(rows).map((row) => ({
            key: row.key,
            rows: [row.left, row.right].filter((item): item is UnifiedRow => !!item),
          }));

    return entries.map((entry) => ({ ...entry, fileIndex: owners.get(entry.key)! }));
  }, [diff, mode, searching]);

  const searchable = useMemo(
    () =>
      query
        ? searchEntries.filter((entry) =>
            entry.rows.some((row) => diffSearchMatches(row.text, query).length > 0),
          )
        : [],
    [searchEntries, query],
  );

  const visible =
    mode === "unified"
      ? unified.map((row) => ({ key: row.key, hunk: row.kind === "hunk" }))
      : split.map((row) => ({ key: row.key, hunk: row.left?.kind === "hunk" }));
  const targets = query
    ? searchable
    : visible.filter((row) => row.hunk).map((row) => ({ key: row.key, fileIndex: undefined }));
  const position = visible.findIndex((row) => row.key === selectedKey);
  const activeTarget = targets.findIndex((target) => target.key === selectedKey);
  const move = (direction: number) => {
    if (!targets.length) return;

    const nextIndex =
      activeTarget < 0
        ? direction > 0
          ? 0
          : targets.length - 1
        : (activeTarget + direction + targets.length) % targets.length;

    const next = targets[nextIndex]!;

    if (query && next.fileIndex !== undefined) {
      setExpanded((current) => new Map(current).set(next.fileIndex!, true));
    }

    setSelectedKey(next.key);
  };

  const incompleteSearch =
    !!diff.omittedFiles || diff.files.some((file) => file.truncated || file.binary);
  const toggle = (index: number, value: boolean) => {
    setExpanded((current) => new Map(current).set(index, value));
    setSelectedKey(null);
  };
  const content = (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1 text-xs text-text-tertiary">
        <SearchField
          aria-label={t("diff.diffContent.findInDiff")}
          placeholder={t("diff.diffContent.searchPlaceholder")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedKey(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
          className="min-w-0 flex-1"
        />
        <span className="shrink-0" role="status" aria-live="polite" aria-atomic="true">
          {t(
            query
              ? activeTarget >= 0
                ? "diff.diffContent.matchPosition"
                : "diff.diffContent.matchCount"
              : activeTarget >= 0
                ? "diff.diffContent.hunkPosition"
                : "diff.diffContent.hunkCount",
            { count: targets.length, position: activeTarget + 1 },
          )}
        </span>
        <IconButton
          size="xs"
          disabled={!targets.length}
          title={query ? t("diff.diffContent.previousMatch") : t("diff.diffContent.previousChange")}
          aria-label={
            query ? t("diff.diffContent.previousMatch") : t("diff.diffContent.previousChange")
          }
          onClick={() => move(-1)}
          icon={<ArrowUp size={14} aria-hidden="true" />}
        />
        <IconButton
          size="xs"
          disabled={!targets.length}
          title={query ? t("diff.diffContent.nextMatch") : t("diff.diffContent.nextChange")}
          aria-label={query ? t("diff.diffContent.nextMatch") : t("diff.diffContent.nextChange")}
          onClick={() => move(1)}
          icon={<ArrowDown size={14} aria-hidden="true" />}
        />
      </div>
      {query && incompleteSearch && (
        <p
          role="status"
          className="shrink-0 border-b border-border-subtle px-3 py-2 text-xs text-git-modified"
        >
          {t("diff.diffContent.someContentWasnTSearchedBinaryContentsAnd")}
        </p>
      )}
      {!!diff.omittedFiles && (
        <p
          role="status"
          className="shrink-0 border-b border-border-subtle px-3 py-2 text-xs text-git-modified"
        >
          {t("diff.diffContent.additionalFilesOmittedByThePreviewLimit", {
            omittedFiles: diff.omittedFiles.toLocaleString(getLocale()),
          })}
        </p>
      )}
      {mode === "unified" ? (
        <VirtualRows
          ariaLabel={t("diff.diffContent.unifiedDiff")}
          scrollKey={readOnly ? undefined : selectionKey}
          items={unified}
          revealIndex={position >= 0 ? position : undefined}
          rowHeight={DIFF_ROW_HEIGHT}
          measureRows={wrap}
          horizontalScroll={!wrap}
          className="min-h-0 flex-1 selectable mono text-xs"
          renderRow={(row, index) =>
            row.kind === "file" || row.kind === "notice" ? (
              <DiffSummaryRow
                key={row.key}
                row={row}
                onToggle={toggle}
                onToggleRegion={toggleRegion}
                query={query}
                active={index === position}
              />
            ) : (
              <UnifiedDiffRow
                wrap={wrap}
                key={row.key}
                row={row}
                query={query}
                active={index === position}
              />
            )
          }
        />
      ) : (
        <VirtualRows
          ariaLabel={t("diff.diffContent.sideBySideDiff")}
          scrollKey={readOnly ? undefined : selectionKey}
          items={split}
          revealIndex={position >= 0 ? position : undefined}
          rowHeight={DIFF_ROW_HEIGHT}
          measureRows={wrap}
          horizontalScroll={!wrap}
          className="min-h-0 flex-1 selectable mono text-xs"
          renderRow={(row, index) =>
            row.left?.kind === "file" || row.left?.kind === "notice" ? (
              <DiffSummaryRow
                key={row.key}
                row={row.left}
                onToggle={toggle}
                onToggleRegion={toggleRegion}
                query={query}
                active={index === position}
              />
            ) : row.left?.kind === "hunk" ? (
              <UnifiedDiffRow
                wrap={wrap}
                key={row.key}
                row={row.left}
                query={query}
                active={index === position}
              />
            ) : (
              <div
                key={row.key}
                className="grid w-full grid-cols-2"
                style={wrap ? { minHeight: DIFF_ROW_HEIGHT } : { height: DIFF_ROW_HEIGHT }}
              >
                <DiffCell
                  wrap={wrap}
                  row={row.left}
                  side="old"
                  query={query}
                  active={index === position}
                />
                <DiffCell
                  wrap={wrap}
                  row={row.right}
                  side="new"
                  query={query}
                  active={index === position}
                />
              </div>
            )
          }
        />
      )}
    </>
  );

  return readOnly ? <PartialStageProvider disabled>{content}</PartialStageProvider> : content;
}
