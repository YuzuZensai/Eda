import { GIT_FILE_MODE } from "@shared/repository/git-file-mode";
import { t } from "@shared/i18n";
import type { DiffLine, FileDiff, UnifiedDiff } from "@shared/repository/repository-read";
import { diffStats } from "@shared/repository/diff-limits";
export { boundDiff, MAX_DIFF_ROWS, MAX_DIFF_LINE_CHARS } from "@shared/repository/diff-limits";

export const MAX_WORD_DIFF_CHARS = 800;
export const AUTO_DIFF_LINES = 500;
export const AUTO_DIFF_CHARS = 64_000;
export const AUTO_LINE_CHARS = 2_000;

export interface TextToken {
  kind: "plain" | "keyword" | "string" | "number" | "comment";
  text: string;
  emphasized?: boolean;
}

export interface UnifiedRow {
  key: string;
  kind: "file" | "notice" | "hunk" | DiffLine["type"];
  contextRegion?: { count: number; collapsed: boolean };
  hunkIndex?: number;
  lineIndex?: number;
  file?: { index: number; expanded: boolean; expandable: boolean; summary: string };
  oldLineNumber?: number;
  newLineNumber?: number;
  text: string;
}

export interface SideBySideRow {
  key: string;
  left?: UnifiedRow;
  right?: UnifiedRow;
}

const KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "class",
  "const",
  "continue",
  "default",
  "else",
  "export",
  "extends",
  "false",
  "for",
  "function",
  "if",
  "import",
  "interface",
  "let",
  "new",
  "null",
  "return",
  "static",
  "switch",
  "throw",
  "true",
  "type",
  "undefined",
  "while",
  "yield",
]);

export function highlightLine(text: string): TextToken[] {
  if (text.length > AUTO_LINE_CHARS) return [{ kind: "plain", text }];

  const parts =
    text.match(
      /\/\/.*|#.*|`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b|\s+|./g,
    ) ?? [];

  return parts.map((part) => ({
    text: part,
    kind:
      part.startsWith("//") || part.startsWith("#")
        ? "comment"
        : /^['"`]/.test(part)
          ? "string"
          : /^\d/.test(part)
            ? "number"
            : KEYWORDS.has(part)
              ? "keyword"
              : "plain",
  }));
}

function collapseReason(file: FileDiff, stats: ReturnType<typeof diffStats>): string | undefined {
  if (file.binary) return t("diffModel.binaryFile");

  if (
    file.truncated ||
    stats.lines > AUTO_DIFF_LINES ||
    stats.characters > AUTO_DIFF_CHARS ||
    stats.longestLine > AUTO_LINE_CHARS
  )
    return t("diffModel.largeDiff");

  const path = file.newPath ?? file.oldPath ?? "";

  if (
    /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|uv\.lock)$|\.min\.(?:js|css)$|\.(?:js|css)\.map$/i.test(
      path,
    )
  )
    return t("diffModel.generatedFile");

  return undefined;
}

export function toUnifiedRows(
  diff: UnifiedDiff,
  expandedFiles: ReadonlyMap<number, boolean> = new Map(),
): UnifiedRow[] {
  const rows: UnifiedRow[] = [];

  for (const [fileIndex, file] of diff.files.entries()) {
    const path = file.newPath ?? file.oldPath ?? "unknown";
    const stats = diffStats(file);
    const reason = collapseReason(file, stats);
    const expandable = !file.binary && file.hunks.some((hunk) => hunk.lines.length > 0);
    const expanded = expandable && (expandedFiles.get(fileIndex) ?? !reason);
    const summary = [
      file.status,
      file.binary ? t("diffModel.binary") : `+${stats.additions} -${stats.deletions}`,
      file.oldPath && file.newPath && file.oldPath !== file.newPath
        ? t("diffModel.from", { oldPath: file.oldPath })
        : "",
      file.oldMode !== file.newMode
        ? t("diffModel.modeTo", {
            value1: file.oldMode ?? t("diffModel.none"),
            value2: file.newMode ?? t("diffModel.none"),
          })
        : "",
      file.newMode === GIT_FILE_MODE.submodule || file.oldMode === GIT_FILE_MODE.submodule
        ? t("diffModel.submodule")
        : "",
    ]
      .filter(Boolean)
      .join(", ");

    rows.push({
      key: `f-${fileIndex}`,
      kind: "file",
      text: path,
      file: { index: fileIndex, expanded, expandable, summary },
    });

    let notice: string | undefined;

    if (file.binary) notice = t("diffModel.binaryFileChangedNoTextPreview");
    else if (!expanded && expandable)
      notice = t(file.truncated ? "diffModel.hiddenPreview" : "diffModel.hiddenChanges", {
        reason: reason ?? t("diffModel.diff"),
        count: stats.lines,
      });
    else if (file.truncated) notice = t("diffModel.previewTruncatedToKeepTheViewerResponsiveSome");
    else if (!expandable)
      notice =
        file.status === "renamed"
          ? t("diffModel.renamedFromNoTextualChanges", {
              value1: file.oldPath ?? t("diffModel.unknown"),
            })
          : file.oldMode !== file.newMode
            ? t("diffModel.fileModeTo", {
                value1: file.oldMode ?? t("diffModel.none"),
                value2: file.newMode ?? t("diffModel.none"),
              })
            : t("diffModel.noTextualChanges");

    if (notice)
      rows.push({
        key: `n-${fileIndex}`,
        kind: "notice",
        text: notice,
      });

    if (!expanded) continue;

    for (const [hunkIndex, hunk] of file.hunks.entries()) {
      const heading = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.heading}`;

      rows.push({
        key: `h-${fileIndex}-${hunkIndex}`,
        kind: "hunk",
        hunkIndex,
        text: heading,
      });

      for (const [lineIndex, line] of hunk.lines.entries()) {
        rows.push({
          key: `l-${fileIndex}-${hunkIndex}-${lineIndex}`,
          kind: line.type,
          hunkIndex,
          lineIndex,
          ...(line.oldLineNumber !== undefined && { oldLineNumber: line.oldLineNumber }),
          ...(line.newLineNumber !== undefined && { newLineNumber: line.newLineNumber }),
          text: line.content,
        });
      }
    }
  }

  return rows;
}

export function groupUnchangedRows(
  rows: UnifiedRow[],
  collapsed: ReadonlySet<string>,
): UnifiedRow[] {
  const result: UnifiedRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const start = index;
    while (rows[index]?.kind === "context") index++;
    if (start === index) {
      result.push(rows[index++]!);
      continue;
    }
    const count = index - start;
    if (count > 6) {
      const key = rows[start]!.key + "-region";
      result.push({
        key,
        kind: "notice",
        text: "",
        contextRegion: { count, collapsed: collapsed.has(key) },
      });
      if (collapsed.has(key)) continue;
    }
    result.push(...rows.slice(start, index));
  }
  return result;
}

export function toSideBySideRows(rows: readonly UnifiedRow[]): SideBySideRow[] {
  const result: SideBySideRow[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;

    if (row.kind === "deletion") {
      const deletions: UnifiedRow[] = [];
      const additions: UnifiedRow[] = [];

      while (rows[index]?.kind === "deletion") deletions.push(rows[index++]!);

      while (rows[index]?.kind === "addition") additions.push(rows[index++]!);

      index -= 1;

      for (let pair = 0; pair < Math.max(deletions.length, additions.length); pair += 1) {
        const left = deletions[pair];
        const right = additions[pair];

        if (left && right) result.push({ key: left.key, left, right });
        else if (left) result.push({ key: left.key, left });
        else if (right) result.push({ key: right.key, right });
      }
    } else if (row.kind === "addition") result.push({ key: row.key, right: row });
    else result.push({ key: row.key, left: row, right: row });
  }

  return result;
}

export function emphasizeWords(left: string, right: string): [TextToken[], TextToken[]] {
  if (left.length + right.length > MAX_WORD_DIFF_CHARS)
    return [highlightLine(left), highlightLine(right)];

  const leftWords = left.split(/(\s+|\b)/).filter(Boolean);
  const rightWords = right.split(/(\s+|\b)/).filter(Boolean);
  let prefix = 0;

  while (prefix < leftWords.length && leftWords[prefix] === rightWords[prefix]) prefix += 1;

  let suffix = 0;

  while (
    suffix < leftWords.length - prefix &&
    suffix < rightWords.length - prefix &&
    leftWords[leftWords.length - 1 - suffix] === rightWords[rightWords.length - 1 - suffix]
  )
    suffix += 1;

  const mark = (words: string[]) =>
    words.map((text, index): TextToken => ({
      kind: "plain",
      text,
      emphasized: index >= prefix && index < words.length - suffix,
    }));

  return [mark(leftWords), mark(rightWords)];
}
