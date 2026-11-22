import type { DiffMode, UnifiedDiff } from "@shared/repository/repository-read";
import { t, getLocale } from "@shared/i18n";
import { useMemo, useState } from "react";
import { ArrowDownIcon as ArrowDown, ArrowUpIcon as ArrowUp } from "../../components/ui/icons";

import {
  type UnifiedRow,
  type SideBySideRow,
  groupUnchangedRows,
  toSideBySideRows,
  toUnifiedRows,
} from "../../repository/diff-model";
import { diffSearchPattern } from "../../repository/diff-search";

import { useRepositoryStore } from "../../stores/repository-store";
import { VirtualRows } from "../../components/ui/display/VirtualRows";
import { PartialStageProvider } from "../changes/PartialStageControls";
import { DIFF_ROW_HEIGHT, SplitDiffRow, DiffSummaryRow, UnifiedDiffRow } from "./DiffRows";
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
    const entry = (row: UnifiedRow, other?: UnifiedRow) => {
      if (row.file) fileIndex = row.file.index;
      return { key: row.key, fileIndex, text: row.text, other: other?.text };
    };

    return mode === "unified"
      ? rows.map((row) => entry(row))
      : toSideBySideRows(rows).map(({ left, right }) =>
          entry(left ?? right!, left && left !== right ? right : undefined),
        );
  }, [diff, mode, searching]);

  const targets = useMemo(() => {
    if (!query)
      return unified
        .filter((row) => row.kind === "hunk")
        .map((row) => ({ key: row.key, fileIndex: undefined }));
    const pattern = diffSearchPattern(query);
    return searchEntries.filter(
      ({ text, other }) => pattern.test(text) || (other && pattern.test(other)),
    );
  }, [unified, searchEntries, query]);

  const visible = mode === "unified" ? unified : split;
  const position = selectedKey === null ? -1 : visible.findIndex((row) => row.key === selectedKey);
  const activeTarget =
    selectedKey === null ? -1 : targets.findIndex((target) => target.key === selectedKey);
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
      const fileIndex = next.fileIndex;
      setExpanded((current) =>
        current.get(fileIndex) ? current : new Map(current).set(fileIndex, true),
      );
    }

    setSelectedKey(next.key);
  };

  const incompleteSearch =
    !!diff.omittedFiles || diff.files.some((file) => file.truncated || file.binary);
  const toggle = (index: number, value: boolean) => {
    setExpanded((current) => new Map(current).set(index, value));
    setSelectedKey(null);
  };
  const renderUnified = (row: UnifiedRow, active: boolean) =>
    row.kind === "file" || row.kind === "notice" ? (
      <DiffSummaryRow
        key={row.key}
        row={row}
        onToggle={toggle}
        onToggleRegion={toggleRegion}
        query={query}
        active={active}
      />
    ) : (
      <UnifiedDiffRow key={row.key} row={row} wrap={wrap} query={query} active={active} />
    );
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
      <VirtualRows<UnifiedRow | SideBySideRow>
        ariaLabel={t(
          mode === "unified" ? "diff.diffContent.unifiedDiff" : "diff.diffContent.sideBySideDiff",
        )}
        scrollKey={readOnly ? undefined : selectionKey}
        items={visible}
        revealIndex={position >= 0 ? position : undefined}
        rowHeight={DIFF_ROW_HEIGHT}
        measureRows={wrap}
        horizontalScroll={!wrap}
        className="min-h-0 flex-1 selectable mono text-xs"
        renderRow={(row, index) => {
          const active = index === position;
          if ("kind" in row) return renderUnified(row, active);
          if (row.left?.kind === "file" || row.left?.kind === "notice" || row.left?.kind === "hunk")
            return renderUnified(row.left, active);
          return <SplitDiffRow key={row.key} wrap={wrap} row={row} query={query} active={active} />;
        }}
      />
    </>
  );

  return readOnly ? <PartialStageProvider disabled>{content}</PartialStageProvider> : content;
}
