import { nullIfFileMissing } from "../../filesystem/missing-file";
import { isFullObjectId } from "@shared/repository/object-id";
import { constants } from "node:fs";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { RepositoryStatus } from "@shared/repository/repository-read";
import { conflictSides } from "@shared/workflows/conflict-sides";
import type { WorkflowKind, WorkflowState } from "@shared/workflows/workflow";
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitService } from "../git-service";

const files = [
  "MERGE_HEAD",
  "MERGE_AUTOSTASH",
  "ORIG_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge/head-name",
  "rebase-merge/orig-head",
  "rebase-merge/onto",
  "rebase-merge/msgnum",
  "rebase-merge/end",
  "rebase-merge/stopped-sha",
  "rebase-merge/amend",
  "rebase-merge/done",
  "rebase-merge/git-rebase-todo",
  "rebase-apply/rebasing",
  "rebase-apply/applying",
  "rebase-apply/orig-head",
  "rebase-apply/head-name",
  "rebase-apply/onto",
  "rebase-apply/next",
  "rebase-apply/last",
  "sequencer/todo",
  "sequencer/head",
  "sequencer/opts",
] as const;

async function readMarker(path: string): Promise<{ text: string; instance: string } | null> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });

  if (!handle) return null;

  try {
    const entry = await handle.stat({ bigint: true });
    if (!entry.isFile())
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.inspectWorkflow"),
        message: errorText("main.workflowState.invalidMarker"),
      });
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

    if (bytesRead > 64 * 1024)
      throw new GitError({
        kind: "output-too-large",
        operation: t("operations.inspectWorkflow"),
        message: errorText(
          "main.git.workflowState.gitOperationMetadataExceedsTheInspectionLimitInspect",
        ),
      });

    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      instance: `${entry.dev}:${entry.ino}:${entry.birthtimeNs}:${entry.ctimeNs}`,
    };
  } finally {
    await handle.close();
  }
}

function objectId(value: string | null | undefined) {
  const oid = value?.trim();
  return isFullObjectId(oid) ? oid : null;
}
const number = (value: string | null | undefined) =>
  /^\d+$/.test(value?.trim() ?? "") ? Number(value!.trim()) : null;

export async function readWorkflowState(
  git: GitService,
  root: string,
  status: RepositoryStatus,
): Promise<WorkflowState | null> {
  const { stdout } = await git.exec(["rev-parse", "--absolute-git-dir"], {
    cwd: root,
    operation: t("operations.locateWorkflowState"),
  });
  const directory = stdout.trim();
  const entries = await Promise.all(files.map((name) => readMarker(join(directory, name))));
  const markerValues = entries.map((entry) => entry?.text ?? null);
  const instances = Object.fromEntries(
    files.map((name, index) => [name, entries[index]?.instance]),
  );
  const markers = Object.fromEntries(files.map((name, index) => [name, markerValues[index]]));
  const directories = await Promise.all(
    ["rebase-merge", "rebase-apply", "sequencer"].map(async (name) => {
      const entry = await stat(join(directory, name)).catch(nullIfFileMissing);
      return entry?.isDirectory() ?? false;
    }),
  );

  let kind: WorkflowKind | null = null;

  if (directories[0]) kind = "rebase";
  else if (directories[1]) kind = markers["rebase-apply/rebasing"] !== null ? "rebase" : "am";
  else if (markers["MERGE_HEAD"] !== null) kind = "merge";
  else if (markers["CHERRY_PICK_HEAD"] !== null) kind = "cherry-pick";
  else if (markers["REVERT_HEAD"] !== null) kind = "revert";
  else if (directories[2]) {
    const action = markers["sequencer/todo"]?.trimStart().split(/\s/)[0];
    kind = action === "pick" ? "cherry-pick" : action === "revert" ? "revert" : "unknown";
  }

  if (!kind) return null;

  const conflicts = status.changes
    .filter((change) => change.kind === "unmerged")
    .map((change) => change.path);
  const head = status.branch.oid ?? null;
  const sides = conflictSides(kind);
  const instance =
    kind === "rebase"
      ? (instances["rebase-merge/orig-head"] ?? instances["rebase-apply/orig-head"])
      : kind === "cherry-pick" || kind === "revert"
        ? (instances["sequencer/head"] ??
          instances[kind === "cherry-pick" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD"])
        : undefined;

  return {
    kind,
    ...(instance ? { instance: createHash("sha256").update(instance).digest("hex") } : {}),
    ...(kind === "rebase"
      ? {
          originalBranch:
            /^refs\/heads\/([^\r\n\0]+)$/.exec(
              (markers["rebase-merge/head-name"] ?? markers["rebase-apply/head-name"] ?? "").trim(),
            )?.[1] ?? null,
          rebaseOnto: objectId(markers["rebase-merge/onto"] ?? markers["rebase-apply/onto"]),
          rebaseEdit:
            conflicts.length === 0 &&
            objectId(markers["rebase-merge/amend"]) !== null &&
            /^(?:edit|e) /.test(markers["rebase-merge/done"]?.trimEnd().split("\n").at(-1) ?? ""),
        }
      : {}),
    token: createHash("sha256")
      .update(JSON.stringify([head, markerValues, directories, conflicts, instance]))
      .digest("hex"),
    head,
    originalHead:
      kind === "cherry-pick" || kind === "revert"
        ? (objectId(markers["sequencer/head"]) ?? head)
        : objectId(
            markers["rebase-merge/orig-head"] ??
              markers["rebase-apply/orig-head"] ??
              markers["sequencer/head"] ??
              markers["ORIG_HEAD"],
          ),
    incoming: (kind === "merge"
      ? (markers["MERGE_HEAD"]?.trim().split(/\s+/) ?? [])
      : [
          kind === "rebase"
            ? (markers["REBASE_HEAD"] ?? markers["rebase-merge/stopped-sha"])
            : kind === "revert"
              ? markers["REVERT_HEAD"]
              : markers["CHERRY_PICK_HEAD"],
        ]
    )
      .filter((value): value is string => objectId(value) !== null)
      .map((value) => value.trim()),
    step: number(markers["rebase-merge/msgnum"] ?? markers["rebase-apply/next"]),
    total: number(markers["rebase-merge/end"] ?? markers["rebase-apply/last"]),
    conflicts,
    currentLabel: t("main.git.workflowState.indexStage2", { current: sides.current }),
    incomingLabel: t("main.git.workflowState.indexStage3", { incoming: sides.incoming }),
  };
}
