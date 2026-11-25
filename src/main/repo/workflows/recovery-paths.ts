import type { RepositoryChange } from "@shared/repository/repository-read";
import type { GitExecOptions, GitService } from "../../git/git-service";

export function trackedChangePaths(changes: readonly RepositoryChange[]) {
  const paths = new Set<string>();
  for (const change of changes) {
    if (change.kind === "untracked" || change.kind === "ignored") continue;
    paths.add(change.path);
    if (change.originalPath) paths.add(change.originalPath);
  }
  return paths;
}

export async function addRecoveryDiffPaths(
  git: GitService,
  paths: Set<string>,
  revisions: readonly [string] | readonly [string, string],
  options: GitExecOptions,
) {
  const affected = await git.execFields(
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      ...revisions,
      "--",
    ],
    options,
  );
  for (const path of affected) paths.add(path);
}
