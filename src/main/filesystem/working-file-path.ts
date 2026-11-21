import { lstat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { assertRepositoryPath } from "../git/validation";

export async function workingFilePath(
  root: string,
  path: string,
  operation: string,
): Promise<string> {
  assertRepositoryPath(path, operation);

  const target = resolve(root, path);
  const local = relative(resolve(root), target);

  if (
    !local ||
    local.startsWith(`..${sep}`) ||
    local.split(sep).some((part) => part.toLowerCase() === ".git")
  )
    throw new GitError({
      kind: "invalid-input",
      operation,
      message: errorText("main.discardService.selectAWorkingFileInsideThisRepository"),
    });

  let current = resolve(root);

  for (const part of local.split(sep)) {
    current = join(current, part);

    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });

    if (stat?.isSymbolicLink())
      throw new GitError({
        kind: "invalid-input",
        operation,
        message: errorText("main.discardService.useExternalToolsForSymlinkChangesEdaWill"),
      });
  }

  return target;
}
