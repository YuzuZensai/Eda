import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { stateLabel } from "@shared/i18n/labels";
import type {
  BranchCheckoutPhase,
  HistoryDirection,
  HistoryReversal,
} from "@shared/workflows/history-recovery";

import type { GitService } from "../../git/git-service";
import { withLockedIndex } from "../../git/operations/locked-index";
import type { ContentRecoveryRepository } from "../../persistence/content-recovery-repository";
import type { WorkflowJournal, WorkflowJournalRecord } from "../../persistence/workflow-journal";
import type { RepositoryManager } from "../lifecycle/repository-manager";
import { workflowFingerprint } from "../workflows/workflow-fingerprint";
import type { WorkflowService } from "../workflows/workflow-service";
import { DiscardService } from "../working-tree/discard-service";
import type { RepositoryWriter } from "../working-tree/repository-writer";
import {
  executeRefHistory,
  finishBranchCheckout,
  finishBranchReversal,
  finishRefConfiguration,
  releaseReferenceObjects,
  validateRefHistory,
  validateUnstartedRefIntent,
} from "./ref-history";
import { HistoryRecoveryInspection } from "./history-recovery-inspection";
import { ensureRecoveryRefs } from "./rewrite-history";
import { publishedRangeCount } from "./shared-history";

const invalid = (message: ErrorText) =>
  new GitError({ kind: "invalid-input", operation: t("operations.reverseLocalAction"), message });

function assertRecordContext(
  record: WorkflowJournalRecord | undefined,
  repositoryId: string,
  profileId: string,
): asserts record is WorkflowJournalRecord {
  if (!record || record.profileId !== profileId || record.repositoryId !== repositoryId)
    throw invalid(errorText("main.historyReversalService.thisActionBelongsToAnotherContext"));
}

export class HistoryReversalService {
  private readonly recovery: DiscardService;
  private readonly inspection: HistoryRecoveryInspection;

  constructor(
    private readonly git: GitService,
    private readonly repositories: RepositoryManager,
    private readonly writer: RepositoryWriter,
    private readonly workflows: WorkflowService,
    private readonly journal: WorkflowJournal,
    private readonly content: ContentRecoveryRepository,
  ) {
    this.recovery = new DiscardService(git, content);
    this.inspection = new HistoryRecoveryInspection(
      git,
      workflows,
      journal,
      content,
      this.recovery,
    );
  }

  private records(repositoryId: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const records = [
      ...this.journal.historyActions(repository.path),
      ...this.journal.refActions(repository.path),
    ]
      .filter(
        (record) =>
          record.profileId === repository.identityId && record.repositoryId === repositoryId,
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    const stateOf = (record: WorkflowJournalRecord) =>
      record.refOperation?.state ?? record.refChange?.reversal?.state;
    const unfinished = (record: WorkflowJournalRecord) =>
      record.state !== "completed" || ["undoing", "redoing"].includes(stateOf(record) ?? "");

    return [
      ...records.filter(unfinished),
      ...records.filter((record) => !unfinished(record)).slice(0, 20),
    ];
  }

  private requireAvailable(repositoryId: string, id: string) {
    if (!this.records(repositoryId).some((record) => record.id === id))
      throw invalid(errorText("main.historyReversalService.thisActionBelongsToAnotherContext"));
  }

  private async requireIdle(root: string) {
    if (await this.workflows.observe(root, await this.git.status(root)))
      throw invalid(
        errorText("main.historyReversalService.finishOrAbortTheCurrentGitOperationFirst"),
      );
  }

  private async finalizeInterruptedReset(record: WorkflowJournalRecord) {
    const reset = record.refChange!;
    const afterIndexTree = await this.inspection.indexTree(record.root);
    const afterFlags = await this.inspection.indexFlags(record.root);
    const afterFingerprint = await workflowFingerprint(
      this.git,
      record.root,
      await this.git.status(record.root),
    );

    await ensureRecoveryRefs(this.git, record.root, reset.recoveryRef, [
      ["head", record.head],
      ["index", reset.indexTree],
      ["after-head", reset.target],
      ["after-index", afterIndexTree],
    ]);

    let blockedReason: string | undefined;

    if (reset.beforeFlags === undefined)
      blockedReason = t("main.historyReversalService.theOriginalResetDidNotRecordIndexFlags");
    else if (
      reset.mode !== "soft" &&
      (this.inspection.specialFlags(reset.beforeFlags) || this.inspection.specialFlags(afterFlags))
    )
      blockedReason = t("main.historyReversalService.theOriginalOrResultingIndexHasSpecialFlags");

    if (reset.snapshotId) {
      const snapshot = this.content.get(record.profileId, record.repositoryId, reset.snapshotId);

      if (!snapshot || snapshot.root !== record.root) {
        delete reset.snapshotId;
        blockedReason ??= t(
          "main.historyReversalService.theOriginalWorkingContentSnapshotIsMissingUse",
        );
      } else if (snapshot.state === "prepared" || snapshot.state === "completed") {
        await this.recovery.finishOperation(snapshot);
      } else {
        blockedReason ??= t(
          "main.historyReversalService.theOriginalContentSnapshotWasAlreadyRestoredInspect",
        );
      }
    }

    reset.afterHead = reset.target;
    reset.afterFingerprint = afterFingerprint;
    reset.reversal = {
      state: "applied",
      expectedFingerprint: afterFingerprint,
      afterIndexTree,
      beforeFlags: reset.beforeFlags ?? "",
      afterFlags,
      ...(blockedReason ? { blockedReason } : {}),
    };
    record.state = "completed";
    record.updatedAt = new Date().toISOString();
    this.journal.save(record);
  }

  resumeReset(repositoryId: string, id: string, expectedPublishedCommits?: number) {
    this.requireAvailable(repositoryId, id);

    return this.writer.remoteOperation(
      repositoryId,
      t("main.historyReversalService.resumeInterruptedReset"),
      async (root, identity) => {
        const current = this.journal.historyActions(root).find((record) => record.id === id);

        assertRecordContext(current, repositoryId, identity.id);

        const inspection = await this.inspection.inspectInterruptedReset(current);
        const publishedCommits = Math.max(
          current.publishedCommits ?? 0,
          await publishedRangeCount(this.git, root, current.head, current.refChange!.target),
        );

        if (expectedPublishedCommits !== undefined && publishedCommits !== expectedPublishedCommits)
          throw invalid(
            errorText(
              "main.historyReversalService.remoteTrackingHistoryChangedAfterReviewRefreshUndo",
            ),
          );

        current.publishedCommits = publishedCommits;
        this.journal.save(current);

        let outcome: "reset" | "recorded" = "recorded";

        if (inspection === "execute") {
          const reset = current.refChange!;
          const afterTree =
            reset.mode === "soft"
              ? reset.indexTree
              : await this.inspection.commitTree(current.root, reset.target);

          await ensureRecoveryRefs(this.git, current.root, reset.recoveryRef, [
            ["head", current.head],
            ["index", reset.indexTree],
            ["after-head", reset.target],
            ["after-index", afterTree],
          ]);
          await this.git.exec(
            [
              "-c",
              "submodule.recurse=false",
              "reset",
              `--${reset.mode}`,
              "--no-recurse-submodules",
              reset.target,
            ],
            { cwd: root, operation: t("operations.resumeReset", { mode: reset.mode }) },
          );
          outcome = "reset";

          if ((await this.inspection.inspectInterruptedReset(current)) !== "record")
            throw invalid(
              errorText("main.historyReversalService.theResumedResetDidNotReachItsRecorded"),
            );
        }

        await this.finalizeInterruptedReset(current);

        return { outcome };
      },
    );
  }

  resumeBranchCheckout(repositoryId: string, id: string, phase: BranchCheckoutPhase = "original") {
    this.requireAvailable(repositoryId, id);

    return this.writer.remoteOperation(
      repositoryId,
      t("main.historyReversalService.resumeBranchCheckout"),
      async (root, identity) => {
        const current = this.findRecord(root, id);

        assertRecordContext(current, repositoryId, identity.id);
        await this.requireIdle(root);

        const candidate =
          phase === "original"
            ? await finishBranchCheckout(this.git, current)
            : await finishBranchReversal(this.git, current, phase);

        candidate.updatedAt = new Date().toISOString();
        this.journal.save(candidate);
      },
    );
  }

  dismissUnstarted(repositoryId: string, id: string) {
    this.requireAvailable(repositoryId, id);

    return this.writer.remoteOperation(
      repositoryId,
      t("main.historyReversalService.dismissUnstartedAction"),
      async (root, identity) => {
        const current = this.findRecord(root, id);

        assertRecordContext(current, repositoryId, identity.id);
        await this.requireIdle(root);

        await validateUnstartedRefIntent(this.git, current);
        await releaseReferenceObjects(this.git, current);
        this.journal.remove(current.id);
      },
    );
  }

  reconcile(repositoryId: string, id: string, expectedState: "applied" | "undone") {
    this.requireAvailable(repositoryId, id);

    return this.writer.remoteOperation(
      repositoryId,
      t("main.historyReversalService.reconcileInterruptedReversal"),
      async (root, identity) => {
        const current = this.findRecord(root, id);

        assertRecordContext(current, repositoryId, identity.id);

        const candidate = await this.inspection.reconciledRecord(current);
        const state = candidate.refOperation?.state ?? candidate.refChange?.reversal?.state;

        if (state !== expectedState)
          throw invalid(
            errorText(
              "main.historyReversalService.theRecoveryStateChangedAfterReviewRefreshUndoRedo",
            ),
          );

        candidate.updatedAt = new Date().toISOString();
        this.journal.save(candidate);
      },
    );
  }

  resumeIndex(repositoryId: string, id: string, expectedDirection?: HistoryDirection) {
    this.requireAvailable(repositoryId, id);

    return this.writer.remoteOperation(
      repositoryId,
      t("main.historyReversalService.resumeInterruptedRestoration"),
      async (root, identity) =>
        withLockedIndex(this.git, root, async (lockedIndex) => {
          const current = this.journal.historyActions(root).find((record) => record.id === id);

          assertRecordContext(current, repositoryId, identity.id);

          const { candidate, targetTree, targetFlags, atTarget, files } =
            await this.inspection.pendingIndex(current);

          if (expectedDirection && current.refChange!.reversal!.state !== `${expectedDirection}ing`)
            throw invalid(
              errorText(
                "main.historyReversalService.theInterruptedReversalChangedAfterReviewRefreshUndoRedo",
              ),
            );
          if (!atTarget)
            await lockedIndex.prepare(targetTree, t("operations.resumeInterruptedReversalIndex"));

          await this.inspection.pendingIndex(current);

          if (files) await this.recovery.restoreOperationFiles(files.target, files.source);
          if (!atTarget) await lockedIndex.publish();
          if (files && current.refChange!.reversal!.state === "undoing")
            await this.recovery.finishOperation(files.redo);

          const status = await this.git.status(root);
          const expectedHead =
            candidate.refChange!.reversal!.state === "undone"
              ? candidate.head
              : candidate.refChange!.target;

          if (
            (status.branch.oid ?? "") !== expectedHead ||
            (status.branch.detached ? undefined : status.branch.head) !== candidate.branch
          )
            throw invalid(
              errorText("main.historyReversalService.headChangedDuringIndexRecoveryTheInterrupted"),
            );

          const fingerprint = await workflowFingerprint(this.git, root, status);
          const flags = (
            await this.git.exec(["ls-files", "-v", "-z"], {
              cwd: root,
              operation: t("operations.verifyResumedIndexFlags"),
            })
          ).stdout;

          const reversal = candidate.refChange!.reversal!;
          const index = await this.git.exec(
            [
              "diff",
              "--cached",
              "--quiet",
              "--no-ext-diff",
              "--no-textconv",
              "--ita-visible-in-index",
              targetTree,
              "--",
            ],
            {
              cwd: root,
              operation: t("operations.verifyResumedIndexContents"),
              allowedExitCodes: [0, 1],
            },
          );

          if (flags !== targetFlags || index.exitCode !== 0)
            throw invalid(
              errorText(
                "main.historyReversalService.theIndexChangedDuringRecoveryTheInterruptedRecord",
              ),
            );

          const preservedNewerWork = fingerprint !== reversal.expectedFingerprint;

          if (preservedNewerWork)
            reversal.blockedReason = t(
              "main.historyReversalService.recoveryFinishedWithNewerRepositoryStateRetainedInspect",
            );

          candidate.updatedAt = new Date().toISOString();
          this.journal.save(candidate);

          return { preservedNewerWork };
        }),
    );
  }

  resumeConfiguration(repositoryId: string, id: string, direction: HistoryDirection) {
    this.requireAvailable(repositoryId, id);

    return this.writer.remoteOperation(
      repositoryId,
      t("main.historyReversalService.finishBranchConfigurationRecovery"),
      async (root, identity) =>
        withLockedIndex(this.git, root, async () => {
          const current = this.findRecord(root, id);

          assertRecordContext(current, repositoryId, identity.id);

          if (current.refOperation?.state !== `${direction}ing`)
            throw invalid(
              errorText(
                "main.historyReversalService.theInterruptedDirectionChangedAfterReviewRefreshUndoRedo",
              ),
            );
          await this.requireIdle(root);

          const candidate = await finishRefConfiguration(this.git, current);

          candidate.updatedAt = new Date().toISOString();
          this.journal.save(candidate);
        }),
    );
  }

  async list(repositoryId: string): Promise<HistoryReversal[]> {
    return this.inspection.list(this.records(repositoryId));
  }

  private findRecord(root: string, id: string) {
    return (
      this.journal.historyActions(root).find((item) => item.id === id) ??
      this.journal.refActions(root).find((item) => item.id === id)
    );
  }

  execute(
    repositoryId: string,
    id: string,
    direction: HistoryDirection,
    expectedPublishedCommits?: number,
  ): Promise<void> {
    const record = this.records(repositoryId).find((item) => item.id === id);

    if (!record)
      throw invalid(
        errorText(
          "main.historyReversalService.thisActionIsNoLongerAvailableInTheCurrentProfileWorktree",
        ),
      );

    return this.writer.remoteOperation(
      repositoryId,
      `${direction === "undo" ? t("operationTitles.undo") : t("operationTitles.redo")} ${record.mode === "reset" ? t("main.historyReversalService.reset", { mode: record.refChange!.mode }) : record.message}`,
      async (root, identity) => {
        if (record.refOperation) {
          const current = this.findRecord(root, id);

          assertRecordContext(current, repositoryId, identity.id);
          if (!current.refOperation)
            throw invalid(
              errorText("main.historyReversalService.thisActionBelongsToAnotherContext"),
            );

          const actual = await validateRefHistory(this.git, current);

          if (actual !== direction)
            throw invalid(
              errorText("main.historyReversalService.thisActionChangedAfterReviewRefreshUndoRedo"),
            );

          current.refOperation.state = direction === "undo" ? "undoing" : "redoing";
          current.updatedAt = new Date().toISOString();
          this.journal.save(current);

          try {
            await executeRefHistory(this.git, current, direction);
            current.refOperation.state = direction === "undo" ? "undone" : "applied";
          } finally {
            current.updatedAt = new Date().toISOString();
            this.journal.save(current);
          }

          return;
        }

        return withLockedIndex(this.git, root, async (lockedIndex) => {
          const current = this.journal.historyActions(root).find((item) => item.id === id);

          assertRecordContext(current, repositoryId, identity.id);

          const { undo, expectedHead, expectedRefs, snapshot } =
            await this.inspection.validate(current);

          if ((undo ? "undo" : "redo") !== direction)
            throw invalid(
              errorText("main.historyReversalService.thisActionChangedAfterReviewRefreshUndoRedo"),
            );

          const reset = current.refChange!;
          const reversal = reset.reversal!;
          const target = undo ? current.head : reset.target;
          const publishedCommits = await publishedRangeCount(this.git, root, expectedHead, target);

          if (
            expectedPublishedCommits !== undefined &&
            publishedCommits !== expectedPublishedCommits
          )
            throw invalid(
              errorText(
                "main.historyReversalService.remoteTrackingHistoryChangedAfterReviewRefreshUndoRedo",
              ),
            );

          let redo: Awaited<ReturnType<DiscardService["prepareOperation"]>> | undefined;

          if (undo && snapshot) {
            redo = await this.recovery.prepareOperation(
              root,
              current.profileId,
              repositoryId,
              snapshot.paths,
            );
            redo.record.source = "reset-recovery";
            await this.recovery.saveOperation(redo.record, redo.index);
            reversal.redoSnapshotId = redo.record.id;
          }

          reversal.state = undo ? "undoing" : "redoing";

          if (publishedCommits)
            current.publishedReversal = {
              fromHead: expectedHead,
              toHead: target,
              count: publishedCommits,
              direction,
              recordedAt: new Date().toISOString(),
            };

          current.updatedAt = new Date().toISOString();
          this.journal.save(current);

          try {
            const ref = current.branch ? `refs/heads/${current.branch}` : "HEAD";
            const change = !target
              ? `delete ${ref} ${expectedHead}`
              : !expectedHead
                ? `create ${ref} ${target}`
                : `update ${ref} ${target} ${expectedHead}`;

            await this.git.exec(
              ["update-ref", "--no-deref", "-m", `Eda: ${direction} ${current.message}`, "--stdin"],
              {
                cwd: root,
                operation: t("operations.reference", {
                  direction: stateLabel(direction),
                  mode: stateLabel(current.mode ?? ""),
                }),
                stdin: `${expectedRefs.map(([suffix, oid]) => `verify ${reset.recoveryRef}/${suffix} ${oid}`).join("\n")}\n${change}\n`,
                env: {
                  overrides: {
                    GIT_COMMITTER_NAME: identity.gitName,
                    GIT_COMMITTER_EMAIL: identity.gitEmail,
                  },
                },
              },
            );

            if (reset.mode !== "soft")
              await lockedIndex.prepare(
                undo ? reset.indexTree : reversal.afterIndexTree,
                t("operations.resetIndex", { direction: stateLabel(direction) }),
              );

            if (snapshot) await this.recovery.restoreOperationFiles(snapshot, snapshot.after!);
            if (reset.mode !== "soft") await lockedIndex.publish();
            if (redo) await this.recovery.finishOperation(redo.record);

            const after = await this.git.status(root);
            const fingerprint = await workflowFingerprint(this.git, root, after);
            const flags = (
              await this.git.exec(["ls-files", "-v", "-z"], {
                cwd: root,
                operation: t("operations.verifyReversedIndexFlags"),
              })
            ).stdout;

            const expectedFingerprint = undo
              ? this.inspection.beforeFingerprint(current)
              : reset.afterFingerprint;

            if (
              fingerprint !== expectedFingerprint ||
              flags !== (undo ? reversal.beforeFlags : reversal.afterFlags)
            )
              throw invalid(
                errorText("main.historyReversalService.theReversalDidNotFinishInTheRecorded"),
              );

            reversal.expectedFingerprint = fingerprint;
            reversal.state = undo ? "undone" : "applied";
          } finally {
            current.updatedAt = new Date().toISOString();
            this.journal.save(current);
          }
        });
      },
    );
  }
}
