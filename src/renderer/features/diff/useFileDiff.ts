import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  isImagePath,
  type ImagePreviewRequest,
  type ImagePreviewVersion,
} from "@shared/repository/image-preview";
import type { DiffDisplayOptions } from "@shared/repository/repository-read";
import { useMemo, useState } from "react";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { useRepositoryStore } from "../../stores/repository-store";

async function decodeVersion(version: ImagePreviewVersion): Promise<ImagePreviewVersion> {
  if (version.kind !== "image") return version;
  const image = new Image();
  image.src = version.dataUrl;
  try {
    await image.decode();
    return version;
  } catch {
    return {
      kind: "unavailable",
      path: version.path,
      bytes: version.bytes,
      reason: t("diff.imageDiff.imageCouldNotBeDecoded"),
    };
  }
}

async function readImage(request: ImagePreviewRequest) {
  const result = await window.eda.repository.imagePreview(request);
  if (!result.ok) return result;
  const [before, after] = await Promise.all([
    decodeVersion(result.value.before),
    decodeVersion(result.value.after),
  ]);
  return { ok: true as const, value: { before, after } };
}

export function useFileDiff(pending: boolean, options: DiffDisplayOptions) {
  const repositoryId = useRepositoryStore((state) => state.repositoryId);
  const selection = useRepositoryStore((state) => state.selection);
  const path = useRepositoryStore((state) =>
    state.selection?.kind === "change" ? state.selection.path : state.commitFilePath,
  );
  const base = useRepositoryStore((state) =>
    state.selection?.kind === "commit" ? state.commitFileDiff : state.diff,
  );
  const loading = useRepositoryStore((state) =>
    state.selection?.kind === "commit" ? state.commitFileLoading : state.diffLoading,
  );
  const error = useRepositoryStore((state) =>
    state.selection?.kind === "commit" ? state.commitFileError : state.error,
  );
  const empty = pending || !selection;
  const adjusted = !!(options.context || options.ignoreWhitespace);

  const imageRequest = useMemo<ImagePreviewRequest | null>(() => {
    const file = base?.files.length === 1 ? base.files[0] : undefined;
    const filePath = file?.newPath ?? file?.oldPath;
    if (empty || !repositoryId || !file || !filePath || !(file.binary || isImagePath(filePath)))
      return null;
    return {
      repositoryId,
      path: filePath,
      ...(file.oldPath && { oldPath: file.oldPath }),
      ...(selection.kind === "commit"
        ? { kind: "commit", oid: selection.oid }
        : { kind: selection.area === "staged" ? "staged" : "working" }),
    };
  }, [base, empty, repositoryId, selection]);
  const image = useRepositoryRead(readImage, imageRequest);

  const request = useMemo(() => {
    if (!adjusted || !repositoryId || empty || !path || imageRequest || !base) return null;
    if (selection.kind === "commit") {
      const file = base.files.find((entry) => (entry.newPath ?? entry.oldPath) === path);
      const paths = file?.oldPath && file.oldPath !== path ? [file.oldPath, path] : [path];
      return { repositoryId, oid: selection.oid, paths, ...options };
    }
    return {
      repositoryId,
      paths: [path],
      area: selection.area === "staged" ? ("staged" as const) : ("unstaged" as const),
      ...options,
    };
  }, [adjusted, repositoryId, empty, selection, path, imageRequest, base, options]);
  const preview = useRepositoryRead(
    (input: NonNullable<typeof request>) =>
      "oid" in input
        ? window.eda.repository.commitDiff(input)
        : window.eda.repository.workingDiff(input),
    request,
  );
  const diff = request ? preview.value : base;
  const failure = error ? errorMessage(error) : (preview.error ?? image.error);
  const waiting =
    !empty &&
    !failure &&
    (loading || (!!request && !preview.value) || (!!imageRequest && !image.value));
  const current = useMemo(
    () => ({
      selection,
      path,
      diff,
      base,
      image: image.value,
      imageKind: imageRequest?.kind,
      adjusted,
      groupContext: !!options.context,
      key: JSON.stringify([selection?.kind === "commit" ? selection.oid : selection?.area, path]),
    }),
    [selection, path, base, diff, image.value, imageRequest, adjusted, options.context],
  );

  // Retain only the last settled file in this repository session.
  const [previous, setPrevious] = useState<typeof current | null>(null);
  const retained = waiting ? previous : null;
  const settled = empty || failure || !diff ? null : current;
  if (!waiting && previous !== settled) setPrevious(settled);

  const imagePath = !!imageRequest && isImagePath(imageRequest.path);
  const feedback =
    imageRequest && !error
      ? {
          loadingLabel: t(imagePath ? "diff.imageDiff.loadingImagePreview" : "diff.binary.loading"),
          errorTitle: t(imagePath ? "diff.imageDiff.couldNotLoadImage" : "diff.binary.failed"),
          retryLabel: t(imagePath ? "diff.imageDiff.retryImagePreview" : "common.retry"),
          retry: image.retry,
        }
      : {
          loadingLabel: t("diffViewer.loadingDiff"),
          errorTitle: t("diffViewer.couldNotLoadChanges"),
          retryLabel: t("diffViewer.retryFileDiff"),
          retry: preview.error ? preview.retry : useRepositoryStore.getState().retryDiff,
        };
  return {
    file: retained ?? current,
    retained: !!retained,
    empty,
    waiting,
    failure,
    switching: !!retained && retained.key !== current.key,
    ...feedback,
  };
}
