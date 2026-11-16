import { errorText, type ErrorText } from "@shared/error-codes";
import { t } from "@shared/i18n";
import {
  isPullStrategy,
  type PullPreview,
  type PullRequest,
  type PullStrategy,
} from "@shared/workflows/pull";
import { randomUUID } from "node:crypto";

import { GitError } from "@shared/errors";
import type { GitService } from "../../git/git-service";
import { createPullAutostash } from "../../git/operations/pull-autostash";
import { remoteName } from "../../git/operations/remotes";
import { assertFullObjectId, assertValidRefName } from "../../git/validation";
import type { SettingsRepository } from "../../persistence/settings-repository";
import { PreviewStore } from "../preview-store";
import type { RepositoryManager } from "../lifecycle/repository-manager";
import type { RebaseService } from "../workflows/rebase-service";
import type { WorkflowService } from "../workflows/workflow-service";
import type { RepositoryWriter } from "../working-tree/repository-writer";
import type { RemoteService } from "./remote-service";

const invalid = (message: ErrorText) =>
  new GitError({ kind: "invalid-input", operation: t("operations.pull"), message });

export class PullService {
  private readonly previews = new PreviewStore<{
    preview: PullPreview;
    profileId: string;
    root: string;
    repositoryId: string;
    operationToken: string | null;
    fastForward: boolean;
  }>();

  constructor(
    private readonly git: GitService,
    private readonly repositories: RepositoryManager,
    private readonly writer: RepositoryWriter,
    private readonly remotes: RemoteService,
    private readonly workflows: WorkflowService,
    private readonly rebase: RebaseService,
    private readonly settings: SettingsRepository,
  ) {}

  preference(repositoryId: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    return this.settings.resolve("pullStrategy", {
      profileId: repository.identityId,
      repositoryId,
    });
  }

  setPreference(repositoryId: string, strategy: PullStrategy | null) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const scope = { kind: "repository" as const, profileId: repository.identityId, repositoryId };
    if (strategy === null) this.settings.reset("pullStrategy", scope);
    else this.settings.set("pullStrategy", scope, strategy);
  }

  async prepare(request: PullRequest): Promise<PullPreview> {
    if (!isPullStrategy(request.strategy))
      throw invalid(errorText("main.pullService.chooseAPullStrategy"));

    const repository = this.repositories.resolveActiveRepository(request.repositoryId);
    const fetched = await this.writer.remoteOperation(
      request.repositoryId,
      t("main.pullService.fetchForPull"),
      async (root, identity) => {
        const status = await this.git.status(root);

        if (
          !status.branch.head ||
          !status.branch.oid ||
          status.branch.detached ||
          (await this.workflows.observe(root, status))
        )
          throw invalid(errorText("main.pullService.checkOutAnExistingBranchAndFinishThe"));

        const branch = status.branch.head;
        const tracking = await this.git.exec(
          [
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)",
            `refs/heads/${branch}`,
          ],
          { cwd: root, operation: t("operations.inspectPullUpstream") },
        );

        const [remote, remoteRef, upstream] = tracking.stdout.trim().split("\0");

        if (!remote || remote === "." || !remoteRef?.startsWith("refs/heads/") || !upstream)
          throw invalid(
            errorText("main.pullService.setARemoteBranchAsTheCurrentBranchSUpstreamBeforePulling"),
          );

        remoteName(remote);

        if (!upstream.startsWith("refs/remotes/"))
          throw invalid(
            errorText("main.pullService.pullRequiresAnUpstreamInTheRemoteTrackingNamespace"),
          );

        assertValidRefName(upstream, t("operations.pullTrackingRef"));
        assertValidRefName(remoteRef.slice("refs/heads/".length), t("operations.pullUpstream"));
        await this.remotes.fetchInPlace(
          root,
          identity,
          {
            repositoryId: request.repositoryId,
            remote,
            prune: this.settings.resolve("fetchPrune", {
              profileId: identity.id,
              repositoryId: request.repositoryId,
            }).value,
            tags: this.settings.resolve("fetchTags", {
              profileId: identity.id,
              repositoryId: request.repositoryId,
            }).value,
            ...(request.credentials ? { credentials: request.credentials } : {}),
          },
          `+${remoteRef}:${upstream}`,
        );

        const source = (
          await this.git.exec(["rev-parse", "--verify", upstream], {
            cwd: root,
            operation: t("operations.resolveFetchedUpstream"),
          })
        ).stdout.trim();

        assertFullObjectId(source, t("operations.fetchedUpstream"));

        const counts = (
          await this.git.exec(
            ["rev-list", "--left-right", "--count", `${status.branch.oid}...${source}`],
            { cwd: root, operation: t("operations.inspectPullDivergence") },
          )
        ).stdout
          .trim()
          .split(/\s+/)
          .map(Number);

        return {
          branch,
          upstream,
          head: status.branch.oid,
          source,
          ahead: counts[0]!,
          behind: counts[1]!,
        };
      },
    );

    const current = this.repositories.resolveActiveRepository(request.repositoryId);

    if (current.identityId !== repository.identityId || current.path !== repository.path)
      throw invalid(
        errorText(
          "main.pullService.theProfileChangedDuringFetchReviewPullAgainInItsOriginalProfile",
        ),
      );

    const blockedReason =
      request.strategy === "ff-only" && fetched.ahead > 0 && fetched.behind > 0
        ? t("main.pullService.theBranchesHaveDivergedFastForwardOnlyCannot")
        : null;
    const fastForward = fetched.ahead === 0 || fetched.behind === 0;
    const operation =
      blockedReason || fastForward
        ? null
        : request.strategy === "rebase"
          ? await this.rebase.prepare(request.repositoryId, "start", fetched.source, false, true)
          : await this.workflows.prepareStart(
              request.repositoryId,
              fetched.source,
              request.strategy,
              true,
            );

    if (operation && (operation.head !== fetched.head || operation.branch !== fetched.branch))
      throw invalid(errorText("main.pullService.theBranchChangedDuringFetchReviewPullAgain"));

    const preview: PullPreview = {
      ...fetched,
      token: randomUUID(),
      strategy: request.strategy,
      ...(blockedReason ? { blockedReason } : {}),
    };

    this.previews.set(preview.token, {
      preview,
      profileId: repository.identityId,
      root: repository.path,
      repositoryId: request.repositoryId,
      operationToken: operation?.token ?? null,
      fastForward,
    });

    return preview;
  }

  execute(repositoryId: string, token: string): Promise<string> {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const pending = this.previews.get(token);

    if (
      !pending ||
      pending.repositoryId !== repositoryId ||
      pending.profileId !== repository.identityId ||
      pending.root !== repository.path
    )
      throw invalid(
        errorText(
          "main.pullService.thePullReviewExpiredOrBelongsToAnotherContextFetchAndReviewAgain",
        ),
      );

    this.previews.delete(token);

    if (pending.fastForward)
      return this.writer.remoteOperation(
        repositoryId,
        t("operationTitles.pull"),
        async (root, identity) => {
          const status = await this.git.status(root);
          if (
            status.branch.oid !== pending.preview.head ||
            status.branch.head !== pending.preview.branch ||
            status.branch.detached ||
            (await this.workflows.observe(root, status))
          )
            throw invalid(
              errorText("main.pullService.theBranchOrGitOperationChangedDuringPullTryAgain"),
            );

          if (pending.preview.behind === 0) return t("main.pullService.alreadyUpToDate");
          const stash = status.changes.length
            ? await createPullAutostash(this.git, root, identity)
            : undefined;
          try {
            await this.git.exec(
              [
                "-c",
                "merge.autoStash=false",
                "-c",
                "submodule.recurse=false",
                "merge",
                "--ff-only",
                "--no-edit",
                pending.preview.source,
              ],
              { cwd: root, operation: t("operations.pull") },
            );
            return t("main.pullService.pullCompleted");
          } finally {
            if (stash)
              await this.workflows.restorePullAutostashInPlace(root, repositoryId, identity, stash);
          }
        },
      );

    if (!pending.operationToken)
      throw invalid(
        errorText("errors.operationBlocked", {
          reason:
            pending.preview.blockedReason ??
            t("main.pullService.reviewThisPullAgainBeforeApplying"),
        }),
      );

    if (pending.preview.strategy === "rebase")
      return this.rebase
        .execute(repositoryId, pending.operationToken)
        .then((result) =>
          result.state === "completed"
            ? t("main.pullService.pullCompleted")
            : t("main.pullService.pullPausedResolveConflictsThenContinueOrAbortTheRebase"),
        );

    return this.workflows
      .startMerge(repositoryId, pending.operationToken)
      .then((result) =>
        result.state === "completed"
          ? t("main.pullService.pullCompleted")
          : result.state === "conflicted"
            ? t("main.pullService.pullPausedResolveConflictsThenContinueOrAbortTheMerge")
            : t("main.pullService.fetchedChangesMergedReviewAndCompleteTheMergeCommitOrAbortIt"),
      );
  }
}
