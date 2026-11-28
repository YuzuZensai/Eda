import { hasSpecialIndexFlags } from "../../git/parsers/status-parser";
import { isFullObjectId } from "@shared/repository/object-id";
import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { Identity } from "@shared/identity/identity";
import type { ResetMode, ResetResult, ResetReview } from "@shared/workflows/reset";
import { createHash, randomUUID } from "node:crypto";
import type { GitService } from "../../git/git-service";
import { assertFullObjectId } from "../../git/validation";
import type { WorkflowJournal, WorkflowJournalRecord } from "../../persistence/workflow-journal";
import { matchesReviewContext, PreviewStore } from "../preview-store";
import { pruneHistoryRecords } from "../history/history-retention";
import { publishedRangeCount } from "../history/shared-history";
import { repositoryCommonDirectory } from "../lifecycle/repository-location";
import type { RepositoryManager } from "../lifecycle/repository-manager";
import type { DiscardService, OperationSnapshot } from "../working-tree/discard-service";
import type { RepositoryWriter } from "../working-tree/repository-writer";
import { trackedChangePaths } from "./recovery-paths";
import {
  fingerprintContents,
  readWorkflowContents,
  workflowFingerprint,
} from "./workflow-fingerprint";
import type { WorkflowService } from "./workflow-service";

const invalid = (message: ErrorText) =>
  new GitError({ kind: "invalid-input", operation: t("operations.reset"), message });

export async function protectResetPaths(
  git: GitService,
  root: string,
  target: string,
  paths: string[],
) {
  if (!paths.length) return;

  const targetFiles = await git.exec(
    ["--literal-pathspecs", "ls-tree", "-r", "-z", target, "--", ...paths],
    { cwd: root, operation: t("operations.reviewResetTargetPaths") },
  );
  const targets: string[] = [];

  for (const row of targetFiles.stdout.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob (\S+)\t([\s\S]+)$/.exec(row);
    if (!match || !isFullObjectId(match[2]))
      throw invalid(
        errorText("main.resetService.hardResetRecoveryCurrentlySupportsRegularFilesResolve"),
      );
    targets.push(match[3]!);
  }

  const others = await git.exec(["ls-files", "--others", "-z"], {
    cwd: root,
    operation: t("operations.protectUntrackedAndIgnoredResetPaths"),
  });
  const ignoreCase = await git.exec(["config", "--bool", "--get", "core.ignorecase"], {
    cwd: root,
    operation: t("operations.inspectResetPathMatching"),
    allowedExitCodes: [0, 1],
  });
  const insensitive = process.platform === "win32" || ignoreCase.stdout.trim() === "true";
  const normalized = (path: string) => {
    const value = path.replace(/\/$/, "");
    return insensitive ? value.toLowerCase() : value;
  };
  const names = targets.map(normalized);
  const blocked = others.stdout
    .split("\0")
    .filter(Boolean)
    .filter((path) => {
      const name = normalized(path);

      return names.some(
        (targetPath) =>
          targetPath === name ||
          targetPath.startsWith(`${name}/`) ||
          name.startsWith(`${targetPath}/`),
      );
    });

  if (blocked.length)
    throw invalid(
      errorText("main.resetService.untrackedOrIgnoredContentBlocksThisResetMove", {
        value1: blocked.slice(0, 5).join(", "),
      }),
    );
}

export class ResetService {
  private readonly reviews = new PreviewStore<{
    review: ResetReview;
    root: string;
    repositoryId: string;
    identity: Identity;
    fingerprint: string;
    snapshot?: OperationSnapshot;
  }>();

  constructor(
    private readonly git: GitService,
    private readonly repositories: RepositoryManager,
    private readonly writer: RepositoryWriter,
    private readonly workflows: WorkflowService,
    private readonly journal: WorkflowJournal,
    private readonly recovery: DiscardService,
  ) {}

  private async inspect(root: string, target: string, mode: ResetMode) {
    const status = await this.git.status(root);

    if (
      !status.branch.oid ||
      (await this.workflows.observe(root, status)) ||
      status.changes.some((item) => item.kind === "unmerged")
    )
      throw invalid(errorText("main.resetService.finishTheCurrentOperationAndUseARepository"));

    const resolved = await this.git.exec(["rev-parse", "--verify", `${target}^{commit}`], {
      cwd: root,
      operation: t("operations.validateResetTarget"),
    });

    if (resolved.stdout.trim() !== target)
      throw invalid(errorText("main.resetService.selectACommitObjectAsTheResetTarget"));

    const flags = await this.git.exec(["ls-files", "-v", "-z"], {
      cwd: root,
      operation: t("operations.reviewResetIndexFlags"),
    });

    if (mode === "hard" && flags.stdout.split("\0").some((line) => /^[a-zS] /.test(line)))
      throw invalid(
        errorText("main.resetService.hardResetReviewRequiresOrdinaryTrackedFilesDisable"),
      );

    const changedIndex =
      mode === "soft"
        ? ""
        : (
            await this.git.exec(
              [
                "diff",
                "--cached",
                "--name-only",
                "-z",
                "--no-renames",
                "--no-ext-diff",
                "--no-textconv",
                target,
                "--",
              ],
              { cwd: root, operation: t("operations.reviewResetIndexEffects") },
            )
          ).stdout;

    const indexPaths = changedIndex.split("\0").filter(Boolean);
    const workingPaths =
      mode === "hard" ? [...new Set([...indexPaths, ...trackedChangePaths(status.changes)])] : [];

    if (Math.max(indexPaths.length, workingPaths.length) > 256)
      throw invalid(
        errorText("main.resetService.thisResetExceedsThe256PathRecoveryLimitNoFilesWereChanged"),
      );
    if (mode === "hard" && workingPaths.length)
      await protectResetPaths(this.git, root, target, workingPaths);

    const contents = await readWorkflowContents(this.git, root);

    return {
      status,
      flags: flags.stdout,
      indexPaths,
      workingPaths,
      working: createHash("sha256").update(contents.working).digest("hex"),
      fingerprint: `${fingerprintContents(status, contents)}:${flags.stdout}`,
    };
  }

  prepare(repositoryId: string, target: string, mode: ResetMode): Promise<ResetReview> {
    assertFullObjectId(target, t("operations.reviewResetTarget"));

    if (!["soft", "mixed", "hard"].includes(mode))
      throw invalid(errorText("main.resetService.chooseSoftMixedOrHardReset"));

    return this.writer.remoteOperation(
      repositoryId,
      t("main.resetService.reviewReset"),
      async (root, identity) => {
        const state = await this.inspect(root, target, mode);
        const paths = mode === "hard" ? state.workingPaths : state.indexPaths;
        const snapshot =
          mode === "soft" || !paths.length
            ? undefined
            : await this.recovery.prepareOperation(root, identity.id, repositoryId, paths, {
                working: mode === "hard",
              });

        if (snapshot) snapshot.record.source = "reset-recovery";

        const review: ResetReview = {
          token: randomUUID(),
          mode,
          target,
          head: state.status.branch.oid!,
          branch: state.status.branch.detached ? null : (state.status.branch.head ?? null),
          indexPaths: state.indexPaths,
          workingPaths: state.workingPaths,
          recoveryBytes: snapshot?.record.bytes ?? 0,
          publishedCommits: await publishedRangeCount(
            this.git,
            root,
            state.status.branch.oid!,
            target,
          ),
        };

        this.reviews.set(review.token, {
          review,
          root,
          repositoryId,
          identity,
          fingerprint: state.fingerprint,
          ...(snapshot ? { snapshot } : {}),
        });

        return review;
      },
    );
  }

  execute(repositoryId: string, token: string): Promise<ResetResult> {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const pending = this.reviews.get(token);

    if (!pending || !matchesReviewContext(pending, repository))
      throw invalid(
        errorText("main.resetService.thisResetReviewExpiredOrBelongsToAnotherContextReviewAgain"),
      );

    return this.writer.remoteOperation(
      repositoryId,
      t("main.resetService.reset", { mode: pending.review.mode }),
      async (root) => {
        const { review, identity } = pending;
        const current = await this.inspect(root, review.target, review.mode);

        if (current.fingerprint !== pending.fingerprint)
          throw invalid(
            errorText("main.resetService.theRepositoryChangedAfterReviewReviewTheResetAgain"),
          );

        if (
          (await publishedRangeCount(this.git, root, review.head, review.target)) !==
          review.publishedCommits
        )
          throw invalid(
            errorText(
              "main.resetService.remoteTrackingHistoryChangedAfterReviewReviewTheResetAgain",
            ),
          );

        const commonDirectory = await repositoryCommonDirectory(this.git, root);

        await pruneHistoryRecords(this.git, this.journal, root, commonDirectory);

        let intentToAdd = false;

        if (review.mode !== "soft") {
          const lists = await Promise.all(
            ["visible", "invisible"].map((visibility) =>
              this.git.exec(
                [
                  "diff",
                  "--cached",
                  "--name-only",
                  "-z",
                  `--ita-${visibility}-in-index`,
                  "--no-ext-diff",
                  "--no-textconv",
                  "--",
                ],
                { cwd: root, operation: t("operations.reviewResetIndexIntent") },
              ),
            ),
          );

          intentToAdd = lists[0]!.stdout !== lists[1]!.stdout;
        }

        if (pending.snapshot)
          await this.recovery.saveOperation(pending.snapshot.record, pending.snapshot.index);

        const indexTree = (
          await this.git.exec(["write-tree"], {
            cwd: root,
            operation: t("operations.preserveResetIndexTree"),
          })
        ).stdout.trim();

        assertFullObjectId(indexTree, t("operations.preserveResetIndex"));

        const id = randomUUID();
        const recoveryRef = `refs/eda/recovery/${id}`;
        const record: WorkflowJournalRecord = {
          version: 1,
          id,
          repositoryId,
          profileId: identity.id,
          root,
          identity,
          mode: "reset",
          publishedCommits: review.publishedCommits,
          head: review.head,
          ...(review.branch ? { branch: review.branch } : {}),
          incoming: [review.target],
          workflowToken: pending.fingerprint,
          tree: indexTree,
          message: t("main.resetService.reset", { mode: review.mode }),
          author: identity.gitName,
          email: identity.gitEmail,
          signing: false,
          state: "prepared",
          updatedAt: new Date().toISOString(),
          refChange: {
            commonDirectory,
            mode: review.mode,
            target: review.target,
            indexTree,
            recoveryRef,
            beforeFlags: current.flags,
            beforeWorking: current.working,
            beforeFingerprint: pending.fingerprint.split(":")[0]!,
            ...(pending.snapshot ? { snapshotId: pending.snapshot.record.id } : {}),
          },
        };

        this.journal.save(record);
        await this.git.exec(["update-ref", "--stdin"], {
          cwd: root,
          operation: t("operations.preserveResetRecoveryRefs"),
          stdin: `start
create ${recoveryRef}/head ${review.head}
create ${recoveryRef}/index ${indexTree}
prepare
commit
`,
        });
        this.reviews.delete(token);
        record.state = "running";
        this.journal.save(record);

        try {
          await this.git.exec(
            [
              "-c",
              "submodule.recurse=false",
              "reset",
              `--${review.mode}`,
              "--no-recurse-submodules",
              review.target,
            ],
            { cwd: root, operation: t("operations.resetLabel", { mode: review.mode }) },
          );

          const after = await this.git.status(root);

          if (after.branch.oid !== review.target)
            throw invalid(
              errorText("main.resetService.headChangedWhileResettingRecoverySnapshotsWere"),
            );

          record.refChange!.afterHead = after.branch.oid;
          record.refChange!.afterFingerprint = await workflowFingerprint(this.git, root, after);

          const afterIndexTree = (
            await this.git.exec(["write-tree"], {
              cwd: root,
              operation: t("operations.preserveResetResultIndex"),
            })
          ).stdout.trim();

          const afterFlags = (
            await this.git.exec(["ls-files", "-v", "-z"], {
              cwd: root,
              operation: t("operations.preserveResetResultIndexFlags"),
            })
          ).stdout;

          await this.git.exec(["update-ref", "--stdin"], {
            cwd: root,
            operation: t("operations.preserveResetRedoRefs"),
            stdin: `create ${recoveryRef}/after-head ${after.branch.oid}
create ${recoveryRef}/after-index ${afterIndexTree}
`,
          });
          record.refChange!.reversal = {
            state: "applied",
            expectedFingerprint: record.refChange!.afterFingerprint,
            afterIndexTree,
            beforeFlags: current.flags,
            afterFlags,
            ...(review.mode !== "soft" && (intentToAdd || hasSpecialIndexFlags(current.flags))
              ? {
                  blockedReason: t("main.resetService.theOriginalIndexHasSpecialFlagsUseSaved"),
                }
              : {}),
          };
          record.state = "completed";

          return {
            head: after.branch.oid!,
            recoveryRef: `${recoveryRef}/head`,
            publishedCommits: review.publishedCommits,
            ...(pending.snapshot ? { snapshotId: pending.snapshot.record.id } : {}),
          };
        } finally {
          record.updatedAt = new Date().toISOString();
          this.journal.save(record);
          if (pending.snapshot) await this.recovery.finishOperation(pending.snapshot.record);
        }
      },
    );
  }
}
