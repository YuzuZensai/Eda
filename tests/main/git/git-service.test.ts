import { afterEach, describe, expect, it } from "vitest";
import { GitError } from "@shared/errors";
import { FakeProcessRunner } from "../../helpers/fake-process-runner";
import { GitService } from "@main/git/git-service";
import { transportOptions } from "@main/git/operations/remotes";
import { ProcessSpawnError } from "@main/git/execution/process-runner";
import type { GitEngine } from "@main/git/execution/git-engine";
import { assertHermetic, createTempRepo, type TempRepo } from "../../helpers/temp-repo";
import { access, writeFile, unlink } from "node:fs/promises";
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
});

describe("GitService command construction", () => {
  const service = (runner: FakeProcessRunner) => new GitService(runner, FAKE_ENGINE);

  it("uses porcelain stdout to distinguish a server hook rejection from generic push stderr", async () => {
    const runner = new FakeProcessRunner().otherwise({
      exitCode: 1,
      ...pushErrorFixtures.hookRejected,
    });

    await expect(
      service(runner).exec(["push", "--porcelain", "--", "origin", "main:main"], {
        operation: "push",
      }),
    ).rejects.toMatchObject({ kind: "remote-rejected" });
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
