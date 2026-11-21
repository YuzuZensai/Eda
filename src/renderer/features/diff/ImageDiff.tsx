import { errorMessage } from "@shared/errors";
import { getLocale, t } from "@shared/i18n";
import {
  isImagePath,
  type ImagePreview,
  type ImagePreviewVersion,
} from "@shared/repository/image-preview";
import type { FileDiff, UnifiedDiff } from "@shared/repository/repository-read";
import { useEffect, useState } from "react";
import { LoadingContent } from "../../components/ui/feedback/Skeleton";
import { SegmentedControl, StateMessage, TextButton } from "../../components/ui/index";
import { useRepositoryStore } from "../../stores/repository-store";

export function ImageDiff({ file, revision }: { file: FileDiff; revision: UnifiedDiff }) {
  const repositoryId = useRepositoryStore((state) => state.repositoryId);
  const identityId = useRepositoryStore((state) => state.identityId);
  const generation = useRepositoryStore((state) => state.generation);
  const selection = useRepositoryStore((state) => state.selection);
  const kind =
    selection?.kind === "commit" ? "commit" : selection?.area === "staged" ? "staged" : "working";
  const oid = selection?.kind === "commit" ? selection.oid : null;
  const path = file.newPath ?? file.oldPath!;
  const imagePath = isImagePath(path);
  const oldPath = file.oldPath;
  const owner = JSON.stringify([identityId, generation, repositoryId, kind, oid, oldPath, path]);
  const [result, setResult] = useState<{
    owner: string;
    value?: ImagePreview;
    error?: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState<"compare" | "before" | "after">("compare");
  const [actualSize, setActualSize] = useState(false);

  useEffect(() => {
    let alive = true;

    setResult(null);

    if (!repositoryId) return;

    const request = { repositoryId, path, ...(oldPath && { oldPath }) };

    void window.eda.repository
      .imagePreview(
        kind === "commit" && oid
          ? { ...request, kind, oid }
          : { ...request, kind: kind === "staged" ? "staged" : "working" },
      )
      .then((result) => {
        if (!alive) return;
        setResult(
          result.ok ? { owner, value: result.value } : { owner, error: errorMessage(result.error) },
        );
      })
      .catch((error) => {
        if (alive) setResult({ owner, error: errorMessage(error) });
      });

    return () => {
      alive = false;
    };
  }, [repositoryId, path, oldPath, kind, oid, owner, revision, retry]);

  const current = result?.owner === owner ? result : null;
  const preview = current?.value;
  const beforeLabel =
    kind === "working"
      ? t("diff.imageDiff.index")
      : kind === "staged"
        ? t("diff.imageDiff.head")
        : t("diff.imageDiff.parent");
  const afterLabel =
    kind === "working"
      ? t("diff.imageDiff.workingTree")
      : kind === "staged"
        ? t("diff.imageDiff.index")
        : t("diff.imageDiff.commit");

  if (!current)
    return (
      <LoadingContent
        label={t(imagePath ? "diff.imageDiff.loadingImagePreview" : "diff.binary.loading")}
      />
    );

  if (!preview)
    return (
      <StateMessage
        className="min-h-0 flex-1"
        tone="error"
        description={current.error}
        title={t(imagePath ? "diff.imageDiff.couldNotLoadImage" : "diff.binary.failed")}
        action={
          <TextButton onClick={() => setRetry((value) => value + 1)}>
            {t(imagePath ? "diff.imageDiff.retryImagePreview" : "common.retry")}
          </TextButton>
        }
      />
    );

  const before =
    view === "before" ||
    (view === "compare" && (preview.before.kind !== "missing" || preview.after.kind === "missing"));
  const after = view === "after" || (view === "compare" && preview.after.kind !== "missing");

  return (
    <section
      aria-label={t(imagePath ? "diff.imageDiff.imagePreview" : "diff.binary.details")}
      className="@container flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2">
        <SegmentedControl
          label={t(imagePath ? "diff.imageDiff.imageVersions" : "diff.binary.versions")}
          value={view}
          options={[
            { value: "compare", label: t("diff.imageDiff.compare") },
            { value: "before", label: beforeLabel },
            { value: "after", label: afterLabel },
          ]}
          onChange={setView}
        />
        {(preview.before.kind === "image" || preview.after.kind === "image") && (
          <TextButton
            className="ml-auto"
            onClick={() => setActualSize((value) => !value)}
            aria-pressed={actualSize}
          >
            {actualSize ? t("diff.imageDiff.fitImage") : t("diff.imageDiff.actualSize")}
          </TextButton>
        )}
      </div>
      <div
        className={`grid min-h-0 flex-1 overflow-auto ${before && after ? "grid-cols-1 @2xl:grid-cols-2" : "grid-cols-1"}`}
      >
        {before && (
          <ImageVersion
            key={`${owner}:before`}
            version={preview.before}
            label={beforeLabel}
            actualSize={actualSize}
          />
        )}
        {after && (
          <ImageVersion
            key={`${owner}:after`}
            version={preview.after}
            label={afterLabel}
            actualSize={actualSize}
          />
        )}
      </div>
    </section>
  );
}

function ImageVersion({
  version,
  label,
  actualSize,
}: {
  version: ImagePreviewVersion;
  label: string;
  actualSize: boolean;
}) {
  const [decoded, setDecoded] = useState<{ url: string; width: number; height: number } | null>(
    null,
  );
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <figure className="flex min-h-0 min-w-0 flex-col border-r border-border-subtle last:border-r-0">
      <figcaption className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2 text-xs text-text-tertiary">
        <strong className="text-text-secondary">{label}</strong>
        <span className="min-w-0 flex-1 truncate" title={version.path}>
          {version.path}
        </span>
        {(version.kind === "binary" || version.kind === "unavailable") &&
          version.bytes !== undefined && (
            <span>
              {t("diff.binary.bytes", { bytes: version.bytes.toLocaleString(getLocale()) })}
            </span>
          )}
        {version.kind === "image" && (
          <span>
            {t("diff.imageDiff.kB", {
              value1: version.mimeType.replace("image/", "").toUpperCase(),
              value2: (version.bytes / 1024).toLocaleString(getLocale(), {
                maximumFractionDigits: 1,
              }),
              value3:
                decoded?.url === version.dataUrl
                  ? t("diff.imageDiff.by", { width: decoded.width, height: decoded.height })
                  : "",
            })}
          </span>
        )}
      </figcaption>
      {version.kind === "image" && failed !== version.dataUrl ? (
        <div
          className="min-h-0 flex-1 overflow-auto p-4"
          style={{
            background:
              "repeating-conic-gradient(var(--bg-inset) 0% 25%, var(--bg-raised) 0% 50%) 50% / 20px 20px",
          }}
        >
          <img
            src={version.dataUrl}
            alt={t("diff.imageDiff.image", { label: label, path: version.path })}
            className={
              actualSize
                ? "mx-auto block max-w-none"
                : "mx-auto block max-h-[65vh] max-w-full object-contain"
            }
            onLoad={(event) =>
              setDecoded({
                url: version.dataUrl,
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(version.dataUrl)}
          />
        </div>
      ) : (
        <StateMessage
          className="min-h-32 flex-1"
          title={
            version.kind === "missing"
              ? t("diff.imageDiff.fileNotPresent")
              : version.kind === "binary"
                ? t("diffModel.binaryFileChangedNoTextPreview")
                : version.kind === "unavailable"
                  ? version.reason
                  : t("diff.imageDiff.imageCouldNotBeDecoded")
          }
        />
      )}
    </figure>
  );
}
