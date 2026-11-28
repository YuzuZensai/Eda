import type { DiffHunk, DiffLine, FileDiff, UnifiedDiff } from "./repository-read";

export const MAX_DIFF_ROWS = 12_000;
export const MAX_FILE_DIFF_ROWS = 2_000;
export const MAX_DIFF_FILES = 2_000;
export const MAX_DIFF_LINE_CHARS = 20_000;
const MAX_DIFF_CHARS = 1_000_000;
const MAX_FILE_DIFF_CHARS = 128_000;

export function emptyDiffStats() {
  return { lines: 0, additions: 0, deletions: 0, characters: 0, longestLine: 0 };
}

export function countDiffLine(stats: NonNullable<FileDiff["stats"]>, line: DiffLine) {
  stats.lines += Number(line.type !== "no-newline");
  stats.additions += Number(line.type === "addition");
  stats.deletions += Number(line.type === "deletion");
  stats.characters += line.content.length;
  stats.longestLine = Math.max(stats.longestLine, line.content.length);
}

export function diffStats(file: FileDiff): NonNullable<FileDiff["stats"]> {
  if (file.stats) return file.stats;

  const stats = emptyDiffStats();

  for (const hunk of file.hunks) for (const line of hunk.lines) countDiffLine(stats, line);

  return stats;
}

export class DiffPreviewBudget {
  private characters = MAX_DIFF_CHARS;
  private fileRows = 0;
  private fileChars = 0;

  constructor(private remaining: number) {}

  startFile() {
    this.fileRows = Math.min(this.remaining, MAX_FILE_DIFF_ROWS);
    this.fileChars = Math.min(this.characters, MAX_FILE_DIFF_CHARS);
  }

  appendLine(hunk: DiffHunk, line: DiffLine): boolean {
    const length = this.takeRow(line.content.length);
    if (length === undefined) {
      hunk.truncated = true;
      return false;
    }
    if (length < line.content.length) {
      hunk.truncated = true;
      hunk.lines.push({ ...line, content: line.content.slice(0, length), truncated: true });
    } else {
      hunk.lines.push(line);
    }
    return true;
  }

  takeRow(length: number): number | undefined {
    if (this.fileRows <= 0 || this.fileChars <= 0) return undefined;
    const retained = Math.min(length, MAX_DIFF_LINE_CHARS, this.fileChars);
    this.remaining--;
    this.fileRows--;
    this.characters -= retained;
    this.fileChars -= retained;
    return retained;
  }
}

export function boundDiff(diff: UnifiedDiff, maxRows = MAX_DIFF_ROWS): UnifiedDiff {
  const selected = diff.files.slice(0, MAX_DIFF_FILES);
  const budget = new DiffPreviewBudget(maxRows - selected.length);
  const files = selected.map((file): FileDiff => {
    const stats = diffStats(file);
    budget.startFile();
    let truncated = file.truncated ?? false;
    const hunks = file.hunks.flatMap((hunk) => {
      if (file.binary || budget.takeRow(0) === undefined) {
        truncated = true;
        return [];
      }

      const retained: DiffHunk = { ...hunk, lines: [] };
      for (const line of hunk.lines) {
        if (!budget.appendLine(retained, line)) break;
      }
      truncated ||= !!retained.truncated;
      return [retained];
    });

    return { ...file, stats, hunks, ...(truncated ? { truncated: true } : {}) };
  });

  const omittedFiles = (diff.omittedFiles ?? 0) + diff.files.length - files.length;

  return { ...diff, files, ...(omittedFiles ? { omittedFiles } : {}) };
}
