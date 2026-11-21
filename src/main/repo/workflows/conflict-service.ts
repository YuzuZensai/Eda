import { isFullObjectId } from "@shared/repository/object-id";
import { scanConflictMarkers } from "@shared/workflows/conflict-markers";
import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { GIT_FILE_MODE, isRegularFileMode } from "@shared/repository/git-file-mode";
import type {
  ConflictPreview,
  ConflictVersion,
  ResolveConflictRequest,
} from "@shared/workflows/workflow";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readlink, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExternalMergeTool } from "../../git/external-merge-tool";
import type { GitService } from "../../git/git-service";
import { readWorkflowState } from "../../git/operations/workflow-state";
import { assertRepositoryPath } from "../../git/validation";
import type { SettingsRepository } from "../../persistence/settings-repository";
import { PreviewStore } from "../preview-store";
import type { RepositoryManager } from "../lifecycle/repository-manager";
import type { RepositoryWriter } from "../working-tree/repository-writer";
import type { WorkflowService } from "./workflow-service";

const MAX_BYTES = 4 * 1024 * 1024;
const PREVIEW_BYTES = 512 * 1024;
const invalid = (message: ErrorText) =>
  new GitError({ kind: "invalid-input", operation: t("operations.resolveConflict"), message });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function text(bytes: Buffer): string | null {
  if (bytes.length > PREVIEW_BYTES || bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

interface Entry {
  mode: string;
  oid: string;
  stage: number;
}

interface Snapshot {
  preview: ConflictPreview;
  root: string;
  repositoryId: string;
  profileId: string;
  index: string;
  fileHash: string;
  entries: Entry[];
}

export class ConflictService {
  private readonly previews = new PreviewStore<Snapshot>(8, 30 * 60_000);

  constructor(
    private readonly git: GitService,
    private readonly repositories: RepositoryManager,
    private readonly writer: RepositoryWriter,
    private readonly workflows?: Pick<WorkflowService, "observe">,
    private readonly externalTool?: ExternalMergeTool,
    private readonly settings?: SettingsRepository,
  ) {}

  private async target(root: string, path: string): Promise<string> {
    assertRepositoryPath(path, t("operations.resolveConflict"));

    const target = resolve(root, path);
    const local = relative(resolve(root), target);

    if (
      !local ||
      local.startsWith(`..${sep}`) ||
      local.split(sep).some((part) => part.toLowerCase() === ".git")
    )
      throw invalid(errorText("main.conflictService.chooseAWorkingPathInsideThisRepository"));

    let parent = resolve(root);

    for (const part of local.split(sep).slice(0, -1)) {
      parent = join(parent, part);

      const entry = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });

      if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
        throw invalid(errorText("main.conflictService.aParentPathIsALinkOrNon"));
    }

    return target;
  }

  private async working(target: string, markerSize?: number) {
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    let kind: ConflictPreview["outputKind"] = "missing";
    let bytes = Buffer.alloc(0);

    if (info?.isSymbolicLink()) {
      kind = "symlink";
      bytes = Buffer.from(await readlink(target));
    } else if (info?.isDirectory()) kind = "directory";
    else if (info) {
      if (!info.isFile())
        throw invalid(
          errorText("main.conflictService.thisConflictUsesASpecialFilesystemObjectResolve"),
        );

      kind = "file";

      const handle = await open(target, "r");

      try {
        const digest = createHash("sha256").update(`${kind}:${info.mode}:`);
        const buffer = Buffer.alloc(256 * 1024);
        const prefix: Buffer[] = [];
        let total = 0;
        let retained = 0;
        const scan = markerSize === undefined ? null : scanConflictMarkers(markerSize);
        let hasMarkers = false;

        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);

          if (!bytesRead) break;

          const chunk = buffer.subarray(0, bytesRead);

          digest.update(chunk);

          if (scan && !hasMarkers) hasMarkers = scan(chunk.toString("utf8"));
          total += bytesRead;

          if (total > info.size)
            throw invalid(
              errorText("main.conflictService.theConflictFileChangedWhileReadingInspectItAgain"),
            );

          if (retained <= PREVIEW_BYTES) {
            const keep = Math.min(bytesRead, PREVIEW_BYTES + 1 - retained);
            prefix.push(Buffer.from(chunk.subarray(0, keep)));
            retained += keep;
          }
        }

        const after = await handle.stat();

        if (
          total !== info.size ||
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.mode !== info.mode
        )
          throw invalid(
            errorText("main.conflictService.theConflictFileChangedWhileReadingInspectItAgain"),
          );

        if (scan && !hasMarkers) hasMarkers = scan("", true);

        return { kind, bytes: Buffer.concat(prefix), hash: digest.digest("hex"), hasMarkers };
      } finally {
        await handle.close();
      }
    }

    return {
      kind,
      bytes,
      hash: hash(Buffer.concat([Buffer.from(`${kind}:${info?.mode ?? 0}:`), bytes])),
      hasMarkers: false,
    };
  }

  private async index(root: string, path: string) {
    const { stdout } = await this.git.exec(
      ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", path],
      { cwd: root, operation: t("operations.inspectConflictEntries"), maxStdoutBytes: 64 * 1024 },
    );
    const entries: Entry[] = [];

    for (const row of stdout.split("\0").filter(Boolean)) {
      const match = /^(\d{6}) (\S+) ([0-3])\t([\s\S]+)$/.exec(row);
      if (!match || !isFullObjectId(match[2]) || match[4] !== path)
        throw invalid(
          errorText(
            "main.conflictService.gitReturnedUnexpectedConflictEntriesRefreshBeforeResolving",
          ),
        );
      entries.push({ mode: match[1]!, oid: match[2]!, stage: Number(match[3]) });
    }

    return { raw: stdout, entries };
  }

  private async blob(root: string, entry: Entry): Promise<Buffer> {
    const { stdoutBytes } = await this.git.exec(["cat-file", "blob", entry.oid], {
      cwd: root,
      operation: t("operations.readConflictVersion"),
      maxStdoutBytes: MAX_BYTES,
    });
    return stdoutBytes;
  }

  async inspect(repositoryId: string, path: string): Promise<ConflictPreview> {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const target = await this.target(repository.path, path);
    const attribute = await this.git.exec(
      ["check-attr", "-z", "conflict-marker-size", "--", path],
      {
        cwd: repository.path,
        operation: t("operations.inspectConflictEntries"),
        maxStdoutBytes: 64 * 1024,
      },
    );
    const size = Number(attribute.stdout.split("\0")[2]);
    const markerSize = Number.isInteger(size) && size > 0 && size <= 0x7fffffff ? size : 7;
    const [index, file, status] = await Promise.all([
      this.index(repository.path, path),
      this.working(target, markerSize),
      this.git.status(repository.path),
    ]);

    if (!index.entries.some((entry) => entry.stage > 0))
      throw invalid(
        errorText(
          "main.conflictService.thisPathNoLongerHasUnresolvedIndexEntriesRefreshTheConflictList",
        ),
      );

    const version = async (stage: number): Promise<ConflictVersion | null> => {
      const entry = index.entries.find((item) => item.stage === stage);

      if (!entry) return null;

      const size =
        entry.mode === GIT_FILE_MODE.submodule
          ? 0
          : Number(
              (
                await this.git.exec(["cat-file", "-s", entry.oid], {
                  cwd: repository.path,
                  operation: t("operations.inspectConflictSize"),
                })
              ).stdout.trim(),
            );

      if (!Number.isSafeInteger(size) || size < 0)
        throw invalid(errorText("main.conflictService.gitReturnedAnInvalidConflictSize"));

      const bytes =
        entry.mode === GIT_FILE_MODE.submodule || size > PREVIEW_BYTES
          ? null
          : await this.blob(repository.path, entry);

      return {
        oid: entry.oid,
        mode: entry.mode,
        bytes: size,
        text: bytes ? text(bytes) : null,
      };
    };

    const [base, current, incoming] = await Promise.all([version(1), version(2), version(3)]);
    const preview: ConflictPreview = {
      token: randomUUID(),
      path,
      markerSize,
      hasMarkers: file.hasMarkers,
      workflow: this.workflows
        ? await this.workflows.observe(repository.path, status)
        : await readWorkflowState(this.git, repository.path, status),
      base,
      current,
      incoming,
      output: file.kind === "file" ? text(file.bytes) : null,
      outputKind: file.kind,
      newline: file.bytes.includes(Buffer.from("\r\n")) ? "crlf" : "lf",
    };

    this.previews.set(preview.token, {
      preview,
      root: repository.path,
      repositoryId,
      profileId: repository.identityId,
      index: index.raw,
      entries: index.entries,
      fileHash: file.hash,
    });

    return preview;
  }

  external(repositoryId: string, token: string): Promise<{ text: string; stale: boolean }> {
    const snapshot = this.previews.get(token);
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const tool = this.externalTool;
    const config = this.settings?.resolve("mergeTool", { profileId: repository.identityId }).value;

    if (!tool || !config?.executable)
      throw invalid(
        errorText("main.conflictService.configureAnExternalMergeToolInApplicationSettingsFirst"),
      );

    if (
      !snapshot ||
      snapshot.repositoryId !== repositoryId ||
      snapshot.root !== repository.path ||
      snapshot.profileId !== repository.identityId
    )
      throw invalid(
        errorText("main.conflictService.inspectThisConflictAgainBeforeOpeningAnExternalTool"),
      );

    const { preview } = snapshot;

    if (
      preview.output === null ||
      [preview.base, preview.current, preview.incoming].some(
        (version) => version && (!isRegularFileMode(version.mode) || version.text === null),
      )
    )
      throw invalid(
        errorText("main.conflictService.externalMergeCurrentlySupportsUtf8TextConflictsUse"),
      );

    return this.writer.remoteOperation(
      repositoryId,
      t("main.conflictService.externalMergeTool"),
      async (root) => {
        const target = await this.target(root, preview.path);
        const unchanged = async () => {
          await this.target(root, preview.path);

          const [index, file, status] = await Promise.all([
            this.index(root, preview.path),
            this.working(target),
            this.git.status(root),
          ]);
          const workflow = this.workflows
            ? await this.workflows.observe(root, status)
            : await readWorkflowState(this.git, root, status);

          return (
            index.raw === snapshot.index &&
            file.hash === snapshot.fileHash &&
            workflow?.token === preview.workflow?.token
          );
        };

        if (!(await unchanged()))
          throw invalid(
            errorText(
              "main.conflictService.theConflictChangedRecheckDiskStateBeforeOpeningTheExternalTool",
            ),
          );

        const text = await tool.run(config, {
          base: Buffer.from(preview.base?.text ?? ""),
          current: Buffer.from(preview.current?.text ?? ""),
          incoming: Buffer.from(preview.incoming?.text ?? ""),
          result: Buffer.from(preview.output!),
        });

        return { text, stale: !(await unchanged().catch(() => false)) };
      },
    );
  }

  resolve(request: ResolveConflictRequest): Promise<void> {
    const snapshot = this.previews.get(request.token);
    const repository = this.repositories.resolveActiveRepository(request.repositoryId);

    if (
      !snapshot ||
      snapshot.repositoryId !== request.repositoryId ||
      snapshot.root !== repository.path ||
      snapshot.profileId !== repository.identityId
    )
      throw invalid(errorText("main.conflictService.thisConflictPreviewExpiredOrBelongsToA"));

    return this.writer.remoteOperation(
      request.repositoryId,
      t("main.conflictService.resolveConflict"),
      async (root) => {
        const { preview } = snapshot;
        const target = await this.target(root, preview.path);
        const [index, file, status] = await Promise.all([
          this.index(root, preview.path),
          this.working(
            target,
            request.stage && request.choice === "worktree" ? preview.markerSize : undefined,
          ),
          this.git.status(root),
        ]);
        const workflow = this.workflows
          ? await this.workflows.observe(root, status)
          : await readWorkflowState(this.git, root, status);

        if (
          index.raw !== snapshot.index ||
          file.hash !== snapshot.fileHash ||
          workflow?.token !== preview.workflow?.token
        )
          throw invalid(
            errorText("main.conflictService.theConflictOrWorkingFileChangedAfterInspection"),
          );

        let bytes: Buffer | null = null;
        const selected =
          request.choice === "current"
            ? preview.current
            : request.choice === "incoming"
              ? preview.incoming
              : null;

        const mode =
          selected?.mode ??
          preview.current?.mode ??
          preview.incoming?.mode ??
          GIT_FILE_MODE.regular;

        if (request.choice === "text") {
          if (
            preview.outputKind === "symlink" ||
            preview.outputKind === "directory" ||
            [preview.current, preview.incoming].some(
              (entry) => entry && !isRegularFileMode(entry.mode),
            )
          )
            throw invalid(
              errorText("main.conflictService.useAWholeSideChoiceForSymlinkOrSubmoduleConflicts"),
            );

          if (request.text === undefined || Buffer.byteLength(request.text) > MAX_BYTES)
            throw invalid(
              errorText("main.conflictService.enterResolvedTextWithinThe4MiBEditorLimit"),
            );

          bytes = Buffer.from(
            preview.newline === "crlf" ? request.text.replace(/\r?\n/g, "\r\n") : request.text,
          );
        }

        if (
          request.stage &&
          (request.choice === "text" || request.choice === "worktree") &&
          (request.choice === "worktree"
            ? file.hasMarkers
            : scanConflictMarkers(preview.markerSize)(request.text ?? "", true))
        )
          throw invalid(
            errorText("main.conflictService.removeConflictMarkersBeforeMarkingThisPathResolved"),
          );

        const submodule =
          mode === GIT_FILE_MODE.submodule ||
          snapshot.entries.some((entry) => entry.mode === GIT_FILE_MODE.submodule);

        if (submodule && (selected?.mode === GIT_FILE_MODE.submodule || !selected)) {
          if (!request.stage || request.choice === "text" || request.choice === "worktree")
            throw invalid(
              errorText("main.conflictService.chooseASubmoduleCommitOrDeletionAndMark"),
            );

          if (selected)
            await this.git.exec(
              [
                "update-index",
                "--add",
                "--cacheinfo",
                `${selected.mode},${selected.oid},${preview.path}`,
              ],
              { cwd: root, operation: t("operations.resolveSubmoduleEntry") },
            );
          else
            await this.git.exec(["update-index", "--force-remove", "--", preview.path], {
              cwd: root,
              operation: t("operations.resolveSubmoduleDeletion"),
            });

          this.previews.delete(request.token);

          return;
        }

        if (file.kind === "directory")
          throw invalid(errorText("main.conflictService.aDirectoryOccupiesThisConflictPathMoveIt"));

        if (request.choice !== "worktree") {
          if (selected) {
            await mkdir(dirname(target), { recursive: true });

            const temporary = await mkdtemp(join(dirname(target), ".eda-resolve-"));

            try {
              await this.git.exec(
                [
                  "checkout-index",
                  "--force",
                  `--prefix=${temporary.replaceAll("\\", "/")}/`,
                  `--stage=${request.choice === "current" ? 2 : 3}`,
                  "--",
                  preview.path,
                ],
                { cwd: root, operation: t("operations.restoreConflictSide") },
              );

              if ((await this.working(target)).hash !== file.hash)
                throw invalid(
                  errorText(
                    "main.conflictService.theWorkingFileChangedWhilePreparingTheResolutionInspectItAgain",
                  ),
                );

              await rename(join(temporary, preview.path), target);
            } catch (error) {
              if (selected.mode === GIT_FILE_MODE.symlink)
                throw new GitError({
                  kind: "invalid-input",
                  operation: t("operations.restoreSymlinkConflictSide"),
                  message: errorText(
                    "main.conflictService.gitCouldNotInstallTheSelectedSymlinkTheConflictRemainsUnresolved",
                  ),
                  suggestedAction: errorText(
                    "main.conflictService.inspectTheWorkingFileAndGitSSymlink",
                  ),
                });

              throw error;
            } finally {
              await rm(temporary, { recursive: true, force: true });
            }
          } else if (bytes === null) {
            if (file.kind !== "missing") await unlink(target);
          } else {
            await mkdir(dirname(target), { recursive: true });

            const temporary = join(dirname(target), `.eda-resolve-${randomUUID()}`);

            try {
              const handle = await open(temporary, "wx");

              try {
                await handle.writeFile(bytes);
              } finally {
                await handle.close();
              }

              await chmod(temporary, mode === GIT_FILE_MODE.executable ? 0o755 : 0o644);
              await rename(temporary, target);
            } finally {
              await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              });
            }
          }
        }

        this.previews.delete(request.token);

        if (request.stage) {
          try {
            await this.git.stage(root, [preview.path]);
          } catch {
            throw new GitError({
              kind: "invalid-input",
              operation: t("operations.markConflictResolved"),
              message: errorText(
                "main.conflictService.theResolutionIsSavedButGitCouldNotStageItYourSavedFileWasRetained",
              ),
              suggestedAction: errorText("main.conflictService.refreshAndStageThisPathFromChanges"),
            });
          }
        }
      },
    );
  }
}
