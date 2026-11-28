import { readActiveRepository, assertRepositoryContext } from "../lifecycle/repository-context";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t, type MessageKey } from "@shared/i18n";
import type { Identity } from "@shared/identity/identity";
import { commitConfigKeys, type CommitConfigGroup } from "@shared/identity/profile-session";
import type { IgnoreKind } from "@shared/repository/ignore";
import type { PartialStagePreview, PartialStageRequest } from "@shared/repository/partial-stage";
import type {
  BranchSummary,
  CommitPreview,
  CommitResult,
  TagSummary,
} from "@shared/repository/repository-write";
import { lstat, writeFile } from "node:fs/promises";
import { workingFilePath } from "../../filesystem/working-file-path";
import { basename } from "node:path";
import { withLocalConfiguration } from "../../git/configuration/local-configuration";
import { commitGitConfig } from "@shared/identity/identity";
import { readWorkflowState } from "../../git/operations/workflow-state";
import { changeWorktree } from "../../git/operations/worktrees";
import { readFlow, runFlow } from "../../git/operations/gitflow";
import type { FlowAction } from "@shared/workflows/gitflow";
import { changeSubmodule } from "../../git/operations/submodules";
import type { WorktreeAction, SubmoduleAction } from "@shared/repository/repository-write";
import { assertFullObjectId, assertRepositoryPath } from "../../git/validation";
import type { GitService } from "../../git/git-service";
import type { IdentityManager } from "../../identity/identity-manager";
import type { OperationManager } from "../../operations/operation-manager";
import type { ContentRecoveryRepository } from "../../persistence/content-recovery-repository";
import type { IdentityRepository } from "../../persistence/identity-repository";
import type { WorkflowJournal } from "../../persistence/workflow-journal";
import { CommitHistory } from "../history/commit-history";
import { RefHistory } from "../history/ref-history";
import { repositoryCapabilities } from "../lifecycle/repository-capabilities";
import { repositoryCommonDirectory } from "../lifecycle/repository-location";
import type { RepositoryManager } from "../lifecycle/repository-manager";
import { DiscardService } from "./discard-service";
import { IgnoreService } from "./ignore-service";
import { PartialStageService } from "./partial-stage-service";
import { WriteQueue } from "../../operations/write-queue";

import type { SignerService } from "../history/signer-service";

export class RepositoryWriter {
  remoteOperation<T>(
    repositoryId: string,
    kind: string,
    work: (path: string, identity: Identity) => Promise<T>,
    kindKey?: MessageKey,
  ): Promise<T> {
    const captured = this.requireActiveIdentity(repositoryId);
    return this.write(repositoryId, (path) => work(path, captured), kind, undefined, true, kindKey);
  }

  private readonly queue = new WriteQueue();
  private readonly partial: PartialStageService;
  private readonly ignore: IgnoreService;
  private readonly discard?: DiscardService;
  private readonly commitHistory?: CommitHistory;
  private readonly refHistory?: RefHistory;

  constructor(
    private readonly git: GitService,
    private readonly repositories: RepositoryManager,
    private readonly identity: IdentityManager,
    private readonly identities: IdentityRepository,
    private readonly operations?: OperationManager,
    recovery?: ContentRecoveryRepository,
    journal?: WorkflowJournal,
    private readonly signers?: Pick<SignerService, "decorate">,
  ) {
    this.partial = new PartialStageService(git);
    this.ignore = new IgnoreService(git);

    if (recovery) this.discard = new DiscardService(git, recovery);

    if (journal) {
      this.commitHistory = new CommitHistory(git, journal);
      this.refHistory = new RefHistory(git, journal);
    }
  }

  private recoveryService(): DiscardService {
    if (!this.discard)
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.discardChanges"),
        message: errorText("main.repositoryWriter.recoveryStorageIsUnavailableNoFilesWereChanged"),
      });

    return this.discard;
  }

  changeWorkingFile(id: string, path: string, trash?: (path: string) => Promise<void>) {
    const operation = t("workingFile.title");
    return this.write(
      id,
      async (root) => {
        const target = await workingFilePath(root, path, operation);
        if (trash) {
          if (!(await lstat(target)).isFile())
            throw new GitError({
              kind: "invalid-input",
              operation,
              message: errorText("workingFile.invalid"),
            });
          await trash(target);
        } else await writeFile(target, "", { flag: "wx" });
      },
      operation,
    );
  }

  changeSubmodule(id: string, action: SubmoduleAction) {
    return this.remoteOperation(id, t("submodules.manage"), (cwd, identity) =>
      changeSubmodule(this.git, cwd, identity, action),
    );
  }

  flowState(id: string) {
    const repo = this.repositories.resolveActiveRepository(id);
    return readFlow(this.git, repo.path, repo.identityId);
  }
  gitflow(id: string, action: FlowAction) {
    return this.remoteOperation(id, t("flow.title"), (cwd, identity) =>
      runFlow(this.git, cwd, identity, action),
    );
  }
  changeWorktree(id: string, action: WorktreeAction) {
    return this.write(id, (cwd) => changeWorktree(this.git, cwd, action), t("worktrees.title"));
  }

  restoreRevision(
    repositoryId: string,
    oid: string,
    paths: string[],
    destination: "index" | "worktree" | "both",
  ) {
    const operation = t("revision.restore");
    assertFullObjectId(oid, operation);
    const invalid = () =>
      new GitError({ kind: "invalid-input", operation, message: errorText("revision.selectFile") });
    if (!paths.length || paths.length > 100) throw invalid();
    for (const path of paths) assertRepositoryPath(path, operation);
    return this.write(
      repositoryId,
      async (cwd) => {
        const options = { cwd, operation };
        const policy = await this.git.trust?.checked(cwd, undefined, oid);
        if (policy?.execution?.blocksWrites && !policy.trusted)
          throw new GitError({
            kind: "invalid-input",
            operation,
            message: errorText("main.repositoryTrust.writesBlocked"),
          });
        const entries = await this.git.exec(
          [
            "--literal-pathspecs",
            "ls-tree",
            "-z",
            "--full-tree",
            oid + "^{commit}",
            "--",
            ...paths,
          ],
          options,
        );
        const files = new Set(
          entries.stdout.split("\0").flatMap((entry) => {
            const match = /^\d+ blob [0-9a-f]+\t([\s\S]+)$/.exec(entry);
            return match ? [match[1]] : [];
          }),
        );
        if (paths.some((path) => !files.has(path))) throw invalid();
        await this.git.exec(
          [
            "--literal-pathspecs",
            "restore",
            "--source=" + oid,
            ...(destination !== "worktree" ? ["--staged"] : []),
            ...(destination !== "index" ? ["--worktree"] : []),
            "--",
            ...paths,
          ],
          options,
        );
      },
      operation,
    );
  }

  mailbox(
    id: string,
    request: { bytes: Uint8Array } | { action: "continue" | "abort"; token: string },
  ) {
    const operation = t("mailbox.apply");
    return this.remoteOperation(id, operation, async (cwd, identity) => {
      const status = await this.git.status(cwd);
      const state = await readWorkflowState(this.git, cwd, status);
      const start = "bytes" in request;
      if (
        start
          ? state || status.changes.length
          : state?.kind !== "am" || state.token !== request.token
      )
        throw new GitError({
          kind: "invalid-input",
          operation,
          message: errorText("mailbox.invalid"),
        });
      const config = Object.entries(commitGitConfig(identity)).flatMap(([key, value]) => [
        "-c",
        key + "=" + value,
      ]);
      await this.git.exec(
        [
          ...config,
          "am",
          ...(start ? ["--3way", "--patch-format=mbox", "-"] : ["--" + request.action]),
        ],
        {
          cwd,
          operation,
          ...(start && { stdin: request.bytes }),
          env: {
            ...(identity.sshKeyPath && { sshKeyPath: identity.sshKeyPath }),
            overrides: {
              GIT_EDITOR: "true",
              GIT_COMMITTER_NAME: identity.gitName,
              GIT_COMMITTER_EMAIL: identity.gitEmail,
            },
          },
        },
      );
    });
  }

  applyPatch(repositoryId: string, patch: Uint8Array) {
    const operation = t("patch.apply");
    return this.write(
      repositoryId,
      async (cwd) => {
        const options = { cwd, operation, stdin: patch, maxStderrBytes: 64 * 1024 };
        const check = await this.git.exec(["apply", "--check", "--whitespace=nowarn", "-"], {
          ...options,
          allowedExitCodes: [0, 1, 128],
        });
        if (check.exitCode !== 0)
          throw new GitError({
            kind: "invalid-input",
            operation,
            message: errorText("patch.rejected", { reason: check.stderr.trim().slice(0, 2048) }),
          });
        await this.git.exec(["apply", "--whitespace=nowarn", "-"], options);
      },
      operation,
    );
  }

  previewDiscard(repositoryId: string, paths: string[]) {
    return readActiveRepository(this.repositories, repositoryId, (root, profileId) =>
      this.recoveryService().preview(root, profileId, repositoryId, paths),
    );
  }

  previewDiscardPartial(request: PartialStageRequest) {
    return readActiveRepository(this.repositories, request.repositoryId, (root, profileId) =>
      this.recoveryService().previewPartial(root, profileId, request),
    );
  }

  applyDiscard(repositoryId: string, token: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    return this.write(
      repositoryId,
      (root) => this.recoveryService().apply(root, repository.identityId, repositoryId, token),
      t("main.repositoryWriter.discardWorktreeChanges"),
    );
  }

  listRecovery(repositoryId: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    return this.recoveryService().list(repository.identityId, repositoryId);
  }

  forgetRecovery(repositoryId: string, id: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);

    return this.write(
      repositoryId,
      async () => this.recoveryService().forget(repository.identityId, repositoryId, id),
      t("main.repositoryWriter.removeRecoverySnapshot"),
      undefined,
      false,
    );
  }

  savedRecoveryFile(repositoryId: string, id: string, path: string, stage?: number) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    return this.recoveryService().savedFile(repository.identityId, repositoryId, id, path, stage);
  }

  restoreContent(repositoryId: string, id: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    return this.write(
      repositoryId,
      (root) => this.recoveryService().restore(root, repository.identityId, repositoryId, id),
      t("main.repositoryWriter.restoreDiscardedFiles"),
    );
  }

  inspectIgnore(repositoryId: string, path: string, kind: IgnoreKind) {
    return readActiveRepository(this.repositories, repositoryId, (root) =>
      this.ignore.inspect(root, path, kind),
    );
  }

  addIgnore(repositoryId: string, path: string, kind: IgnoreKind) {
    return this.write(
      repositoryId,
      (root) => this.ignore.add(root, path, kind),
      t("main.repositoryWriter.addIgnoreRule"),
    );
  }

  stopTracking(repositoryId: string, path: string) {
    return this.write(
      repositoryId,
      (root) => this.ignore.stopTracking(root, path),
      t("main.repositoryWriter.stopTrackingFile"),
    );
  }

  previewPartial(request: PartialStageRequest): Promise<PartialStagePreview> {
    return readActiveRepository(this.repositories, request.repositoryId, (root, profileId) =>
      this.partial.preview(root, profileId, request),
    );
  }

  applyPartial(repositoryId: string, token: string): Promise<void> {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    return this.write(
      repositoryId,
      (path) => this.partial.apply(path, repository.identityId, repositoryId, token),
      t("main.repositoryWriter.applySelectedChanges"),
    );
  }

  stage(repositoryId: string, paths?: readonly string[]): Promise<void> {
    return this.write(
      repositoryId,
      (path) => (paths && paths.length > 0 ? this.git.stage(path, paths) : this.git.stageAll(path)),
      t("main.repositoryWriter.stageChanges"),
      () => this.stage(repositoryId, paths),
    );
  }

  unstage(repositoryId: string, paths?: readonly string[]): Promise<void> {
    return this.write(
      repositoryId,
      (path) =>
        paths && paths.length > 0 ? this.git.unstage(path, paths) : this.git.unstageAll(path),
      t("main.repositoryWriter.unstageChanges"),
      () => this.unstage(repositoryId, paths),
    );
  }

  async previewCommit(repositoryId: string): Promise<CommitPreview> {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const expected = this.requireActiveIdentity(repositoryId);
    const [check, stats, head] = await Promise.all([
      this.identity.verifyEffectiveIdentity(repository.path, expected),
      this.git.exec(
        ["diff", "--cached", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"],
        {
          cwd: repository.path,
          operation: t("operations.previewStagedTotals"),
          maxStdoutBytes: 4 * 1024 * 1024,
        },
      ),
      this.git.exec(["rev-parse", "--verify", "--quiet", "HEAD"], {
        cwd: repository.path,
        operation: t("operations.previewCommitAncestry"),
        allowedExitCodes: [0, 1],
      }),
    ]);

    let additions = 0,
      deletions = 0,
      binaryFiles = 0;

    for (const row of stats.stdout.split("\0").filter(Boolean)) {
      const [added, removed] = row.split("\t");
      if (added === "-" || removed === "-") binaryFiles++;
      else {
        additions += Number(added) || 0;
        deletions += Number(removed) || 0;
      }
    }

    const refs =
      head.exitCode === 0
        ? await this.git.exec(
            [
              "for-each-ref",
              `--contains=${head.stdout.trim()}`,
              "--format=%(refname:short)",
              "refs/remotes",
            ],
            {
              cwd: repository.path,
              operation: t("operations.inspectSharedHead"),
              maxStdoutBytes: 1024 * 1024,
            },
          )
        : null;

    assertRepositoryContext(this.repositories, repository, t("operations.commit"));

    return {
      author: { name: expected.gitName, email: expected.gitEmail },
      matchesProfile: check.matches,
      signingEnabled: expected.signing.signCommits,
      signing: expected.signing.signCommits
        ? `${expected.signing.format.toUpperCase()}, ${expected.signing.keyRef ?? t("main.repositoryWriter.defaultKey")}`
        : t("main.repositoryWriter.unsigned"),
      additions,
      deletions,
      binaryFiles,
      sharedRefs: refs?.stdout.trim().split("\n").filter(Boolean) ?? [],
    };
  }

  commit(
    repositoryId: string,
    message: string,
    options: { amend?: boolean; skipCommitHooks?: boolean; signOff?: boolean } = {},
  ): Promise<CommitResult> {
    const expected = this.requireActiveIdentity(repositoryId);
    return this.write(
      repositoryId,
      (path) => this.commitInPlace(path, repositoryId, message, options, expected),
      options.amend ? t("main.repositoryWriter.amendCommit") : t("operationTitles.commit"),
    );
  }

  private async commitInPlace(
    path: string,
    repositoryId: string,
    message: string,
    options: { amend?: boolean; skipCommitHooks?: boolean; signOff?: boolean },
    expected: Identity,
  ): Promise<CommitResult> {
    this.identity.assertOperationIdentity(expected);

    const commit = () => this.git.commit(path, message, options, expected);

    return this.commitHistory
      ? this.commitHistory.run(path, repositoryId, expected, options.amend ?? false, commit)
      : { oid: await commit() };
  }

  stageAndCommit(
    repositoryId: string,
    paths: readonly string[] | undefined,
    message: string,
    options: { amend?: boolean; skipCommitHooks?: boolean; signOff?: boolean } = {},
  ): Promise<CommitResult> {
    const expected = this.requireActiveIdentity(repositoryId);
    return this.write(repositoryId, async (path) => {
      if (paths && paths.length > 0) await this.git.stage(path, paths);
      else await this.git.stageAll(path);
      return this.commitInPlace(path, repositoryId, message, options, expected);
    });
  }

  createBranch(
    repositoryId: string,
    name: string,
    options: { checkout?: boolean; startPoint?: string } = {},
  ): Promise<void> {
    const expected = this.requireActiveIdentity(repositoryId);

    return this.write(
      repositoryId,
      async (path) => {
        const before = await this.git.status(path);
        const tip = options.startPoint ?? before.branch.oid;
        const create = () => this.git.createBranch(path, name, options);

        if (!this.refHistory || !tip) return create();

        await this.refHistory.run(
          path,
          repositoryId,
          expected,
          { kind: "branch-create", name, tip, checkedOut: !!options.checkout },
          create,
        );
      },
      t("main.repositoryWriter.createBranch"),
    );
  }

  checkoutBranch(repositoryId: string, name: string, remote = false): Promise<void> {
    const expected = this.requireActiveIdentity(repositoryId);

    return this.write(
      repositoryId,
      async (path) => {
        if (!remote && !this.refHistory) return this.git.checkoutBranch(path, name);

        const ref = `refs/${remote ? "remotes" : "heads"}/${name}`;
        const tip = (
          await this.git.exec(["show-ref", "--verify", "--hash", ref], {
            cwd: path,
            operation: t("operations.reviewCheckoutBranch"),
          })
        ).stdout.trim();
        const checkout = () =>
          this.git.checkoutBranch(path, remote ? tip : name, { detach: remote });

        if (!this.refHistory) return checkout();

        await this.refHistory.run(
          path,
          repositoryId,
          expected,
          { kind: "checkout", name: remote ? null : name, tip },
          checkout,
        );
      },
      t("main.repositoryWriter.checkoutBranch"),
    );
  }

  deleteBranch(
    repositoryId: string,
    name: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const expected = this.requireActiveIdentity(repositoryId);

    return this.write(
      repositoryId,
      async (path) => {
        const remove = () => this.git.deleteBranch(path, name, options);

        if (!this.refHistory) return remove();

        const tip = (
          await this.git.exec(["rev-parse", "--verify", `refs/heads/${name}`], {
            cwd: path,
            operation: t("operations.reviewDeletedBranch"),
          })
        ).stdout.trim();

        await this.refHistory.run(
          path,
          repositoryId,
          expected,
          { kind: "branch-delete", name, tip },
          remove,
        );
      },
      t("main.repositoryWriter.deleteBranch"),
    );
  }

  renameBranch(repositoryId: string, from: string, to: string): Promise<void> {
    const expected = this.requireActiveIdentity(repositoryId);

    return this.write(
      repositoryId,
      async (path) => {
        const rename = () => this.git.renameBranch(path, from, to);

        if (!this.refHistory) return rename();

        const tip = (
          await this.git.exec(["rev-parse", "--verify", `refs/heads/${from}`], {
            cwd: path,
            operation: t("operations.reviewRenamedBranch"),
          })
        ).stdout.trim();

        await this.refHistory.run(
          path,
          repositoryId,
          expected,
          { kind: "branch-rename", from, to, tip },
          rename,
        );
      },
      t("main.repositoryWriter.renameBranch"),
    );
  }

  listBranches(repositoryId: string): Promise<BranchSummary[]> {
    return readActiveRepository(
      this.repositories,
      repositoryId,
      (path) => this.git.listBranches(path),
      t("operations.listBranches"),
    );
  }

  createTag(
    repositoryId: string,
    name: string,
    options: { message?: string; target?: string; sign?: boolean } = {},
  ): Promise<void> {
    const expected = this.requireActiveIdentity(repositoryId);

    return this.write(repositoryId, async (path) => {
      return this.git.createTag(path, name, options, expected);
    });
  }

  deleteTag(repositoryId: string, name: string): Promise<void> {
    return this.write(
      repositoryId,
      (path) => this.git.deleteTag(path, name),
      t("main.repositoryWriter.deleteTag"),
    );
  }

  checkoutTag(repositoryId: string, name: string): Promise<void> {
    const expected = this.requireActiveIdentity(repositoryId);

    return this.write(
      repositoryId,
      async (path) => {
        const checkout = () => this.git.checkoutTag(path, name);

        if (!this.refHistory) return checkout();

        const tip = (
          await this.git.exec(["rev-parse", "--verify", `refs/tags/${name}^{commit}`], {
            cwd: path,
            operation: t("operations.reviewCheckoutTag"),
          })
        ).stdout.trim();

        await this.refHistory.run(
          path,
          repositoryId,
          expected,
          { kind: "checkout", name: null, tip },
          checkout,
        );
      },
      t("main.repositoryWriter.checkoutTag"),
    );
  }

  async verifyTag(repositoryId: string, name: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const tag = await this.git.verifyTag(repository.path, name);
    assertRepositoryContext(this.repositories, repository, t("operations.verifyTag"));
    return { ...tag, ...this.signers?.decorate(repository.identityId, repositoryId, tag) };
  }

  listTags(repositoryId: string): Promise<TagSummary[]> {
    return readActiveRepository(
      this.repositories,
      repositoryId,
      (path) => this.git.listTags(path),
      t("operations.listTags"),
    );
  }

  private write<T>(
    repositoryId: string,
    work: (path: string) => Promise<T>,
    kind = t("main.repositoryWriter.updateRepository"),
    retry?: () => Promise<unknown>,
    needsWriteAccess = true,
    kindKey?: MessageKey,
  ): Promise<T> {
    const { path, identityId } = this.repositories.resolveActiveRepository(repositoryId);
    const execute = () =>
      this.identity.serialize(async () => {
        if (!this.identities.findById(identityId))
          throw new GitError({
            kind: "invalid-input",
            operation: t("operations.writeRepository"),
            message: errorText(
              "main.repositoryWriter.theOriginatingProfileWasDeletedBeforeThisOperationCouldStart",
            ),
          });

        const commonDirectory = await repositoryCommonDirectory(this.git, path);

        return this.queue.run(commonDirectory, async () => {
          const capabilities = needsWriteAccess
            ? await repositoryCapabilities(this.git, path)
            : { write: true };

          if (!capabilities.write)
            throw new GitError({
              kind: "invalid-input",
              operation: kind,
              message: errorText("errors.operationBlocked", {
                reason: capabilities.reason ?? t("main.repositoryWriter.thisRepositoryIsReadOnly"),
              }),
            });

          return work(path);
        });
      });

    return this.operations
      ? this.operations.run(
          { profileId: identityId, repositoryId, repositoryName: basename(path) },
          kind,
          execute,
          retry
            ? async () => {
                const current = this.repositories.resolveActiveRepository(repositoryId);

                if (current.identityId !== identityId || current.path !== path)
                  throw new GitError({
                    kind: "invalid-input",
                    operation: t("operations.retryOperation"),
                    message: errorText(
                      "main.repositoryWriter.theOriginalRepositoryContextChangedReopenItBeforeRetrying",
                    ),
                  });

                return retry();
              }
            : undefined,
          kindKey,
        )
      : execute();
  }

  applyProfile(repositoryId: string): Promise<void> {
    const expected = this.requireActiveIdentity();
    return this.write(
      repositoryId,
      (path) => this.identity.applyToRepository(path, expected),
      t("main.repositoryWriter.applyProfile"),
    );
  }

  clearLocalCommitConfig(repositoryId: string, group: CommitConfigGroup): Promise<void> {
    const keys = commitConfigKeys(group);

    return this.write(
      repositoryId,
      (path) =>
        withLocalConfiguration(
          this.git,
          path,
          t("main.repositoryWriter.removeLocalCommitOverrides"),
          async (file) => {
            for (const key of keys)
              await this.git.exec(
                ["config", "--file", file, "--no-includes", "--unset-all", "--", key],
                {
                  cwd: path,
                  operation: t("operations.removeLocalCommitOverride"),
                  allowedExitCodes: [0, 5],
                },
              );
          },
        ),
      t("main.repositoryWriter.removeLocalCommitOverrides"),
    );
  }

  private requireActiveIdentity(repositoryId?: string) {
    const id = this.identities.getActiveId();
    const identity = id ? this.identities.findById(id) : undefined;

    if (!identity) {
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.commit"),
        message: errorText("main.repositoryWriter.thereIsNoActiveIdentity"),
        suggestedAction: errorText("main.repositoryWriter.selectAnIdentityBeforeCommitting"),
      });
    }

    return repositoryId ? this.identity.forRepository(repositoryId, identity) : identity;
  }
}
