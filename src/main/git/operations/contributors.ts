import { isUtf8 } from "node:buffer";
import { ERROR_CODE } from "@shared/error-codes";
import { AppError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { Contributor } from "@shared/repository/repository-read";
import type { GitService } from "../git-service";

export async function readContributors(
  git: Pick<GitService, "exec">,
  cwd: string,
): Promise<Contributor[]> {
  const revisions = [
    "--branches",
    "--remotes",
    "--tags",
    // Include detached HEAD without traversing internal recovery/checkpoint refs.
    "--exclude=refs/*",
    "--all",
    "--",
  ];
  const options = { cwd, operation: t("operations.readContributors") };
  // With no revisions, shortlog switches to stdin and rejects custom grouping.
  const head = await git.exec(["log", "-1", "--format=%H", ...revisions], {
    ...options,
    maxStdoutBytes: 1024,
  });
  if (!head.stdout.trim()) return [];

  const result = await git.exec(
    [
      "shortlog",
      "--summary",
      "--numbered",
      // Raw placeholders preserve distinct recorded identities despite .mailmap aliases.
      "--group=format:%an <%ae>",
      ...revisions,
    ],
    { ...options, maxStdoutBytes: 4 * 1024 * 1024 },
  );
  if (!isUtf8(result.stdoutBytes)) throw new AppError(ERROR_CODE.INVALID_GIT_OUTPUT);

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^\s*(\d+)\t(?:(.*) )?<([^<>]*)>$/.exec(line);
      const commits = Number(match?.[1]);
      if (!match || !Number.isSafeInteger(commits) || commits < 1)
        throw new AppError(ERROR_CODE.INVALID_GIT_OUTPUT);
      return { name: match[2] ?? "", email: match[3]!, commits };
    });
}
