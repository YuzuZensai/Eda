import { nullIfFileMissing } from "../../filesystem/missing-file";
import { readRegularFile } from "../../filesystem/read-regular-file";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { join } from "node:path";
import type { GitService } from "../git-service";

export async function assertSafeRebaseState(git: GitService, root: string): Promise<void> {
  const result = await git.exec(["rev-parse", "--absolute-git-dir"], {
    cwd: root,
    operation: t("operations.inspectWorkflow"),
  });
  const directory = result.stdout.replace(process.platform === "win32" ? /\r?\n$/ : /\n$/, "");
  const path = join(directory, "rebase-merge", "git-rebase-todo");
  const invalid = () =>
    new GitError({
      kind: "invalid-input",
      operation: t("operations.rebase"),
      message: errorText("main.git.rebaseState.unsafeInstructions"),
    });
  const file = await readRegularFile(path, 64 * 1024, invalid).catch(nullIfFileMissing);
  if (!file) return;
  const text = file.bytes.toString("utf8");
  for (const line of text.split("\n")) {
    const command = line.trim();
    if (!command || command.startsWith("#")) continue;
    if (/^(?:noop|break|b)$/.test(command)) continue;
    if (/^(?:pick|p|reword|r|edit|e|squash|s|drop|d) [a-f0-9]{4,64}(?:\s|$)/.test(command))
      continue;
    if (/^(?:fixup|f) (?:-[cC] )?[a-f0-9]{4,64}(?:\s|$)/.test(command)) continue;
    throw invalid();
  }
}
