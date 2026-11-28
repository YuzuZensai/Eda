import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { AppError, GitError } from "@shared/errors";
import { ERROR_CODE, errorText } from "@shared/error-codes";
import { t } from "@shared/i18n";
import type { WorktreeSummary } from "@shared/repository/repository-read";
import { nullIfFileMissing } from "../../filesystem/missing-file";
import type { GitService } from "../git-service";

import type { WorktreeAction } from "@shared/repository/repository-write";
import { assertValidRefName, assertFullObjectId, assertRepositoryPath } from "../validation";
export async function listWorktrees(
  git: Pick<GitService, "exec">,
  root: string,
): Promise<Omit<WorktreeSummary, "available">[]> {
  const { stdoutBytes } = await git.exec(["worktree", "list", "--porcelain", "-z"], {
    cwd: root,
    operation: t("worktrees.title"),
    maxStdoutBytes: 1024 * 1024,
  });
  if (!isUtf8(stdoutBytes)) throw new AppError(ERROR_CODE.INVALID_GIT_OUTPUT);
  const output = stdoutBytes.toString("utf8");
  if (!output.endsWith("\0\0")) throw new AppError(ERROR_CODE.INVALID_GIT_OUTPUT);
  return output
    .slice(0, -2)
    .split("\0\0")
    .map((record, index) => {
      const fields = new Map(
        record.split("\0").map((field) => {
          const space = field.indexOf(" ");
          return space < 0 ? [field, ""] : [field.slice(0, space), field.slice(space + 1)];
        }),
      );
      const path = fields.get("worktree");
      if (!path) throw new AppError(ERROR_CODE.INVALID_GIT_OUTPUT);
      const branch = fields.get("branch")?.replace(/^refs\/heads\//, "");
      return {
        path: normalize(path),
        main: index === 0,
        bare: fields.has("bare"),
        ...(branch && { branch }),
        ...(fields.has("HEAD") && { oid: fields.get("HEAD")! }),
        ...(fields.has("locked") && { locked: fields.get("locked")! }),
        ...(fields.has("prunable") && { prunable: fields.get("prunable")! }),
      };
    });
}

export async function changeWorktree(
  git: GitService,
  cwd: string,
  action: WorktreeAction,
): Promise<string | null> {
  const operation = t("worktrees.title");
  const options = { cwd, operation };
  const fail = (
    key: "worktrees.invalid" | "worktrees.changed" | "worktrees.inUse" | "worktrees.unmerged",
  ) => new GitError({ kind: "invalid-input", operation, message: errorText(key) });
  const entries = await listWorktrees(git, cwd);
  if (action.kind === "prune") {
    await git.exec(["worktree", "prune", "--expire=now"], options);
    return null;
  }
  if (action.kind === "create") {
    assertValidRefName(action.branch, operation);
    if (!isAbsolute(action.path) || resolve(action.path) !== action.path)
      throw fail("worktrees.invalid");
    const leaf = basename(action.path);
    assertRepositoryPath(leaf, operation);
    const destination = join(await realpath(dirname(action.path)), leaf);
    if (destination.split(sep).some((part) => part.toLowerCase() === ".git"))
      throw fail("worktrees.invalid");
    if (
      entries.some((entry) => {
        const rel = relative(entry.path, destination);
        return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
      })
    )
      throw fail("worktrees.invalid");
    if (await lstat(destination).catch(nullIfFileMissing)) throw fail("worktrees.invalid");
    const start = action.base ?? "refs/heads/" + action.branch;
    if (action.base) assertValidRefName(action.base, operation);
    const { stdout } = await git.exec(
      ["rev-parse", "--verify", "--end-of-options", start + "^{commit}"],
      options,
    );
    const oid = stdout.trim();
    assertFullObjectId(oid, operation);
    const policy = await git.trust?.checked(cwd, undefined, oid);
    if (!policy?.trusted && policy?.execution?.blocksWrites)
      throw new GitError({
        kind: "invalid-input",
        operation,
        message: errorText("main.repositoryTrust.writesBlocked"),
      });
    await git.exec(
      [
        "worktree",
        "add",
        ...(action.base ? ["-b", action.branch] : []),
        "--",
        destination,
        action.base ? oid : action.branch,
      ],
      options,
    );
    return null;
  }
  const entry = entries.find((item) => item.path === action.path);
  if (!entry || entry.main || entry.bare) throw fail("worktrees.changed");
  if (action.kind === "lock" || action.kind === "unlock") {
    await git.exec(["worktree", action.kind, "--", entry.path], options);
    return null;
  }
  if (action.kind !== "remove" && action.kind !== "cleanup") throw fail("worktrees.invalid");
  assertFullObjectId(action.oid, operation);
  if (
    entry.oid !== action.oid ||
    entry.branch !== action.branch ||
    entry.locked !== undefined ||
    (await realpath(cwd)) === entry.path ||
    (await realpath(entry.path)) !== entry.path
  )
    throw fail("worktrees.changed");
  const dirty = await git.exec(
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--ignore-submodules=none",
      "--ignored",
      "--untracked-files=all",
    ],
    { cwd: entry.path, operation },
  );
  if (dirty.stdoutBytes.length) throw fail("worktrees.inUse");
  const metadata = await git.exec(["rev-parse", "--absolute-git-dir"], {
    cwd: entry.path,
    operation,
  });
  for (const file of [
    "index.lock",
    "HEAD.lock",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_START",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ]) {
    if (await lstat(join(metadata.stdout.trimEnd(), file)).catch(nullIfFileMissing))
      throw fail("worktrees.inUse");
  }
  if (action.kind === "cleanup") {
    if (
      !entry.branch ||
      (
        await git.exec(["merge-base", "--is-ancestor", action.oid, "HEAD"], {
          ...options,
          allowedExitCodes: [0, 1],
        })
      ).exitCode !== 0
    )
      throw fail("worktrees.unmerged");
  }
  const ref = "refs/eda/recovery/worktree-" + randomUUID();
  await git.exec(["update-ref", ref, action.oid, "0".repeat(action.oid.length)], options);
  await git.exec(["worktree", "remove", "--", entry.path], options);
  if (action.kind === "cleanup" && entry.branch) {
    const tip = await git.exec(["rev-parse", "--verify", "refs/heads/" + entry.branch], options);
    if (tip.stdout.trim() !== action.oid) throw fail("worktrees.changed");
    await git.exec(["branch", "-d", "--", entry.branch], options);
  }
  return ref;
}
