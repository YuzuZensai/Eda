import { hasSpecialIndexFlags } from "../../git/parsers/status-parser";
import { isUtf8 } from "node:buffer";
import { ERROR_CODE, errorText } from "@shared/error-codes";
import { AppError, errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { GitService } from "../../git/git-service";
import type { WorkflowJournal, WorkflowJournalRecord } from "../../persistence/workflow-journal";
import { repositoryCommonDirectory } from "../lifecycle/repository-location";
import { workflowFingerprint } from "../workflows/workflow-fingerprint";
import type { DiscardService } from "../working-tree/discard-service";

export interface RewriteStart {
  flags: string;
  fingerprint: string;
}

export async function recordRewriteStart(
  git: GitService,
  journal: WorkflowJournal,
  record: WorkflowJournalRecord,
): Promise<RewriteStart> {
  if (record.rewriteStart) return record.rewriteStart;
  const root = record.root;
  const status = await git.status(root);
  const flags = await git.exec(["ls-files", "-v", "-z"], {
    cwd: root,
    operation: t("operations.captureRewriteIndexFlags"),
  });

  record.rewriteStart = {
    flags: flags.stdout,
    fingerprint: await workflowFingerprint(git, root, status),
  };
  journal.save(record);
  return record.rewriteStart;
}

export async function ensureRecoveryRefs(
  git: GitService,
  root: string,
  recoveryRef: string,
  expected: [string, string][],
) {
  const refs = await git.exec(
    ["for-each-ref", "--format=%(refname)%00%(objectname)", recoveryRef],
    { cwd: root, operation: t("operations.reviewRewriteRecoveryRefs") },
  );
  const existing = new Map(
    refs.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\0") as [string, string]),
  );

  const missing: string[] = [];

  for (const [suffix, oid] of expected) {
    const name = `${recoveryRef}/${suffix}`;
    const current = existing.get(name);
    if (current && current !== oid) throw new AppError(ERROR_CODE.REWRITE_RECOVERY_REF_CHANGED);
    if (!current) missing.push(`create ${name} ${oid}`);
  }

  if (missing.length)
    await git.exec(["update-ref", "--stdin"], {
      cwd: root,
      operation: t("operations.preserveRewriteRecoveryRefs"),
      stdin: `${missing.join("\n")}\n`,
    });
}

export async function finalizeRewrite(
  git: GitService,
  journal: WorkflowJournal,
  recovery: DiscardService,
  record: WorkflowJournalRecord,
  resultHead: string | null,
  start?: RewriteStart,
): Promise<void> {
  if (
    record.state !== "completed" ||
    record.refChange?.reversal ||
    !record.head ||
    !resultHead ||
    record.head === resultHead ||
    !record.branch
  )
    return;

  const root = record.root;
  const status = await git.status(root);

  if (status.branch.oid !== resultHead || status.branch.head !== record.branch)
    throw new AppError(ERROR_CODE.REWRITE_BRANCH_MISMATCH);

  const afterFingerprint = await workflowFingerprint(git, root, status);
  const afterFlags = (
    await git.exec(["ls-files", "-v", "-z"], {
      cwd: root,
      operation: t("operations.captureRewrittenIndexFlags"),
    })
  ).stdout;

  const originalTree = (
    await git.exec(["rev-parse", `${record.head}^{tree}`], {
      cwd: root,
      operation: t("operations.reviewOriginalRewriteTree"),
    })
  ).stdout.trim();

  const resultTree = (
    await git.exec(["rev-parse", `${resultHead}^{tree}`], {
      cwd: root,
      operation: t("operations.reviewRewrittenResultTree"),
    })
  ).stdout.trim();

  const commonDirectory = await repositoryCommonDirectory(git, root);
  const recoveryRef = `refs/eda/recovery/${record.id}`;

  await ensureRecoveryRefs(git, root, recoveryRef, [
    ["head", record.head],
    ["index", originalTree],
    ["after-head", resultHead],
    ["after-index", resultTree],
  ]);

  const changed = await git.exec(
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      record.head,
      resultHead,
      "--",
    ],
    { cwd: root, operation: t("operations.reviewRewrittenPaths"), maxStdoutBytes: 1024 * 1024 },
  );

  const paths = changed.stdout.split("\0").filter(Boolean);
  let snapshotId: string | undefined;
  let blockedReason: string | undefined;

  if (record.refOperation || record.refChange)
    throw new AppError(ERROR_CODE.REWRITE_RECOVERY_ALREADY_SET);

  const beforeFlags = start?.flags ?? "";

  if (!start) blockedReason = t("main.rewriteHistory.theOriginalIndexFlagsWereNotRecordedUse");
  else if (!start.fingerprint)
    blockedReason = t("main.rewriteHistory.theOriginalRepositoryFingerprintWasNotRecordedUse");

  if (hasSpecialIndexFlags(beforeFlags))
    blockedReason = t("main.rewriteHistory.theOriginalIndexHasSpecialFlagsUseSaved");

  if (!isUtf8(changed.stdoutBytes)) {
    blockedReason = t("main.rewriteHistory.unsupportedPathEncoding");
  } else if (paths.length) {
    try {
      const snapshot = await recovery.prepareTreeOperation(
        root,
        record.profileId,
        record.repositoryId,
        record.head,
        resultHead,
        paths,
      );

      snapshotId = snapshot.id;
    } catch (error) {
      blockedReason = errorMessage(
        error,
        errorText("main.rewriteHistory.savedRewriteContentCouldNotBePreparedUse"),
      );
    }
  }

  if (hasSpecialIndexFlags(afterFlags))
    blockedReason = t("main.rewriteHistory.theRewrittenIndexHasSpecialFlagsUseSaved");

  record.tree = originalTree;
  record.refChange = {
    commonDirectory,
    mode: "hard",
    target: resultHead,
    indexTree: originalTree,
    recoveryRef,
    ...(snapshotId ? { snapshotId } : {}),
    beforeFlags,
    beforeFingerprint: start?.fingerprint ?? "",
    beforeWorking: "",
    afterHead: resultHead,
    afterFingerprint,
    reversal: {
      state: "applied",
      expectedFingerprint: afterFingerprint,
      afterIndexTree: resultTree,
      beforeFlags,
      afterFlags,
      ...(blockedReason ? { blockedReason } : {}),
    },
  };
  record.updatedAt = new Date().toISOString();
  journal.save(record);
}
