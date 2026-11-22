import { workingFilePath } from "../../filesystem/working-file-path";
import type { GitHosts } from "../../providers/git-hosts";
import { isFullObjectId } from "@shared/repository/object-id";
import { errorText } from "@shared/error-codes";
import { errorMessage, GitError } from "@shared/errors";
import { t, type MessageKey } from "@shared/i18n";
import type { Identity } from "@shared/identity/identity";
import { isGitHubHttps } from "@shared/integrations/github";
import type {
  LfsAction,
  HttpsHelper,
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
import {
  readSparseCheckout,
  setSparseCheckout,
  validateSparseDirectories,
} from "../../git/operations/sparse-checkout";
import { assertRepositoryPath, assertValidRefName } from "../../git/validation";
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
    private readonly httpsHelper?: (profileId: string) => HttpsHelper,
    private readonly gitHosts?: Pick<GitHosts, "forFetch">,
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

    for (const provider of [this.github, this.gitlab, this.gitlabSelfHosted, this.gitHosts]) {
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
      this.httpsHelper?.(identity.id),
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

  primaryFetchUrl(id: string, { refresh = false } = {}): Promise<string | undefined> {
    const repository = this.repositories.resolveActiveRepository(id);
    const key = `${repository.identityId}:${repository.id}:${repository.path}`;
    const cached = this.primaryFetchUrls.get(key);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;

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
    this.operations.cancelMatching(
      profileId,
      repositoryId,
      "main.backgroundFetchService.backgroundFetch",
    );
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
    if (request.tag !== undefined) {
      assertValidRefName(request.tag, t("operations.fetch", { name: request.remote }));
      if (request.remote === null)
        throw remoteError(errorText("main.remoteService.chooseOneRemoteToFetchATag"));
    }

    if (request.remote === null && request.credentials)
      throw remoteError(
        errorText("main.remoteService.fetchOneRemoteWhenSupplyingHttpsCredentials"),
      );

    if (
      request.deepen !== undefined &&
      (request.remote === null ||
        request.tag ||
        (request.deepen !== "all" &&
          (!Number.isSafeInteger(request.deepen) ||
            request.deepen < 1 ||
            request.deepen > 2147483647)))
    )
      throw remoteError(errorText("shallow.invalidFetch"));
    const tagOptions: string[] = [];
    if (request.tag) tagOptions.push("--no-tags");
    else if (request.tags) tagOptions.push("--tags");

    const names =
      request.remote === null
        ? (await this.remotes.list(path)).map((remote) => remote.name)
        : [request.remote];

    if (!names.length) throw remoteError(errorText("main.remoteService.addARemoteBeforeFetching"));

    const completed: string[] = [];

    for (const name of names) {
      const url = await this.remotes.destination(path, name, request.tag !== undefined);

      this.operations.progress(
        t("main.remoteService.fetching", {
          name: name,
          value2: request.prune ? t("main.remoteService.withPruning") : "",
        }),
      );

      let branchRefspec = "+refs/heads/*:refs/remotes/" + name + "/*";
      if (request.deepen !== undefined) {
        // Negotiate the selected tip explicitly. Fetching unrelated tips can leave its shallow boundary in place.
        const { branch } = await this.git.status(path);
        const remotePrefix = name + "/";
        const source = branch.upstream?.startsWith(remotePrefix)
          ? branch.upstream.slice(remotePrefix.length)
          : branch.head;
        if (!source || branch.detached) throw remoteError(errorText("shallow.selectBranch"));
        assertValidRefName(source, t("operations.fetch", { name }));
        branchRefspec = "+refs/heads/" + source + ":refs/remotes/" + name + "/" + source;
      }
      try {
        const credentials = await this.resolveCredentials(identity.id, url, request.credentials);

        const result = await this.git.exec(
          [
            "fetch",
            "--upload-pack=git-upload-pack",
            "--progress",
            "--no-recurse-submodules",
            request.prune && !request.tag ? "--prune" : "--no-prune",
            "--no-prune-tags",
            ...tagOptions,
            ...(request.deepen === undefined
              ? []
              : [request.deepen === "all" ? "--unshallow" : "--deepen=" + request.deepen]),
            "--",
            url,
            request.tag ? `refs/tags/${request.tag}:refs/tags/${request.tag}` : branchRefspec,
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
        if (!request.tag)
          this.fetchHistory.record(identity.id, request.repositoryId, name, url, Date.now(), null);
      } catch (error) {
        const failure = this.githubFailure(error, url, !!request.credentials);

        if (!request.tag)
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

    if (request.tag)
      return t("main.remoteService.fetchedTag", { tag: request.tag, remote: request.remote });

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

  lfs(id: string, action: LfsAction) {
    const operation = t("lfs.title");
    return this.writer.remoteOperation(
      id,
      operation,
      async (cwd, identity) => {
        if (this.git.trust && !(await this.git.trust.checked(cwd)).trusted)
          throw remoteError(errorText("lfs.requiresTrust"));
        const opts = { cwd, operation, maxStdoutBytes: 1024 * 1024, maxStderrBytes: 256 * 1024 };
        const version = await this.git.exec(["lfs", "version"], opts);
        if (!version.stdout.startsWith("git-lfs/"))
          throw remoteError(errorText("gitDiagnostics.lfsMissing"));
        if (action.kind === "install")
          return (await this.git.exec(["lfs", "install", "--local"], opts)).stdout;
        if ("pattern" in action) {
          await workingFilePath(cwd, ".gitattributes", operation);
          assertRepositoryPath(action.pattern, operation);
          if (/^[!-]|[\r\n]/.test(action.pattern)) throw remoteError(errorText("lfs.invalid"));
          const output = await this.git.exec(["lfs", action.kind, "--", action.pattern], opts);
          await this.git.stage(cwd, [".gitattributes"]);
          return output.stdout;
        }
        if (!("remote" in action))
          return (
            await this.git.exec(
              [
                "lfs",
                "prune",
                "--verbose",
                ...(action.kind === "previewPrune" ? ["--dry-run"] : []),
              ],
              opts,
            )
          ).stdout;
        remoteName(action.remote);
        const url = await this.remotes.destination(cwd, action.remote, action.kind === "push");
        const transport = this.transport(
          url,
          identity,
          await this.resolveCredentials(identity.id, url),
        );
        const options = { ...opts, ...transport };
        if ("path" in action) {
          assertRepositoryPath(action.path, operation);
          // The locking API is optional, even for servers that support object transfers.
          await this.git.exec(["lfs", "locks", "--limit=1", "--remote=" + action.remote], options);
          return (
            await this.git.exec(
              ["lfs", action.kind, "--remote=" + action.remote, "--", action.path],
              options,
            )
          ).stdout;
        }
        if (action.kind === "locks")
          return (
            await this.git.exec(
              ["lfs", "locks", "--limit=100", "--remote=" + action.remote],
              options,
            )
          ).stdout;
        return (
          await this.git.exec(
            ["lfs", action.kind, action.remote, ...(action.kind === "push" ? ["HEAD"] : [])],
            {
              ...options,
              reportStdoutProgress: true,
              env: {
                ...transport.env,
                overrides: { ...transport.env?.overrides, GIT_LFS_FORCE_PROGRESS: "1" },
              },
            },
          )
        ).stdout;
      },
      "lfs.title",
    );
  }

  private async fetchCheckoutBlobs(
    cwd: string,
    directories: string[] | undefined,
    url: string,
    transport: ReturnType<RemoteService["transport"]>,
  ) {
    const options = { cwd, operation: t("sparse.title"), maxStdoutBytes: 32 * 1024 * 1024 };
    // A cone also includes files directly inside every ancestor directory.
    const listing = await this.git.exec(["ls-tree", "-r", "-z", "HEAD"], options);
    const blobs = new Set<string>();
    for (const entry of listing.stdout.split("\0")) {
      const match = /^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
      if (!match) continue;
      const path = match[2]!;
      const parent = path.slice(0, path.lastIndexOf("/") + 1);
      if (
        !directories ||
        !parent ||
        directories.some((dir) => path.startsWith(dir + "/") || (dir + "/").startsWith(parent))
      )
        blobs.add(match[1]!);
    }
    if (!blobs.size) return;
    const checked = await this.git.exec(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      ...options,
      stdin: [...blobs].join("\n") + "\n",
    });
    const missing = checked.stdout.split("\n").flatMap((line) => {
      const [oid, state] = line.split(" ");
      return state === "missing" && oid && blobs.has(oid) ? [oid] : [];
    });
    if (missing.length)
      await this.git.exec(
        [
          "fetch",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          "--no-tags",
          "--no-prune",
          "--refmap=",
          "--upload-pack=git-upload-pack",
          "--stdin",
          "--",
          url,
        ],
        { ...options, ...transport, stdin: missing.join("\n") + "\n" },
      );
  }

  changeSparseCheckout(id: string, action: "set" | "disable" | "reapply", paths: string[]) {
    const operation = t("sparse.title");
    validateSparseDirectories(paths);
    return this.writer.remoteOperation(id, operation, async (cwd, identity) => {
      const current = await readSparseCheckout(this.git, cwd);
      if (action === "set" && !current.cone) throw remoteError(errorText("sparse.nonCone"));
      const promisor = await this.git.exec(["config", "--get-regexp", "^remote\\..+\\.promisor$"], {
        cwd,
        operation,
        allowedExitCodes: [0, 1],
      });
      const remote = promisor.stdout
        .split("\n")
        .map((line) => /^remote\.(.+)\.promisor (?:true|1|yes|on)$/i.exec(line)?.[1])
        .find(Boolean);
      if (remote) {
        const url = await this.remotes.destination(cwd, remote, false);
        const credentials = await this.resolveCredentials(identity.id, url);
        let directories = action === "set" ? paths : undefined;
        if (action === "reapply" && current.cone) directories = current.directories;
        await this.fetchCheckoutBlobs(
          cwd,
          directories,
          url,
          this.transport(url, identity, credentials),
        );
      }
      if (action === "set") await setSparseCheckout(this.git, cwd, paths);
      else await this.git.exec(["sparse-checkout", action], { cwd, operation });
    });
  }

  clone(request: CloneRequest) {
    const captured = this.identity.getActive();

    if (!captured || captured.id !== request.profileId)
      throw remoteError(errorText("main.remoteService.theProfileChangedReopenCloneAndTryAgain"));

    remoteUrl(request.url);

    transportOptions(request.url, captured, request.credentials);
    if (request.sparseDirectories) validateSparseDirectories(request.sparseDirectories);
    if (request.branch !== undefined)
      assertValidRefName(request.branch, t("operations.cloneRepository"));
    if (
      request.depth !== undefined &&
      (request.since !== undefined ||
        !Number.isSafeInteger(request.depth) ||
        request.depth < 1 ||
        request.depth > 2147483647)
    )
      throw remoteError(errorText("shallow.invalidLimit"));
    if (
      request.since !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(request.since) ||
        !Number.isFinite(Date.parse(request.since)) ||
        new Date(request.since).toISOString().slice(0, 10) !== request.since)
    )
      throw remoteError(errorText("historySearch.invalidDate"));

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
                ...(request.sparseDirectories ? ["--sparse"] : []),
                ...(request.blobless ? ["--filter=blob:none"] : []),
                ...(request.branch ? ["--branch=" + request.branch] : []),
                ...(request.depth ? ["--depth=" + request.depth] : []),
                ...(request.since ? ["--shallow-since=" + request.since + "T00:00:00Z"] : []),
                ...(this.git.trust || request.blobless ? ["--no-checkout"] : []),
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
            this.operations.attachRepository(repository.id);
            if (this.git.trust || request.blobless) {
              const policy = await this.git.trust?.checked(destination);
              const options = { cwd: destination, operation: t("operations.cloneRepository") };
              const head = await this.git.exec(["rev-parse", "--verify", "HEAD"], {
                ...options,
                allowedExitCodes: [0, 128],
              });
              if (head.exitCode === 0 && !policy?.execution?.blocksWrites) {
                if (request.blobless)
                  await this.fetchCheckoutBlobs(
                    destination,
                    request.sparseDirectories,
                    request.url,
                    authenticatedTransport,
                  );
                if (request.sparseDirectories)
                  await setSparseCheckout(this.git, destination, request.sparseDirectories);
                await this.git.exec(["read-tree", "-m", "-u", "HEAD"], options);
              }
            } else if (request.sparseDirectories?.length) {
              await setSparseCheckout(this.git, destination, request.sparseDirectories);
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
