import { readLfsPointer, LFS_VERSION } from "@shared/repository/lfs-pointer";
import { isFullObjectId } from "@shared/repository/object-id";
import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { isImagePath } from "@shared/repository/image-preview";
import type {
  ImagePreview,
  ImagePreviewRequest,
  ImagePreviewVersion,
} from "@shared/repository/image-preview";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitService } from "../../git/git-service";
import { assertFullObjectId, assertRepositoryPath } from "../../git/validation";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const operation = t("operations.previewRepositoryImage");
const readEnv = { overrides: { GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" } };
const invalid = (message: ErrorText) => new GitError({ kind: "invalid-input", operation, message });
const unavailable = (
  path: string,
  reason: string,
  bytes?: number,
): Extract<ImagePreviewVersion, { kind: "unavailable" }> => ({
  kind: "unavailable",
  path,
  reason,
  ...(bytes !== undefined && { bytes }),
});

const tooLarge = (path: string, bytes?: number) =>
  unavailable(path, t("main.imagePreview.imageExceedsThe8MiBPreviewLimit"), bytes);

function validatePath(path: string): void {
  assertRepositoryPath(path, operation);
  if (path.split(/[\\/]/).some((part) => part.toLowerCase() === ".git"))
    throw invalid(errorText("main.imagePreview.selectAnImageOutsideGitSInternalMetadata"));
}

function image(path: string, bytes: Buffer): ImagePreviewVersion {
  if (!isImagePath(path)) {
    const pointer = readLfsPointer(bytes.toString("utf8"));
    return pointer
      ? unavailable(path, t("revision.lfs", pointer), pointer.bytes)
      : { kind: "binary", path, bytes: bytes.length };
  }
  const head = bytes.subarray(0, 16);
  const mimeType = head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : head[0] === 255 && head[1] === 216 && head[2] === 255
      ? "image/jpeg"
      : /^GIF8[79]a/.test(head.toString("ascii"))
        ? "image/gif"
        : head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP"
          ? "image/webp"
          : head.toString("ascii", 0, 2) === "BM"
            ? "image/bmp"
            : head.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))
              ? "image/x-icon"
              : head.toString("ascii", 4, 8) === "ftyp" &&
                  /avif|avis/.test(bytes.subarray(8, 64).toString("ascii"))
                ? "image/avif"
                : null;

  if (!mimeType) {
    const head = bytes.subarray(0, 1025).toString("utf8");
    const pointer = readLfsPointer(head);
    if (pointer) return unavailable(path, t("revision.lfs", pointer), pointer.bytes);
    return unavailable(
      path,
      head.startsWith(LFS_VERSION)
        ? t("main.imagePreview.gitLfsPointerImageContentIsNotAvailableLocally")
        : t("main.imagePreview.thisFileIsNotASupportedRasterImage"),
      bytes.length,
    );
  }

  return {
    kind: "image",
    path,
    mimeType,
    bytes: bytes.length,
    dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
  };
}

type FileVersion =
  | Exclude<ImagePreviewVersion, { kind: "image" }>
  | { kind: "contents"; path: string; data: Buffer };
async function workingImage(root: string, path: string, preview: boolean): Promise<FileVersion> {
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, path);
  const local = relative(canonicalRoot, target);

  if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
    throw invalid(errorText("main.imagePreview.selectAnImageInsideThisRepository"));

  try {
    let parent = canonicalRoot;

    for (const part of local.split(sep).slice(0, -1)) {
      parent = join(parent, part);
      const entry = await lstat(parent);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        return unavailable(path, t("main.imagePreview.imagePreviewsDoNotFollowSymbolicLinks"));
    }

    const entry = await lstat(target);

    if (!entry.isFile() || entry.isSymbolicLink())
      return unavailable(path, t("main.imagePreview.onlyRegularImageFilesCanBePreviewed"));

    const file = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );

    try {
      const info = await file.stat();
      const canonical = await realpath(target);
      const current = await stat(canonical);
      const contained = relative(canonicalRoot, canonical);

      if (
        isAbsolute(contained) ||
        contained === ".." ||
        contained.startsWith(`..${sep}`) ||
        !info.isFile() ||
        info.dev !== entry.dev ||
        info.ino !== entry.ino ||
        info.dev !== current.dev ||
        info.ino !== current.ino
      )
        throw invalid(
          errorText("main.imagePreview.theImagePathChangedWhileItWasBeingOpenedRefreshAndTryAgain"),
        );

      if (preview && !isImagePath(path) && info.size > 1024)
        return { kind: "binary", path, bytes: info.size };
      if (info.size > MAX_IMAGE_BYTES) return tooLarge(path, info.size);

      const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_IMAGE_BYTES + 1));
      let total = 0;

      while (total < bytes.length) {
        const result = await file.read(bytes, total, bytes.length - total, null);
        if (!result.bytesRead) break;
        total += result.bytesRead;
      }

      if (total > MAX_IMAGE_BYTES || total > info.size)
        return unavailable(
          path,
          t("main.imagePreview.theImageChangedWhileItWasBeingReadRefreshAndTryAgain"),
        );

      return { kind: "contents", path, data: bytes.subarray(0, total) };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
      return { kind: "missing", path };
    throw error;
  }
}

async function gitImage(
  git: GitService,
  root: string,
  tree: string | null,
  path: string,
  preview: boolean,
): Promise<FileVersion> {
  if (tree === null) return { kind: "missing", path };

  const index = tree === "index";
  const result = await git.exec(
    index
      ? ["ls-files", "--stage", "-z", "--", `:(literal)${path}`]
      : ["ls-tree", "-z", tree, "--", `:(literal)${path}`],
    { cwd: root, env: readEnv, operation, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024 },
  );

  const entries = result.stdout
    .split("\0")
    .filter((entry) => entry.slice(entry.indexOf("\t") + 1) === path);

  if (!entries.length) return { kind: "missing", path };

  const entry = entries.find((entry) => !index || /^\d+ [0-9a-f]+ 0\t/.test(entry));

  if (!entry)
    return unavailable(path, t("main.imagePreview.theIndexHasUnresolvedConflictVersions"));

  const match = /^(100644|100755) (?:blob )?(\S+)(?: 0)?\t/.exec(entry);

  if (!match || !isFullObjectId(match[2]))
    return unavailable(path, t("main.imagePreview.onlyRegularImageBlobsCanBePreviewed"));

  const oid = match[2]!;
  const size = await git.exec(["cat-file", "-s", oid], {
    cwd: root,
    env: readEnv,
    operation,
    maxStdoutBytes: 128,
  });

  const count = Number(size.stdout.trim());

  if (!Number.isSafeInteger(count) || count < 0)
    throw invalid(errorText("main.imagePreview.gitReturnedAnInvalidImageSize"));
  if (preview && !isImagePath(path) && count > 1024) return { kind: "binary", path, bytes: count };
  if (count > MAX_IMAGE_BYTES) return tooLarge(path, count);

  try {
    const blob = await git.exec(["cat-file", "blob", oid], {
      cwd: root,
      env: readEnv,
      operation,
      maxStdoutBytes: MAX_IMAGE_BYTES,
      maxStderrBytes: 64 * 1024,
    });

    return { kind: "contents", path, data: blob.stdoutBytes };
  } catch (error) {
    if (error instanceof GitError && error.kind === "output-too-large") return tooLarge(path);
    throw error;
  }
}

async function readVersions(
  git: GitService,
  root: string,
  request: ImagePreviewRequest,
  preview: boolean,
) {
  validatePath(request.path);
  validatePath(request.oldPath ?? request.path);

  let before: string | null = "index";
  let after = "index";

  if (request.kind === "commit") {
    assertFullObjectId(request.oid, operation);

    const commit = await git.exec(["rev-list", "--parents", "-n", "1", request.oid, "--"], {
      cwd: root,
      env: readEnv,
      operation,
      maxStdoutBytes: 64 * 1024,
    });

    const ids = commit.stdout.trim().split(" ");

    after = ids[0]!;
    assertFullObjectId(after, operation);
    before = ids[1] ?? null;
  } else if (request.kind === "staged") {
    const head = await git.exec(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      cwd: root,
      env: readEnv,
      operation,
      allowedExitCodes: [0, 1],
      maxStdoutBytes: 128,
    });

    before = head.exitCode === 0 ? head.stdout.trim() : null;
  }

  const previous = await gitImage(git, root, before, request.oldPath ?? request.path, preview);
  const next =
    request.kind === "working"
      ? await workingImage(root, request.path, preview)
      : await gitImage(git, root, after, request.path, preview);

  return { before: previous, after: next };
}

export async function readImagePreview(
  git: GitService,
  root: string,
  request: ImagePreviewRequest,
): Promise<ImagePreview> {
  const { before, after } = await readVersions(git, root, request, true);
  const display = (version: FileVersion) =>
    version.kind === "contents" ? image(version.path, version.data) : version;
  return { before: display(before), after: display(after) };
}

export async function readDiffToolFiles(
  git: GitService,
  root: string,
  request: ImagePreviewRequest,
) {
  const { before, after } = await readVersions(git, root, request, false);
  return [before, after].map((version) => {
    if (version.kind === "missing") return { path: version.path, bytes: Buffer.alloc(0) };
    if (version.kind === "contents") return { path: version.path, bytes: version.data };
    throw invalid(errorText("externalDiff.regularFiles"));
  });
}
