import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { GitService } from "../git-service";
import { assertRepositoryPath } from "../validation";

export function validateSparseDirectories(paths: string[]) {
  const operation = t("sparse.title");
  if (paths.length > 100)
    throw new GitError({ kind: "invalid-input", operation, message: errorText("sparse.invalid") });
  for (const path of paths) {
    assertRepositoryPath(path, operation);
    if (/[\x00-\x1f\x7f]/.test(path) || path.split("/").some((part) => !part || part === "."))
      throw new GitError({
        kind: "invalid-input",
        operation,
        message: errorText("sparse.invalid"),
      });
  }
}

export async function readSparseCheckout(git: Pick<GitService, "exec">, cwd: string) {
  const options = {
    cwd,
    operation: t("sparse.title"),
    allowedExitCodes: [0, 1],
    maxStdoutBytes: 512 * 1024,
  };
  const enabled = await git.exec(["config", "--bool", "--get", "core.sparseCheckout"], options);
  if (enabled.stdout.trim() !== "true") return { enabled: false, cone: true, directories: [] };
  const cone = await git.exec(["config", "--bool", "--get", "core.sparseCheckoutCone"], options);
  if (cone.stdout.trim() !== "true") return { enabled: true, cone: false, directories: [] };
  const list = await git.exec(["-c", "core.quotePath=false", "sparse-checkout", "list"], {
    ...options,
    allowedExitCodes: [0],
  });
  // Git C-quotes names containing control characters, quotes or backslashes.
  const lines = list.stdout.split("\n").filter(Boolean);
  const editable = lines.length <= 100 && lines.every((line) => !line.startsWith('"'));
  return { enabled: true, cone: editable, directories: editable ? lines : [] };
}

export async function setSparseCheckout(git: GitService, cwd: string, paths: string[]) {
  validateSparseDirectories(paths);
  await git.exec(["sparse-checkout", "set", "--cone", "--", ...paths], {
    cwd,
    operation: t("sparse.title"),
  });
}
