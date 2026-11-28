import { describe, expect, it } from "vitest";
import { UNIFIED_DIFF } from "../../fixtures/repository-read-output";
import { parseUnifiedDiff } from "@main/git/parsers/diff-parser";
import { MAX_DIFF_FILES, MAX_DIFF_ROWS, MAX_FILE_DIFF_ROWS } from "@shared/repository/diff-limits";

describe("parseUnifiedDiff", () => {
  it("counts discarded lines, reserves later file headings and respects the shared preview budget", () => {
    const count = 3000;
    const patch = Array.from(
      { length: 7 },
      (_, index) =>
        `diff --git a/${index} b/${index}\r\n@@ -0,0 +1,${count} @@\r\n${"+café\r\n".repeat(count)}`,
    ).join("");
    const { files } = parseUnifiedDiff(
      Buffer.from(patch + "diff --git a/last b/last\nold mode 100644\nnew mode 100755"),
    );
    expect(files).toHaveLength(8);
    expect(files[0]?.hunks[0]?.lines).toHaveLength(MAX_FILE_DIFF_ROWS - 1);
    expect(files[0]?.hunks[0]?.truncated).toBe(true);
    expect(files[0]?.hunks[0]?.lines.at(-1)).toMatchObject({
      content: "café",
      newLineNumber: MAX_FILE_DIFF_ROWS - 1,
    });
    expect(
      files
        .slice(0, 7)
        .every(
          (file) =>
            file.truncated &&
            file.stats?.additions === count &&
            file.stats.characters === 4 * count,
        ),
    ).toBe(true);
    const retainedRows = files.reduce(
      (total, file) =>
        total + 1 + file.hunks.reduce((rows, hunk) => rows + 1 + hunk.lines.length, 0),
      0,
    );
    expect(retainedRows).toBe(MAX_DIFF_ROWS);
    expect(files.at(-1)).toMatchObject({ newPath: "last", newMode: "100755" });
  });

  it("counts omitted files and still rejects invalid hunk headers beyond the preview", () => {
    const headers = "diff --git a/f b/f\n".repeat(MAX_DIFF_FILES + 1);
    expect(parseUnifiedDiff(Buffer.from(headers)).omittedFiles).toBe(1);
    expect(() => parseUnifiedDiff(Buffer.from(headers + "@@ malformed"))).toThrow();
  });

  it("normalizes renamed text and binary files", () => {
    const diff = parseUnifiedDiff(Buffer.from(UNIFIED_DIFF));

    expect(diff.files).toHaveLength(2);
    expect(diff.files[0]).toMatchObject({
      oldPath: "old.txt",
      newPath: "new.txt",
      status: "renamed",
      binary: false,
    });
    expect(diff.files[0]?.hunks[0]?.lines).toEqual([
      { type: "context", content: "same", oldLineNumber: 1, newLineNumber: 1 },
      { type: "deletion", content: "old", oldLineNumber: 2 },
      { type: "addition", content: "new", newLineNumber: 2 },
      { type: "no-newline", content: "No newline at end of file" },
    ]);
    expect(diff.files[1]).toMatchObject({
      binary: true,
      status: "modified",
      oldPath: "image.bin",
      newPath: "image.bin",
    });
  });

  it("retains Unicode line separators in a Git hunk heading", () => {
    const output = "diff --git a/f b/f\n@@ -1 +1 @@ function name\u2028continued\n-old\n+new\n";
    expect(parseUnifiedDiff(Buffer.from(output)).files[0]?.hunks[0]?.heading).toBe(
      "function name\u2028continued",
    );
  });

  it("returns an empty model for an empty diff", () => {
    expect(parseUnifiedDiff(Buffer.alloc(0))).toEqual({ files: [] });
  });

  it("keeps header-like content inside hunks without changing paths or line numbers", () => {
    const output =
      "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n--- old heading\n+++ new heading\n context\n";
    const file = parseUnifiedDiff(Buffer.from(output)).files[0];

    expect(file).toMatchObject({ oldPath: "file.txt", newPath: "file.txt" });
    expect(file?.hunks[0]?.lines).toEqual([
      { type: "deletion", content: "-- old heading", oldLineNumber: 1 },
      { type: "addition", content: "++ new heading", newLineNumber: 1 },
      { type: "context", content: "context", oldLineNumber: 2, newLineNumber: 2 },
    ]);
  });

  it("retains binary paths with spaces and metadata-only mode changes", () => {
    const diff = parseUnifiedDiff(
      Buffer.from(
        "diff --git a/a b/file.bin b/a b/file.bin\nBinary files a/a b/file.bin and b/a b/file.bin differ\ndiff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n",
      ),
    );

    expect(diff.files[0]).toMatchObject({ newPath: "a b/file.bin", binary: true });
    expect(diff.files[1]).toMatchObject({
      newPath: "script.sh",
      oldMode: "100644",
      newMode: "100755",
    });
  });

  it("decodes Git-quoted marker paths", () => {
    const output =
      'diff --git "a/a file.txt" "b/a file.txt"\n--- "a/a file.txt"\n+++ "b/a file.txt"\n@@ -1 +1 @@\n-old\n+new\n';
    expect(parseUnifiedDiff(Buffer.from(output)).files[0]).toMatchObject({
      oldPath: "a file.txt",
      newPath: "a file.txt",
    });
  });

  it.each(["rename", "copy"])("decodes quoted %s metadata paths", (kind) => {
    const output = `diff --git "a/old\\tname" "b/new\\tname"\nsimilarity index 100%\n${kind} from "old\\tname"\n${kind} to "new\\tname"\n`;

    expect(parseUnifiedDiff(Buffer.from(output)).files[0]).toMatchObject({
      oldPath: "old\tname",
      newPath: "new\tname",
      status: kind === "rename" ? "renamed" : "copied",
      hunks: [],
    });
  });

  it("decodes octal UTF-8 paths without interpreting escaped backslashes twice", () => {
    const output =
      'diff --git "a/caf\\303\\251\\\\a.txt" "b/caf\\303\\251\\\\a.txt"\nold mode 100644\nnew mode 100755\n';

    expect(parseUnifiedDiff(Buffer.from(output)).files[0]).toMatchObject({
      oldPath: "café\\a.txt",
      newPath: "café\\a.txt",
    });
  });
});
