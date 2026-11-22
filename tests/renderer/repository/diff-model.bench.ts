import { test } from "vitest";
import type { UnifiedDiff } from "@shared/repository/repository-read";
import { toSideBySideRows, toUnifiedRows } from "@renderer/repository/diff-model";

test("build navigation rows for an 8,000-line diff", async ({ bench }) => {
  const diff: UnifiedDiff = {
    files: Array.from({ length: 20 }, (_, index) => ({
      newPath: `file${index}.ts`,
      status: "modified",
      binary: false,
      hunks: [
        {
          heading: "",
          oldStart: 1,
          newStart: 1,
          oldLines: 200,
          newLines: 200,
          lines: Array.from({ length: 400 }, (_, line) => ({
            type: line < 200 ? "deletion" : "addition",
            content: `const value = ${line} + Math.max(1, 2);`,
          })),
        },
      ],
    })),
  };
  await bench("unified", () => {
    toUnifiedRows(diff);
  }).run();
  await bench("split", () => {
    toSideBySideRows(toUnifiedRows(diff));
  }).run();
});
