import { commitGitConfig } from "@shared/identity/identity";
import { errorText, type ErrorText } from "@shared/error-codes";
import { errorMessage, GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { Identity } from "@shared/identity/identity";
import type {
  ReplayAction,
  ReplayCommit,
  ReplayKind,
  ReplayResult,
  ReplayReview,
} from "@shared/workflows/replay";
import { randomUUID } from "node:crypto";
import type { GitService } from "../../git/git-service";
import { assertFullObjectId } from "../../git/validation";
import type { IdentityManager } from "../../identity/identity-manager";
import type { WorkflowJournal, WorkflowJournalRecord } from "../../persistence/workflow-journal";
import { matchesReviewContext, PreviewStore } from "../preview-store";
import { recordRewriteStart, finalizeRewrite } from "../history/rewrite-history";
import type { RepositoryManager } from "../lifecycle/repository-manager";
import type { DiscardService, OperationSnapshot } from "../working-tree/discard-service";
import type { RepositoryWriter } from "../working-tree/repository-writer";
import { addRecoveryDiffPaths, trackedChangePaths } from "./recovery-paths";
import { workflowFingerprint } from "./workflow-fingerprint";
import { matchesNativeWorkflow, type WorkflowService } from "./workflow-service";

const invalid = (message: ErrorText) =>
  new GitError({ kind: "invalid-input", operation: t("operations.replayCommits"), message });

export class ReplayService {
  private readonly reviews = new PreviewStore<{
    review: ReplayReview;
    root: string;
    repositoryId: string;
    identity: Identity;
    workflowToken: string | null;
    fingerprint: string;
    record?: WorkflowJournalRecord;
    snapshot?: OperationSnapshot;
  }>();

  constructor(
    private readonly git: GitService,
    private readonly repositories: RepositoryManager,
    private readonly writer: RepositoryWriter,
    private readonly identities: IdentityManager,
    private readonly workflows: WorkflowService,
    private readonly journal: WorkflowJournal,
    private readonly recovery: DiscardService,
  ) {}

  private async commits(root: string, oids: string[]): Promise<ReplayCommit[]> {
    if (!oids.length) return [];

    const result = await this.git.exec(
      ["show", "--no-patch", "--no-walk=unsorted", "-z", "--format=%H%x00%P%x00%s", ...oids, "--"],
      { cwd: root, operation: t("operations.reviewReplayCommits"), maxStdoutBytes: 1024 * 1024 },
    );

    const fields = result.stdout.split("\0");

    if (fields.at(-1) === "") fields.pop();
    if (fields.length !== oids.length * 3)
      throw invalid(errorText("main.replayService.gitReturnedAnIncompleteCommitSelection"));

    return oids.map((oid, index) => {
      if (fields[index * 3] !== oid)
        throw invalid(errorText("main.replayService.gitReturnedADifferentCommitOrderReviewAgain"));

      return {
        oid,
        subject: fields[index * 3 + 2]!,
        parents: fields[index * 3 + 1]!.split(" ").filter(Boolean),
      };
    });
  }

  prepare(
    repositoryId: string,
    kind: ReplayKind,
    action: ReplayAction,
    oids: string[] = [],
    mainline?: number,
  ): Promise<ReplayReview> {
    if (
      !["cherry-pick", "revert"].includes(kind) ||
      !["start", "continue", "skip", "abort"].includes(action)
    )
      throw invalid(errorText("main.replayService.chooseACherryPickOrRevertAction"));

    if (
      !Array.isArray(oids) ||
      oids.length > 100 ||
      new Set(oids).size !== oids.length ||
      (action === "start" && !oids.length)
    )
      throw invalid(errorText("main.replayService.choose1To100DistinctCommitIDsInExecutionOrder"));

    for (const oid of oids) assertFullObjectId(oid, t("operations.reviewReplayCommit"));

    if (mainline !== undefined && (!Number.isInteger(mainline) || mainline < 1 || mainline > 1024))
      throw invalid(errorText("main.replayService.chooseAValidMainlineParentNumber"));

    return this.writer.remoteOperation(
      repositoryId,
      t("main.replayService.review", { kind: kind }),
      async (root, identity) => {
        const status = await this.git.status(root);
        const workflow = await this.workflows.observe(root, status);
        let record = this.journal.activeLocal(root, kind);

        if (action === "start") {
          if (
            workflow ||
            status.changes.length ||
            status.branch.detached ||
            !status.branch.head ||
            !status.branch.oid
          )
            throw invalid(errorText("main.replayService.checkOutACleanExistingBranchAndFinish"));

          record = undefined;
        } else {
          if (workflow?.kind !== kind || !workflow.originalHead)
            throw invalid(
              errorText("main.replayService.noIsAvailableRefreshRepositoryState", { kind: kind }),
            );

          if (!matchesNativeWorkflow(record, workflow)) record = undefined;

          if (record && record.profileId !== identity.id)
            throw invalid(
              errorText(
                "main.replayService.switchToTheProfileThatOwnsThisOperationBeforeContinuingOrAborting",
              ),
            );

          if (action === "continue" && workflow.conflicts.length)
            throw invalid(
              errorText("main.replayService.resolveAndStageEveryConflictBeforeContinuing"),
            );
        }

        const commits = await this.commits(
          root,
          action === "start" ? oids : (record?.incoming ?? workflow?.incoming ?? []),
        );

        if (mainline !== undefined && commits.some((commit) => mainline > commit.parents.length))
          throw invalid(errorText("main.replayService.thatMainlineParentDoesNotExistInEvery"));

        let snapshot: OperationSnapshot | undefined;

        if (action === "abort" || action === "skip") {
          const paths = trackedChangePaths(status.changes);
          if (action === "abort")
            await addRecoveryDiffPaths(this.git, paths, [workflow!.originalHead!], {
              cwd: root,
              operation: t("operations.reviewReplayAbortPaths"),
            });

          snapshot = await this.recovery.prepareOperation(root, identity.id, repositoryId, [
            ...paths,
          ]);

          snapshot.record.source = "replay-recovery";
        }

        const captured = record?.identity ?? identity;

        const review: ReplayReview = {
          token: randomUUID(),
          kind,
          action,
          head: action === "start" ? status.branch.oid! : workflow!.originalHead!,
          branch: status.branch.head ?? null,
          commits,
          ...(mainline !== undefined ? { mainline } : {}),
          author: captured.gitName,
          email: captured.gitEmail,
          paths: snapshot?.record.paths ?? [],
          recoveryBytes: snapshot?.record.bytes ?? 0,
        };

        this.reviews.set(review.token, {
          review,
          root,
          repositoryId,
          identity: captured,
          workflowToken: workflow?.token ?? null,
          fingerprint: await workflowFingerprint(this.git, root, status),
          ...(record ? { record } : {}),
          ...(snapshot ? { snapshot } : {}),
        });

        return review;
      },
    );
  }

  execute(repositoryId: string, token: string): Promise<ReplayResult> {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const pending = this.reviews.get(token);

    if (!pending || !matchesReviewContext(pending, repository))
      throw invalid(
        errorText("main.replayService.thisReplayReviewExpiredOrBelongsToAnotherContextReviewAgain"),
      );

    const { review, identity } = pending;

    if (
      review.action === "start" &&
      review.commits.some((commit) => commit.parents.length > 1) &&
      review.mainline === undefined
    )
      throw invalid(
        errorText("main.replayService.chooseTheMainlineParentBeforeReplayingAMergeCommit"),
      );

    return this.writer.remoteOperation(
      repositoryId,
      `${review.kind} ${review.action}`,
      async (root) => {
        const status = await this.git.status(root);
        const workflow = await this.workflows.observe(root, status);

        if (
          (workflow?.token ?? null) !== pending.workflowToken ||
          (await workflowFingerprint(this.git, root, status)) !== pending.fingerprint
        )
          throw invalid(
            errorText("main.replayService.theOperationOrRepositoryChangedAfterReviewReviewAgain"),
          );

        if (workflow?.ownerProfileId && workflow.ownerProfileId !== identity.id)
          throw invalid(errorText("main.replayService.anotherProfileOwnsThisOperation"));

        if (review.action !== "abort") this.identities.assertOperationIdentity(identity);

        if (pending.snapshot)
          await this.recovery.saveOperation(pending.snapshot.record, pending.snapshot.index);

        const record: WorkflowJournalRecord = pending.record ?? {
          version: 1,
          id: randomUUID(),
          repositoryId,
          profileId: identity.id,
          root,
          identity,
          mode: review.kind,
          head: review.head,
          ...(review.branch ? { branch: review.branch } : {}),
          incoming: review.commits.map((commit) => commit.oid),
          workflowToken: pending.workflowToken ?? "",
          tree: "",
          message: review.kind,
          author: identity.gitName,
          email: identity.gitEmail,
          signing: identity.signing.signCommits,
          state: "prepared",
          updatedAt: new Date().toISOString(),
        };

        record.state = "running";

        if (workflow?.instance && !record.nativeInstance) record.nativeInstance = workflow.instance;

        this.journal.save(record);
        this.reviews.delete(token);

        try {
          const rewriteStart =
            review.action === "abort"
              ? undefined
              : await recordRewriteStart(this.git, this.journal, record);

          const config = {
            ...commitGitConfig(identity),
            "submodule.recurse": "false",
          };

          const result = await this.git.exec(
            [
              ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${value}`]),
              review.kind,
              ...(review.action === "start"
                ? [
                    "--no-edit",
                    ...(review.kind === "cherry-pick" ? ["--allow-empty"] : []),
                    "--no-walk=unsorted",
                    ...(review.mainline !== undefined
                      ? ["--mainline", String(review.mainline)]
                      : []),
                    "--stdin",
                  ]
                : [`--${review.action}`]),
            ],
            {
              cwd: root,
              operation: `${review.kind} ${review.action}`,
              allowedExitCodes: [0, 1],
              ...(review.action === "start"
                ? { stdin: `${review.commits.map((commit) => commit.oid).join("\n")}\n` }
                : {}),
              env: {
                ...(identity.sshKeyPath ? { sshKeyPath: identity.sshKeyPath } : {}),
                overrides: {
                  GIT_EDITOR: "true",
                  GIT_COMMITTER_NAME: identity.gitName,
                  GIT_COMMITTER_EMAIL: identity.gitEmail,
                  ...(review.kind === "revert"
                    ? { GIT_AUTHOR_NAME: identity.gitName, GIT_AUTHOR_EMAIL: identity.gitEmail }
                    : {}),
                },
              },
            },
          );

          const after = await this.git.status(root);
          const remaining = await this.workflows.observe(root, after);

          if (remaining?.instance && !record.nativeInstance)
            record.nativeInstance = remaining.instance;

          record.state = remaining?.kind === review.kind ? "paused" : "completed";

          if (after.branch.oid) record.resultHead = after.branch.oid;

          if (result.exitCode !== 0 && !remaining)
            throw invalid(
              errorText(
                "main.replayService.gitCouldNotCompleteThisActionInspectActivityAndRepositoryState",
              ),
            );

          if (record.state === "completed" && rewriteStart) {
            try {
              await finalizeRewrite(
                this.git,
                this.journal,
                this.recovery,
                record,
                after.branch.oid ?? null,
                rewriteStart,
              );
            } catch (error) {
              record.recoveryWarning = t(
                "main.replayService.completedButAutomaticUndoCouldNotBePreparedUseHistoryRecoveryToInspectTheOriginalCommit",
                {
                  kind: review.kind,
                  head: record.head,
                  value3: errorMessage(
                    error,
                    errorText("main.replayService.recoveryMetadataCouldNotBeSaved"),
                  ),
                },
              );
            }
          }

          return {
            state: remaining ? "needs-attention" : "completed",
            head: after.branch.oid ?? null,
            ...(record.recoveryWarning ? { recoveryWarning: record.recoveryWarning } : {}),
          };
        } finally {
          await this.workflows.finishRewriteJournal(record, review.kind);

          if (pending.snapshot) await this.recovery.finishOperation(pending.snapshot.record);
        }
      },
    );
  }
}
