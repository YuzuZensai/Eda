import { t } from "@shared/i18n";
import { isImagePath } from "@shared/repository/image-preview";
import {
  ArrowLeftIcon as ArrowLeft,
  EyeOffIcon as EyeOff,
  SpinnerIcon,
} from "../../components/ui/icons";
import { useEffect, useState } from "react";
import { PanelHeader } from "../../components/layout/PanelHeader";
import { usePanel } from "../../components/layout/hooks/usePanel";
import { DIFF_ROW_HEIGHT } from "./DiffRows";
import { LoadingContent, Skeleton } from "../../components/ui/feedback/Skeleton";
import { IconButton, StateMessage, TextButton } from "../../components/ui/index";
import { useAppStore } from "../../stores/app-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { IgnoreDialog } from "../changes/IgnoreDialog";
import { PartialStageProvider, PartialStageToolbar } from "../changes/PartialStageControls";
import { useFileDiff } from "./useFileDiff";
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
  const scope = useRepositoryStore((state) =>
    JSON.stringify([state.identityId, state.repositoryId, state.generation]),
  );
  return <FileDiffPane key={scope} scope={scope} pending={pending} />;
}

function FileDiffPane({ scope, pending }: { scope: string; pending: boolean }) {
  const [ignorePath, setIgnorePath] = useState<string | null>(null);
  const showHistory = useRepositoryStore((state) => state.showHistory);
  const profileId = useAppStore((state) => state.activeIdentity?.id);
  const repositoryId = useAppStore((state) => state.selectedRepositoryId);

  const layout = useDiffLayout(profileId, repositoryId);
  const { mode } = layout;
  const panel = usePanel("diff");
  const display = useDiffDisplay();
  const {
    file,
    empty,
    retained,
    waiting,
    failure,
    switching,
    loadingLabel,
    errorTitle,
    retryLabel,
    retry,
  } = useFileDiff(pending, display.options);
  const { selection, path, diff: visibleDiff, key: contentKey, adjusted, image, imageKind } = file;
  useEffect(() => {
    if (switching || ignorePath !== path) setIgnorePath(null);
  }, [switching, path, ignorePath]);
  const fileName = path?.split("/").at(-1);

  const source =
    selection?.kind === "change"
      ? selection.area === "staged"
        ? t("diffViewer.staged")
        : t("diffViewer.workingTree")
      : selection
        ? t("diffViewer.commitSource", { oid: selection.oid.slice(0, 8) })
        : "";

  return (
    <section
      data-tour="diff"
      aria-busy={waiting || undefined}
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

        <div className="ml-auto">
          {retained && (
            <LoadingContent delayed label={loadingLabel}>
              <SpinnerIcon aria-hidden="true" className="animate-spin-fast text-text-tertiary" />
            </LoadingContent>
          )}
        </div>

        <div className="contents" inert={retained}>
          {!empty &&
          repositoryId &&
          path &&
          file.base?.files.length &&
          selection &&
          (selection.kind === "commit" || selection.area !== "conflicted") ? (
            <ExportPatchButton
              oldPath={file.base.files[0]?.oldPath ?? undefined}
              key={contentKey}
              request={{
                repositoryId,
                path,
                ...(selection.kind === "commit"
                  ? { oid: selection.oid }
                  : { area: selection.area === "staged" ? "staged" : "unstaged" }),
                ...(selection.kind === "commit" &&
                  file.base.files[0]?.oldPath &&
                  file.base.files[0].oldPath !== path && {
                    oldPath: file.base.files[0].oldPath,
                  }),
              }}
            />
          ) : null}
          {!empty && !imageKind && <DiffLayoutControls {...layout} />}

          {!empty && selection?.kind === "change" && (
            <IconButton
              size="xs"
              aria-label={t("diffViewer.ignore")}
              title={t("diffViewer.ignore")}
              onClick={() => setIgnorePath(selection.path)}
              icon={<EyeOff size={14} aria-hidden="true" />}
            />
          )}
        </div>
      </PanelHeader>

      <div inert={retained} className="flex min-h-0 flex-1 flex-col">
        <PartialStageProvider
          key={empty ? "empty" : contentKey}
          disabled={empty}
          selection={selection}
          inactive={switching}
        >
          {!empty && !imageKind && !visibleDiff?.files[0]?.binary && (
            <DiffDisplayControls {...display} />
          )}
          {!empty && <PartialStageToolbar fileOnly={!!imageKind || adjusted} />}
          {!empty && adjusted && !imageKind && selection?.kind === "change" && (
            <p className="px-3 py-1 text-xs text-text-secondary">{t("diff.options.staging")}</p>
          )}

          {!empty && !retained && ignorePath && repositoryId && (
            <IgnoreDialog
              key={`${repositoryId}:${ignorePath}`}
              repositoryId={repositoryId}
              path={ignorePath}
              onClose={() => setIgnorePath(null)}
            />
          )}

          {pending || (waiting && !retained) ? (
            <LoadingContent label={loadingLabel} delayed={!pending}>
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
            </LoadingContent>
          ) : empty ? (
            <StateMessage
              className="min-h-0 flex-1"
              title={t("diffViewer.selectACommitOrFile")}
              description={t("diffViewer.itsChangesWillAppearHere")}
            />
          ) : failure ? (
            <StateMessage
              tone="error"
              className="min-h-0 flex-1"
              title={errorTitle}
              description={failure}
              action={<TextButton onClick={() => void retry()}>{retryLabel}</TextButton>}
            />
          ) : !visibleDiff || visibleDiff.files.length === 0 ? (
            <StateMessage className="min-h-0 flex-1" title={t("diffViewer.noTextualChanges")} />
          ) : image && imageKind ? (
            <ImageDiff
              key={contentKey}
              kind={imageKind}
              preview={image}
              imagePath={isImagePath(path ?? "")}
            />
          ) : (
            <DiffContent
              key={contentKey}
              diff={visibleDiff}
              wrap={display.wrap}
              groupContext={file.groupContext}
              scrollKey={scope + ":" + contentKey + ":" + mode}
              mode={mode}
              readOnly={selection?.kind === "commit" || adjusted}
            />
          )}
        </PartialStageProvider>
      </div>
    </section>
  );
}
