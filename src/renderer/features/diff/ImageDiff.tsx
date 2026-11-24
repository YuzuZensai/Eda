import { getLocale, t } from "@shared/i18n";
import type {
  ImagePreview,
  ImagePreviewRequest,
  ImagePreviewVersion,
} from "@shared/repository/image-preview";
import { useState } from "react";
import { SegmentedControl, StateMessage, TextButton } from "../../components/ui/index";

export function ImageDiff({
  preview,
  kind,
  imagePath,
}: {
  preview: ImagePreview;
  kind: ImagePreviewRequest["kind"];
  imagePath: boolean;
}) {
  const [view, setView] = useState<"compare" | "before" | "after">("compare");
  const [actualSize, setActualSize] = useState(false);
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
          <ImageVersion version={preview.before} label={beforeLabel} actualSize={actualSize} />
        )}
        {after && (
          <ImageVersion version={preview.after} label={afterLabel} actualSize={actualSize} />
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
