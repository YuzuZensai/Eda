import { isUtf8 } from "node:buffer";
import { lstat, realpath } from "node:fs/promises";
import { join, normalize } from "node:path";
import { AppError, GitError } from "@shared/errors";
import { ERROR_CODE, errorText } from "@shared/error-codes";
import { t } from "@shared/i18n";
import type { SubmoduleListing, SubmoduleSummary } from "@shared/repository/repository-read";
import type { GitService } from "../git-service";
import { assertAllowedRemoteUrl, assertRepositoryPath } from "../validation";

import type { SubmoduleAction } from "@shared/repository/repository-write";
import type { Identity } from "@shared/identity/identity";
import { workingFilePath } from "../../filesystem/working-file-path";
import { transportOptions } from "./remotes";

export async function listSubmodules(
  git: Pick<GitService, "exec" | "status">,
  root: string,
): Promise<SubmoduleListing> {
  const operation = t("submodules.title");
  const options = {
    cwd: root,
    operation,
    env: { overrides: { GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" } },
  };
  const [index, superproject, canonical] = await Promise.all([
    git.exec(["ls-files", "--stage", "-z"], { ...options, maxStdoutBytes: 16 * 1024 * 1024 }),
    git.exec(["rev-parse", "--show-superproject-working-tree"], {
      ...options,
      maxStdoutBytes: 8192,
    }),
    realpath(root),
  ]);
  if (!isUtf8(index.stdoutBytes) || !isUtf8(superproject.stdoutBytes))
    throw new AppError(ERROR_CODE.INVALID_GIT_OUTPUT);
  const recorded = new Map<string, string>();
  for (const entry of index.stdout.split("\0")) {
    const match = /^160000 ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    const path = match[3]!;
    assertRepositoryPath(path, operation);
    recorded.set(path, match[2] === "0" ? match[1]! : "");
  }
  const entries: SubmoduleSummary[] = [];
  for (const [path, expected] of recorded) {
    const directory = join(canonical, path);
    const summary: SubmoduleSummary = { path, state: "missing" };
    entries.push(summary);
    try {
      if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory())
        continue;
      summary.state = "uninitialized";
      const marker = await lstat(join(directory, ".git"));
      if (!(marker.isDirectory() || marker.isFile())) continue;
      summary.directory = directory;
      summary.state = "uninspected";
      if (!expected) {
        summary.state = "conflicted";
        continue;
      }
      const status = await git.status(directory);
      summary.state = status.branch.oid === expected ? "initialized" : "outOfSync";
      summary.dirty = status.changes.length > 0;
    } catch (error) {
      if (
        error instanceof GitError &&
        (error.kind === "not-a-repository" || error.text.key === "main.repositoryTrust.required")
      )
        continue;
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  const parent = superproject.stdout.replace(/\r?\n$/, "");
  return { entries, ...(parent && { parent: normalize(parent) }) };
}

const invalidModule = (key: "submodules.trust" | "submodules.invalid" | "submodules.clean") =>
  new GitError({
    kind: "invalid-input",
    operation: t("submodules.manage"),
    message: errorText(key),
  });

export async function checkChildWorktrees(
  git: GitService,
  cwd: string,
  selected?: string,
  depth = 0,
) {
  if (depth > 16) throw invalidModule("submodules.invalid");
  const { entries } = await listSubmodules(git, cwd);
  if (selected && !entries.some((entry) => entry.path === selected))
    throw invalidModule("submodules.invalid");
  for (const entry of entries) {
    if (selected && entry.path !== selected) continue;
    await workingFilePath(cwd, entry.path, t("submodules.manage"));
    if (!entry.directory) continue;
    if (entry.state === "conflicted" || entry.dirty) throw invalidModule("submodules.clean");
    if (git.trust && !(await git.trust.checked(entry.directory)).trusted)
      throw invalidModule("submodules.trust");
    const status = await git.exec(
      [
        "status",
        "--porcelain",
        "-z",
        "--ignored",
        "--untracked-files=all",
        "--ignore-submodules=dirty",
      ],
      { cwd: entry.directory, operation: t("submodules.manage") },
    );
    if (status.stdoutBytes.length) throw invalidModule("submodules.clean");
    await checkChildWorktrees(git, entry.directory, undefined, depth + 1);
  }
}

export async function changeSubmodule(
  git: GitService,
  cwd: string,
  identity: Identity,
  action: SubmoduleAction,
) {
  const operation = t("submodules.manage");
  if (git.trust && !(await git.trust.checked(cwd)).trusted) throw invalidModule("submodules.trust");
  const opts = { cwd, operation };
  if (action.kind === "automatic") {
    await git.exec(["config", "--local", "eda.updateSubmodules", String(action.enabled)], opts);
    return;
  }
  assertRepositoryPath(action.path, operation);
  if (action.path.split(/[\/\\]/).some((part) => !part || part === "."))
    throw invalidModule("submodules.invalid");
  await workingFilePath(cwd, action.path, operation);
  if (action.kind === "add") {
    assertAllowedRemoteUrl(action.url, operation);
    await git.exec(["submodule", "add", "--", action.url, action.path], {
      ...opts,
      ...transportOptions(action.url, identity),
    });
    return;
  }
  await checkChildWorktrees(git, cwd, action.path);
  if (action.kind === "remove") {
    await git.exec(["--literal-pathspecs", "rm", "--", action.path], opts);
    return;
  }
  if (action.kind === "sync") {
    await git.exec(
      [
        "--literal-pathspecs",
        "submodule",
        "sync",
        ...(action.recursive ? ["--recursive"] : []),
        "--",
        action.path,
      ],
      opts,
    );
    return;
  }
  // Explicit update modes never run a custom submodule update command.
  await git.exec(
    [
      "--literal-pathspecs",
      "submodule",
      "update",
      ...(action.kind === "init" ? ["--init"] : []),
      "--" + action.mode,
      ...(action.recursive ? ["--recursive"] : []),
      "--",
      action.path,
    ],
    {
      ...opts,
      env: {
        ...(identity.sshKeyPath && { sshKeyPath: identity.sshKeyPath }),
        overrides: {
          GIT_ALLOW_PROTOCOL: "https:ssh",
          GIT_COMMITTER_NAME: identity.gitName,
          GIT_COMMITTER_EMAIL: identity.gitEmail,
        },
      },
    },
  );
  await git.writeConfig("eda.submoduleUpdateMode", action.mode, { cwd, scope: "local" });
}
