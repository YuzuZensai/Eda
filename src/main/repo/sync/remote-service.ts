import { isFullObjectId } from "@shared/repository/object-id";
import { errorText } from "@shared/error-codes";
import { errorMessage, GitError } from "@shared/errors";
import { t, type MessageKey } from "@shared/i18n";
import type { Identity } from "@shared/identity/identity";
import { isGitHubHttps } from "@shared/integrations/github";
import type {
  CloneRequest,
  FetchRequest,
  PushPreview,
  PushRequest,
  RemoteChange,
  RemoteState,
  RemoteTagsRequest,
  RemoteTagSummary,
  TransportCredentials,
} from "@shared/integrations/remotes";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, join } from "node:path";
import type { GitService } from "../../git/git-service";
import {
  GitRemotes,
  remoteError,
  remoteName,
  remoteUrl,
  transportOptions,
} from "../../git/operations/remotes";
import { assertValidRefName } from "../../git/validation";
import type { IdentityManager } from "../../identity/identity-manager";
import type { OperationManager } from "../../operations/operation-manager";
import type { FetchHistoryRepository } from "../../persistence/fetch-history-repository";
import type { IdentityRepository } from "../../persistence/identity-repository";
import type { GitLabSelfHostedAuth } from "../../providers/gitlab-self-hosted-auth";
import type { GitLabAuth } from "../../providers/gitlab-auth";
import type { GitHubAuth } from "../../providers/github-auth";
import { PreviewStore } from "../preview-store";
import type { RepositoryManager } from "../lifecycle/repository-manager";
import type { RepositoryWriter } from "../working-tree/repository-writer";

interface PreparedPush {
  preview: PushPreview;
  request: PushRequest;
  identity: Identity;
  path: string;
}

export class RemoteService {
  private readonly remotes: GitRemotes;
  private readonly pushes = new PreviewStore<PreparedPush>(20);
  private readonly primaryFetchUrls = new Map<
    string,
    { expiresAt: number; value: Promise<string | undefined> }
  >();

  constructor(
    private readonly git: GitService,
    private readonly repositories: RepositoryManager,
    private readonly writer: RepositoryWriter,
    private readonly identity: IdentityManager,
    private readonly identities: IdentityRepository,
    private readonly operations: OperationManager,
    private readonly fetchHistory: FetchHistoryRepository,
    private readonly github?: Pick<GitHubAuth, "forFetch">,
    private readonly gitlab?: Pick<GitLabAuth, "forFetch">,
    private readonly gitlabSelfHosted?: Pick<GitLabSelfHostedAuth, "forFetch" | "ignoresTlsErrors">,
  ) {
    this.remotes = new GitRemotes(git);
  }

  private githubFailure(error: unknown, url: string, manual = false): unknown {
    if (
      manual ||
      !this.github ||
      !isGitHubHttps(url) ||
      !(error instanceof GitError) ||
      error.kind !== "auth-failed"
    )
      return error;

    const accessDenied = /returned error: 403|write access to repository not granted/i.test(
      error.rawStderr ?? "",
    );

    return new GitError({
      kind: accessDenied ? "github-access-required" : "github-auth-required",
      operation: error.operation,
      message: accessDenied
        ? errorText("main.remoteService.gitHubDeniedRepositoryAccessEnableEdaFor")
        : errorText("main.remoteService.gitHubRejectedThisLoginSignInWithGitHubAgainThenRetry"),
      suggestedAction: accessDenied
        ? errorText("main.remoteService.openSettingsProfileIntegrationsEnableAccessOrManageAccess")
        : errorText("main.remoteService.reconnectGitHubInTheIntegrationsSectionOfProfileSettings"),
    });
  }

  private async resolveCredentials(
    profileId: string,
    url: string,
    supplied?: TransportCredentials,
  ): Promise<TransportCredentials | undefined> {
    if (supplied) return supplied;
    if (!url.startsWith("https://")) return undefined;

    for (const provider of [this.github, this.gitlab, this.gitlabSelfHosted]) {
      const credentials = await provider?.forFetch(profileId, url);
      if (credentials) return credentials;
    }

    return undefined;
  }

  private transport(url: string, identity: Identity, credentials?: TransportCredentials) {
    return transportOptions(
      url,
      identity,
      credentials,
      this.gitlabSelfHosted?.ignoresTlsErrors(identity.id, url) ?? false,
    );
  }

  async inspect(id: string): Promise<RemoteState> {
    const { path } = this.repositories.resolveActiveRepository(id);

    const [remotes, branches, states] = await Promise.all([
      this.remotes.list(path),
      this.git.listBranches(path),
      this.remotes.upstreamStates(path),
    ]);

    return {
      remotes,
      branches: branches.map((branch) => ({
        ...branch,
        upstreamState: states.get(branch.name) ?? "",
      })),
    };
  }

  primaryFetchUrl(id: string): Promise<string | undefined> {
    const repository = this.repositories.resolveActiveRepository(id);
    const key = `${repository.identityId}:${repository.id}:${repository.path}`;
    const cached = this.primaryFetchUrls.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const value = (async () => {
      const origin = await this.git.readConfig("remote.origin.url", { cwd: repository.path });
      if (origin) return origin;

      const result = await this.git.exec(["remote"], {
        cwd: repository.path,
        operation: t("operations.readRemoteNames"),
        maxStdoutBytes: 64 * 1024,
      });
      const name = result.stdout.trim().split("\n").find(Boolean);
      return name ? this.git.readConfig(`remote.${name}.url`, { cwd: repository.path }) : undefined;
    })();

    this.primaryFetchUrls.delete(key);
    this.primaryFetchUrls.set(key, { expiresAt: Date.now() + 60_000, value });
    while (this.primaryFetchUrls.size > 128)
      this.primaryFetchUrls.delete(this.primaryFetchUrls.keys().next().value!);
    return value;
  }

  async listTags(request: RemoteTagsRequest): Promise<RemoteTagSummary[]> {
    remoteName(request.remote);
    const { path, identityId } = this.repositories.resolveActiveRepository(request.repositoryId);
    const identity = this.identities.findById(identityId);
    if (!identity)
      throw remoteError(errorText("main.remoteService.theOriginatingProfileNoLongerExists"));
    const url = await this.remotes.destination(path, request.remote, true);
    const credentials = await this.resolveCredentials(identity.id, url, request.credentials);

    const result = await this.git
      .exec(["ls-remote", "--upload-pack=git-upload-pack", "--refs", "--tags", "--", url], {
        cwd: path,
        operation: t("main.remoteService.inspectRemoteTags"),
        maxStdoutBytes: 4 * 1024 * 1024,
        ...this.transport(url, identity, credentials),
      })
      .catch((error: unknown) => {
        throw this.githubFailure(error, url, !!request.credentials);
      });

    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [oid, ref] = line.split("\t");
        if (!oid || !isFullObjectId(oid) || !ref?.startsWith("refs/tags/"))
          throw remoteError(errorText("main.remoteService.theRemoteReturnedAnInvalidObjectId"));
        const name = ref.slice("refs/tags/".length);
        assertValidRefName(name, t("main.remoteService.inspectRemoteTags"));
        return { name, oid };
      });
  }

  async fetchStates(id: string) {
    const repository = this.repositories.resolveActiveRepository(id);

    return (await this.remotes.list(repository.path)).map((remote) => ({
      name: remote.name,
      supported: remote.fetchUrls.length === 1,
      history: this.fetchHistory.read(
        repository.identityId,
        id,
        remote.name,
        remote.fetchUrls[0] ?? "",
      ),
    }));
  }

  change(id: string, change: RemoteChange): Promise<void> {
    return this.writer
      .remoteOperation(
        id,
        t("main.remoteService.configureRemote"),
        (path) => this.remotes.change(path, change),
        "main.remoteService.configureRemote",
      )
      .then(() => this.primaryFetchUrls.clear());
  }

  track(id: string, branch: string, upstream: string | null): Promise<void> {
    return this.writer.remoteOperation(
      id,
      t("main.remoteService.setUpstream"),
      (path) => this.remotes.track(path, branch, upstream),
      "main.remoteService.setUpstream",
    );
  }

  cancelScheduled(profileId: string, repositoryId: string): void {
    for (const operation of this.operations.list(profileId))
      if (
        operation.repositoryId === repositoryId &&
        operation.kindKey === "main.backgroundFetchService.backgroundFetch" &&
        (operation.state === "queued" || operation.state === "running")
      )
        this.operations.cancel(profileId, operation.id);
  }

  fetch(
    request: FetchRequest,
    kind = t("main.remoteService.fetchRemotes"),
    kindKey: MessageKey = "main.remoteService.fetchRemotes",
  ): Promise<string> {
    return this.writer.remoteOperation(
      request.repositoryId,
      kind,
      (path, identity) => this.fetchInPlace(path, identity, request),
      kindKey,
    );
  }

  // The caller must already hold the repository writer lock.
  async fetchInPlace(
    path: string,
    identity: Identity,
    request: FetchRequest,
    refspec?: string,
  ): Promise<string> {
    if (request.remote === null && request.credentials)
      throw remoteError(
        errorText("main.remoteService.fetchOneRemoteWhenSupplyingHttpsCredentials"),
      );

    const names =
      request.remote === null
        ? (await this.remotes.list(path)).map((remote) => remote.name)
        : [request.remote];

    if (!names.length) throw remoteError(errorText("main.remoteService.addARemoteBeforeFetching"));

    const completed: string[] = [];

    for (const name of names) {
      const url = await this.remotes.destination(path, name, false);

      this.operations.progress(
        t("main.remoteService.fetching", {
          name: name,
          value2: request.prune ? t("main.remoteService.withPruning") : "",
        }),
      );

      try {
        const credentials = await this.resolveCredentials(identity.id, url, request.credentials);

        const result = await this.git.exec(
          [
            "fetch",
            "--upload-pack=git-upload-pack",
            "--progress",
            "--no-recurse-submodules",
            request.prune ? "--prune" : "--no-prune",
            "--no-prune-tags",
            ...(request.tags ? ["--tags"] : ["--no-tags"]),
            "--",
            url,
            `+refs/heads/*:refs/remotes/${name}/*`,
            ...(refspec ? [refspec] : []),
          ],
          {
            cwd: path,
            operation: t("operations.fetch", { name: name }),
            ...this.transport(url, identity, credentials),
          },
        );

        this.operations.progress(
          t("main.remoteService.completed", {
            name: name,
            value2: result.stderr || t("main.remoteService.remoteTrackingBranchesAreUpToDate"),
          }),
        );

        completed.push(name);
        this.fetchHistory.record(identity.id, request.repositoryId, name, url, Date.now(), null);
      } catch (error) {
        const failure = this.githubFailure(error, url, !!request.credentials);

        this.fetchHistory.record(
          identity.id,
          request.repositoryId,
          name,
          url,
          Date.now(),
          errorMessage(failure, errorText("main.remoteService.fetchFailed")),
        );

        throw failure;
      }
    }

    return t("main.remoteService.fetchedLocalBranchesAndFilesWereNotChanged", {
      completed: completed.join(", "),
      value2: request.prune ? t("main.remoteService.deletedRemoteTrackingBranchesPruned") : "",
    });
  }

  preparePush(request: PushRequest): Promise<PushPreview> {
    remoteName(request.remote);

    if (request.mode !== "delete") assertValidRefName(request.branch, t("operations.pushSource"));

    if (request.setUpstream && (request.mode === "delete" || request.refKind === "tag"))
      throw remoteError(
        errorText("main.remoteService.upstreamTrackingIsOnlyAvailableWhenPushingABranch"),
      );

    assertValidRefName(request.destination, t("operations.pushDestination"));

    return this.writer.remoteOperation(
      request.repositoryId,
      t("main.remoteService.inspectPushDestination"),
      async (path, identity) => {
        const url = await this.remotes.destination(path, request.remote, true);
        const namespace = request.refKind === "tag" ? "tags" : "heads";
        const source = request.mode === "delete" ? "" : `refs/${namespace}/${request.branch}`;
        const destination = `refs/${namespace}/${request.destination}`;

        const localOid = source
          ? (
              await this.git.exec(["rev-parse", "--verify", source], {
                cwd: path,
                operation: t("operations.inspectPushSource"),
              })
            ).stdout.trim()
          : null;

        const credentials = await this.resolveCredentials(identity.id, url, request.credentials);

        const result = await this.git
          .exec(["ls-remote", "--upload-pack=git-upload-pack", "--refs", "--", url, destination], {
            cwd: path,
            operation: t("operations.inspectRemoteBranch"),
            ...this.transport(url, identity, credentials),
          })
          .catch((error: unknown) => {
            throw this.githubFailure(error, url, !!request.credentials);
          });

        const match = result.stdout
          .split("\n")
          .map((line) => line.split("\t"))
          .find(([, ref]) => ref === destination);

        const remoteOid = match?.[0] ?? null;

        if (remoteOid !== null && !isFullObjectId(remoteOid))
          throw remoteError(errorText("main.remoteService.theRemoteReturnedAnInvalidObjectId"));

        if (request.mode === "delete" && remoteOid === null)
          throw remoteError(
            errorText("main.remoteService.thatRemoteRefNoLongerExistsRefreshBeforeDeleting"),
          );

        const preview: PushPreview = {
          token: randomUUID(),
          url,
          source,
          destination,
          localOid,
          remoteOid,
          mode: request.mode,
        };

        const savedRequest = { ...request };

        delete savedRequest.credentials;

        this.pushes.set(preview.token, {
          preview,
          request: savedRequest,
          path,
          identity,
        });

        return preview;
      },
      "main.remoteService.inspectPushDestination",
    );
  }

  push(id: string, token: string, credentials?: PushRequest["credentials"]): Promise<string> {
    const prepared = this.pushes.get(token);

    this.pushes.delete(token);

    const repository = this.repositories.resolveActiveRepository(id);

    if (
      !prepared ||
      prepared.request.repositoryId !== id ||
      prepared.identity.id !== repository.identityId ||
      prepared.path !== repository.path
    )
      throw remoteError(errorText("main.remoteService.thePushPreviewExpiredOrItsProfileChanged"));

    return this.writer.remoteOperation(
      id,
      t("operationTitles.pushBranch"),
      async (path) => {
        const { request, preview, identity } = prepared;
        const url = await this.remotes.destination(path, request.remote, true);

        const localOid = preview.source
          ? (
              await this.git.exec(["rev-parse", "--verify", preview.source], {
                cwd: path,
                operation: t("operations.recheckPushSource"),
              })
            ).stdout.trim()
          : null;

        if (url !== preview.url || localOid !== preview.localOid)
          throw remoteError(
            errorText(
              "main.remoteService.theBranchOrDestinationChangedAfterPreviewReviewANewPushPreview",
            ),
          );

        if (this.git.trust && (isAbsolute(url) || url.startsWith("file://"))) {
          const target = isAbsolute(url) ? url : fileURLToPath(url);

          const worktree = await lstat(join(target, ".git")).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return false;
            },
          );

          await this.git.trust.authorize(target, !worktree);
        }

        const result = await this.git
          .exec(
            [
              "-c",
              `remote.${request.remote}.mirror=false`,
              "push",
              "--receive-pack=git-receive-pack",
              "--porcelain",
              "--progress",
              "--no-follow-tags",
              "--recurse-submodules=no",
              ...(request.mode === "lease" || request.mode === "delete"
                ? [`--force-with-lease=${preview.destination}:${preview.remoteOid ?? ""}`]
                : request.mode === "force"
                  ? ["--force"]
                  : ["--no-force"]),
              ...(request.setUpstream ? ["--set-upstream"] : []),
              "--",
              request.remote,
              `${preview.source}:${preview.destination}`,
            ],
            {
              cwd: path,
              operation: t("operations.pushBranch"),
              ...this.transport(
                url,
                identity,
                await this.resolveCredentials(identity.id, url, credentials),
              ),
            },
          )
          .catch((error: unknown) => {
            throw this.githubFailure(error, url, !!credentials);
          });

        this.operations.progress(result.stdout);

        return result.stdout;
      },
      "operationTitles.pushBranch",
    );
  }

  clone(request: CloneRequest) {
    const captured = this.identity.getActive();

    if (!captured || captured.id !== request.profileId)
      throw remoteError(errorText("main.remoteService.theProfileChangedReopenCloneAndTryAgain"));

    remoteUrl(request.url);

    transportOptions(request.url, captured, request.credentials);

    if (
      !isAbsolute(request.parent) ||
      !/^[^<>:"/\\|?*\x00-\x1f]+$/.test(request.name) ||
      request.name === "." ||
      request.name === ".." ||
      /[. ]$/.test(request.name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(request.name)
    )
      throw remoteError(
        errorText("main.remoteService.chooseAnAbsoluteParentFolderAndAValidNewFolderName"),
      );

    const path = join(request.parent, request.name);

    return this.operations.run(
      { profileId: captured.id, repositoryId: randomUUID(), repositoryName: basename(path) },
      t("operationTitles.cloneRepository"),
      () =>
        this.identity.serialize(async () => {
          if (!this.identities.findById(captured.id))
            throw remoteError(errorText("main.remoteService.theOriginatingProfileNoLongerExists"));

          const credentials = await this.resolveCredentials(
            captured.id,
            request.url,
            request.credentials,
          );

          const authenticatedTransport = this.transport(request.url, captured, credentials);

          this.operations.started(t("main.remoteService.preparingCloneDestination"));

          if (!(await lstat(request.parent)).isDirectory())
            throw remoteError(errorText("main.remoteService.theCloneParentMustBeADirectory"));

          const destination = join(await realpath(request.parent), request.name);

          try {
            await mkdir(destination);
          } catch {
            throw remoteError(
              errorText(
                "main.remoteService.theDestinationAlreadyExistsOrCannotBeCreatedChooseANewFolderName",
              ),
            );
          }

          try {
            await this.git.exec(
              [
                "clone",
                "--no-local",
                ...(this.git.trust ? ["--no-checkout"] : []),
                "--upload-pack=git-upload-pack",
                "--progress",
                "--no-recurse-submodules",
                "--",
                request.url,
                destination,
              ],
              {
                operation: t("operations.cloneRepository"),
                ...authenticatedTransport,
              },
            );

            await this.git.trust?.rememberCreated(destination);
            const repository = await this.repositories.open(destination, captured);
            if (this.git.trust) {
              const policy = await this.git.trust.checked(destination);
              const head = await this.git.exec(["rev-parse", "--verify", "HEAD"], {
                cwd: destination,
                operation: t("operations.cloneRepository"),
                allowedExitCodes: [0, 128],
              });
              if (head.exitCode === 0 && !policy.execution?.blocksWrites)
                await this.git.exec(["read-tree", "-m", "-u", "HEAD"], {
                  cwd: destination,
                  operation: t("operations.cloneRepository"),
                });
            }
            return repository;
          } catch (error) {
            this.operations.progress(
              t(
                "main.remoteService.cloneDidNotCompleteInspectBeforeRetryingEdaHasNotRemovedItsFiles",
                { path: path },
              ),
            );

            throw error;
          }
        }),
      undefined,
      "operationTitles.cloneRepository",
    );
  }
}
