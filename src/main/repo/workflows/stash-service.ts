import { isFullObjectId } from "@shared/repository/object-id";
import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { diffPaths } from "@shared/repository/diff-paths";
import {
  MAX_STASH_ENTRIES,
  MAX_STASH_NAME_LENGTH,
  type StashArea,
  type StashBranchPreview,
  type StashContents,
  type StashCreateOptions,
  type StashEntry,
  type StashFilePreview,
  type StashInspection,
  type StashList,
} from "@shared/workflows/stashes";
import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";

import type { GitService } from "../../git/git-service";
import { createScopedStash } from "../../git/operations/scoped-stash";
import { assertFullObjectId, assertRepositoryPath, assertValidRefName } from "../../git/validation";
import type { IdentityManager } from "../../identity/identity-manager";
import type { ContentRecoveryRepository } from "../../persistence/content-recovery-repository";
import { PreviewStore } from "../preview-store";
import type { RepositoryManager } from "../lifecycle/repository-manager";
import { DiscardService } from "../working-tree/discard-service";
import type { RepositoryWriter } from "../working-tree/repository-writer";
import type { WorkflowService } from "./workflow-service";

const invalid = (message: ErrorText) =>
  new GitError({ kind: "invalid-input", operation: t("operations.manageStashes"), message });

export class StashService {
  private readonly previews = new PreviewStore<{
    profileId: string;
    repositoryId: string;
    root: string;
    entry: StashEntry;
    fingerprint: string;
    trees: Record<StashArea, string | null>;
    paths: Record<StashArea, string[]>;
  }>();

  private readonly filePreviews = new PreviewStore<{
    preview: StashFilePreview;
    stashToken: string;
    source: string;
    head: string | undefined;
    branch: string | undefined;
    snapshot: Awaited<ReturnType<DiscardService["prepareOperation"]>>;
  }>();

  private readonly recovery: DiscardService;

  private readonly branchPreviews = new PreviewStore<{
    preview: StashBranchPreview;
    stashToken: string;
  }>();

  constructor(
    private readonly git: GitService,
    private readonly repositories: RepositoryManager,
    private readonly writer: RepositoryWriter,
    private readonly identity: IdentityManager,
    private readonly workflows: WorkflowService,
    recovery: ContentRecoveryRepository,
  ) {
    this.recovery = new DiscardService(git, recovery);
  }

  private async read(root: string) {
    const result = await this.git.exec(
      ["stash", "list", "-z", "--max-count=201", "--format=%H%x00%gd%x00%gs%x00%ct"],
      {
        cwd: root,
        operation: t("operations.listStashes"),
        maxStdoutBytes: 1024 * 1024,
      },
    );

    const fields = result.stdout.split("\0");

    if (fields.at(-1) === "") fields.pop();

    if (fields.length % 4)
      throw invalid(
        errorText(
          "main.stashService.gitReturnedAnUnreadableStashListInspectItWithGitBeforeChangingIt",
        ),
      );

    const entries: StashEntry[] = [];

    for (let index = 0; index < fields.length; index += 4) {
      const [oid, selector, message, timestamp] = fields.slice(index, index + 4) as [
        string,
        string,
        string,
        string,
      ];

      if (!isFullObjectId(oid) || !/^stash@\{\d+\}$/.test(selector) || !/^\d+$/.test(timestamp))
        throw invalid(errorText("main.stashService.gitReturnedAnUnreadableStashEntry"));

      entries.push({ oid, selector, message, timestamp: Number(timestamp) });
    }

    return { entries, fingerprint: createHash("sha256").update(result.stdoutBytes).digest("hex") };
  }

  async list(repositoryId: string): Promise<StashList> {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const { entries } = await this.read(repository.path);

    return {
      entries: entries.slice(0, MAX_STASH_ENTRIES),
      truncated: entries.length > MAX_STASH_ENTRIES,
    };
  }

  create(
    repositoryId: string,
    message: string,
    contents: StashContents,
    options: StashCreateOptions = {},
  ): Promise<void> {
    if (!message.trim() || message.length > MAX_STASH_NAME_LENGTH)
      throw invalid(errorText("main.stashService.enterAStashNameOf1To1024Characters"));
    if (!["tracked", "untracked", "all"].includes(contents))
      throw invalid(errorText("main.stashService.chooseWhichFilesToStash"));

    const { stagedOnly = false, keepIndex = false } = options;
    const paths = options.paths ? [...new Set(options.paths)] : undefined;

    if (paths && (!paths.length || paths.length > 256))
      throw invalid(errorText("main.stashService.selectBetween1And256PathsToStash"));

    for (const path of paths ?? []) assertRepositoryPath(path, t("operations.stashSelectedPaths"));

    if (stagedOnly && (contents !== "tracked" || paths || keepIndex))
      throw invalid(errorText("main.stashService.stagedOnlyStashesCannotIncludeUntrackedPathsOr"));

    return this.writer.remoteOperation(
      repositoryId,
      t("main.stashService.createStash"),
      async (root, identity) => {
        const status = await this.git.status(root);

        if (
          status.branch.unborn ||
          (await this.workflows.observe(root, status)) ||
          status.changes.some((item) => item.kind === "unmerged")
        )
          throw invalid(
            errorText(
              "main.stashService.finishTheCurrentOperationAndCreateAnInitialCommitBeforeStashing",
            ),
          );

        const effective = await this.identity.verifyEffectiveIdentity(root, identity);

        if (!effective.matches)
          throw invalid(
            errorText("main.stashService.theRepositoryAuthorDiffersFromThisProfileApply"),
          );

        const included = (path: string) =>
          !paths ||
          paths.some(
            (selected) => path === selected || path.startsWith(`${selected.replace(/\/$/, "")}/`),
          );

        if (paths) {
          for (const change of status.changes) {
            if (change.originalPath && (included(change.path) || included(change.originalPath))) {
              for (const path of [change.originalPath, change.path])
                if (!paths.includes(path)) paths.push(path);
            }
          }

          if (paths.length > 256)
            throw invalid(
              errorText("main.stashService.selectUpTo256PathsIncludingBothSidesOfRenamedFiles"),
            );
        }

        const visibleChanges = status.changes.some(
          (item) =>
            included(item.path) &&
            item.kind !== "ignored" &&
            (item.kind !== "untracked" || contents !== "tracked") &&
            (!stagedOnly || (item.index !== "." && item.index !== "?")),
        );

        if (!visibleChanges) {
          const ignored =
            contents === "all"
              ? await this.git.exec(
                  [
                    "ls-files",
                    "--others",
                    "--ignored",
                    "--exclude-standard",
                    "--directory",
                    "-z",
                    ...(paths ? ["--", ...paths.map((path) => `:(literal)${path}`)] : []),
                  ],
                  {
                    cwd: root,
                    operation: t("operations.inspectIgnoredStashContents"),
                    maxStdoutBytes: 1024 * 1024,
                  },
                )
              : null;

          if (!ignored?.stdout)
            throw invalid(
              errorText("main.stashService.thereAreNoEligibleChangesForTheSelectedStashContents"),
            );
        }

        const push = (indexFile?: string, exclusions: string[] = []) =>
          this.git.exec(
            [
              "-c",
              "submodule.recurse=false",
              "stash",
              "push",
              "--message",
              message,
              ...(stagedOnly ? ["--staged"] : []),
              ...(keepIndex ? ["--keep-index"] : []),
              ...(contents === "untracked"
                ? ["--include-untracked"]
                : contents === "all"
                  ? ["--all"]
                  : []),
              ...(exclusions.length ? ["--pathspec-from-file=-", "--pathspec-file-nul"] : []),
            ],
            {
              cwd: root,
              operation: t("operations.createStash"),
              ...(exclusions.length
                ? { stdin: exclusions.map((path) => `:(exclude,literal)${path}\0`).join("") }
                : {}),
              env: {
                overrides: {
                  GIT_AUTHOR_NAME: identity.gitName,
                  GIT_AUTHOR_EMAIL: identity.gitEmail,
                  GIT_COMMITTER_NAME: identity.gitName,
                  GIT_COMMITTER_EMAIL: identity.gitEmail,
                  ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
                },
              },
            },
          );

        if (paths)
          await createScopedStash(this.git, root, paths, keepIndex, async (index, exclusions) => {
            await push(index, exclusions);
          });
        else await push();
      },
    );
  }

  async inspect(repositoryId: string, selector: string, oid: string): Promise<StashInspection> {
    assertFullObjectId(oid, t("operations.inspectStash"));

    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const listed = await this.read(repository.path);
    const entry = listed.entries.find((item) => item.selector === selector && item.oid === oid);

    if (!entry)
      throw invalid(
        errorText("main.stashService.theStashListChangedRefreshAndChooseTheStashAgain"),
      );

    const parents = (
      await this.git.exec(["rev-list", "--parents", "-n", "1", oid], {
        cwd: repository.path,
        operation: t("operations.inspectStashStructure"),
      })
    ).stdout
      .trim()
      .split(" ")
      .slice(1);

    if (
      parents.length < 2 ||
      parents.length > 3 ||
      parents.some((parent) => !isFullObjectId(parent))
    )
      throw invalid(errorText("main.stashService.thisEntryDoesNotHaveASupportedStashStructure"));

    const [tracked, staged, untracked] = await Promise.all([
      this.git.compareDiff(repository.path, parents[0]!, oid),
      this.git.compareDiff(repository.path, parents[0]!, parents[1]!),
      parents[2] ? this.git.commitDiff(repository.path, parents[2]) : null,
    ]);

    const token = randomUUID();

    this.previews.set(token, {
      profileId: repository.identityId,
      repositoryId,
      root: repository.path,
      entry,
      fingerprint: listed.fingerprint,
      trees: { tracked: oid, staged: parents[1]!, untracked: parents[2] ?? null },
      paths: {
        tracked: diffPaths(tracked),
        staged: diffPaths(staged),
        untracked: diffPaths(untracked),
      },
    });

    return { entry, token, tracked, staged, untracked };
  }

  private reviewed(repositoryId: string, token: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const preview = this.previews.get(token);

    if (
      !preview ||
      preview.repositoryId !== repositoryId ||
      preview.profileId !== repository.identityId ||
      preview.root !== repository.path
    )
      throw invalid(
        errorText("main.stashService.theStashReviewExpiredOrBelongsToAnotherContextInspectItAgain"),
      );

    return preview;
  }

  prepareFile(
    repositoryId: string,
    token: string,
    area: StashArea,
    path: string,
  ): Promise<StashFilePreview> {
    const stash = this.reviewed(repositoryId, token);

    assertRepositoryPath(path, t("operations.restoreStashFile"));

    const source = stash.trees[area];

    if (!source || !stash.paths[area]?.includes(path))
      throw invalid(errorText("main.stashService.chooseAChangedFileFromThisPartOfTheStash"));

    return this.writer.remoteOperation(
      repositoryId,
      t("main.stashService.reviewStashFileRestore"),
      async (root, identity) => {
        if ((await this.read(root)).fingerprint !== stash.fingerprint)
          throw invalid(errorText("main.stashService.theStashListChangedInspectItAgain"));

        const status = await this.git.status(root);

        if (await this.workflows.observe(root, status))
          throw invalid(
            errorText(
              "main.stashService.finishOrAbortTheCurrentGitOperationBeforeRestoringAStashFile",
            ),
          );

        const result = await this.git.exec(
          ["--literal-pathspecs", "ls-tree", "-z", source, "--", path],
          {
            cwd: root,
            operation: t("operations.inspectSavedStashFile"),
            maxStdoutBytes: 64 * 1024,
          },
        );

        const entry = result.stdout
          ? /^(100644|100755) blob (\S+)\t([^\0]+)\0$/.exec(result.stdout)
          : null;

        if (result.stdout && (!entry || !isFullObjectId(entry[2]) || entry[3] !== path))
          throw invalid(
            errorText("main.stashService.individualRestoreSupportsRegularFilesUseTheDedicated"),
          );

        const size = entry
          ? Number(
              (
                await this.git.exec(["cat-file", "-s", entry[2]!], {
                  cwd: root,
                  operation: t("operations.inspectSavedFileSize"),
                })
              ).stdout.trim(),
            )
          : 0;

        if (!Number.isSafeInteger(size) || size > 32 * 1024 * 1024)
          throw invalid(errorText("main.stashService.thisSavedFileExceedsThe32MiBRestoreLimit"));

        const snapshot = await this.recovery.prepareOperation(root, identity.id, repositoryId, [
          path,
        ]);

        snapshot.record.source = "stash-file-restore";

        const preview: StashFilePreview = {
          token: randomUUID(),
          path,
          area,
          deleted: !entry,
          savedBytes: size,
          recoveryBytes: snapshot.record.bytes,
        };

        this.filePreviews.set(preview.token, {
          preview,
          stashToken: token,
          source,
          head: status.branch.oid,
          branch: status.branch.head,
          snapshot,
        });

        return preview;
      },
    );
  }

  restoreFile(repositoryId: string, token: string): Promise<void> {
    const saved = this.filePreviews.get(token);

    if (!saved) throw invalid(errorText("main.stashService.reviewTheSavedFileBeforeRestoringIt"));

    const stash = this.reviewed(repositoryId, saved.stashToken);

    return this.writer.remoteOperation(
      repositoryId,
      t("main.stashService.restoreStashFile"),
      async (root) => {
        const status = await this.git.status(root);

        if (
          status.branch.oid !== saved.head ||
          status.branch.head !== saved.branch ||
          (await this.workflows.observe(root, status))
        )
          throw invalid(
            errorText("main.stashService.theRepositoryStateChangedReviewTheStashFileAgain"),
          );

        if ((await this.read(root)).fingerprint !== stash.fingerprint)
          throw invalid(errorText("main.stashService.theStashListChangedInspectItAgain"));

        await this.recovery.saveOperation(saved.snapshot.record, saved.snapshot.index);
        this.filePreviews.delete(token);

        try {
          if (saved.preview.deleted)
            await unlink(await this.recovery.safePath(root, saved.preview.path)).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              },
            );
          else
            await this.git.exec(
              [
                "--literal-pathspecs",
                "restore",
                `--source=${saved.source}`,
                "--worktree",
                "--ignore-skip-worktree-bits",
                "--",
                saved.preview.path,
              ],
              { cwd: root, operation: t("operations.restoreSavedStashFile") },
            );
        } finally {
          await this.recovery.finishOperation(saved.snapshot.record);
        }
      },
    );
  }

  private async cleanBranchStart(root: string) {
    const status = await this.git.status(root);

    if (
      !status.branch.oid ||
      status.branch.unborn ||
      status.changes.length ||
      (await this.workflows.observe(root, status))
    )
      throw invalid(errorText("main.stashService.commitStashOrMoveLocalChangesAndFinish"));

    return status;
  }

  prepareBranch(repositoryId: string, token: string, name: string): Promise<StashBranchPreview> {
    const stash = this.reviewed(repositoryId, token);

    assertValidRefName(name, t("operations.branchFromStash"));

    return this.writer.remoteOperation(
      repositoryId,
      t("main.stashService.reviewBranchFromStash"),
      async (root) => {
        if (!(await this.git.isRefNameValid(name)))
          throw invalid(errorText("main.stashService.chooseAValidBranchName"));

        const status = await this.cleanBranchStart(root);

        if ((await this.read(root)).fingerprint !== stash.fingerprint)
          throw invalid(errorText("main.stashService.theStashListChangedInspectItAgain"));

        const existing = await this.git.exec(
          ["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
          { cwd: root, operation: t("operations.checkStashBranchName"), allowedExitCodes: [0, 1] },
        );

        if (existing.exitCode === 0)
          throw invalid(errorText("main.stashService.thatBranchAlreadyExistsChooseANewName"));

        const base = (
          await this.git.exec(["rev-parse", `${stash.entry.oid}^1`], {
            cwd: root,
            operation: t("operations.inspectOriginalStashBase"),
          })
        ).stdout.trim();

        assertFullObjectId(base, t("operations.inspectStashBase"));

        const preview: StashBranchPreview = {
          token: randomUUID(),
          name,
          base,
          head: status.branch.oid!,
          branch: status.branch.head ?? null,
        };

        this.branchPreviews.set(preview.token, { preview, stashToken: token });

        return preview;
      },
    );
  }

  createBranch(repositoryId: string, token: string): Promise<{ applied: boolean }> {
    const saved = this.branchPreviews.get(token);

    if (!saved) throw invalid(errorText("main.stashService.reviewTheNewBranchBeforeCreatingIt"));

    const stash = this.reviewed(repositoryId, saved.stashToken);

    return this.writer.remoteOperation(
      repositoryId,
      t("main.stashService.createBranchFromStash"),
      async (root, identity) => {
        const status = await this.cleanBranchStart(root);
        const { preview } = saved;

        if (status.branch.oid !== preview.head || (status.branch.head ?? null) !== preview.branch)
          throw invalid(
            errorText(
              "main.stashService.theCurrentBranchChangedAfterReviewReviewTheNewBranchAgain",
            ),
          );

        if ((await this.read(root)).fingerprint !== stash.fingerprint)
          throw invalid(errorText("main.stashService.theStashListChangedInspectItAgain"));

        this.branchPreviews.delete(token);

        try {
          await this.git.exec(
            [
              "-c",
              "submodule.recurse=false",
              "checkout",
              "--no-overwrite-ignore",
              "-b",
              preview.name,
              preview.base,
            ],
            { cwd: root, operation: t("operations.createStashBranch") },
          );

          const applied = await this.workflows.applyStashInPlace(
            root,
            repositoryId,
            identity,
            stash.entry.oid,
            true,
          );

          return { applied };
        } catch (error) {
          const after = await this.git.status(root).catch(() => null);

          if (after?.branch.head === preview.name)
            throw new GitError({
              kind: "unknown",
              operation: t("operations.createBranchFromStash"),
              message: errorText("main.stashService.branchIsCheckedOutButRestoringTheStash", {
                name: preview.name,
              }),
              suggestedAction: errorText(
                "main.stashService.inspectTheBranchAndContinueOrAbortAnyPendingStashApplication",
              ),
            });

          throw error;
        }
      },
    );
  }

  apply(
    repositoryId: string,
    token: string,
    pop: boolean,
    restoreIndex: boolean,
  ): Promise<{ applied: boolean; kept: boolean }> {
    const preview = this.reviewed(repositoryId, token);

    return this.writer.remoteOperation(
      repositoryId,
      pop ? t("main.stashService.popStash") : t("main.stashService.applyStash"),
      async (root, identity) => {
        if ((await this.read(root)).fingerprint !== preview.fingerprint)
          throw invalid(
            errorText(
              "main.stashService.theStashListChangedAfterReviewInspectItAgainBeforeApplying",
            ),
          );

        this.previews.delete(token);

        const applied = await this.workflows.applyStashInPlace(
          root,
          repositoryId,
          identity,
          preview.entry.oid,
          restoreIndex,
        );

        if (!applied || !pop || (await this.read(root)).fingerprint !== preview.fingerprint)
          return { applied, kept: true };

        try {
          await this.git.exec(["stash", "drop", preview.entry.selector], {
            cwd: root,
            operation: t("operations.dropAppliedStash"),
          });

          return { applied: true, kept: false };
        } catch {
          return { applied: true, kept: true };
        }
      },
    );
  }

  rename(repositoryId: string, token: string, message: string): Promise<{ keptOriginal: boolean }> {
    const preview = this.reviewed(repositoryId, token);
    const name = message.trim();

    if (!name || name.length > MAX_STASH_NAME_LENGTH || /[\r\n\0]/.test(name))
      throw invalid(errorText("main.stashService.enterASingleLineStashNameOf1To1024Characters"));

    return this.writer.remoteOperation(
      repositoryId,
      t("main.stashService.renameStash"),
      async (root, identity) => {
        const workflow = await this.workflows.observe(root, await this.git.status(root));

        if (workflow?.kind === "stash" && workflow.incoming.includes(preview.entry.oid))
          throw invalid(
            errorText("main.stashService.finishOrAbortThisStashApplicationBeforeRenamingItsSource"),
          );

        const before = await this.read(root);

        if (before.fingerprint !== preview.fingerprint)
          throw invalid(
            errorText(
              "main.stashService.theStashListChangedAfterReviewInspectItAgainBeforeRenaming",
            ),
          );

        if (name === preview.entry.message) return { keptOriginal: false };

        const metadata = (
          await this.git.exec(["show", "--no-patch", "--format=%T%x00%P", preview.entry.oid], {
            cwd: root,
            operation: t("operations.inspectStashStructure"),
          })
        ).stdout
          .trim()
          .split("\0");

        const tree = metadata[0]!;
        const parents = metadata[1]?.split(" ") ?? [];

        assertFullObjectId(tree, t("operations.renameStash"));

        if (parents.length < 2 || parents.length > 3)
          throw invalid(errorText("main.stashService.unsupportedStashStructure"));

        for (const parent of parents) assertFullObjectId(parent, t("operations.renameStash"));

        const oid = (
          await this.git.exec(
            [
              "-c",
              "commit.gpgSign=false",
              "commit-tree",
              tree,
              ...parents.flatMap((parent) => ["-p", parent]),
              "-m",
              name,
            ],
            {
              cwd: root,
              operation: t("operations.createRenamedStash"),
              env: {
                overrides: {
                  GIT_AUTHOR_NAME: identity.gitName,
                  GIT_AUTHOR_EMAIL: identity.gitEmail,
                  GIT_COMMITTER_NAME: identity.gitName,
                  GIT_COMMITTER_EMAIL: identity.gitEmail,
                },
              },
            },
          )
        ).stdout.trim();

        assertFullObjectId(oid, t("operations.renameStash"));

        if ((await this.read(root)).fingerprint !== before.fingerprint)
          throw invalid(
            errorText("main.stashService.theStashListChangedInspectItAgainBeforeRenaming"),
          );

        this.previews.delete(token);

        await this.git.exec(["stash", "store", "--message", name, oid], {
          cwd: root,
          operation: t("operations.saveRenamedStash"),
        });

        const after = await this.read(root).catch(() => null);

        if (!after) return { keptOriginal: true };

        const shifted = Number(preview.entry.selector.slice(7, -1)) + 1;
        const expected = before.entries.slice(0, MAX_STASH_ENTRIES);

        if (
          after.entries[0]?.oid !== oid ||
          after.entries[0]?.message !== name ||
          after.entries.length !== Math.min(before.entries.length + 1, 201) ||
          expected.some((entry, index) => {
            const actual = after.entries[index + 1];

            return (
              actual?.oid !== entry.oid ||
              actual.message !== entry.message ||
              actual.timestamp !== entry.timestamp
            );
          }) ||
          after.entries[shifted]?.oid !== preview.entry.oid
        )
          return { keptOriginal: true };

        try {
          await this.git.exec(["stash", "drop", `stash@{${shifted}}`], {
            cwd: root,
            operation: t("operations.removeOriginalStashDescription"),
          });

          return { keptOriginal: false };
        } catch {
          return { keptOriginal: true };
        }
      },
    );
  }

  drop(repositoryId: string, token: string): Promise<void> {
    const preview = this.reviewed(repositoryId, token);

    return this.writer.remoteOperation(
      repositoryId,
      t("main.stashService.dropStash"),
      async (root) => {
        const workflow = await this.workflows.observe(root, await this.git.status(root));

        if (workflow?.kind === "stash" && workflow.incoming.includes(preview.entry.oid))
          throw invalid(
            errorText("main.stashService.finishOrAbortThisStashApplicationBeforeDroppingItsSource"),
          );

        const current = await this.read(root);

        if (current.fingerprint !== preview.fingerprint)
          throw invalid(
            errorText(
              "main.stashService.theStashListChangedAfterReviewInspectItAgainBeforeDropping",
            ),
          );

        this.previews.delete(token);

        await this.git.exec(["stash", "drop", preview.entry.selector], {
          cwd: root,
          operation: t("operations.dropReviewedStash"),
        });
      },
    );
  }
}
