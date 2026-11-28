import { nullIfFileMissing } from "../../filesystem/missing-file";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitService } from "../git-service";

export async function withLocalConfiguration<T>(
  git: GitService,
  root: string,
  operation: string,
  work: (file: string) => Promise<T>,
): Promise<T> {
  const path = (
    await git.exec(["rev-parse", "--path-format=absolute", "--git-path", "config"], {
      cwd: root,
      operation: t("operations.locateLocalGitConfiguration"),
    })
  ).stdout.trim();

  const lockPath = `${path}.lock`;
  const temporary = join(dirname(path), `eda-config-${randomUUID()}`);
  const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    throw new GitError({
      kind: "lock-contention",
      operation,
      message: errorText(
        "main.git.localConfiguration.anotherGitOperationHoldsTheConfigLockWaitAndTryAgain",
      ),
    });
  });

  let owned = true;

  try {
    const configFile = await lstat(path);

    if (!configFile.isFile() || configFile.isSymbolicLink())
      throw new GitError({
        kind: "invalid-input",
        operation,
        message: errorText(
          "main.git.localConfiguration.updatingLocalGitConfigurationRequiresARegularConfigFile",
        ),
      });

    await lock.chmod(configFile.mode & 0o777);
    await writeFile(temporary, await readFile(path), { mode: 0o600, flag: "wx" });

    const result = await work(temporary);

    await lock.writeFile(await readFile(temporary));
    await lock.sync();
    await lock.close();
    await rename(lockPath, path);
    owned = false;

    return result;
  } finally {
    await lock.close();
    for (const file of [temporary, `${temporary}.lock`, ...(owned ? [lockPath] : [])])
      await unlink(file).catch(nullIfFileMissing);
  }
}
