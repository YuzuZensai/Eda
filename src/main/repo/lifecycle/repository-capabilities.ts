import { t } from "@shared/i18n";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import type { GitService } from "../../git/git-service";
import type { RepositoryCapabilities } from "@shared/repository/repository-read";

export async function repositoryCapabilities(
  git: GitService,
  path: string,
  inspectCheckout = false,
): Promise<RepositoryCapabilities> {
  const directories = await git.exec(
    [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
      "--is-shallow-repository",
      "--show-object-format",
    ],
    { cwd: path, operation: t("operations.inspectRepositoryAccess"), maxStdoutBytes: 64 * 1024 },
  );
  const lines = directories.stdout.trimEnd().split(/\r?\n/);
  const objectFormat = lines.pop();
  const shallow = lines.pop() === "true";
  const roots = lines;
  const format: Partial<RepositoryCapabilities> = {
    shallow,
    ...(objectFormat && { objectFormat }),
  };
  if (inspectCheckout) {
    const config = await git.exec(
      [
        "config",
        "--null",
        "--get-regexp",
        "^(core\\.sparsecheckout|extensions\\.partialclone|remote\\..+\\.promisor)$",
      ],
      {
        cwd: path,
        operation: t("operations.inspectRepositoryAccess"),
        allowedExitCodes: [0, 1],
        maxStdoutBytes: 64 * 1024,
      },
    );
    const settings = new Map(
      config.stdout
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const end = record.indexOf("\n");
          return end < 0 ? [record, "true"] : [record.slice(0, end), record.slice(end + 1)];
        }),
    );
    const enabled = (value: string | undefined) => !!value && /^(1|true|yes|on)$/i.test(value);
    format.sparse = enabled(settings.get("core.sparsecheckout"));
    format.partial =
      !!settings.get("extensions.partialclone") ||
      [...settings].some(([key, value]) => key.endsWith(".promisor") && enabled(value));
  }

  try {
    await Promise.all([path, ...roots].map((root) => access(root, constants.W_OK)));
    await access(join(roots[0]!, "index"), constants.W_OK).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return { ...format, write: true };
  } catch {
    return {
      ...format,
      write: false,
      reason: t("main.repositoryCapabilities.theWorktreeOrGitMetadataIsReadOnly"),
    };
  }
}
