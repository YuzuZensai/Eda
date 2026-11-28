import { nullIfFileMissing } from "../../filesystem/missing-file";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { randomUUID } from "node:crypto";
import { copyFile, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitService } from "../git-service";

/** Git can stash staged changes outside the requested paths. */
export async function createScopedStash(
  git: GitService,
  root: string,
  paths: readonly string[],
  keepIndex: boolean,
  run: (indexFile: string, exclusions: string[]) => Promise<void>,
): Promise<void> {
  const indexPath = (
    await git.exec(["rev-parse", "--path-format=absolute", "--git-path", "index"], {
      cwd: root,
      operation: t("operations.locateStashIndex"),
    })
  ).stdout.trim();

  const lockPath = `${indexPath}.lock`;
  const temporary = join(dirname(indexPath), `eda-stash-${randomUUID()}`);
  const finalIndex = `${temporary}-final`;
  const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    throw new GitError({
      kind: "lock-contention",
      operation: t("operations.createSelectedStash"),
      message: errorText(
        "main.git.scopedStash.anotherGitOperationHoldsTheIndexLockWaitForItToFinishAndRetry",
      ),
    });
  });

  let ownsLock = true;
  const pathspecs = paths.map((path) => `:(literal)${path}`);
  const execute = (args: string[], index: string, stdin?: string) =>
    git.exec(args, {
      cwd: root,
      operation: t("operations.prepareSelectedStashIndex"),
      env: { overrides: { GIT_INDEX_FILE: index } },
      ...(stdin === undefined ? {} : { stdin }),
      maxStdoutBytes: 16 * 1024 * 1024,
    });

  try {
    await copyFile(indexPath, finalIndex).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      await execute(["read-tree", "HEAD"], finalIndex);
    });

    const staged = await git.exec(
      ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...paths],
      {
        cwd: root,
        operation: t("operations.captureSelectedStagedChanges"),
        maxStdoutBytes: 16 * 1024 * 1024,
      },
    );

    await execute(["read-tree", "HEAD"], temporary);

    const basePaths = await execute(
      ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...paths],
      temporary,
    );
    const remove = basePaths.stdout
      .split("\0")
      .filter(Boolean)
      .map(
        (entry) =>
          `${entry.replace(/^\d{6} ([a-f0-9]+) 0\t/, (_match, oid: string) => `0 ${"0".repeat(oid.length)}\t`)}\0`,
      )
      .join("");

    await execute(["update-index", "-z", "--index-info"], temporary, remove + staged.stdout);

    if (!keepIndex) await execute(["reset", "--quiet", "HEAD", "--", ...pathspecs], finalIndex);

    const candidates = await execute(["ls-files", "--cached", "--others", "-z"], temporary);
    const exclusions = [...new Set(candidates.stdout.split("\0").filter(Boolean))].filter(
      (candidate) =>
        !paths.some(
          (path) => candidate === path || candidate.startsWith(`${path.replace(/\/$/, "")}/`),
        ),
    );

    // Use exclusions for staged deletions; Git rejects them with positive pathspecs.
    await run(temporary, exclusions);

    if (!keepIndex) {
      try {
        await lock.writeFile(await readFile(finalIndex));
        await lock.sync();
        await lock.close();
        await rename(lockPath, indexPath);
        ownsLock = false;
      } catch {
        throw new GitError({
          kind: "unknown",
          operation: t("operations.finishSelectedStash"),
          message: errorText("main.git.scopedStash.theStashWasSavedButEdaCouldNot"),
          suggestedAction: errorText(
            "main.git.scopedStash.checkRepositoryPermissionsAndAvailableDiskSpace",
          ),
        });
      }
    }
  } finally {
    await lock.close();

    for (const path of [
      temporary,
      `${temporary}.lock`,
      finalIndex,
      `${finalIndex}.lock`,
      ...(ownsLock ? [lockPath] : []),
    ]) {
      await unlink(path).catch(nullIfFileMissing);
    }
  }
}
