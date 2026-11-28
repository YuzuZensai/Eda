import { afterEach, describe, expect, it } from "vitest";
import { displayedSource, createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { PartialStageService } from "@main/repo/working-tree/partial-stage-service";

let repo: TempRepo;

afterEach(async () => {
  if (repo) await repo.cleanup();
});

describe("partial index writes", () => {
  it("stages the displayed selected line after header-like hunk content", async () => {
    repo = await createTempRepo();
    await repo.writeFile("file.txt", "-- old heading\nkeep\n");
    await repo.commit("initial");
    await repo.writeFile("file.txt", "++ new heading\nkeep\nextra\n");

    const diff = await repo.git.workingDiff(repo.path, { area: "unstaged" });
    const line = diff.files[0]!.hunks[0]!.lines.findIndex(
      (entry) => entry.type === "addition" && entry.content === "extra",
    );
    expect(line).toBeGreaterThanOrEqual(0);

    const partial = new PartialStageService(repo.git);
    const preview = await partial.preview(repo.path, "work", {
      repositoryId: "r",
      path: "file.txt",
      area: "unstaged",
      sourceDigest: await displayedSource(repo, "file.txt", "unstaged"),
      lines: [{ hunk: 0, line }],
    });
    await partial.apply(repo.path, "work", "r", preview.token);

    expect(await repo.run(["show", ":file.txt"])).toBe("-- old heading\nkeep\nextra\n");
  });

  it("rejects an explicit context line even when its whole hunk is selected", async () => {
    repo = await createTempRepo();
    await repo.writeFile("notes", "keep\nold\n");
    await repo.commit("base");
    await repo.writeFile("notes", "keep\nnew\n");

    const partial = new PartialStageService(repo.git);
    const request = {
      repositoryId: "r",
      path: "notes",
      area: "unstaged" as const,
      sourceDigest: await displayedSource(repo, "notes", "unstaged"),
      hunks: [0],
    };

    await expect(
      partial.preview(repo.path, "work", {
        ...request,
        lines: [{ hunk: 0, line: 0 }],
      }),
    ).rejects.toThrow("Select added or deleted lines");

    const { token } = await partial.preview(repo.path, "work", {
      ...request,
      lines: [{ hunk: 0, line: 1 }],
    });
    await partial.apply(repo.path, "work", "r", token);
    expect(await repo.run(["show", ":notes"])).toBe("keep\nnew\n");
  });

  it.each(["one\r\ntwo\r\n", "one\ntwo"])(
    "preserves CRLF and missing final newlines: %j",
    async (original) => {
      repo = await createTempRepo();
      await repo.run(["config", "core.autocrlf", "false"]);
      await repo.writeFile("file.txt", original);
      await repo.commit("initial");

      const changed = original.replace("two", "changed");

      await repo.writeFile("file.txt", changed);

      const partial = new PartialStageService(repo.git);
      const preview = await partial.preview(repo.path, "work", {
        repositoryId: "r",
        path: "file.txt",
        area: "unstaged",
        sourceDigest: await displayedSource(repo, "file.txt", "unstaged"),
        hunks: [0],
      });

      await partial.apply(repo.path, "work", "r", preview.token);
      expect(await repo.run(["show", ":file.txt"])).toBe(changed);

      const reverse = await partial.preview(repo.path, "work", {
        repositoryId: "r",
        path: "file.txt",
        area: "staged",
        sourceDigest: await displayedSource(repo, "file.txt", "staged"),
        hunks: [0],
      });

      await partial.apply(repo.path, "work", "r", reverse.token);
      expect(await repo.run(["show", ":file.txt"])).toBe(original);
    },
  );

  it("stages one of two hunks, commits it, and leaves the other change in the worktree", async () => {
    repo = await createTempRepo();

    const original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";

    await repo.writeFile("file.txt", original);
    await repo.commit("initial");
    await repo.writeFile(
      "file.txt",
      original.replace("line 1\n", "first change\n").replace("line 25\n", "second change\n"),
    );

    const partial = new PartialStageService(repo.git);
    const preview = await partial.preview(repo.path, "work", {
      repositoryId: "r",
      path: "file.txt",
      area: "unstaged",
      sourceDigest: await displayedSource(repo, "file.txt", "unstaged"),
      hunks: [0],
    });

    expect(preview.patch).not.toContain("second change");

    await partial.apply(repo.path, "work", "r", preview.token);
    await repo.run(["commit", "-m", "first hunk"]);
    expect(await repo.run(["show", "HEAD:file.txt"])).toContain("first change");
    expect(await repo.run(["show", "HEAD:file.txt"])).not.toContain("second change");
    expect(await repo.run(["diff"])).toContain("second change");
  });

  it("stages selected lines and unstages a replacement without altering the worktree", async () => {
    repo = await createTempRepo();
    await repo.writeFile("file.txt", "old\nkeep\n");
    await repo.commit("initial");
    await repo.writeFile("file.txt", "new\nkeep\nextra\n");

    const partial = new PartialStageService(repo.git);
    let preview = await partial.preview(repo.path, "work", {
      repositoryId: "r",
      path: "file.txt",
      area: "unstaged",
      sourceDigest: await displayedSource(repo, "file.txt", "unstaged"),
      lines: [
        { hunk: 0, line: 0 },
        { hunk: 0, line: 1 },
      ],
    });

    await partial.apply(repo.path, "work", "r", preview.token);
    expect(await repo.run(["show", ":file.txt"])).toBe("new\nkeep\n");

    preview = await partial.preview(repo.path, "work", {
      repositoryId: "r",
      path: "file.txt",
      area: "staged",
      sourceDigest: await displayedSource(repo, "file.txt", "staged"),
      hunks: [0],
    });
    await partial.apply(repo.path, "work", "r", preview.token);
    expect(await repo.run(["show", ":file.txt"])).toBe("old\nkeep\n");
    expect(await repo.run(["diff"])).toContain("+extra");
  });

  it("rejects stale previews and a different profile without applying any index change", async () => {
    repo = await createTempRepo();
    await repo.writeFile("file.txt", "old\n");
    await repo.commit("initial");
    await repo.writeFile("file.txt", "new\n");

    const partial = new PartialStageService(repo.git);
    const preview = await partial.preview(repo.path, "work", {
      repositoryId: "r",
      path: "file.txt",
      area: "unstaged",
      sourceDigest: await displayedSource(repo, "file.txt", "unstaged"),
      hunks: [0],
    });

    await expect(partial.apply(repo.path, "other", "r", preview.token)).rejects.toThrow();

    await repo.writeFile("file.txt", "changed again\n");
    await expect(partial.apply(repo.path, "work", "r", preview.token)).rejects.toThrow(
      "changed after",
    );
    expect(await repo.run(["diff", "--cached"])).toBe("");
  });

  it("supports new UTF-8 files and partial unstaging without dropping remaining lines", async () => {
    repo = await createTempRepo();
    await repo.writeFile("日本語 file.txt", "one\ntwo\n");

    const partial = new PartialStageService(repo.git);
    let preview = await partial.preview(repo.path, "work", {
      repositoryId: "r",
      path: "日本語 file.txt",
      area: "unstaged",
      sourceDigest: await displayedSource(repo, "日本語 file.txt", "unstaged"),
      lines: [{ hunk: 0, line: 0 }],
    });

    await partial.apply(repo.path, "work", "r", preview.token);
    expect(await repo.run(["show", ":日本語 file.txt"])).toBe("one\n");

    await repo.run(["add", "."]);
    preview = await partial.preview(repo.path, "work", {
      repositoryId: "r",
      path: "日本語 file.txt",
      area: "staged",
      sourceDigest: await displayedSource(repo, "日本語 file.txt", "staged"),
      lines: [{ hunk: 0, line: 0 }],
    });
    await partial.apply(repo.path, "work", "r", preview.token);
    expect(await repo.run(["show", ":日本語 file.txt"])).toBe("two\n");
  });
});

it("rejects a hunk when an earlier edit changed its position since display", async () => {
  repo = await createTempRepo();
  const original = Array.from({ length: 32 }, (_, i) => "line " + i + "\n").join("");
  await repo.writeFile("file", original);
  await repo.commit("initial");
  const visible = original.replace("line 28\n", "visible edit\n");
  await repo.writeFile("file", visible);
  const sourceDigest = await displayedSource(repo, "file", "unstaged");
  await repo.writeFile("file", visible.replace("line 2\n", "later edit\n"));
  const service = new PartialStageService(repo.git);
  await expect(
    service.preview(repo.path, "work", {
      repositoryId: "r",
      path: "file",
      area: "unstaged",
      sourceDigest,
      hunks: [0],
    }),
  ).rejects.toThrow("changed");
  expect(await repo.run(["show", ":file"])).toBe(original);
});
it("stages ordinary text containing a Git file mode", async () => {
  repo = await createTempRepo();
  await repo.writeFile("notes", "documented mode 120000\n");
  const service = new PartialStageService(repo.git);
  const { token } = await service.preview(repo.path, "work", {
    repositoryId: "r",
    path: "notes",
    area: "unstaged",
    sourceDigest: await displayedSource(repo, "notes", "unstaged"),
    hunks: [0],
  });
  await service.apply(repo.path, "work", "r", token);
  expect(await repo.run(["show", ":notes"])).toBe("documented mode 120000\n");
});

it.each([
  { path: "notes", text: "line separator\u2028old mode 100644" },
  ...(process.platform === "win32" ? [] : [{ path: "bell\x07file.txt", text: "updated" }]),
])(
  "stages the displayed text in $path without interpreting it as patch metadata",
  async ({ path, text }) => {
    repo = await createTempRepo();
    await repo.writeFile(path, "before\n");
    await repo.commit("base");
    await repo.writeFile(path, text + "\n");
    const service = new PartialStageService(repo.git);
    const { token } = await service.preview(repo.path, "work", {
      repositoryId: "r",
      path,
      area: "unstaged",
      sourceDigest: await displayedSource(repo, path, "unstaged"),
      hunks: [0],
    });
    await service.apply(repo.path, "work", "r", token);
    expect(await repo.run(["show", ":" + path])).toBe(text + "\n");
  },
);

it("retains blank context lines and their line numbers when Git hides blank context prefixes", async () => {
  repo = await createTempRepo();
  await repo.writeFile("notes", "first\n\nbefore\nlast\n");
  await repo.commit("base");
  await repo.run(["config", "diff.suppressBlankEmpty", "true"]);
  await repo.writeFile("notes", "first\n\nafter\nlast\n");
  const diff = await repo.git.workingDiff(repo.path, { paths: ["notes"], area: "unstaged" });
  expect(diff.files[0]!.hunks[0]!.lines).toContainEqual({
    type: "addition",
    newLineNumber: 3,
    content: "after",
  });
  const service = new PartialStageService(repo.git);
  const { token } = await service.preview(repo.path, "work", {
    repositoryId: "r",
    path: "notes",
    area: "unstaged",
    sourceDigest: diff.sourceDigest!,
    hunks: [0],
  });
  await service.apply(repo.path, "work", "r", token);
  expect(await repo.run(["show", ":notes"])).toBe("first\n\nafter\nlast\n");
});
