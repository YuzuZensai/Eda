import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { GitService } from "../git-service";
import { parseConfigEntry } from "../parsers/config-entry";
import { withLocalConfiguration } from "./local-configuration";

export type BranchConfiguration = [string, string][];

export async function branchConfiguration(
  git: GitService,
  root: string,
  name: string,
  file?: string,
  renameFrom?: string,
): Promise<BranchConfiguration> {
  const result = await git.exec(
    ["config", ...(file ? ["--file", file] : ["--local"]), "--no-includes", "--null", "--list"],
    {
      cwd: root,
      operation: t("operations.readBranchConfiguration"),
    },
  );

  const section = `branch.${name}`;

  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => parseConfigEntry(entry, "true"))
    .map(([key, value]): [string, string] =>
      renameFrom && key.slice(0, key.lastIndexOf(".")) === `branch.${renameFrom}`
        ? [`${section}.${key.slice(key.lastIndexOf(".") + 1)}`, value]
        : [key, value],
    )
    .filter(([key]) => key.slice(0, key.lastIndexOf(".")) === section)
    .sort(([a], [b]) => a.localeCompare(b));
}

export async function withBranchConfiguration<T>(
  git: GitService,
  root: string,
  name: string,
  expected: BranchConfiguration,
  target: BranchConfiguration,
  work: () => Promise<T>,
): Promise<T> {
  return withBranchConfigurations(git, root, [{ name, expected, target }], work);
}

export async function withBranchConfigurations<T>(
  git: GitService,
  root: string,
  changes: { name: string; expected: BranchConfiguration; target: BranchConfiguration }[],
  work: () => Promise<T>,
): Promise<T> {
  return withLocalConfiguration(
    git,
    root,
    t("operations.restoreBranchConfiguration"),
    async (temporary) => {
      for (const { name, expected, target } of changes) {
        if (
          JSON.stringify(await branchConfiguration(git, root, name, temporary)) !==
          JSON.stringify(expected)
        )
          throw new GitError({
            kind: "invalid-input",
            operation: t("operations.restoreBranchConfiguration"),
            message: errorText(
              "main.git.branchConfiguration.branchConfigurationChangedSinceThisActionReviewThe",
            ),
          });

        for (const key of new Set(expected.map(([key]) => key)))
          await git.exec(["config", "--file", temporary, "--unset-all", key], {
            cwd: root,
            operation: t("operations.prepareBranchConfiguration"),
          });

        for (const [key, value] of target)
          await git.exec(["config", "--file", temporary, "--add", key, value], {
            cwd: root,
            operation: t("operations.prepareBranchConfiguration"),
          });
      }

      return work();
    },
  );
}
