import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { defaultDiffArgs } from "@shared/integrations/merge-tool";
import { GitError } from "@shared/errors";
import { errorText } from "@shared/error-codes";
import { t } from "@shared/i18n";
import { buildGitEnvironment } from "../execution/environment";
import type { ProcessRunner } from "../execution/process-runner";

export async function runExternalDiff(
  runner: ProcessRunner,
  executable: string,
  versions: { path: string; bytes: Buffer }[],
  checkOwner: () => void,
  signal?: AbortSignal,
  templates: readonly string[] = defaultDiffArgs,
) {
  const directory = await mkdtemp(join(tmpdir(), "eda-diff-"));
  try {
    const args: string[] = [];
    for (const [index, version] of versions.entries()) {
      const suffix = extname(version.path);
      const file = join(
        directory,
        (index === 0 ? "before" : "after") + (/^\.[\w-]{1,16}$/.test(suffix) ? suffix : ""),
      );
      await writeFile(file, version.bytes, { flag: "wx", mode: 0o400 });
      args.push(file);
    }
    checkOwner();
    const result = await runner.run({
      executable,
      args: templates.map((template) =>
        template.replace(
          /\{(before|after)\}/g,
          (_, side: string) => args[side === "before" ? 0 : 1]!,
        ),
      ),
      cwd: directory,
      env: buildGitEnvironment(),
      ...(signal && { signal }),
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    if (result.cancelled || result.outputLimitExceeded || ![0, 1].includes(result.exitCode))
      throw new GitError({
        kind: "invalid-input",
        operation: t("externalDiff.open"),
        message: errorText("externalDiff.failed"),
      });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
