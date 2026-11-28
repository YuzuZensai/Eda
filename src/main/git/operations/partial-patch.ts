import { hash } from "node:crypto";
import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { parseHunkHeader } from "../parsers/diff-parser";
import { GIT_FILE_MODE, isRegularFileMode } from "@shared/repository/git-file-mode";
import type { PartialStageRequest } from "@shared/repository/repository-write";

const invalid = (message: ErrorText) =>
  new GitError({
    kind: "invalid-input",
    operation: t("operations.preparePartialStaging"),
    message,
  });

interface PatchLine {
  type: string;
  content: string;
  marker: boolean;
  index: number;
}

interface PatchHunk {
  oldStart: number;
  newStart: number;
  lines: PatchLine[];
}

export function partialPatch(
  raw: string,
  path: string,
  selection: Pick<PartialStageRequest, "area" | "hunks" | "lines" | "sourceDigest">,
): { patch: string; additions: number; deletions: number } {
  if (hash("sha256", raw) !== selection.sourceDigest)
    throw invalid(
      errorText(
        "main.partialStageService.theFileOrIndexChangedAfterThePreviewRefreshAndPreviewAgain",
      ),
    );

  const { hunks, added, deleted, mode } = parseEditableDiff(raw);
  const hunkSet = new Set(selection.hunks ?? []);

  for (const index of hunkSet)
    if (!Number.isInteger(index) || !hunks[index])
      throw invalid(errorText("main.git.partialPatch.aSelectedHunkNoLongerExists"));

  const remainingLines = new Map<number, Set<number>>();
  for (const { hunk, line } of selection.lines ?? []) {
    const indices = remainingLines.get(hunk);
    if (indices) indices.add(line);
    else remainingLines.set(hunk, new Set([line]));
  }

  const reverse = selection.area === "staged";
  let all = true;
  let additions = 0;
  let deletions = 0;
  let delta = 0;
  const body: string[] = [];

  for (const [hunkIndex, hunk] of hunks.entries()) {
    const lines: PatchLine[] = [];
    const wholeHunk = hunkSet.has(hunkIndex);
    const selectedLines = remainingLines.get(hunkIndex);
    let changed = false;

    for (const line of hunk.lines) {
      if (line.type === " ") {
        lines.push(line);
        continue;
      }

      const selectedLine = selectedLines?.delete(line.index) ?? false;
      const selected = wholeHunk || selectedLine;

      all &&= selected;

      const type = reverse ? (line.type === "+" ? "-" : "+") : line.type;

      if (selected) {
        lines.push({ ...line, type });
        changed = true;
        if (type === "+") additions += 1;
        else deletions += 1;
      } else if (type === "-") lines.push({ ...line, type: " " });
    }

    if (!changed) continue;

    const oldCount = lines.filter((line) => line.type !== "+").length;
    const newCount = lines.filter((line) => line.type !== "-").length;
    const oldStart = reverse ? hunk.newStart : hunk.oldStart;
    const newStart =
      newCount === 0
        ? Math.max(0, oldStart + delta - 1)
        : oldCount === 0
          ? oldStart + delta + 1
          : oldStart + delta;

    body.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);

    for (const line of lines) {
      body.push(line.type + line.content);
      if (line.marker) body.push("\\ No newline at end of file");
    }

    delta += newCount - oldCount;
  }

  if ([...remainingLines.values()].some((indices) => indices.size > 0))
    throw invalid(errorText("main.git.partialPatch.selectAddedOrDeletedLinesFromTheCurrentDiff"));

  if (!body.length)
    throw invalid(errorText("main.git.partialPatch.selectAtLeastOneChangedLineOrHunk"));

  const sourceNull = reverse ? deleted : added;
  const targetNull = (reverse ? added : deleted) && all;
  const oldPath = quotePatchPath(`a/${path}`);
  const newPath = quotePatchPath(`b/${path}`);
  const header = [`diff --git ${oldPath} ${newPath}`];

  if (sourceNull) header.push(`new file mode ${mode}`);
  if (targetNull) header.push(`deleted file mode ${mode}`);

  header.push(
    `--- ${sourceNull ? "/dev/null" : oldPath}`,
    `+++ ${targetNull ? "/dev/null" : newPath}`,
  );

  return { patch: [...header, ...body, ""].join("\n"), additions, deletions };
}

function parseEditableDiff(raw: string) {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  let files = 0;
  let displayIndex = 0;

  let added = false;
  let deleted = false;
  let mode: string = GIT_FILE_MODE.regular;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
    if (!current) {
      if (line.startsWith("new file mode ")) added = true;
      if (line.startsWith("deleted file mode ")) deleted = true;
      const fileMode =
        /^(?:new file mode|deleted file mode|index [0-9a-f]+\.\.[0-9a-f]+) (\d{6})$/.exec(
          line,
        )?.[1];
      if (
        /^(?:Binary files |GIT binary patch|rename |copy |old mode |new mode )/.test(line) ||
        (fileMode && !isRegularFileMode(fileMode))
      )
        throw invalid(errorText("main.git.partialPatch.useWholeFileStagingForBinaryRenamedMode"));
      if (fileMode) mode = fileMode;
    }
    if (line.startsWith("@@ ")) {
      const { oldStart, newStart } = parseHunkHeader(line);
      current = { oldStart, newStart, lines: [] };
      hunks.push(current);
      displayIndex = 0;
    } else if (current && /^[ +\-]/.test(line))
      current.lines.push({
        type: line[0]!,
        content: line.slice(1),
        marker: false,
        index: displayIndex++,
      });
    else if (current && line.startsWith("\\ No newline") && current.lines.length) {
      current.lines.at(-1)!.marker = true;
      displayIndex += 1;
    }
  }

  if (files !== 1 || hunks.length === 0)
    throw invalid(
      errorText("main.git.partialPatch.thereIsNoEditableTextPatchForThisFileRefreshItsDiff"),
    );

  return { hunks, added, deleted, mode };
}

function quotePatchPath(path: string): string {
  // Git accepts octal byte escapes for control characters in patch headers.
  const escaped = path.replace(/[\x00-\x1f"\\]/g, (char) =>
    char === '"' || char === "\\"
      ? "\\" + char
      : "\\" + char.charCodeAt(0).toString(8).padStart(3, "0"),
  );
  return '"' + escaped + '"';
}
