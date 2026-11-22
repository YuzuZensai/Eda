import type { GitHost } from "@shared/integrations/git-host";
import { assertFullObjectId } from "../git/validation";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { referenceLink, type ReferenceLinkKind } from "@shared/repository/reference-link";
import type {
  ComparisonDiffRequest,
  PatchExportRequest,
  RevisionPathRequest,
  BlameRequest,
  RevisionComparisonRequest,
} from "@shared/repository/repository-read";
import type { GitService } from "../git/git-service";
import { resolveSshReferenceRemote } from "../ssh/reference-host";
import { listSubmodules } from "../git/operations/submodules";
import { readSparseCheckout } from "../git/operations/sparse-checkout";
import { listWorktrees } from "../git/operations/worktrees";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isOneOf } from "@shared/validation";
import { submoduleUpdateModes, type WorktreeSummary } from "@shared/repository/repository-read";
import { readBlame, readRevisionPath } from "../git/operations/revision-path";
import { readRevisionComparison } from "../git/operations/revision-comparison";
import type { RepositoryManager } from "./lifecycle/repository-manager";

const MAX_IGNORED_FILES = 5_000;

export class RepositoryReader {
  constructor(
    private readonly git: Pick<
      GitService,
      | "status"
      | "remoteNames"
      | "readConfig"
      | "ignoredFiles"
      | "commitTemplate"
      | "commitMessage"
      | "exec"
      | "compareDiff"
      | "filePatch"
    >,
    private readonly repositories: Pick<RepositoryManager, "resolveActiveRepository">,
    private readonly gitlabInstances: (profileId: string) => readonly string[],
    private readonly additionalHosts?: (profileId: string) => Promise<GitHost[]>,
  ) {}

  async referenceUrl(repositoryId: string, kind: ReferenceLinkKind, name: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const names = await this.git.remoteNames(repository.path);
    let remote = names.includes("origin") ? "origin" : names[0];

    let reference = name;
    if (kind === "branch") {
      const configured = await this.git.readConfig(`branch.${name}.remote`, {
        cwd: repository.path,
      });
      if (configured && configured !== ".") {
        if (!names.includes(configured)) return null;
        remote = configured;
        const merge = await this.git.readConfig(`branch.${name}.merge`, { cwd: repository.path });
        if (merge?.startsWith("refs/heads/")) reference = merge.slice("refs/heads/".length);
      }
    }
    if (kind === "remote-branch")
      remote = names
        .sort((first, second) => second.length - first.length)
        .find((candidate) => name.startsWith(`${candidate}/`));

    if (!remote) return null;

    if (kind === "remote-branch") reference = name.slice(remote.length + 1);
    const url = await this.git.readConfig(`remote.${remote}.url`, { cwd: repository.path });

    if (!url) return null;
    const instances = this.gitlabInstances(repository.identityId);
    const direct = referenceLink(url, kind, reference, instances);
    if (direct) return direct;
    const hosts = (await this.additionalHosts?.(repository.identityId)) ?? [];
    const hosted = referenceLink(url, kind, reference, instances, hosts);
    if (hosted) return hosted;
    const resolved = await resolveSshReferenceRemote(url);
    return resolved ? referenceLink(resolved, kind, reference, instances, hosts) : null;
  }

  async ignoredFiles(repositoryId: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const paths = await this.git.ignoredFiles(repository.path);

    return {
      paths: paths.slice(0, MAX_IGNORED_FILES),
      truncated: paths.length > MAX_IGNORED_FILES,
    };
  }

  async commitTemplate(repositoryId: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);

    return this.git.commitTemplate(repository.path);
  }

  commitMessage(repositoryId: string, oid: string) {
    return this.readRepository(
      repositoryId,
      (root) => this.git.commitMessage(root, oid),
      t("operations.readCommitMessage"),
    );
  }

  mailboxPatch(id: string, oid: string, after?: string) {
    const operation = t("mailbox.export");
    assertFullObjectId(oid, operation);
    if (after) assertFullObjectId(after, operation);
    return this.readRepository(id, async (cwd) => {
      const options = { cwd, operation, maxStdoutBytes: 32 * 1024 * 1024 };
      if (
        after &&
        (
          await this.git.exec(["merge-base", "--is-ancestor", after, oid], {
            ...options,
            allowedExitCodes: [0, 1],
          })
        ).exitCode !== 0
      )
        throw new GitError({
          kind: "invalid-input",
          operation,
          message: errorText("mailbox.range"),
        });
      const patch = await this.git.exec(
        [
          "format-patch",
          "--stdout",
          "--no-cover-letter",
          "--no-signature",
          "--no-ext-diff",
          "--no-textconv",
          "--binary",
          "--full-index",
          ...(after ? [after + ".." + oid] : ["-1", oid]),
          "--",
        ],
        options,
      );
      return patch.stdoutBytes;
    });
  }

  filePatch(request: PatchExportRequest) {
    return this.readRepository(request.repositoryId, (root) => this.git.filePatch(root, request));
  }

  submodules(id: string) {
    return this.readRepository(id, async (root) => {
      const opts = { cwd: root, scope: "local" } as const;
      const [listing, automatic, mode] = await Promise.all([
        listSubmodules(this.git, root),
        this.git.readConfig("eda.updateSubmodules", opts),
        this.git.readConfig("eda.submoduleUpdateMode", opts),
      ]);
      if (automatic !== undefined) listing.automatic = automatic === "true";
      if (isOneOf(mode, submoduleUpdateModes)) listing.defaultMode = mode;
      return listing;
    });
  }

  sparseCheckout(id: string) {
    return this.readRepository(id, (root) => readSparseCheckout(this.git, root));
  }

  worktrees(id: string, inspectChanges = true) {
    return this.readRepository(id, async (root) => {
      const entries = await listWorktrees(this.git, root);
      const currentRoot = await realpath(root);
      const worktrees: WorktreeSummary[] = [];
      for (let start = 0; start < entries.length; start += 4) {
        worktrees.push(
          ...(await Promise.all(
            entries.slice(start, start + 4).map(async (entry) => {
              const metadata = entry.bare ? entry.path : join(entry.path, ".git");
              const available = await stat(metadata).then(
                (info) => info.isDirectory() || info.isFile(),
                () => false,
              );
              const current = entry.path === currentRoot;
              let changedPaths: number | undefined;
              if (inspectChanges && available && !current && !entry.bare && start < 64) {
                try {
                  changedPaths = (await this.git.status(entry.path)).changes.length;
                } catch (error) {
                  // Unopened or unreadable worktrees can still be located in the graph.
                  if (!(error instanceof GitError)) throw error;
                }
              }
              return {
                ...entry,
                available,
                current,
                ...(changedPaths !== undefined && { changedPaths }),
              };
            }),
          )),
        );
      }
      return worktrees;
    });
  }

  blame(request: BlameRequest) {
    return this.readRepository(request.repositoryId, (root) => readBlame(this.git, root, request));
  }

  revisionPath(request: RevisionPathRequest) {
    return this.readRepository(request.repositoryId, (root) =>
      readRevisionPath(this.git, root, request),
    );
  }

  compareRevisions(request: RevisionComparisonRequest) {
    return this.readRepository(request.repositoryId, (root) =>
      readRevisionComparison(this.git, root, request),
    );
  }

  comparisonDiff({
    repositoryId,
    baseOid,
    rightOid,
    path,
    oldPath,
    ...options
  }: ComparisonDiffRequest) {
    return this.readRepository(repositoryId, (root) =>
      this.git.compareDiff(
        root,
        baseOid,
        rightOid,
        oldPath && oldPath !== path ? [oldPath, path] : [path],
        options,
      ),
    );
  }

  private async readRepository<T>(
    repositoryId: string,
    read: (root: string) => Promise<T>,
    operation = t("operations.compareRevisions"),
  ) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const result = await read(repository.path);
    const current = this.repositories.resolveActiveRepository(repositoryId);

    if (current.identityId !== repository.identityId || current.path !== repository.path)
      throw new GitError({
        kind: "invalid-input",
        operation,
        message: errorText("main.repositoryManager.theRepositoryChangedRefreshAndTryAgain"),
      });
    return result;
  }
}
