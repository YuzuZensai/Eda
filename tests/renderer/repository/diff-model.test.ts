import type { UnifiedDiff } from "@shared/repository/repository-read";
import {
  MAX_WORD_DIFF_CHARS,
  boundDiff,
  emphasizeWords,
  highlightLine,
  toSideBySideRows,
  toUnifiedRows,
} from "@renderer/repository/diff-model";

const diff: UnifiedDiff = {
  files: [
    {
      oldPath: "a.ts",
      newPath: "a.ts",
      status: "modified",
      binary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          heading: "",
          lines: [
            { type: "deletion", content: "const old = 1", oldLineNumber: 1 },
            { type: "addition", content: "const next = 2", newLineNumber: 1 },
          ],
        },
      ],
    },
  ],
};

describe("diff presentation model", () => {
  it("normalizes unified and paired side-by-side rows", () => {
    const unified = toUnifiedRows(diff);
    const paired = toSideBySideRows(unified);
    expect(unified.map((row) => row.kind)).toEqual(["file", "hunk", "deletion", "addition"]);
    expect(paired).toHaveLength(3);
    expect(paired[2]).toMatchObject({ left: unified[2], right: unified[3] });
  });

  it("creates inert token data and bounds expensive word comparison", () => {
    expect(
      highlightLine("<img onerror=alert(1)>")
        .map((token) => token.text)
        .join(""),
    ).toBe("<img onerror=alert(1)>");

    const long = "x".repeat(MAX_WORD_DIFF_CHARS);

    expect(emphasizeWords(long, long)[0].some((token) => token.emphasized)).toBe(false);
  });

  it("collapses large and generated diffs before creating text rows, with explicit reveal", () => {
    const files = [
      { ...diff.files[0]!, newPath: "pnpm-lock.yaml" },
      {
        ...diff.files[0]!,
        newPath: "large.ts",
        hunks: [
          {
            ...diff.files[0]!.hunks[0]!,
            lines: Array.from({ length: 501 }, () => ({
              type: "addition" as const,
              content: "const value = 1",
            })),
          },
        ],
      },
      { ...diff.files[0]!, newPath: "small.ts" },
    ];

    const rows = toUnifiedRows({ files });

    expect(rows.filter((row) => row.kind === "addition")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "notice").map((row) => row.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Generated file hidden"),
        expect.stringContaining("Large diff hidden"),
      ]),
    );

    const revealed = toUnifiedRows({ files }, new Map([[1, true]]));

    expect(revealed.filter((row) => row.kind === "addition")).toHaveLength(502);
    expect(toSideBySideRows(rows).filter((row) => row.left?.kind === "notice")).toHaveLength(2);
  });

  it("shows named binary and metadata-only changes without an expand action", () => {
    const rows = toUnifiedRows({
      files: [
        { status: "modified", binary: true, newPath: "logo.png", hunks: [] },
        {
          status: "type-changed",
          binary: false,
          newPath: "script.sh",
          oldMode: "100644",
          newMode: "100755",
          hunks: [],
        },
      ],
    });

    expect(rows[0]).toMatchObject({ text: "logo.png", file: { expandable: false } });
    expect(rows[1]?.text).toContain("Binary file changed");
    expect(rows[3]?.text).toContain("100644 to 100755");
  });

  it("avoids token explosions on minified lines and reports truncated expanded previews", () => {
    const long = "x + ".repeat(6_000);

    expect(highlightLine(long)).toEqual([{ kind: "plain", text: long }]);

    const bounded = boundDiff({
      files: [
        {
          ...diff.files[0]!,
          hunks: [{ ...diff.files[0]!.hunks[0]!, lines: [{ type: "addition", content: long }] }],
        },
      ],
    });

    expect(toUnifiedRows(bounded).some((row) => row.kind === "addition")).toBe(false);
    expect(
      toUnifiedRows(bounded, new Map([[0, true]])).some((row) =>
        row.text.startsWith("Preview truncated"),
      ),
    ).toBe(true);
  });
});

it("offers partial edits only on fully visible hunks and lines after preview limits are applied", () => {
  const first = diff.files[0]!.hunks[0]!;
  const long = "x".repeat(25_000);
  const second = { ...first, lines: [{ type: "addition" as const, content: long }] };
  const rows = toUnifiedRows(
    boundDiff({ files: [{ ...diff.files[0]!, hunks: [first, second] }] }),
    new Map([[0, true]]),
  );
  expect(rows.filter((row) => row.kind === "hunk").map((row) => row.hunkIndex)).toEqual([
    0,
    undefined,
  ]);
  expect(
    rows.find((row) => row.kind === "addition" && row.text.startsWith("x"))?.lineIndex,
  ).toBeUndefined();
  const short = toUnifiedRows(boundDiff(diff, 3), new Map([[0, true]]));
  expect(short.find((row) => row.kind === "hunk")?.hunkIndex).toBeUndefined();
  expect(short.find((row) => row.kind === "deletion")?.lineIndex).toBe(0);
});
