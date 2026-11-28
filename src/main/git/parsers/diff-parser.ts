import { ERROR_CODE } from "@shared/error-codes";
import { AppError } from "@shared/errors";
import {
  countDiffLine,
  DiffPreviewBudget,
  emptyDiffStats,
  MAX_DIFF_FILES,
  MAX_DIFF_ROWS,
} from "@shared/repository/diff-limits";
import type { DiffHunk, DiffLine, FileDiff, UnifiedDiff } from "@shared/repository/repository-read";

export function parseUnifiedDiff(output: Buffer): UnifiedDiff {
  const text = output.toString("utf8");

  if (text.length === 0) return { files: [] };

  // Reserve file headings first so one large patch cannot hide later files.
  let headings = Number(text.startsWith("diff --git "));
  let header = text.indexOf("\ndiff --git ");
  while (header !== -1 && headings < MAX_DIFF_FILES) {
    headings++;
    header = text.indexOf("\ndiff --git ", header + 1);
  }
  const budget = new DiffPreviewBudget(MAX_DIFF_ROWS - headings);
  const files: FileDiff[] = [];
  let omittedFiles = 0;
  let file: (FileDiff & { stats: NonNullable<FileDiff["stats"]> }) | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (let offset = 0; offset < text.length;) {
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(offset, newline >= 0 && text[end - 1] === "\r" ? end - 1 : end);
    offset = end + 1;
    if (line.startsWith("diff --git ")) {
      file = {
        ...parseHeaderPaths(line.slice(11)),
        status: "modified",
        binary: false,
        hunks: [],
        stats: emptyDiffStats(),
      };
      if (files.length < MAX_DIFF_FILES) files.push(file);
      else omittedFiles++;
      budget.startFile();
      hunk = undefined;
      continue;
    }

    if (!file) continue;

    if (hunk && !line.startsWith("@@ ")) {
      const parsed = parseHunkLine(line, oldLine, newLine);
      if (!parsed) continue;
      oldLine = parsed.oldLine;
      newLine = parsed.newLine;
      if (omittedFiles) continue;
      countDiffLine(file.stats, parsed.line);
      if (file.binary) file.truncated = true;
      else {
        budget.appendLine(hunk, parsed.line);
        if (hunk.truncated) file.truncated = true;
      }
      continue;
    }

    if (line.startsWith("new file mode ")) {
      file.status = "added";
      delete file.oldPath;
      file.newMode = line.slice(14);
    } else if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
      delete file.newPath;
      file.oldMode = line.slice(18);
    } else if (line.startsWith("old mode ")) {
      file.oldMode = line.slice(9);
      file.status = "type-changed";
    } else if (line.startsWith("new mode ")) {
      file.newMode = line.slice(9);
    } else if (line.startsWith("rename from ")) {
      file.oldPath = unquotePath(line.slice(12));
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      file.newPath = unquotePath(line.slice(10));
    } else if (line.startsWith("copy from ")) {
      file.oldPath = unquotePath(line.slice(10));
      file.status = "copied";
    } else if (line.startsWith("copy to ")) {
      file.newPath = unquotePath(line.slice(8));
    } else if (line.startsWith("--- ")) {
      const path = parseMarkerPath(line.slice(4));
      if (path !== undefined) file.oldPath = path;
      else delete file.oldPath;
    } else if (line.startsWith("+++ ")) {
      const path = parseMarkerPath(line.slice(4));
      if (path !== undefined) file.newPath = path;
      else delete file.newPath;
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
    } else if (line.startsWith("@@ ")) {
      hunk = { ...parseHunkHeader(line), lines: [] };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      if (!omittedFiles && !file.binary && budget.takeRow(0) !== undefined) file.hunks.push(hunk);
      else file.truncated = true;
    }
  }

  return { files, ...(omittedFiles ? { omittedFiles } : {}) };
}

export function parseHunkHeader(line: string) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/s.exec(line);
  if (!match) throw new AppError(ERROR_CODE.INVALID_DIFF_OUTPUT);
  return {
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? 1),
    heading: match[5]!.trimStart(),
  };
}

function parseHeaderPaths(value: string): Pick<FileDiff, "oldPath" | "newPath"> {
  // Even the " b/" separator can appear inside an unquoted path.
  if (value.startsWith("a/")) {
    for (let split = value.indexOf(" b/"); split >= 0; split = value.indexOf(" b/", split + 1)) {
      const oldPath = value.slice(2, split);
      const newPath = value.slice(split + 3);
      if (oldPath === newPath) return { oldPath, newPath };
    }
  }

  const pair = /^("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/.exec(value);

  if (!pair) return {};

  const oldPath = parseMarkerPath(pair[1]!);
  const newPath = parseMarkerPath(pair[2]!);

  return { ...(oldPath !== undefined && { oldPath }), ...(newPath !== undefined && { newPath }) };
}

function parseMarkerPath(value: string): string | undefined {
  // Git terminates marker paths containing spaces with a tab. Tabs in file names are quoted.
  const path = unquotePath(value.split("\t", 1)[0]!);
  if (path === "/dev/null") return undefined;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

export function unquotePath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    const normalized = value.replace(/(?:\\[0-3][0-7]{2})+|\\./g, (escape) => {
      if (escape === "\\a") return "\\u0007";
      if (escape === "\\v") return "\\u000b";
      if (!/^\\[0-3]/.test(escape)) return escape;

      const bytes = escape
        .split("\\")
        .slice(1)
        .map((octal) => Number.parseInt(octal, 8));
      return JSON.stringify(Buffer.from(bytes).toString("utf8")).slice(1, -1);
    });

    return JSON.parse(normalized) as string;
  } catch {
    throw new AppError(ERROR_CODE.INVALID_DIFF_PATH);
  }
}

function parseHunkLine(
  line: string,
  oldLine: number,
  newLine: number,
): { line: DiffLine; oldLine: number; newLine: number } | undefined {
  if (line.startsWith(" ")) {
    return {
      line: {
        type: "context",
        content: line.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      },
      oldLine: oldLine + 1,
      newLine: newLine + 1,
    };
  }

  if (line.startsWith("-")) {
    return {
      line: { type: "deletion", content: line.slice(1), oldLineNumber: oldLine },
      oldLine: oldLine + 1,
      newLine,
    };
  }

  if (line.startsWith("+")) {
    return {
      line: { type: "addition", content: line.slice(1), newLineNumber: newLine },
      oldLine,
      newLine: newLine + 1,
    };
  }

  if (line === "\\ No newline at end of file") {
    return { line: { type: "no-newline", content: "No newline at end of file" }, oldLine, newLine };
  }

  return undefined;
}
