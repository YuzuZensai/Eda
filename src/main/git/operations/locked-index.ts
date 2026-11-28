import { nullIfFileMissing } from "../../filesystem/missing-file";
import { ERROR_CODE, errorText } from "@shared/error-codes";
import { AppError, GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitService } from "../git-service";

export async function withLockedIndex<T>(
  git: GitService,
  root: string,
  work: (index: {
    prepare(tree: string, operation: string): Promise<void>;
    publish(): Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const path = (
    await git.exec(["rev-parse", "--path-format=absolute", "--git-path", "index"], {
      cwd: root,
      operation: t("operations.locateReversalIndex"),
    })
  ).stdout.trim();

  const lockPath = `${path}.lock`;
  const temporary = join(dirname(path), `eda-index-${randomUUID()}`);
  const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;

    throw new GitError({
      kind: "lock-contention",
      operation: t("operations.reverseLocalAction"),
      message: errorText("main.git.lockedIndex.anotherGitOperationHoldsTheIndexLockWait"),
    });
  });

  let ownsLock = true;
  let prepared = false;

  try {
    return await work({
      async prepare(tree, operation) {
        await git.exec(
          ["read-tree", "--reset", "-i", "--no-sparse-checkout", "--no-recurse-submodules", tree],
          {
            cwd: root,
            operation,
            env: { overrides: { GIT_INDEX_FILE: temporary } },
          },
        );
        prepared = true;
      },
      async publish() {
        if (!prepared || !ownsLock) throw new AppError(ERROR_CODE.PREPARED_INDEX_MISSING);
        await lock.writeFile(await readFile(temporary));
        await lock.sync();
        await lock.close();
        await rename(lockPath, path);
        ownsLock = false;
      },
    });
  } finally {
    await lock.close();
    for (const file of [temporary, `${temporary}.lock`, ...(ownsLock ? [lockPath] : [])])
      await unlink(file).catch(nullIfFileMissing);
  }
}
