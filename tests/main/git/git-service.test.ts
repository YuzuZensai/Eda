import { afterEach, describe, expect, it } from "vitest";
import { GitError } from "@shared/errors";
import { MAX_DIFF_FILES } from "@shared/repository/diff-limits";
import { FakeProcessRunner } from "../../helpers/fake-process-runner";
import { GitService } from "@main/git/git-service";
import { listSubmodules } from "@main/git/operations/submodules";
import { repositoryCapabilities } from "@main/repo/lifecycle/repository-capabilities";
import { listWorktrees } from "@main/git/operations/worktrees";
import { readRevisionPath, readBlame } from "@main/git/operations/revision-path";
import { readRevisionComparison } from "@main/git/operations/revision-comparison";
import { transportOptions } from "@main/git/operations/remotes";
import { ProcessSpawnError } from "@main/git/execution/process-runner";
import type { GitEngine } from "@main/git/execution/git-engine";
import { assertHermetic, createTempRepo, type TempRepo } from "../../helpers/temp-repo";
import { access, writeFile, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { pushErrorFixtures } from "../../fixtures/git-errors";

const FAKE_ENGINE: GitEngine = {
  source: "system",
  path: "/usr/bin/git",
  version: "2.55.0",
  versionParts: { major: 2, minor: 55, patch: 0 },
};

describe("GitService against real Git", () => {
  let repo: TempRepo;

  afterEach(async () => {
    await repo?.cleanup();
  });

  it("drives a real command and returns a typed result", async () => {
    repo = await createTempRepo();
    await repo.writeFile("README.md", "# Eda\n");
    await repo.commit("Initial commit");

    const root = await repo.git.resolveRepositoryRoot(repo.path);

    expect(root.endsWith("repo")).toBe(true);

    expect(await repo.git.isRepository(repo.path)).toBe(true);
  });

  it("stages, commits and inspects history in a sparse SHA-256 checkout with a promisor configured", async () => {
    repo = await createTempRepo({ init: false });
    await repo.run(["init", "--object-format=sha256", "-b", "main"]);
    await repo.writeFile("dir/a", "a");
    await repo.commit("base");
    await repo.run(["sparse-checkout", "set", "dir"]);
    await repo.run(["config", "remote.local.promisor", "true"]);
    expect(await repositoryCapabilities(repo.git, repo.path, true)).toMatchObject({
      write: true,
      objectFormat: "sha256",
      shallow: false,
      sparse: true,
      partial: true,
    });

    const parent = (await repo.run(["rev-parse", "HEAD"])).trim();
    await repo.writeFile("dir/a", "updated\n");
    await repo.git.stage(repo.path, ["dir/a"]);
    const tip = await repo.git.commit(repo.path, "Update sparse file");

    expect(tip).toMatch(/^[a-f0-9]{64}$/);
    expect((await repo.git.status(repo.path)).changes).toEqual([]);
    expect((await repo.git.history(repo.path)).commits[0]).toMatchObject({
      oid: tip,
      parents: [parent],
    });
    expect(
      await readRevisionComparison(repo.git, repo.path, {
        repositoryId: "repo",
        left: parent,
        right: tip,
        mode: "direct",
      }),
    ).toMatchObject({
      baseOid: parent,
      rightOid: tip,
      files: [{ status: "modified", oldPath: "dir/a", newPath: "dir/a" }],
    });
    expect(await repo.run(["show", tip + ":dir/a"])).toBe("updated\n");
  });

  it("inspects submodule changes, recorded commits, missing directories and the parent path", async () => {
    repo = await createTempRepo();
    await repo.writeFile("seed", "original");
    await repo.commit("base");
    const child = join(repo.path, "child module");
    await repo.run([
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      repo.path,
      "child module",
    ]);
    await repo.commit("record child");
    expect((await listSubmodules(repo.git, repo.path)).entries).toEqual([
      { path: "child module", directory: child, state: "initialized", dirty: false },
    ]);
    expect((await listSubmodules(repo.git, child)).parent).toBe(repo.path);
    await writeFile(join(child, "seed"), "modified");
    expect((await listSubmodules(repo.git, repo.path)).entries[0]?.dirty).toBe(true);
    await repo.run(["commit", "-am", "child advances"], child);
    expect((await listSubmodules(repo.git, repo.path)).entries[0]?.state).toBe("outOfSync");
    await repo.run(["submodule", "deinit", "-f", "--", "child module"]);
    expect((await listSubmodules(repo.git, repo.path)).entries[0]?.state).toBe("uninitialized");
    await rename(child, child + "-moved");
    expect((await listSubmodules(repo.git, repo.path)).entries[0]?.state).toBe("missing");
  });

  it("distinguishes the main worktree, detached locked worktrees and prunable registrations", async () => {
    repo = await createTempRepo();
    await repo.writeFile("tracked", "contents");
    await repo.commit("Seed");
    const linked = join(repo.home, "linked worktree");
    await repo.run(["worktree", "add", "--detach", linked]);
    await repo.run(["worktree", "lock", "--reason", "offline", linked]);
    expect(await listWorktrees(repo.git, linked)).toMatchObject([
      { path: repo.path, main: true, branch: "main" },
      { path: linked, main: false, locked: "offline" },
    ]);
    await repo.run(["worktree", "unlock", linked]);
    await rename(linked, linked + "-moved");
    const entries = await listWorktrees(repo.git, repo.path);
    expect(entries[1]?.prunable).toBeTruthy();
    expect(entries[1]?.branch).toBeUndefined();
  });

  it("browses committed content and follows a renamed file through history and blame", async () => {
    repo = await createTempRepo();
    await repo.writeFile("old [x].txt", "unchanged\nold\nmore\n");
    await repo.commit("Original");
    const first = (await repo.run(["rev-parse", "HEAD"])).trim();
    await repo.run(["mv", "old [x].txt", "new [x].txt"]);
    await repo.writeFile("new [x].txt", "unchanged\nnew\nmore\n");
    await repo.commit("Rename");
    const oid = (await repo.run(["rev-parse", "HEAD"])).trim();
    await repo.writeFile("new [x].txt", "worktree only");
    const request = { repositoryId: "repo", oid, path: "new [x].txt" };
    expect(
      await readRevisionPath(repo.git, repo.path, { repositoryId: "repo", oid }),
    ).toMatchObject({ kind: "tree", entries: [{ name: request.path, type: "blob" }] });
    expect(await readRevisionPath(repo.git, repo.path, request)).toEqual({
      kind: "text",
      text: "unchanged\nnew\nmore\n",
    });
    const history = await repo.git.history(repo.path, {
      refs: [oid],
      search: { field: "path", text: request.path },
    });
    expect(history.commits.map((c) => c.oid)).toEqual([oid, first]);
    const blame = await readBlame(repo.git, repo.path, { ...request, start: 1 });
    expect(blame.map((line) => line.oid)).toEqual([first, oid, first]);
    expect(blame[1]?.previous).toEqual({ oid: first, path: "old [x].txt" });
    const found = await repo.git.history(repo.path, {
      search: { field: "message", text: "ORIGINAL" },
    });
    expect(found.commits.map((c) => c.oid)).toEqual([first]);
  });

  it("exports an applicable Git patch for untracked binary content, staged renames and committed mode changes", async () => {
    repo = await createTempRepo();
    const path = "bytes [new].bin";
    const request = { repositoryId: "repo", path };
    await writeFile(join(repo.path, path), Buffer.from([0, 12, 255]));
    const binary = await repo.git.filePatch(repo.path, { ...request, area: "unstaged" });
    expect(binary.toString()).toContain("GIT binary patch");
    const patch = join(repo.home, "change.patch");
    await writeFile(patch, binary);
    await unlink(join(repo.path, path));
    await repo.run(["apply", "--index", patch]);
    await repo.run(["commit", "-m", "binary"]);
    const nextPath = "renamed.bin";
    await repo.run(["mv", "--", path, nextPath]);
    await repo.run(["update-index", "--chmod=+x", "--", nextPath]);
    const staged = await repo.git.filePatch(repo.path, {
      ...request,
      path: nextPath,
      area: "staged",
    });
    expect(staged.toString()).toContain("rename from " + path);
    expect(staged.toString()).toContain("new mode 100755");
    await repo.run(["commit", "-m", "rename"]);
    const oid = (await repo.run(["rev-parse", "HEAD"])).trim();
    expect(
      await repo.git.filePatch(repo.path, { ...request, oid, oldPath: path, path: nextPath }),
    ).toEqual(staged);
    expect(await repo.git.filePatch(repo.path, { repositoryId: "repo", oid })).toEqual(staged);
    await writeFile(patch, staged);
    await repo.run(["apply", "--reverse", "--cached", "--check", patch]);
  });

  it("uses the requested context and whitespace rules for working, staged and historical diffs", async () => {
    repo = await createTempRepo();
    const original = Array.from({ length: 90 }, (_, i) => "row " + i).join("\n") + "\n";
    const path = "context.txt";
    await repo.writeFile(path, original);
    await repo.commit("Base");
    const base = (await repo.run(["rev-parse", "HEAD"])).trim();
    await repo.writeFile(path, original.replace("row 45", "row     45"));
    const options = { paths: [path], context: "full" as const };
    const working = await repo.git.workingDiff(repo.path, { ...options, area: "unstaged" });
    expect(working.files[0]?.hunks[0]?.lines.at(-1)?.content).toBe("row 89");
    const filtered = { ...options, ignoreWhitespace: true };
    expect(
      (await repo.git.workingDiff(repo.path, { ...filtered, area: "unstaged" })).files,
    ).toEqual([]);
    await repo.run(["add", "--", path]);
    expect((await repo.git.workingDiff(repo.path, { ...filtered, area: "staged" })).files).toEqual(
      [],
    );
    await repo.commit("Spaces");
    const right = (await repo.run(["rev-parse", "HEAD"])).trim();
    expect((await repo.git.commitDiff(repo.path, right, [path], filtered)).files).toEqual([]);
    const compared = await repo.git.compareDiff(repo.path, base, right, [path], {
      context: "expanded",
    });
    expect(compared.files[0]?.hunks[0]?.lines[0]?.content).toBe("row 15");
  });

  it("does not execute tracked clone hooks selected by global configuration", async () => {
    repo = await createTempRepo();
    const marker = join(repo.home, "clone-hook-executed");
    await repo.writeFile(
      ".githooks/post-checkout",
      `#!/bin/sh\nprintf executed > '${marker.replaceAll("\\", "/")}'\n`,
    );
    await repo.run(["add", "--chmod=+x", ".githooks/post-checkout"]);
    await repo.run(["commit", "-m", "tracked hook"]);
    await repo.run(["config", "--global", "core.hooksPath", ".githooks"]);
    await repo.git.exec(["clone", "--", repo.path, join(repo.home, "clone")], {
      operation: "clone",
      cwd: repo.home,
    });
    await expect(access(marker)).rejects.toThrow();
  });

  it("never touches the developer's real global config", async () => {
    repo = await createTempRepo();
    await assertHermetic(repo);

    await repo.git.writeConfig("user.email", "sandbox@eda.invalid", {
      scope: "global",
      cwd: repo.path,
    });
    expect(await repo.git.readConfig("user.email", { cwd: repo.path, scope: "global" })).toBe(
      "sandbox@eda.invalid",
    );
    expect(repo.home).toContain("eda-test-");
  });

  it("reports actual global and overriding local origins, including unset keys", async () => {
    repo = await createTempRepo();
    expect(await repo.git.inspectConfig("user.email", { scope: "global" })).toMatchObject({
      value: "test@eda.invalid",
      scope: "global",
      origin: expect.stringContaining(".gitconfig"),
    });

    await repo.git.writeConfig("user.email", "local@example.com", {
      cwd: repo.path,
      scope: "local",
    });
    expect(await repo.git.inspectConfig("user.email", { cwd: repo.path })).toMatchObject({
      value: "local@example.com",
      scope: "local",
      origin: expect.stringContaining("config"),
    });
    expect(await repo.git.inspectConfig("eda.nonexistent", { cwd: repo.path })).toEqual({
      key: "eda.nonexistent",
    });
  });

  it("reports a plain directory as not-a-repository rather than throwing", async () => {
    repo = await createTempRepo({ init: false });
    expect(await repo.git.isRepository(repo.path)).toBe(false);
  });

  it("lists only direct local configuration keys without following includes", async () => {
    repo = await createTempRepo();
    const included = join(repo.home, "included.gitconfig");
    await writeFile(included, "[user]\n\temail = included@example.com\n");
    await repo.run(["config", "--local", "include.path", included]);
    await repo.run(["config", "--local", "user.name", "Local Author"]);

    const keys = await repo.git.localConfigKeys(repo.path);
    expect(keys).toContain("user.name");
    expect(keys).not.toContain("user.email");
    expect(keys).not.toContain("");
  });

  it("maps a missing repository to a typed error", async () => {
    repo = await createTempRepo();
    await expect(
      repo.git.exec(["status"], { cwd: `${repo.path}/does-not-exist`, operation: "read status" }),
    ).rejects.toMatchObject({ kind: "not-a-repository", operation: "read status" });
  });

  it("returns undefined for an unset config key instead of failing", async () => {
    repo = await createTempRepo();
    expect(await repo.git.readConfig("eda.nothing.here", { cwd: repo.path })).toBeUndefined();
  });

  it("confirms ref names with Git itself", async () => {
    repo = await createTempRepo();
    expect(await repo.git.isRefNameValid("feature/identity-switch")).toBe(true);
    await expect(repo.git.isRefNameValid("bad branch")).rejects.toThrow(GitError);
  });

  it("splits -z output on NUL without a trailing empty field", async () => {
    repo = await createTempRepo();
    await repo.writeFile("a.txt", "a\n");
    await repo.writeFile("b.txt", "b\n");

    const fields = await repo.git.execFields(["status", "--porcelain=v2", "-z"], {
      cwd: repo.path,
      operation: "read status",
    });

    expect(fields.length).toBe(2);
    expect(fields.every((f) => f.length > 0)).toBe(true);
  });

  it("reads typed status including untracked files", async () => {
    repo = await createTempRepo();
    await repo.writeFile("tracked.txt", "before\n");
    await repo.commit("Root");
    await repo.writeFile("tracked.txt", "after\n");
    await repo.writeFile("untracked.txt", "new\n");

    const status = await repo.git.status(repo.path);

    expect(status.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt", worktree: "M" }),
        expect.objectContaining({ path: "untracked.txt", kind: "untracked" }),
      ]),
    );
  });

  it.runIf(process.platform === "linux")(
    "blocks ambiguous file actions when status contains a non-UTF-8 filename",
    async () => {
      repo = await createTempRepo();
      const invalid = Buffer.concat([Buffer.from(join(repo.path, "bad")), Buffer.from([0xff])]);
      await writeFile(invalid, "raw");
      await repo.writeFile("bad�", "unicode");
      await expect(repo.git.status(repo.path)).rejects.toMatchObject({ kind: "invalid-input" });
      expect(await repo.run(["ls-files", "--cached"])).toBe("");
      await unlink(invalid);
      expect((await repo.git.status(repo.path)).changes.map((change) => change.path)).toEqual([
        "bad�",
      ]);
    },
  );

  it("reads a valid record separator inside commit text", async () => {
    repo = await createTempRepo();
    await repo.writeFile("test", "content");
    await repo.commit("subject\x1econtinued\n\nbody\x1econtinued");
    const [commit] = (await repo.git.history(repo.path)).commits;
    expect(commit).toMatchObject({
      subject: "subject\x1econtinued",
      body: expect.stringContaining("body\x1econtinued"),
    });
  });

  it("pages typed history and includes every merge parent", async () => {
    repo = await createTempRepo();
    await repo.writeFile("root.txt", "root\n");
    await repo.commit("Root");
    await repo.run(["checkout", "-b", "side"]);
    await repo.writeFile("side.txt", "side\n");
    await repo.commit("Side");

    const side = (await repo.run(["rev-parse", "HEAD"])).trim();

    await repo.run(["checkout", "main"]);
    await repo.writeFile("second.txt", "second\n");
    await repo.commit("Second");

    const main = (await repo.run(["rev-parse", "HEAD"])).trim();

    await repo.run(["merge", "--no-ff", "side", "-m", "Merge side"]);

    const first = await repo.git.history(repo.path, { limit: 1 });
    const second = await repo.git.history(repo.path, { offset: first.nextOffset!, limit: 1 });

    expect(first.commits[0]?.subject).toBe("Merge side");
    expect(first.commits[0]?.parents).toEqual([main, side]);
    expect(first.nextOffset).toBe(1);
    expect([main, side]).toContain(second.commits[0]?.oid);
    expect(second.commits[0]?.oid).not.toBe(first.commits[0]?.oid);
  });

  it("returns root commit and untracked working diffs", async () => {
    repo = await createTempRepo();
    await repo.writeFile("root.txt", "root\n");
    await repo.commit("Root");

    const oid = (await repo.run(["rev-parse", "HEAD"])).trim();

    await repo.writeFile("untracked.txt", "new\n");

    const rootDiff = await repo.git.commitDiff(repo.path, oid);
    const workingDiff = await repo.git.workingDiff(repo.path, {
      area: "unstaged",
      paths: ["untracked.txt"],
    });

    expect(rootDiff.files[0]).toMatchObject({ status: "added", newPath: "root.txt" });
    expect(workingDiff.files[0]).toMatchObject({ status: "added", newPath: "untracked.txt" });
  });

  it.runIf(process.platform !== "win32").each(["\t", "\x07", "\x0b", "\x1b"])(
    "keeps quoted rename paths consistent between status and diffs: %j",
    async (separator) => {
      repo = await createTempRepo();
      const oldPath = `old${separator}name.txt`;
      const newPath = `new${separator}name.txt`;
      await repo.writeFile(oldPath, "unchanged content\n");
      await repo.commit("initial");
      await repo.run(["mv", "--", oldPath, newPath]);

      expect((await repo.git.status(repo.path)).changes[0]).toMatchObject({
        path: newPath,
        originalPath: oldPath,
      });
      expect((await repo.git.workingDiff(repo.path, { area: "staged" })).files[0]).toMatchObject({
        oldPath,
        newPath,
        status: "renamed",
      });
    },
  );

  it("reports a missing selected commit without claiming the repository is corrupt", async () => {
    repo = await createTempRepo();
    await repo.writeFile("root.txt", "root\n");
    await repo.commit("Root");

    await expect(repo.git.commitDiff(repo.path, "a".repeat(40))).rejects.toMatchObject({
      kind: "invalid-input",
      code: "main.git.gitService.theCommitIsNoLongerAvailable",
    });

    expect(await repo.run(["fsck", "--full"])).toBe("");
  });

  it("compares branch tips or their merge base and keeps file reads on the reviewed objects", async () => {
    repo = await createTempRepo();
    await repo.writeFile("old [topic].txt", "original\nsecond line\nthird line\n");
    await repo.commit("Base");
    const base = (await repo.run(["rev-parse", "HEAD"])).trim();
    await repo.run(["checkout", "-b", "topic"]);
    await repo.run(["mv", "--", "old [topic].txt", "new [topic].txt"]);
    await repo.writeFile("new [topic].txt", "change\nsecond line\nthird line\n");
    await repo.commit("Rename on topic");
    const topic = (await repo.run(["rev-parse", "HEAD"])).trim();
    await repo.run(["tag", "-a", "topic-version", "-m", "snapshot"]);
    await repo.run(["checkout", "main"]);
    await repo.writeFile("on-main", "left only\n");
    await repo.commit("Advance main");
    const main = (await repo.run(["rev-parse", "HEAD"])).trim();
    await repo.run(["config", "diff.renames", "false"]);
    const request = { repositoryId: "repo", left: "main", right: "refs/tags/topic-version" };
    const renamed = { status: "renamed", oldPath: "old [topic].txt", newPath: "new [topic].txt" };

    const direct = await readRevisionComparison(repo.git, repo.path, {
      ...request,
      mode: "direct",
    });
    expect(direct).toEqual({
      leftOid: main,
      rightOid: topic,
      baseOid: main,
      files: [renamed, { status: "deleted", oldPath: "on-main" }],
      omittedFiles: 0,
    });
    const merged = await readRevisionComparison(repo.git, repo.path, {
      ...request,
      left: main,
      right: "topic",
      mode: "merge-base",
    });
    expect(merged).toEqual({
      leftOid: main,
      rightOid: topic,
      baseOid: base,
      files: [renamed],
      omittedFiles: 0,
    });
    const ancestors = await readRevisionComparison(repo.git, repo.path, {
      ...request,
      left: "HEAD~1",
      right: "topic^",
      mode: "direct",
    });
    expect(ancestors).toEqual({
      leftOid: base,
      rightOid: base,
      baseOid: base,
      files: [],
      omittedFiles: 0,
    });

    await repo.run(["branch", "-f", "topic", "main"]);
    await repo.writeFile("on-main", "uncommitted and unrelated");
    const diff = await repo.git.compareDiff(repo.path, merged.baseOid, merged.rightOid, [
      renamed.oldPath,
      renamed.newPath,
    ]);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject(renamed);
    expect(diff.files[0]?.hunks[0]?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "deletion", content: "original" }),
        expect.objectContaining({ type: "addition", content: "change" }),
      ]),
    );
    expect((await repo.git.status(repo.path)).changes).toMatchObject([
      { path: "on-main", worktree: "M", index: "." },
    ]);
    expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(main);
  });

  it("reports ambiguous names and unrelated histories while direct comparisons remain available", async () => {
    repo = await createTempRepo();
    await repo.writeFile("one", "one\n");
    await repo.commit("One");
    await repo.run(["switch", "--orphan", "other"]);
    await repo.writeFile("two", "two\n");
    await repo.commit("Two");
    await repo.run(["tag", "main"]);
    await repo.run(["config", "core.warnAmbiguousRefs", "false"]);
    const request = { repositoryId: "repo", left: "main", right: "other", mode: "direct" } as const;

    await expect(readRevisionComparison(repo.git, repo.path, request)).rejects.toMatchObject({
      kind: "invalid-input",
      code: "main.git.gitService.ambiguousComparisonRevision",
    });
    await expect(
      readRevisionComparison(repo.git, repo.path, {
        ...request,
        left: "refs/heads/main",
        mode: "merge-base",
      }),
    ).rejects.toMatchObject({
      kind: "invalid-input",
      code: "main.git.gitService.noCommonAncestor",
    });
    const direct = await readRevisionComparison(repo.git, repo.path, {
      ...request,
      left: "refs/heads/main",
    });
    expect(direct.files).toEqual([
      { status: "deleted", oldPath: "one" },
      { status: "added", newPath: "two" },
    ]);
    await expect(
      readRevisionComparison(repo.git, repo.path, { ...request, left: "missing" }),
    ).rejects.toMatchObject({ kind: "invalid-input" });
  });

  it("limits a selected historical file to that path when a directory replaces it", async () => {
    repo = await createTempRepo();
    await repo.writeFile("item", "previous contents\n");
    await repo.commit("File");
    const base = (await repo.run(["rev-parse", "HEAD"])).trim();
    await repo.run(["rm", "item"]);
    await repo.writeFile("item/nested", "directory contents\n");
    await repo.commit("Directory");
    const tip = (await repo.run(["rev-parse", "HEAD"])).trim();

    const diff = await repo.git.compareDiff(repo.path, base, tip, ["item"]);
    expect(diff.files.map((file) => file.oldPath ?? file.newPath)).toEqual(["item"]);
  });
});

describe("GitService command construction", () => {
  const service = (runner: FakeProcessRunner) => new GitService(runner, FAKE_ENGINE);

  it("reports the number of changed files beyond the comparison display limit", async () => {
    const runner = new FakeProcessRunner()
      .when(({ args }) => args.includes("rev-parse"), {
        stdout: "a".repeat(40),
      })
      .otherwise({
        stdout: Array.from({ length: MAX_DIFF_FILES + 3 }, (_, index) => `M\0file-${index}\0`).join(
          "",
        ),
      });
    const result = await readRevisionComparison(service(runner), "/repo", {
      repositoryId: "repo",
      left: "main",
      right: "topic",
      mode: "direct",
    });
    expect(result.files).toHaveLength(MAX_DIFF_FILES);
    expect(result.omittedFiles).toBe(3);
  });

  it("retains the rejected ref and server reason for Activity when Git reports them on stdout", async () => {
    const runner = new FakeProcessRunner().otherwise({
      exitCode: 1,
      ...pushErrorFixtures.hookRejected,
    });

    await expect(
      service(runner).exec(["push", "--porcelain", "--", "origin", "main:main"], {
        operation: "push",
      }),
    ).rejects.toMatchObject({
      kind: "remote-rejected",
      rawStderr: expect.stringContaining(pushErrorFixtures.hookRejected.stdout),
    });
  });

  it("passes argv, never a shell string", async () => {
    const runner = new FakeProcessRunner().otherwise({ stdout: "true\n" });
    await service(runner).isRepository("/repo");
    expect(runner.lastCall?.executable).toBe("/usr/bin/git");
    expect(Array.isArray(runner.lastCall?.args)).toBe(true);
  });

  it("puts -- before user-controlled config keys and values", async () => {
    const runner = new FakeProcessRunner().otherwise({ exitCode: 0 });
    await service(runner).writeConfig("user.email", "--not-an-option", { scope: "global" });
    const args = runner.lastCall?.args ?? [];
    const separator = args.indexOf("--");
    expect(separator).toBeGreaterThan(-1);
    expect(args.slice(separator + 1)).toEqual(["user.email", "--not-an-option"]);
  });

  it("builds an explicit environment rather than inheriting the shell's", async () => {
    const runner = new FakeProcessRunner().otherwise({ stdout: "true\n" });

    await service(runner).isRepository("/repo");

    const env = runner.lastCall?.env ?? {};

    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["LC_ALL"]).toBe("C");
    expect(env["GIT_AUTHOR_NAME"]).toBeUndefined();
    expect(env["GIT_COMMITTER_EMAIL"]).toBeUndefined();
  });

  it("isolates clone configuration using Git's portable null path", async () => {
    const runner = new FakeProcessRunner().otherwise({ exitCode: 0 });
    await service(runner).exec(["clone", "--", "/source", "/destination"], { operation: "clone" });
    expect(runner.lastCall?.env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    expect(runner.lastCall?.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(runner.lastCall?.args).toEqual(
      expect.arrayContaining(["core.hooksPath=/dev/null", "init.templateDir="]),
    );
  });

  it("limits opted-in credential helpers to HTTPS without explicit credentials", () => {
    const helpers = (url: string, credentials?: { username: string; password: string }) => {
      const env = transportOptions(url, { name: "fixture" }, credentials, false, "cache").env!
        .overrides!;
      return Array.from({ length: Number(env["GIT_CONFIG_COUNT"]) }, (_, index) => [
        env["GIT_CONFIG_KEY_" + index],
        env["GIT_CONFIG_VALUE_" + index],
      ]).filter(([key]) => key?.startsWith("credential."));
    };
    expect(helpers("https://git.example/repo")).toEqual([
      ["credential.helper", ""],
      ["credential.helper", "cache"],
      ["credential.useHttpPath", "true"],
    ]);
    expect(helpers("https://git.example/repo", { username: "test", password: "fixture" })).toEqual([
      ["credential.helper", ""],
    ]);
    expect(helpers("git@git.example:repo")).toEqual([["credential.helper", ""]]);
  });

  it("pins SSH to one key so the agent cannot offer another identity's", async () => {
    const runner = new FakeProcessRunner().otherwise({ stdout: "" });

    await service(runner).exec(["fetch"], {
      cwd: "/repo",
      operation: "fetch",
      ...transportOptions("git@example.com:team/repo.git", {
        name: "Work",
        sshKeyPath: "/home/dev/.ssh/work_ed25519",
      }),
    });

    const sshCommand = runner.lastCall?.env["GIT_SSH_COMMAND"] ?? "";

    expect(sshCommand).toContain("IdentitiesOnly=yes");
    expect(sshCommand).toContain("work_ed25519");
    expect(sshCommand).toContain("BatchMode=no");
    expect(sshCommand).toContain("StrictHostKeyChecking=ask");
    expect(sshCommand).toContain("PasswordAuthentication=no");
    expect(runner.lastCall?.env["EDA_SSH_HOST_TRUST"]).toBe("1");
  });

  it("surfaces cancellation as a typed error, not a failed command", async () => {
    const controller = new AbortController();

    controller.abort();

    const runner = new FakeProcessRunner().otherwise({ stdout: "" });

    await expect(
      service(runner).exec(["fetch"], {
        cwd: "/repo",
        operation: "fetch",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("names the identity and removes supplied credentials from authentication diagnostics", async () => {
    const secret = "fixture-secret-not-for-storage";
    const lines: string[] = [];
    const runner = new FakeProcessRunner().otherwise({
      exitCode: 128,
      stderr: `fatal: Authentication failed. Server echoed ${secret}`,
      stderrLines: [`Server echoed ${secret}`],
    });

    await expect(
      service(runner).exec(["push"], {
        cwd: "/repo",
        operation: "push",
        onProgress: (line) => lines.push(line),
        ...transportOptions(
          "https://example.com/repo",
          { name: "Work" },
          { username: "fixture", password: secret },
        ),
      }),
    ).rejects.toMatchObject({
      kind: "auth-failed",
      message: "Authentication failed for identity Work.",
      rawStderr: "fatal: Authentication failed. Server echoed [redacted]",
    });
    expect(lines).toEqual(["Server echoed [redacted]"]);
    expect(runner.lastCall?.args.join(" ")).not.toContain(secret);
  });

  it("reports a missing git binary as git-not-found, not as a command failure", async () => {
    const enoent = Object.assign(new Error("spawn ENOENT"), {
      code: "ENOENT",
    }) as NodeJS.ErrnoException;
    const runner = { run: () => Promise.reject(new ProcessSpawnError("/usr/bin/git", enoent)) };

    await expect(
      service(runner as never).exec(["status"], { operation: "read status" }),
    ).rejects.toMatchObject({ kind: "git-not-found" });
  });

  it("blames the folder, not the engine, when the working directory is gone", async () => {
    const enoent = Object.assign(new Error("spawn ENOENT"), {
      code: "ENOENT",
    }) as NodeJS.ErrnoException;
    const runner = { run: () => Promise.reject(new ProcessSpawnError("/usr/bin/git", enoent)) };

    await expect(
      service(runner as never).exec(["status"], {
        cwd: "/tmp/eda-definitely-not-here",
        operation: "read status",
      }),
    ).rejects.toMatchObject({ kind: "not-a-repository" });
  });

  it("treats an allowed non-zero exit as a normal answer", async () => {
    const runner = new FakeProcessRunner().otherwise({ exitCode: 1 });
    const result = await service(runner).exec(["diff", "--quiet"], {
      cwd: "/repo",
      operation: "check for changes",
      allowedExitCodes: [0, 1],
    });

    expect(result.exitCode).toBe(1);
  });

  it("bounds status output at the runner boundary", async () => {
    const runner = new FakeProcessRunner().otherwise({ stdout: "" });
    await service(runner).status("/repo");
    expect(runner.lastCall).toMatchObject({
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
    });
  });

  it("surfaces a capture overflow as a typed error", async () => {
    const runner = new FakeProcessRunner().otherwise({ outputLimitExceeded: "stdout" });
    await expect(service(runner).status("/repo")).rejects.toMatchObject({
      kind: "output-too-large",
    });
  });

  it("maps malformed machine output to a typed repository error", async () => {
    const runner = new FakeProcessRunner().otherwise({ stdout: "not porcelain output\0" });
    await expect(service(runner).status("/repo")).rejects.toMatchObject({
      kind: "repository-corrupt",
    });
  });

  it("rejects abbreviated object IDs and paths outside the repository", async () => {
    const runner = new FakeProcessRunner().otherwise({ stdout: "" });

    await expect(service(runner).commitDiff("/repo", "deadbeef")).rejects.toMatchObject({
      kind: "invalid-input",
    });
    await expect(
      service(runner).workingDiff("/repo", { area: "staged", paths: ["../outside"] }),
    ).rejects.toMatchObject({ kind: "invalid-input" });
    expect(runner.calls).toHaveLength(0);
  });

  it.each([
    "fatal: unable to read tree bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "error: object file .git/objects/aa/object is empty\nfatal: bad object aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ])("preserves corruption diagnostics when reading a commit diff: %s", async (stderr) => {
    const runner = new FakeProcessRunner().otherwise({ exitCode: 128, stderr });

    await expect(service(runner).commitDiff("/repo", "a".repeat(40))).rejects.toMatchObject({
      kind: "repository-corrupt",
      code: "main.git.errorMapping.thisRepositoryHasCorruptOrMissingObjects",
    });
  });

  it("disables external diff and textconv and separates user paths", async () => {
    const runner = new FakeProcessRunner().otherwise({ stdout: "" });

    await service(runner).commitDiff("/repo", "a".repeat(40), ["--hostile-name"]);

    const args = runner.lastCall?.args ?? [];

    expect(args).toContain("--no-ext-diff");
    expect(args).not.toContain("--binary");
    expect(args).toContain("--no-textconv");
    expect(args.slice(args.indexOf("--") + 1)).toEqual([":(literal)--hostile-name"]);
  });

  it("enforces fixed history page bounds before spawning Git", async () => {
    const runner = new FakeProcessRunner().otherwise({ stdout: "" });
    await expect(service(runner).history("/repo", { limit: 201 })).rejects.toMatchObject({
      kind: "invalid-input",
    });
    expect(runner.calls).toHaveLength(0);
  });
});

it("never executes a tracked smudge program selected by global attributes during clone", async () => {
  const repo = await createTempRepo();
  try {
    await repo.writeFile(".gitattributes", "*.filtered filter=attack\n");
    await repo.writeFile("data.filtered", "payload");
    await repo.writeFile("a-run.sh", "echo executed > ../executed; cat\n");
    await repo.commit("untrusted checkout");
    await repo.run(["config", "--global", "filter.attack.smudge", "sh a-run.sh"]);
    await repo.run(["config", "--global", "filter.attack.required", "true"]);
    const target = join(repo.home, "copy");
    await repo.git.exec(["clone", "--no-local", "--", repo.path, target], {
      operation: "clone",
      cwd: repo.home,
    });
    await access(join(target, "data.filtered"));
    await expect(access(join(repo.home, "executed"))).rejects.toThrow();
  } finally {
    await repo.cleanup();
  }
});
