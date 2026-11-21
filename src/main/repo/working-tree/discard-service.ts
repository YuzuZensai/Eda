import { isFullObjectId } from "@shared/repository/object-id";
import { readRegularFile } from "../../filesystem/read-regular-file";
import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { GIT_FILE_MODE, isRegularFileMode } from "@shared/repository/git-file-mode";
import type { PartialStageRequest } from "@shared/repository/partial-stage";
import type { DiscardPreview, RecoverySummary } from "@shared/workflows/recovery";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitService } from "../../git/git-service";
import { partialPatch } from "../../git/operations/partial-patch";
import { workingFilePath } from "../../filesystem/working-file-path";
import {
  recoveryFileHash,
  type ContentRecoveryRecord,
  type ContentRecoveryRepository,
  type SavedFile,
} from "../../persistence/content-recovery-repository";

const invalid = (message: ErrorText) =>
  new GitError({ kind: "invalid-input", operation: t("operations.recoverLocalChanges"), message });
const MAX_BYTES = 32 * 1024 * 1024;

export type OperationSnapshot = Awaited<ReturnType<DiscardService["prepareOperation"]>>;

export class DiscardService {
  async prepareOperation(
    root: string,
    profileId: string,
    repositoryId: string,
    paths: string[],
    options: { working?: boolean } = {},
  ) {
    if (paths.length > 256 || new Set(paths).size !== paths.length)
      throw invalid(
        errorText("main.discardService.recoverySupportsAtMost256AffectedPathsNoFilesWereChanged"),
      );

    const files: SavedFile[] = [];
    const savedIndex: NonNullable<ContentRecoveryRecord["savedIndex"]> = [];
    let bytes = 0;

    for (const path of paths) {
      if (options.working !== false) {
        files.push(await this.capture(root, path, true));
        bytes += Buffer.byteLength(files.at(-1)!.content ?? "", "base64");
      }

      const result = await this.git.exec(
        ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", path],
        {
          cwd: root,
          operation: t("operations.preserveOperationIndex"),
          maxStdoutBytes: 64 * 1024,
        },
      );

      for (const row of result.stdout.split("\0").filter(Boolean)) {
        const entry = /^(\d{6}) (\S+) ([0-3])\t([\s\S]+)$/.exec(row);

        if (
          !entry ||
          !isFullObjectId(entry[2]) ||
          entry[4] !== path ||
          (entry[1] === GIT_FILE_MODE.submodule && options.working !== false)
        )
          throw invalid(
            errorText(
              "main.discardService.thisPathRequiresSubmoduleOrDirectoryRecoveryNoFilesWereChanged",
            ),
          );

        const content =
          entry[1] === GIT_FILE_MODE.submodule
            ? { stdoutBytes: Buffer.from(`${entry[2]}\n`) }
            : await this.git.exec(["cat-file", "blob", entry[2]!], {
                cwd: root,
                operation: t("operations.preserveStagedContent"),
                maxStdoutBytes: MAX_BYTES,
              });

        bytes += content.stdoutBytes.length;
        savedIndex.push({
          path,
          stage: Number(entry[3]),
          mode: entry[1]!,
          content: content.stdoutBytes.toString("base64"),
        });
      }

      if (bytes > MAX_BYTES)
        throw invalid(
          errorText("main.discardService.theRecoveryCopyExceeds32MiBNoFilesWereChanged"),
        );
    }

    const record: ContentRecoveryRecord = {
      id: randomUUID(),
      root,
      profileId,
      repositoryId,
      paths,
      files,
      savedIndex,
      ...(options.working === false ? { indexOnly: true } : {}),
      source: "merge-abort",
      indexVersions: savedIndex.map(({ path, stage, mode }) => ({ path, stage, mode })),
      state: "prepared",
      createdAt: new Date().toISOString(),
      bytes,
    };

    return { record, index: await this.index(root, paths) };
  }

  private async readRegularTree(root: string, oid: string, paths: string[]) {
    const result = await this.git.exec(
      ["--literal-pathspecs", "ls-tree", "-r", "-z", oid, "--", ...paths],
      {
        cwd: root,
        operation: t("operations.reviewRewriteRecoveryTree"),
        maxStdoutBytes: 1024 * 1024,
      },
    );

    const entries = new Map<string, { mode: string; oid: string }>();

    for (const row of result.stdout.split("\0").filter(Boolean)) {
      const match = /^(\d{6}) (\w+) (\S+)\t([\s\S]+)$/.exec(row);
      if (
        !match ||
        match[2] !== "blob" ||
        !isFullObjectId(match[3]) ||
        !isRegularFileMode(match[1]!)
      )
        throw invalid(
          errorText("main.discardService.thisRewriteAffectsASymlinkSubmoduleOrAnother"),
        );
      entries.set(match[4]!, { mode: match[1]!, oid: match[3]! });
    }

    return entries;
  }

  async prepareTreeOperation(
    root: string,
    profileId: string,
    repositoryId: string,
    fromOid: string,
    toOid: string,
    paths: string[],
  ): Promise<ContentRecoveryRecord> {
    if (!paths.length || paths.length > 256 || new Set(paths).size !== paths.length)
      throw invalid(
        errorText("main.discardService.recoverySupportsBetween1And256DistinctAffectedPaths"),
      );

    const fromEntries = await this.readRegularTree(root, fromOid, paths);
    const toEntries = await this.readRegularTree(root, toOid, paths);
    const files: SavedFile[] = [];
    const after: Record<string, string> = Object.create(null);
    let bytes = 0;

    for (const path of paths) {
      const from = fromEntries.get(path);
      const to = toEntries.get(path);

      if (from) {
        const content = await this.git.exec(["cat-file", "blob", from.oid], {
          cwd: root,
          operation: t("operations.preserveRewrittenFile"),
          maxStdoutBytes: MAX_BYTES,
        });

        bytes += content.stdoutBytes.length;

        if (bytes > MAX_BYTES)
          throw invalid(errorText("main.discardService.theRewriteAffectsMoreThan32MiBOf"));

        const mode = process.platform === "win32" ? 0o666 : Number.parseInt(from.mode.slice(-3), 8);

        files.push({
          path,
          content: content.stdoutBytes.toString("base64"),
          mode,
          gitMode: from.mode,
          hash: recoveryFileHash(content.stdoutBytes, mode),
          tracked: true,
        });
      } else {
        files.push({ path, content: null, mode: 0, hash: "missing", tracked: true });
      }

      if (to) {
        const current = await this.capture(root, path, true);
        if (current.hash === "missing")
          throw invalid(errorText("main.discardService.theWorkingFileDoesNotMatchTheCompleted"));
        after[path] = current.hash;
      } else {
        const current = await this.capture(root, path, true);
        if (current.hash !== "missing")
          throw invalid(
            errorText("main.discardService.theCompletedRewriteLeftAnUnexpectedTrackedPath"),
          );
        after[path] = "missing";
      }
    }

    const record: ContentRecoveryRecord = {
      id: randomUUID(),
      root,
      profileId,
      repositoryId,
      paths,
      files,
      source: "rewrite-recovery",
      state: "completed",
      createdAt: new Date().toISOString(),
      bytes,
      after,
    };

    this.store.prune(profileId, repositoryId);
    this.store.save(record);

    return record;
  }

  async saveOperation(record: ContentRecoveryRecord, index: string): Promise<void> {
    if ((await this.index(record.root, record.paths)) !== index)
      throw invalid(
        errorText("main.discardService.theIndexChangedAfterReviewingThisOperationReviewItAgain"),
      );

    for (const file of record.files)
      if ((await this.capture(record.root, file.path, true)).hash !== file.hash)
        throw invalid(
          errorText("main.discardService.aFileChangedAfterReviewingThisOperationReviewItAgain"),
        );

    this.store.prune(record.profileId, record.repositoryId);

    const pending = this.store
      .list(record.profileId, record.repositoryId)
      .filter((item) => item.state === "prepared");

    if (
      pending.length >= 100 ||
      pending.reduce((sum, item) => sum + item.bytes, 0) + record.bytes > 256 * 1024 * 1024
    )
      throw invalid(
        errorText(
          "main.discardService.recoveryStorageIsFullInspectExistingSnapshotsBeforeContinuing",
        ),
      );

    this.store.save(record);
  }

  async finishOperation(record: ContentRecoveryRecord): Promise<void> {
    const after: Record<string, string> = Object.create(null);
    for (const file of record.files)
      after[file.path] = (await this.capture(record.root, file.path, true)).hash;
    this.store.save({ ...record, state: "completed", after });
  }

  async removeIntroduced(record: ContentRecoveryRecord, paths: string[]): Promise<void> {
    for (const path of paths) {
      const saved = record.files.find((file) => file.path === path);
      if (!saved)
        throw invalid(
          errorText("main.discardService.theRecoveryCopyDoesNotCoverARestoredUntrackedPath"),
        );
      const current = await this.capture(record.root, path, false);
      if (current.hash !== saved.hash && current.content !== null)
        throw invalid(
          errorText(
            "main.discardService.aRestoredFileChangedDuringAbortItsNewerContentsWereRetained",
          ),
        );
      if (current.content !== null) await unlink(await this.safePath(record.root, path));
    }
  }

  private readonly previews = new Map<
    string,
    { record: ContentRecoveryRecord; index: string; expires: number; patch?: string }
  >();

  constructor(
    private readonly git: GitService,
    private readonly store: ContentRecoveryRepository,
  ) {}

  safePath(root: string, path: string) {
    return workingFilePath(root, path, t("operations.discardLocalChanges"));
  }

  private async capture(root: string, path: string, tracked: boolean): Promise<SavedFile> {
    const target = await this.safePath(root, path);
    const captured = await readRegularFile(target, MAX_BYTES, () =>
      invalid(errorText("main.discardService.recoverySupportsRegularFilesUpTo32MiB")),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!captured) return { path, content: null, mode: 0, hash: "missing", tracked };
    const { bytes: content, entry: stat } = captured;

    return {
      path,
      content: content.toString("base64"),
      mode: stat.mode & 0o777,
      hash: recoveryFileHash(content, stat.mode),
      tracked,
    };
  }

  private async index(root: string, paths: string[]): Promise<string> {
    const result = await this.git.exec(
      ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...paths],
      { cwd: root, operation: t("operations.inspectDiscardIndex") },
    );
    return createHash("sha256").update(result.stdoutBytes).digest("hex");
  }

  async preview(
    root: string,
    profileId: string,
    repositoryId: string,
    paths: string[],
  ): Promise<DiscardPreview> {
    if (!paths.length || paths.length > 256 || new Set(paths).size !== paths.length)
      throw invalid(errorText("main.discardService.selectBetween1And256DistinctFiles"));

    const status = await this.git.status(root);
    const files: SavedFile[] = [];
    let bytes = 0;

    for (const path of paths) {
      const change = status.changes.find((change) => change.path === path);

      if (
        !change ||
        change.kind === "unmerged" ||
        change.submodule !== "N..." ||
        (change.worktree === "." && change.kind !== "untracked")
      )
        throw invalid(
          errorText("main.discardService.refreshTheChangesChooseUnstagedRegularFilesWithout"),
        );

      const file = await this.capture(root, path, change.kind !== "untracked");

      files.push(file);
      bytes += file.content ? Buffer.byteLength(file.content, "base64") : 0;

      if (bytes > MAX_BYTES)
        throw invalid(
          errorText("main.discardService.theSelectionExceedsThe32MiBRecoveryLimitSelectFewerFiles"),
        );
    }

    const token = randomUUID();
    const record: ContentRecoveryRecord = {
      id: randomUUID(),
      root,
      profileId,
      repositoryId,
      createdAt: new Date().toISOString(),
      paths: [...paths],
      files,
      bytes,
      state: "prepared",
    };

    this.previews.set(token, {
      record,
      index: await this.index(root, paths),
      expires: Date.now() + 300_000,
    });

    while (
      this.previews.size > 8 ||
      [...this.previews.values()].reduce((sum, preview) => sum + preview.record.bytes, 0) >
        64 * 1024 * 1024
    )
      this.previews.delete(this.previews.keys().next().value!);

    return {
      token,
      paths,
      bytes,
      tracked: files.filter((file) => file.tracked).length,
      untracked: files.filter((file) => !file.tracked).length,
    };
  }

  async previewPartial(
    root: string,
    profileId: string,
    request: PartialStageRequest,
  ): Promise<DiscardPreview> {
    if (request.area !== "unstaged")
      throw invalid(
        errorText("main.discardService.unstageChangesBeforeDiscardingSelectedWorkingFileContent"),
      );

    const preview = await this.preview(root, profileId, request.repositoryId, [request.path]);
    const pending = this.previews.get(preview.token)!;
    const untracked = !pending.record.files[0]!.tracked;
    const flags = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3"];
    const args = untracked
      ? [
          "diff",
          "--no-index",
          ...flags,
          "--",
          process.platform === "win32" ? "NUL" : "/dev/null",
          request.path,
        ]
      : ["--literal-pathspecs", "diff", ...flags, "--", request.path];

    const source = await this.git.exec(args, {
      cwd: root,
      operation: t("operations.previewPartialDiscard"),
      allowedExitCodes: untracked ? [0, 1] : [0],
      maxStdoutBytes: 1024 * 1024,
    });

    try {
      new TextDecoder("utf-8", { fatal: true }).decode(source.stdoutBytes);
    } catch {
      throw invalid(errorText("main.discardService.partialDiscardRequiresUtf8TextUseAWhole"));
    }

    const { patch } = partialPatch(source.stdout, request.path, { ...request, area: "staged" });

    await this.git.exec(["apply", "--check", "--whitespace=nowarn", "-"], {
      cwd: root,
      operation: t("operations.checkPartialDiscard"),
      stdin: patch,
    });
    pending.patch = patch;

    return { ...preview, patch };
  }

  async apply(root: string, profileId: string, repositoryId: string, token: string): Promise<void> {
    const preview = this.previews.get(token);

    if (
      !preview ||
      preview.expires < Date.now() ||
      preview.record.profileId !== profileId ||
      preview.record.repositoryId !== repositoryId ||
      preview.record.root !== root
    )
      throw invalid(
        errorText(
          "main.discardService.theDiscardPreviewExpiredOrBelongsToAnotherContextPreviewAgain",
        ),
      );

    this.previews.delete(token);

    const { record } = preview;

    if ((await this.index(root, record.paths)) !== preview.index)
      throw invalid(errorText("main.discardService.theIndexChangedPreviewTheDiscardAgain"));

    for (const file of record.files)
      if ((await this.capture(root, file.path, file.tracked)).hash !== file.hash)
        throw invalid(
          errorText("main.discardService.aSelectedFileChangedAfterThePreviewPreviewAgain"),
        );

    this.store.prune(profileId, repositoryId);

    const pending = this.store
      .list(profileId, repositoryId)
      .filter((record) => record.state === "prepared");

    if (
      pending.length >= 100 ||
      pending.reduce((sum, record) => sum + record.bytes, 0) + record.bytes > 256 * 1024 * 1024
    )
      throw invalid(
        errorText("main.discardService.interruptedSnapshotsReachedTheRecoveryStorageLimitExport"),
      );

    this.store.save(record);

    try {
      if (preview.patch) {
        await this.git.exec(["apply", "--whitespace=nowarn", "-"], {
          cwd: root,
          operation: t("operations.discardSelectedWorkingFileChanges"),
          stdin: preview.patch,
        });
      } else {
        const tracked = record.files.filter((file) => file.tracked).map((file) => file.path);

        if (tracked.length)
          await this.git.exec(["--literal-pathspecs", "restore", "--worktree", "--", ...tracked], {
            cwd: root,
            operation: t("operations.discardTrackedWorktreeChanges"),
          });

        for (const file of record.files.filter((file) => !file.tracked)) {
          const target = await this.safePath(root, file.path);
          if ((await this.capture(root, file.path, false)).hash !== file.hash)
            throw invalid(
              errorText(
                "main.discardService.anUntrackedFileChangedDuringDiscardItsNewerContentsWerePreserved",
              ),
            );
          await unlink(target);
        }
      }
    } finally {
      const after: Record<string, string> = Object.create(null);
      for (const file of record.files)
        after[file.path] = (await this.capture(root, file.path, file.tracked)).hash;
      this.store.save({ ...record, state: "completed", after });
      this.store.prune(profileId, repositoryId);
    }
  }

  list(profileId: string, repositoryId: string): RecoverySummary[] {
    this.store.prune(profileId, repositoryId);

    return this.store
      .list(profileId, repositoryId)
      .map(({ id, paths, state, bytes, createdAt, source, indexVersions, indexOnly }) => ({
        id,
        paths,
        state,
        bytes,
        createdAt,
        ...(source ? { source } : {}),
        ...(indexVersions ? { indexVersions } : {}),
        ...(indexOnly ? { indexOnly } : {}),
      }));
  }

  savedFile(
    profileId: string,
    repositoryId: string,
    id: string,
    path: string,
    stage?: number,
  ): Buffer {
    const record = this.store.get(profileId, repositoryId, id, "inspect");

    if (stage !== undefined) {
      const entry = record?.savedIndex?.find((item) => item.path === path && item.stage === stage);
      if (!entry)
        throw invalid(errorText("main.discardService.thisSavedIndexVersionIsUnavailable"));
      return Buffer.from(entry.content, "base64");
    }

    const file = record?.files.find((file) => file.path === path);

    if (!file || file.content === null)
      throw invalid(
        errorText("main.discardService.thisSnapshotRecordsAnAbsentFileOrTheSavedFileIsUnavailable"),
      );

    return Buffer.from(file.content, "base64");
  }

  forget(profileId: string, repositoryId: string, id: string): void {
    if (!this.store.get(profileId, repositoryId, id, "inspect"))
      throw invalid(errorText("main.discardService.thisSnapshotIsNoLongerAvailable"));
    this.store.remove(profileId, repositoryId, id);
  }

  async restore(root: string, profileId: string, repositoryId: string, id: string): Promise<void> {
    const record = this.store.get(profileId, repositoryId, id);

    if (record?.indexOnly)
      throw invalid(
        errorText("main.discardService.thisSnapshotPreservesIndexVersionsOnlyExportThe"),
      );

    if (!record || record.root !== root || record.state !== "completed" || !record.after)
      throw invalid(
        errorText("main.discardService.thisSnapshotCannotBeRestoredAutomaticallyInspectIts"),
      );

    await this.restoreOperationFiles(record, record.after);
    this.store.save({ ...record, state: "restored" });
  }

  async validateOperationFiles(
    record: ContentRecoveryRecord,
    expected: Record<string, string>,
    allowRestored = false,
  ) {
    // Earlier Windows rewrite snapshots stored 0666 for both regular files and symlinks.
    if (record.source === "rewrite-recovery") {
      const ambiguous = record.files.filter((file) => file.mode === 0o666 && !file.gitMode);
      if (ambiguous.length) {
        const tree = this.store.originalRewriteTree(record);
        const paths = ambiguous.map((file) => file.path);
        const entries = tree && (await this.readRegularTree(record.root, tree, paths));
        if (!entries || paths.some((path) => !entries.has(path)))
          throw invalid(
            errorText("main.discardService.thisSnapshotCannotBeRestoredAutomaticallyInspectIts"),
          );
      }
    }
    for (const file of record.files) {
      const current = await this.capture(record.root, file.path, file.tracked);
      if (current.hash !== expected[file.path] && !(allowRestored && current.hash === file.hash))
        throw invalid(
          errorText(
            "main.discardService.aFileChangedSinceTheOperationRestoreIsBlockedToProtectNewerWork",
          ),
        );
    }
  }

  async restoreOperationFiles(record: ContentRecoveryRecord, expected: Record<string, string>) {
    await this.validateOperationFiles(record, expected, true);

    for (const file of record.files) {
      const current = await this.capture(record.root, file.path, file.tracked);

      if (current.hash === file.hash) continue;
      if (current.hash !== expected[file.path])
        throw invalid(
          errorText("main.discardService.aFileChangedDuringRecoveryItsNewerContentWasPreserved"),
        );

      const target = await this.safePath(record.root, file.path);

      if (file.content === null)
        await unlink(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      else {
        await mkdir(dirname(target), { recursive: true });
        const temporary = join(dirname(target), `eda-restore-${randomUUID()}`);
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(Buffer.from(file.content, "base64"));
          await handle.chmod(file.mode);
          await handle.close();
          await rename(temporary, await this.safePath(record.root, file.path));
        } finally {
          await handle.close();
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
    }
  }
}
