import { isFullObjectId } from "@shared/repository/object-id";
import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { RebasePlanEntry } from "@shared/workflows/rebase";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { GitService } from "../git-service";

const invalid = (message: ErrorText) =>
  new GitError({ kind: "invalid-input", operation: t("operations.interactiveRebase"), message });

export async function readRebasePlan(
  git: GitService,
  root: string,
  onto: string | null,
  head = "HEAD",
) {
  const result = await git.exec(
    [
      "log",
      "--reverse",
      "--topo-order",
      "--max-count=201",
      "-z",
      "--format=%H%x00%B",
      onto ? `${onto}..${head}` : head,
      "--",
    ],
    { cwd: root, operation: t("operations.readRebasePlan"), maxStdoutBytes: 2 * 1024 * 1024 },
  );

  const fields = result.stdout.split("\0");

  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 || fields.length > 400)
    throw invalid(
      errorText("main.git.rebasePlan.chooseARangeOfAtMost200CommitsForInteractiveRebase"),
    );

  const entries: RebasePlanEntry[] = [];

  for (let index = 0; index < fields.length; index += 2) {
    const oid = fields[index]!;
    if (!isFullObjectId(oid))
      throw invalid(
        errorText("main.git.rebasePlan.gitReturnedAnInvalidRebasePlanRefreshAndReviewAgain"),
      );
    entries.push({ oid, action: "pick", message: fields[index + 1]!.trimEnd() });
  }

  if (!entries.length)
    throw invalid(errorText("main.git.rebasePlan.thereAreNoCommitsToEditAboveThisBase"));

  return entries;
}

export function validateRebasePlan(value: unknown, original: RebasePlanEntry[]): RebasePlanEntry[] {
  if (!Array.isArray(value) || value.length !== original.length)
    throw invalid(
      errorText("main.git.rebasePlan.keepEveryReviewedCommitInThePlanChooseDropToRemoveOne"),
    );

  const remaining = new Set(original.map((entry) => entry.oid));
  let kept = false;
  const plan: RebasePlanEntry[] = [];

  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !remaining.delete(entry.oid) ||
      !["pick", "reword", "squash", "drop", "fixup", "edit", "fixup-reword"].includes(
        entry.action,
      ) ||
      typeof entry.message !== "string" ||
      entry.message.includes("\0") ||
      Buffer.byteLength(entry.message) > 64 * 1024
    )
      throw invalid(
        errorText(
          "main.git.rebasePlan.chooseAValidActionAndMessageForEachReviewedCommitExactlyOnce",
        ),
      );

    if (["reword", "squash", "fixup-reword"].includes(entry.action) && !entry.message.trim())
      throw invalid(
        errorText("main.git.rebasePlan.enterANonemptyMessageForRewordedOrSquashedCommits"),
      );
    if (["squash", "fixup", "fixup-reword"].includes(entry.action) && !kept)
      throw invalid(
        errorText("main.git.rebasePlan.squashOrFixupNeedsAPrecedingRetainedCommitInThePlan"),
      );
    if (entry.action !== "drop") kept = true;

    plan.push({ oid: entry.oid, action: entry.action, message: entry.message });
  }

  return plan;
}

// Git runs editor commands through its POSIX shell.
const quote = (value: string) =>
  `'${(process.platform === "win32" ? value.replaceAll("\\", "/") : value).replaceAll("'", "'\\''")}'`;

async function planDirectory(git: GitService, root: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id))
    throw invalid(errorText("main.git.rebasePlan.invalidRebaseOperationIdentifier"));

  const directory = (
    await git.exec(["rev-parse", "--path-format=absolute", "--git-path", `eda-rebase-${id}`], {
      cwd: root,
      operation: t("operations.locateRebasePlan"),
    })
  ).stdout.trim();

  if (!isAbsolute(directory) || basename(resolve(directory)) !== `eda-rebase-${id}`)
    throw invalid(errorText("main.git.rebasePlan.gitReturnedAnInvalidRebaseMetadataDirectory"));

  return directory;
}

export async function writeRebasePlan(
  git: GitService,
  root: string,
  id: string,
  plan: RebasePlanEntry[],
) {
  const directory = await planDirectory(git, root, id);

  await mkdir(directory, { recursive: false, mode: 0o700 });

  const todo: string[] = [];
  const cases: string[] = [];
  let messagePath: string | undefined;

  for (const [index, entry] of plan.entries()) {
    if (["pick", "edit", "reword"].includes(entry.action)) messagePath = undefined;

    todo.push(`${entry.action === "fixup-reword" ? "fixup -c" : entry.action} ${entry.oid}`);

    if (["reword", "squash", "fixup-reword"].includes(entry.action)) {
      const path = join(directory, `${index}.txt`);
      await writeFile(path, `${entry.message}\n`, { mode: 0o600 });
      messagePath = path;
    }

    if (messagePath && ["reword", "squash", "fixup-reword", "fixup"].includes(entry.action))
      cases.push(
        `${quote(`${entry.action} ${entry.oid}`)}) cat ${quote(messagePath)} > "$target" ;;`,
      );
  }

  const path = join(directory, "todo");

  await writeFile(path, `${todo.join("\n")}\n`, { mode: 0o600 });

  const editor = join(directory, "editor.sh");

  await writeFile(editor, `#!/bin/sh\ncat ${quote(path)} > "$1"\n`, { mode: 0o700 });

  const done = (
    await git.exec(["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge/done"], {
      cwd: root,
      operation: t("operations.locateRebaseMessageState"),
    })
  ).stdout.trim();

  await writeFile(
    join(directory, "message-editor.sh"),
    `#!/bin/sh\nset -e\ntarget=$1\ntail -n 1 ${quote(done)} | {\n  read -r command oid rest\n  if [ "$command" = fixup ] && [ "$oid" = -c ]; then\n    command=fixup-reword\n    oid=\${rest%% *}\n  fi\n  oid=$(git rev-parse --verify "$oid^{commit}")\n  case "$command $oid" in\n${cases.join("\n")}\n  esac\n}\n`,
    { mode: 0o700 },
  );

  return `sh ${quote(editor)}`;
}

export async function rebaseMessageEditor(git: GitService, root: string, id: string) {
  return `sh ${quote(join(await planDirectory(git, root, id), "message-editor.sh"))}`;
}

export async function removeRebasePlan(git: GitService, root: string, id: string) {
  await rm(await planDirectory(git, root, id), { recursive: true, force: true });
}
