import type { CommitDiffRequest, WorkingDiffRequest } from "@shared/repository/repository-read";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { isImagePath } from "@shared/repository/image-preview";
import { ArrowLeftIcon as ArrowLeft, EyeOffIcon as EyeOff } from "../../components/ui/icons";
import { useEffect, useMemo, useState } from "react";
import { PanelHeader } from "../../components/layout/PanelHeader";
import { usePanel } from "../../components/layout/hooks/usePanel";
import { DIFF_ROW_HEIGHT } from "./DiffRows";
import { Skeleton } from "../../components/ui/feedback/Skeleton";
import { IconButton, StateMessage, TextButton } from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { IgnoreDialog } from "../changes/IgnoreDialog";
import { PartialStageProvider, PartialStageToolbar } from "../changes/PartialStageControls";
import { DiffContent } from "./DiffContent";
import {
  DiffLayoutControls,
  useDiffLayout,
  DiffDisplayControls,
  useDiffDisplay,
} from "./DiffLayout";
import { ExportPatchButton } from "./ExportPatchButton";
import { ImageDiff } from "./ImageDiff";

export function DiffViewer({ pending = false }: { pending?: boolean }) {
  const [ignorePath, setIgnorePath] = useState<string | null>(null);
  const diff = useRepositoryStore((state) => state.diff);

  const loading = useRepositoryStore((state) =>
    state.selection?.kind === "commit" ? state.commitFileLoading : state.diffLoading,
  );

  const selection = useRepositoryStore((state) => state.selection);

  const error = useRepositoryStore((state) =>
    state.selection?.kind === "commit" ? state.commitFileError : state.error,
  );

  const commitFileDiff = useRepositoryStore((state) => state.commitFileDiff);
  const commitFilePath = useRepositoryStore((state) => state.commitFilePath);
  const showHistory = useRepositoryStore((state) => state.showHistory);
  const profileId = useAppStore((state) => state.activeIdentity?.id);
  const repositoryId = useAppStore((state) => state.selectedRepositoryId);

  useEffect(() => {
    setIgnorePath(null);
  }, [repositoryId, profileId]);

  const layout = useDiffLayout(profileId, repositoryId);
  const { mode } = layout;
  const panel = usePanel("diff");
  const displayedDiff = selection?.kind === "commit" ? commitFileDiff : diff;

  const previewFile =
    displayedDiff?.files.length === 1 &&
    (displayedDiff.files[0]?.binary ||
      isImagePath(displayedDiff.files[0]?.newPath ?? displayedDiff.files[0]?.oldPath ?? ""))
      ? displayedDiff.files[0]
      : undefined;

  const empty = pending || !selection;
  const path = selection?.kind === "change" ? selection.path : commitFilePath;
  const fileName = path?.split("/").at(-1);

  const source =
    selection?.kind === "change"
      ? selection.area === "staged"
        ? t("diffViewer.staged")
        : t("diffViewer.workingTree")
      : selection
        ? t("diffViewer.commitSource", { oid: selection.oid.slice(0, 8) })
        : "";

  const selectionKey =
    selection?.kind === "commit"
      ? `${selection.oid}:${commitFilePath}`
      : selection
        ? `${selection.area}:${selection.path}`
        : "";

  const display = useDiffDisplay();
  const { options } = display;
  const adjusted = !!(options.context || options.ignoreWhitespace);
  const request = useMemo(() => {
    if (!adjusted || !repositoryId || !selection || !path || previewFile || !displayedDiff || empty)
      return null;
    if (selection.kind === "commit") {
      const file = displayedDiff.files.find((entry) => (entry.newPath ?? entry.oldPath) === path);
      const paths = file?.oldPath && file.oldPath !== path ? [file.oldPath, path] : [path];
      return { repositoryId, oid: selection.oid, paths, ...options };
    }
    return {
      repositoryId,
      paths: [path],
      area: selection.area === "staged" ? ("staged" as const) : ("unstaged" as const),
      ...options,
    };
  }, [adjusted, repositoryId, selection, path, previewFile, displayedDiff, empty, options]);
  const preview = useRepositoryRead(
    (input: CommitDiffRequest | WorkingDiffRequest) =>
      "oid" in input
        ? window.eda.repository.commitDiff(input)
        : window.eda.repository.workingDiff(input),
    request,
  );
  const visibleDiff = request ? preview.value : displayedDiff;
  const contentKey = `${profileId}:${repositoryId}:${selectionKey}`;

  return (
    <PartialStageProvider key={empty ? "empty" : contentKey} disabled={empty}>
      <section
        data-tour="diff"
        className="app-surface-panel @container/diff flex h-full w-full min-h-0 min-w-0 flex-col border-l border-border-subtle"
      >
        <PanelHeader
          label={t("diffViewer.diffViewer")}
          title={
            empty ? (
              t("diffViewer.diffViewer")
            ) : (
              <span title={`${source}: ${path ?? ""}`}>{fileName ?? source}</span>
            )
          }
          controls={{
            name: t("diffViewer.diffViewerLabel"),
            state: panel.state,
            onToggleMaximize: panel.toggleMaximize,
            onToggleCollapse: panel.toggleCollapse,
            collapseDirection: "down",
          }}
          leading={
            <IconButton
              size="xs"
              onClick={showHistory}
              aria-label={t("diffViewer.backToHistory")}
              title={t("diffViewer.backToHistory")}
              icon={<ArrowLeft size={14} aria-hidden="true" />}
            />
          }
        >
          {!empty && fileName && (
            <span className="hidden min-w-0 truncate text-xs text-text-tertiary @min-[600px]/diff:inline">
              {source}
            </span>
          )}

          <span className="ml-auto" />

          {!empty &&
          repositoryId &&
          path &&
          displayedDiff?.files.length &&
          selection &&
          (selection.kind === "commit" || selection.area !== "conflicted") ? (
            <ExportPatchButton
              oldPath={displayedDiff.files[0]?.oldPath ?? undefined}
              key={contentKey}
              request={{
                repositoryId,
                path,
                ...(selection.kind === "commit"
                  ? { oid: selection.oid }
                  : { area: selection.area === "staged" ? "staged" : "unstaged" }),
                ...(selection.kind === "commit" &&
                  displayedDiff.files[0]?.oldPath &&
                  displayedDiff.files[0].oldPath !== path && {
                    oldPath: displayedDiff.files[0].oldPath,
                  }),
              }}
            />
          ) : null}
          {!empty && !previewFile && <DiffLayoutControls {...layout} />}

          {!empty && selection?.kind === "change" && (
            <IconButton
              size="xs"
              aria-label={t("diffViewer.ignore")}
              title={t("diffViewer.ignore")}
              onClick={() => setIgnorePath(selection.path)}
              icon={<EyeOff size={14} aria-hidden="true" />}
            />
          )}
        </PanelHeader>

        {!empty && !previewFile && !displayedDiff?.files[0]?.binary && (
          <DiffDisplayControls {...display} />
        )}
        {!empty && <PartialStageToolbar fileOnly={!!previewFile || adjusted} />}
        {request && selection?.kind === "change" && (
          <p className="px-3 py-1 text-xs text-text-secondary">{t("diff.options.staging")}</p>
        )}

        {!empty && ignorePath && repositoryId && (
          <IgnoreDialog
            key={`${repositoryId}:${ignorePath}`}
            repositoryId={repositoryId}
            path={ignorePath}
            onClose={() => setIgnorePath(null)}
          />
        )}

        {pending || (!empty && (loading || (!!request && !preview.value && !preview.error))) ? (
          <div
            role="status"
            aria-label={t("diffViewer.loadingDiff")}
            className="min-h-0 flex-1 overflow-hidden"
          >
            <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-1">
              <Skeleton className="h-6 flex-1" />
              <Skeleton className="w-24" />
            </div>
            {Array.from({ length: 16 }, (_, row) => (
              <div key={row} className="flex" style={{ height: DIFF_ROW_HEIGHT }}>
                {Array.from({ length: mode === "split" ? 2 : 1 }, (_, side) => (
                  <div
                    key={side}
                    className="flex min-w-0 flex-1 items-center gap-2 border-r border-border-subtle"
                  >
                    <span className={mode === "split" ? "w-10 shrink-0" : "w-20 shrink-0"} />
                    <Skeleton className={row % 3 ? "w-1/2" : "w-1/3"} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : empty ? (
          <StateMessage
            className="min-h-0 flex-1"
            title={t("diffViewer.selectACommitOrFile")}
            description={t("diffViewer.itsChangesWillAppearHere")}
          />
        ) : error || preview.error ? (
          <StateMessage
            tone="error"
            className="min-h-0 flex-1"
            title={t("diffViewer.couldNotLoadChanges")}
            description={preview.error ?? errorMessage(error)}
            action={
              <TextButton
                onClick={() =>
                  preview.error ? preview.retry() : void useRepositoryStore.getState().retryDiff()
                }
              >
                {t("diffViewer.retryFileDiff")}
              </TextButton>
            }
          />
        ) : !visibleDiff || visibleDiff.files.length === 0 ? (
          <StateMessage className="min-h-0 flex-1" title={t("diffViewer.noTextualChanges")} />
        ) : previewFile ? (
          <ImageDiff key={contentKey} file={previewFile} revision={visibleDiff} />
        ) : (
          <DiffContent
            key={contentKey}
            diff={visibleDiff}
            wrap={display.wrap}
            groupContext={!!options.context}
            mode={mode}
            readOnly={selection?.kind === "commit" || adjusted}
          />
        )}
      </section>
    </PartialStageProvider>
  );
}
