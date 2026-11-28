import { errorText, type ErrorText } from "@shared/error-codes";
import { errorMessage, GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { HistoryReversal, HistoryReversalKind } from "@shared/workflows/history-recovery";
import { createHash } from "node:crypto";
import type { GitService } from "../../git/git-service";
import type {
  ContentRecoveryRecord,
  ContentRecoveryRepository,
} from "../../persistence/content-recovery-repository";
import type { WorkflowJournal, WorkflowJournalRecord } from "../../persistence/workflow-journal";
import { repositoryCommonDirectory } from "../lifecycle/repository-location";
import { protectResetPaths } from "../workflows/reset-service";
import { workflowFingerprint } from "../workflows/workflow-fingerprint";
import type { WorkflowService } from "../workflows/workflow-service";
import type { DiscardService } from "../working-tree/discard-service";
import {
  completedRefIntent,
  pendingBranchReversal,
  pendingRefConfiguration,
  validatePendingBranchCheckout,
  validateRefHistory,
  validateUnstartedRefIntent,
} from "./ref-history";
import { publishedRangeCount } from "./shared-history";

const invalid = (message: ErrorText) =>
  new GitError({ kind: "invalid-input", operation: t("operations.reverseLocalAction"), message });

async function inspectCandidate<Value>(
  inspect: () => Promise<Value>,
): Promise<{ applicable: true; value: Value } | { applicable: false; error: GitError }> {
  try {
    return { applicable: true, value: await inspect() };
  } catch (error) {
    if (!(error instanceof GitError) || error.kind !== "invalid-input") throw error;
    return { applicable: false, error };
  }
}

export class HistoryRecoveryInspection {
  constructor(
    private readonly git: GitService,
    private readonly workflows: WorkflowService,
    private readonly journal: Pick<WorkflowJournal, "historyActions">,
    private readonly content: ContentRecoveryRepository,
    private readonly recovery: DiscardService,
  ) {}

  async validate(
    record: WorkflowJournalRecord,
    options: { reconciling?: boolean; partialIndex?: boolean } = {},
  ) {
    if (record.refOperation)
      throw invalid(
        errorText(
          "main.historyReversalService.thisIsABranchOrCheckoutActionInspectItsReferenceStateFirst",
        ),
      );

    const reset = record.refChange;

    if (!reset)
      throw invalid(
        errorText("main.historyReversalService.thisActionHasNoCompletedReversalRecordInspect"),
      );

    const reversal = reset.reversal;

    if (record.state !== "completed" || !reversal)
      throw invalid(
        errorText("main.historyReversalService.thisActionHasNoCompletedReversalRecordInspect"),
      );

    if (reversal.state === "undoing" || reversal.state === "redoing")
      throw invalid(
        errorText("main.historyReversalService.aReversalWasInterruptedInspectHeadIndexAnd"),
      );

    if (reversal.blockedReason)
      throw invalid(errorText("errors.operationBlocked", { reason: reversal.blockedReason }));

    if (
      !options.reconciling &&
      this.journal
        .historyActions(record.root)
        .some(
          (item) =>
            item.id !== record.id &&
            ["undoing", "redoing"].includes(item.refChange?.reversal?.state ?? ""),
        )
    )
      throw invalid(
        errorText(
          "main.historyReversalService.anotherLocalActionReversalWasInterruptedInspectRecovery",
        ),
      );

    if ((await repositoryCommonDirectory(this.git, record.root)) !== reset.commonDirectory)
      throw invalid(errorText("main.historyReversalService.thePhysicalRepositoryChanged"));

    const status = await this.git.status(record.root);

    if (await this.workflows.observe(record.root, status))
      throw invalid(
        errorText("main.historyReversalService.finishOrAbortTheCurrentGitOperationFirst"),
      );

    const undo = reversal.state === "applied";
    const expectedHead = undo ? reset.target : record.head;

    if (
      (status.branch.oid ?? "") !== expectedHead ||
      (status.branch.detached ? undefined : status.branch.head) !== record.branch
    )
      throw invalid(
        errorText("main.historyReversalService.headOrTheCheckedOutBranchChangedSinceThisAction"),
      );

    if (
      !options.partialIndex &&
      (await workflowFingerprint(this.git, record.root, status)) !== reversal.expectedFingerprint
    )
      throw invalid(
        errorText("main.historyReversalService.theRepositoryChangedSinceThisActionUndoRedo"),
      );

    const flags = (
      await this.git.exec(["ls-files", "-v", "-z"], {
        cwd: record.root,
        operation: t("operations.validateReversalIndexFlags"),
      })
    ).stdout;

    if (!options.partialIndex && flags !== (undo ? reversal.afterFlags : reversal.beforeFlags))
      throw invalid(errorText("main.historyReversalService.indexFlagsChangedSinceThisAction"));

    const refs = (
      await this.git.exec(
        ["for-each-ref", "--format=%(refname)%00%(objectname)", reset.recoveryRef],
        { cwd: record.root, operation: t("operations.validateReversalRecoveryRefs") },
      )
    ).stdout;

    const objects = new Map(
      refs
        .trim()
        .split("\n")
        .map((line) => line.split("\0") as [string, string]),
    );

    const expectedRefs: [string, string][] = [
      ...(record.head ? [["head", record.head] as [string, string]] : []),
      ["index", reset.indexTree],
      ["after-head", reset.target],
      ["after-index", reversal.afterIndexTree],
    ];

    for (const [suffix, oid] of expectedRefs)
      if (objects.get(`${reset.recoveryRef}/${suffix}`) !== oid)
        throw invalid(
          errorText("main.historyReversalService.aRequiredRecoveryRefIsMissingOrChanged"),
        );

    if (record.branch) {
      const worktrees = await this.git.exec(["worktree", "list", "--porcelain"], {
        cwd: record.root,
        operation: t("operations.validateReversalWorktrees"),
      });

      if (
        worktrees.stdout.split("\n").filter((line) => line === `branch refs/heads/${record.branch}`)
          .length > 1
      )
        throw invalid(
          errorText("main.historyReversalService.thisBranchIsCheckedOutInMultipleWorktrees"),
        );

      const symbolic = await this.git.exec(
        ["symbolic-ref", "--quiet", `refs/heads/${record.branch}`],
        {
          cwd: record.root,
          operation: t("operations.validateReversalBranch"),
          allowedExitCodes: [0, 1],
        },
      );

      if (symbolic.exitCode === 0)
        throw invalid(
          errorText("main.historyReversalService.symbolicBranchRefsCannotBeReversedAutomatically"),
        );
    }

    let snapshot: ContentRecoveryRecord | undefined;

    if (reset.mode === "hard" && reset.snapshotId && !options.partialIndex) {
      if (
        this.content.get(record.profileId, record.repositoryId, reset.snapshotId)?.state !==
        "completed"
      )
        throw invalid(
          errorText(
            "main.historyReversalService.theOriginalWorkingContentSnapshotIsMissingInspect",
          ),
        );

      const id = undo ? reset.snapshotId : reversal.redoSnapshotId;

      snapshot = id ? this.content.get(record.profileId, record.repositoryId, id) : undefined;

      if (
        !snapshot ||
        snapshot.root !== record.root ||
        snapshot.state !== "completed" ||
        !snapshot.after
      )
        throw invalid(
          errorText("main.historyReversalService.aRequiredWorkingContentSnapshotIsMissingOr"),
        );

      await this.recovery.validateOperationFiles(snapshot, snapshot.after);
    }

    return { undo, expectedHead, expectedRefs, snapshot };
  }

  private async workingHash(root: string) {
    const working = await this.git.exec(
      ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"],
      { cwd: root, operation: t("operations.reviewInterruptedResetWorkingFiles") },
    );
    return createHash("sha256").update(working.stdoutBytes).digest("hex");
  }

  async indexFlags(root: string) {
    return (
      await this.git.exec(["ls-files", "-v", "-z"], {
        cwd: root,
        operation: t("operations.reviewInterruptedResetIndexFlags"),
      })
    ).stdout;
  }

  async indexTree(root: string) {
    return (
      await this.git.exec(["write-tree"], {
        cwd: root,
        operation: t("operations.reviewInterruptedResetIndex"),
      })
    ).stdout.trim();
  }

  async commitTree(root: string, oid: string) {
    return (
      await this.git.exec(["rev-parse", `${oid}^{tree}`], {
        cwd: root,
        operation: t("operations.reviewInterruptedResetTarget"),
      })
    ).stdout.trim();
  }

  async inspectInterruptedReset(record: WorkflowJournalRecord): Promise<"execute" | "record"> {
    const reset = record.refChange;

    if (record.mode !== "reset" || !reset || reset.reversal)
      throw invalid(
        errorText("main.historyReversalService.thisRecordIsNotAnInterruptedOriginalReset"),
      );
    if (record.state === "completed")
      throw invalid(
        errorText("main.historyReversalService.thisResetAlreadyHasACompletedRecoveryRecord"),
      );
    if ((await repositoryCommonDirectory(this.git, record.root)) !== reset.commonDirectory)
      throw invalid(errorText("main.historyReversalService.thePhysicalRepositoryChanged"));

    const status = await this.git.status(record.root);

    if (await this.workflows.observe(record.root, status))
      throw invalid(
        errorText("main.historyReversalService.finishOrAbortTheCurrentGitOperationFirst"),
      );
    if ((status.branch.detached ? undefined : status.branch.head) !== record.branch)
      throw invalid(
        errorText("main.historyReversalService.theCheckedOutBranchChangedSinceThisReset"),
      );

    const head = status.branch.oid ?? "";
    const tree = await this.indexTree(record.root);
    const flags = await this.indexFlags(record.root);
    const working = await this.workingHash(record.root);
    const startMatches =
      tree === reset.indexTree &&
      reset.beforeFlags !== undefined &&
      flags === reset.beforeFlags &&
      !!reset.beforeWorking &&
      working === reset.beforeWorking;

    const requireSavedStart = async () => {
      if (reset.mode !== "hard" || !reset.snapshotId) return;

      const snapshot = this.content.get(record.profileId, record.repositoryId, reset.snapshotId);

      if (
        !snapshot ||
        snapshot.root !== record.root ||
        !["prepared", "completed"].includes(snapshot.state)
      )
        throw invalid(
          errorText(
            "main.historyReversalService.theOriginalWorkingContentSnapshotIsUnavailablePreserve",
          ),
        );

      await this.recovery.validateOperationFiles(
        snapshot,
        Object.fromEntries(snapshot.files.map((file) => [file.path, file.hash])),
      );
    };

    if (reset.mode === "hard") {
      const affected = await this.git.exec(
        ["diff", "--cached", "--name-only", "-z", "--no-renames", reset.target, "--"],
        { cwd: record.root, operation: t("operations.reviewResumedResetPaths") },
      );

      await protectResetPaths(
        this.git,
        record.root,
        reset.target,
        affected.stdout.split("\0").filter(Boolean),
      );
    }

    if (head === record.head && head !== reset.target) {
      if (tree !== reset.indexTree)
        throw invalid(
          errorText(
            "main.historyReversalService.theIndexChangedSinceThisResetInspectStagedChangesBeforeResuming",
          ),
        );

      if (reset.beforeFlags === undefined || flags !== reset.beforeFlags)
        throw invalid(errorText("main.historyReversalService.theIndexFlagsChangedSinceThisReset"));

      if (!reset.beforeWorking || working !== reset.beforeWorking)
        throw invalid(
          errorText("main.historyReversalService.workingFilesChangedSinceThisResetResumeIs"),
        );

      await requireSavedStart();

      return "execute";
    }

    if (head !== reset.target)
      throw invalid(errorText("main.historyReversalService.headIsNeitherThisResetSStarting"));

    const expectedIndex =
      reset.mode === "soft" ? reset.indexTree : await this.commitTree(record.root, reset.target);
    const resultMatches =
      tree === expectedIndex &&
      (reset.mode !== "soft" || (reset.beforeFlags !== undefined && flags === reset.beforeFlags)) &&
      (reset.mode === "hard"
        ? working === createHash("sha256").update(Buffer.alloc(0)).digest("hex")
        : reset.mode === "soft"
          ? !!reset.beforeWorking && working === reset.beforeWorking
          : true);

    if (resultMatches) return "record";

    if (startMatches) {
      await requireSavedStart();
      return "execute";
    }

    throw invalid(
      reset.mode === "soft"
        ? errorText("main.historyReversalService.theIndexOrWorkingFilesDoNotMatchMessage")
        : errorText("main.historyReversalService.theIndexOrWorkingFilesDoNotMatch"),
    );
  }

  async reconciledRecord(record: WorkflowJournalRecord): Promise<WorkflowJournalRecord> {
    if (record.refOperation) {
      if (record.state !== "completed") return completedRefIntent(this.git, record);

      const operation = record.refOperation;

      if (!["undoing", "redoing"].includes(operation.state))
        throw invalid(
          errorText("main.historyReversalService.thisActionHasNoInterruptedReversalToReconcile"),
        );

      const states =
        operation.state === "undoing"
          ? (["undone", "applied"] as const)
          : (["applied", "undone"] as const);

      for (const state of states) {
        const candidate = structuredClone(record);

        candidate.refOperation!.state = state;

        const result = await inspectCandidate(() => validateRefHistory(this.git, candidate));
        if (result.applicable && result.value === (state === "undone" ? "redo" : "undo"))
          return candidate;
      }

      throw invalid(
        errorText(
          "main.historyReversalService.theInterruptedReferenceReversalIsPartialOrExternally",
        ),
      );
    }

    const reversal = record.refChange?.reversal;

    if (!reversal || !["undoing", "redoing"].includes(reversal.state))
      throw invalid(
        errorText("main.historyReversalService.thisActionHasNoInterruptedReversalToReconcile"),
      );

    const states =
      reversal.state === "undoing"
        ? (["undone", "applied"] as const)
        : (["applied", "undone"] as const);

    for (const state of states) {
      const candidate = structuredClone(record);

      candidate.refChange!.reversal!.state = state;
      candidate.refChange!.reversal!.expectedFingerprint =
        state === "undone"
          ? this.beforeFingerprint(candidate)
          : record.refChange!.afterFingerprint!;

      const result = await inspectCandidate(() => this.validate(candidate, { reconciling: true }));
      if (result.applicable) return candidate;
    }

    throw invalid(
      errorText("main.historyReversalService.theInterruptedReversalIsPartialExternallyChangedOr"),
    );
  }

  beforeFingerprint(record: WorkflowJournalRecord) {
    const reset = record.refChange;

    if (!reset)
      throw invalid(
        errorText("main.historyReversalService.thisActionHasNoResetStyleRecoveryRecord"),
      );

    const recorded = reset.beforeFingerprint;

    if (!recorded)
      throw invalid(
        errorText("main.historyReversalService.theOriginalRepositoryFingerprintWasNotRecordedUse"),
      );

    return recorded;
  }

  async pendingIndex(record: WorkflowJournalRecord) {
    const reset = record.refChange;
    const reversal = reset?.reversal;

    if (
      !reset ||
      !["mixed", "hard"].includes(reset.mode) ||
      !reversal ||
      !["undoing", "redoing"].includes(reversal.state)
    )
      throw invalid(
        errorText(
          "main.historyReversalService.onlyAnInterruptedMixedOrHardResetReversalCanResumeRestoration",
        ),
      );

    const undo = reversal.state === "undoing";
    const candidate = structuredClone(record);
    const next = candidate.refChange!.reversal!;

    next.state = undo ? "undone" : "applied";
    next.expectedFingerprint = undo ? this.beforeFingerprint(record) : reset.afterFingerprint!;
    await this.validate(candidate, { partialIndex: true });

    let files:
      | {
          target: ContentRecoveryRecord;
          source: Record<string, string>;
          redo: ContentRecoveryRecord;
        }
      | undefined;

    if (reset.mode === "hard" && reset.snapshotId) {
      const original = this.content.get(record.profileId, record.repositoryId, reset.snapshotId);
      const redo = reversal.redoSnapshotId
        ? this.content.get(record.profileId, record.repositoryId, reversal.redoSnapshotId)
        : undefined;

      if (
        !original ||
        !redo ||
        original.root !== record.root ||
        redo.root !== record.root ||
        original.state !== "completed" ||
        !original.after ||
        !(redo.state === "completed" || (undo && redo.state === "prepared")) ||
        original.files.length !== redo.files.length ||
        original.files.some(
          (file) =>
            !redo.files.some(
              (saved) => saved.path === file.path && saved.hash === original.after![file.path],
            ),
        )
      )
        throw invalid(
          errorText(
            "main.historyReversalService.requiredWorkingContentSnapshotsAreMissingOrChanged",
          ),
        );

      const target = undo ? original : redo;
      const source = Object.fromEntries(
        (undo ? redo : original).files.map((file) => [file.path, file.hash]),
      );

      await this.recovery.validateOperationFiles(target, source, true);
      files = { target, source, redo };
    }

    const flags = (
      await this.git.exec(["ls-files", "-v", "-z"], {
        cwd: record.root,
        operation: t("operations.reviewInterruptedIndexFlags"),
      })
    ).stdout;

    const targetTree = undo ? reset.indexTree : reversal.afterIndexTree;
    const sourceTree = undo ? reversal.afterIndexTree : reset.indexTree;
    const targetFlags = undo ? reversal.beforeFlags : reversal.afterFlags;
    const sourceFlags = undo ? reversal.afterFlags : reversal.beforeFlags;

    for (const [tree, expectedFlags] of [
      [targetTree, targetFlags],
      [sourceTree, sourceFlags],
    ]) {
      if (flags !== expectedFlags) continue;

      const match = await this.git.exec(
        [
          "diff",
          "--cached",
          "--quiet",
          "--no-ext-diff",
          "--no-textconv",
          "--ita-visible-in-index",
          tree!,
          "--",
        ],
        {
          cwd: record.root,
          operation: t("operations.reviewInterruptedIndexContents"),
          allowedExitCodes: [0, 1],
        },
      );

      if (match.exitCode === 0)
        return { candidate, targetTree, targetFlags, atTarget: tree === targetTree, files };
    }

    throw invalid(errorText("main.historyReversalService.theIndexHasNewerStagedChangesOrFlags"));
  }

  private async inspectReference(record: WorkflowJournalRecord): Promise<HistoryReversal> {
    const operation = record.refOperation!;
    const direction = ["undone", "redoing"].includes(operation.state) ? "redo" : "undo";
    const item: HistoryReversal = {
      kind: record.mode === "checkout" ? "checkout" : "branch",
      fromHead: (direction === "undo" ? operation.afterHead : operation.beforeHead) ?? "",
      toHead: (direction === "undo" ? operation.beforeHead : operation.afterHead) ?? "",
      id: record.id,
      direction,
      label: `${direction === "undo" ? t("main.historyReversalService.undoLabel") : t("main.historyReversalService.redo")} ${record.message}`,
      available: true,
      publishedCommits: 0,
      ...(record.branch ? { branch: record.branch } : {}),
    };

    try {
      const actual = await validateRefHistory(this.git, record);
      if (actual !== direction)
        throw invalid(
          errorText(
            "main.historyReversalService.theReferenceStateChangedAfterThisActionRefreshUndoRedo",
          ),
        );
    } catch (error) {
      if (!(error instanceof GitError) || error.kind !== "invalid-input") throw error;
      item.available = false;
      item.reason = errorMessage(
        error,
        errorText("main.historyReversalService.referenceStateCouldNotBeInspected"),
      );

      if (record.state !== "completed" || ["undoing", "redoing"].includes(operation.state)) {
        const reconciled = await inspectCandidate(() => this.reconciledRecord(record));
        if (reconciled.applicable) {
          item.reconciliation = reconciled.value.refOperation!.state as "applied" | "undone";
        } else {
          const checkout = await inspectCandidate(() =>
            validatePendingBranchCheckout(this.git, record),
          );
          if (checkout.applicable) {
            item.resumeBranchCheckout = "original";
          } else {
            const reversal = await inspectCandidate(() => pendingBranchReversal(this.git, record));
            if (reversal.applicable) item.resumeBranchCheckout = reversal.value;
          }

          const unstarted = await inspectCandidate(() =>
            validateUnstartedRefIntent(this.git, record),
          );
          if (unstarted.applicable) item.dismissUnstarted = true;

          const configuration = await inspectCandidate(() =>
            pendingRefConfiguration(this.git, record),
          );
          if (configuration.applicable) item.resumeConfiguration = true;

          item.reason = errorMessage(
            reconciled.error,
            errorText("main.historyReversalService.referenceRecoveryIsIncomplete"),
          );
        }
      }
    }

    return item;
  }

  private async inspectOriginalReset(record: WorkflowJournalRecord): Promise<HistoryReversal> {
    const reset = record.refChange!;
    const item: HistoryReversal = {
      kind: "reset",
      mode: reset.mode,
      fromHead: record.head,
      toHead: reset.target,
      id: record.id,
      direction: "undo",
      label: t("main.historyReversalService.resumeInterruptedResetTo", {
        mode: reset.mode,
        target: reset.target.slice(0, 12),
      }),
      available: false,
      publishedCommits: record.publishedCommits ?? 0,
      ...(record.branch ? { branch: record.branch } : {}),
    };

    try {
      const inspection = await this.inspectInterruptedReset(record);

      item.publishedCommits = Math.max(
        item.publishedCommits,
        await publishedRangeCount(this.git, record.root, record.head, reset.target),
      );
      item.resumeReset = true;
      item.reason =
        inspection === "execute"
          ? t("main.historyReversalService.gitDidNotReachTheReviewedResetTarget")
          : t("main.historyReversalService.gitAlreadyReachedTheReviewedResetTargetResume");
    } catch (error) {
      if (!(error instanceof GitError) || error.kind !== "invalid-input") throw error;
      item.reason = errorMessage(
        error,
        errorText("main.historyReversalService.interruptedResetStateCouldNotBeInspected"),
      );
    }

    return item;
  }

  private async inspectReversal(record: WorkflowJournalRecord): Promise<HistoryReversal> {
    const reset = record.refChange!;
    const direction = ["undone", "redoing"].includes(reset.reversal?.state ?? "") ? "redo" : "undo";
    const kind: HistoryReversalKind =
      record.mode === "commit" ||
      record.mode === "amend" ||
      record.mode === "rebase" ||
      record.mode === "cherry-pick" ||
      record.mode === "revert"
        ? record.mode
        : "reset";

    const item: HistoryReversal = {
      kind,
      mode: reset.mode,
      fromHead: direction === "undo" ? reset.target : record.head,
      toHead: direction === "undo" ? record.head : reset.target,
      id: record.id,
      direction,
      label:
        kind === "reset"
          ? t("main.historyReversalService.resetTo", {
              value1:
                direction === "undo"
                  ? t("main.historyReversalService.undoLabel")
                  : t("main.historyReversalService.redo"),
              mode: reset.mode,
              target: reset.target.slice(0, 12),
            })
          : `${direction === "undo" ? t("main.historyReversalService.undoLabel") : t("main.historyReversalService.redo")} ${record.message}${kind === "rebase" && record.incoming[0] ? t("main.historyReversalService.onto", { value1: record.incoming[0].slice(0, 12) }) : ""}`,
      available: true,
      publishedCommits: 0,
      ...(record.branch ? { branch: record.branch } : {}),
    };

    try {
      await this.validate(record);
      item.publishedCommits = await publishedRangeCount(
        this.git,
        record.root,
        item.fromHead,
        item.toHead,
      );
    } catch (error) {
      if (!(error instanceof GitError) || error.kind !== "invalid-input") throw error;
      item.available = false;
      item.reason = errorMessage(
        error,
        errorText("main.historyReversalService.recoveryStateCouldNotBeInspected"),
      );

      if (["undoing", "redoing"].includes(reset.reversal?.state ?? "")) {
        const reconciled = await inspectCandidate(() => this.reconciledRecord(record));
        if (reconciled.applicable) {
          item.reconciliation = reconciled.value.refChange!.reversal!.state as "applied" | "undone";
        } else if (["mixed", "hard"].includes(reset.mode)) {
          const index = await inspectCandidate(() => this.pendingIndex(record));
          if (index.applicable) {
            item.resumeIndex = true;
          } else {
            item.reason = errorMessage(
              index.error,
              errorText("errors.operationBlocked", { reason: item.reason }),
            );
          }
        }
      }
    }

    return item;
  }

  async list(records: WorkflowJournalRecord[]): Promise<HistoryReversal[]> {
    const results: HistoryReversal[] = [];

    for (const record of records) {
      if (record.recoveryWarning) {
        results.push({
          id: record.id,
          kind: record.mode as HistoryReversalKind,
          label: t("main.historyReversalService.undo", { message: record.message }),
          direction: "undo",
          available: false,
          fromHead: record.resultHead ?? "",
          toHead: record.head,
          publishedCommits: record.publishedCommits ?? 0,
          reason: record.recoveryWarning,
        });
        continue;
      }

      if (record.refOperation) {
        results.push(await this.inspectReference(record));
      } else if (
        record.mode === "reset" &&
        record.state !== "completed" &&
        !record.refChange?.reversal
      ) {
        results.push(await this.inspectOriginalReset(record));
      } else {
        results.push(await this.inspectReversal(record));
      }
    }

    return results;
  }
}
