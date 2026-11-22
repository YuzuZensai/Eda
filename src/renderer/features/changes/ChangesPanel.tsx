import { errorMessage } from "@shared/errors";
import { categorizeChanges } from "../../repository/working-changes";
import { t } from "@shared/i18n";
import { MAX_FILE_VIEW_PATHS, defaultFileView, type FileView } from "@shared/preferences/file-view";
import type { RepositoryChange } from "@shared/repository/repository-read";
import {
  ArchiveIcon as Archive,
  CopyIcon as Copy,
  DiffIcon as FileDiff,
  EyeOffIcon as EyeOff,
  FileIcon,
  HistoryIcon as History,
  MinusIcon as Minus,
  PackageCheckIcon as PackageCheck,
  PencilIcon as Pencil,
  PlusIcon as Plus,
  Trash2Icon as Trash2,
  CloseIcon as X,
} from "../../components/ui/icons";
import { type Ref, useEffect, useMemo, useState } from "react";
import { PanelHeader } from "../../components/layout/PanelHeader";
import { usePanel } from "../../components/layout/hooks/usePanel";
import { LoadingContent, Skeleton } from "../../components/ui/feedback/Skeleton";
import {
  Button,
  ContextPopover,
  ErrorDialog,
  IconButton,
  MenuItem,
  MenuSubmenu,
  TreeIcon,
} from "../../components/ui/index";
import { WorkingFileDialog } from "./WorkingFileDialog";
import { MailboxDialog } from "./MailboxDialog";
import { usePreferencesStore } from "../../stores/preferences-store";
import { useRepositoryStore, type ChangeArea } from "../../stores/repository-store";
import { useSessionStore } from "../../stores/session-store";
import { copyText } from "../../utils/clipboard";
import { ChangeFilters } from "./ChangeFilters";
import { ChangeList } from "./ChangeList";
import { DiscardDialog } from "./DiscardDialog";
import { buildChangeRows, type ChangeListRow } from "./change-list-model";

import { IgnoredFilesDialog } from "./IgnoredFilesDialog";

export function ChangesPanel({
  pending = false,
  ref,
}: {
  pending?: boolean;
  ref?: Ref<HTMLElement>;
}) {
  const mailbox = usePreferencesStore((state) => state.values.mailboxPreview.value);
  const [workingFile, setWorkingFile] = useState<{ id: string; path: string } | null>(null);
  const [mailboxId, setMailboxId] = useState<string | null>(null);
  const [applyingPatch, setApplyingPatch] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [ignoredRepository, setIgnoredRepository] = useState<string | null>(null);

  const [discard, setDiscard] = useState<{ repositoryId: string; paths: string[] | null } | null>(
    null,
  );

  const [menu, setMenu] = useState<{
    repositoryId: string;
    identityId: string | null;
    change: RepositoryChange;
    area: ChangeArea;
    stagePaths: string[];
    unstagePaths: string[];
    stashPaths: string[];
    x: number;
    y: number;
  } | null>(null);

  const identityId = useRepositoryStore((state) => state.identityId);
  const status = useRepositoryStore((state) => state.status);
  const selection = useRepositoryStore((state) => state.selection);
  const selectChange = useRepositoryStore((state) => state.selectChange);
  const truncated = useRepositoryStore((state) => state.truncatedChanges);
  const panel = usePanel("rail");
  const stage = useRepositoryStore((state) => state.stage);
  const unstage = useRepositoryStore((state) => state.unstage);
  const stash = useRepositoryStore((state) => state.stash);

  const writing = useRepositoryStore(
    (state) => pending || state.writing || state.status?.capabilities?.write === false,
  );

  const repositoryId = useRepositoryStore((state) => state.repositoryId);

  useEffect(() => setMenu(null), [repositoryId, identityId, pending]);

  const grouped = useSessionStore((state) =>
    repositoryId ? (state.snapshot?.session.views[repositoryId]?.grouped ?? false) : false,
  );

  const savedFiles = useSessionStore((state) =>
    repositoryId ? state.snapshot?.session.views[repositoryId]?.files : undefined,
  );

  const files = useMemo(() => savedFiles ?? defaultFileView(grouped), [savedFiles, grouped]);
  const checked = new Set(files.selected);

  const updateFiles = (change: Partial<FileView>) => {
    if (repositoryId)
      useSessionStore.getState().setView(repositoryId, {
        files: { ...files, ...change },
        grouped: (change.mode ?? files.mode) === "tree",
      });
  };

  const allCategories = useMemo(() => categorizeChanges(status?.changes ?? []), [status?.changes]);

  const categories = useMemo(() => {
    const query = files.query.toLocaleLowerCase();

    const filter = (changes: RepositoryChange[]) =>
      changes.filter(
        (change) =>
          change.path.toLocaleLowerCase().includes(query) &&
          (!files.status || change.index === files.status || change.worktree === files.status),
      );

    return {
      conflicted: filter(allCategories.conflicted),
      staged: filter(allCategories.staged),
      unstaged: filter(allCategories.unstaged),
      untracked: filter(allCategories.untracked),
    };
  }, [allCategories, files.query, files.status]);

  const checkedStage = [...allCategories.unstaged, ...allCategories.untracked]
    .filter(
      (change) => checked.has(`unstaged:${change.path}`) || checked.has(`untracked:${change.path}`),
    )
    .map((change) => change.path);

  const checkedUnstage = allCategories.staged
    .filter((change) => checked.has(`staged:${change.path}`))
    .map((change) => change.path);

  const rows = useMemo(() => buildChangeRows(categories, files), [categories, files]);

  return (
    <section
      ref={ref}
      data-tour="changes"
      tabIndex={0}
      aria-label={t("changesPanel.workingFilesUpAndDownSelectFilesSpace")}
      className="app-surface-panel flex h-full min-h-0 flex-col"
      onKeyDown={(event) => {
        if (pending) return;

        if (
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          (event.target instanceof HTMLElement && event.target.closest("input, textarea, select"))
        )
          return;

        const choices = rows.filter(
          (row): row is Extract<ChangeListRow, { kind: "change" }> => row.kind === "change",
        );

        const current = choices.findIndex(
          (row) =>
            selection?.kind === "change" &&
            row.change.path === selection.path &&
            row.area === selection.area,
        );

        const index =
          event.key === "ArrowDown"
            ? Math.min(choices.length - 1, current + 1)
            : event.key === "ArrowUp"
              ? Math.max(0, current - 1)
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? choices.length - 1
                  : -1;

        const row = choices[index >= 0 ? index : current];

        if (!row) return;

        if (index >= 0) {
          event.preventDefault();
          event.currentTarget.focus();
          void selectChange(row.change, row.area, false);
        } else if (
          event.target === event.currentTarget &&
          row.area === "conflicted" &&
          event.key === "Enter"
        ) {
          event.preventDefault();
          void selectChange(row.change, row.area);
        } else if (event.target === event.currentTarget && row.area !== "conflicted") {
          if (event.key === " ") {
            event.preventDefault();

            const key = `${row.area}:${row.change.path}`;

            updateFiles({
              selected: checked.has(key)
                ? files.selected.filter((item) => item !== key)
                : [...files.selected, key].slice(-MAX_FILE_VIEW_PATHS),
            });
          }

          if (event.key.toLowerCase() === "s" && !writing) {
            event.preventDefault();
            void (row.area === "staged" ? unstage([row.change.path]) : stage([row.change.path]));
          }
        }
      }}
    >
      {repositoryId && workingFile?.id === repositoryId && (
        <WorkingFileDialog
          id={repositoryId}
          initialPath={workingFile.path}
          onClose={() => setWorkingFile(null)}
        />
      )}
      {repositoryId && mailboxId === repositoryId && (
        <MailboxDialog
          id={repositoryId}
          head={status?.branch.oid ?? ""}
          state={status?.workflow ?? null}
          enabled={mailbox}
          onClose={() => setMailboxId(null)}
        />
      )}
      <PanelHeader
        title={t("changesPanel.workingTree")}
        controls={{
          name: t("changesPanel.workingTreeLabel"),
          state: panel.state,
          onToggleMaximize: panel.toggleMaximize,
          onToggleCollapse: panel.toggleCollapse,
          collapseDirection: "right",
        }}
      >
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs">
          {pending ? (
            <Skeleton className="w-16" />
          ) : (
            <>
              {allCategories.staged.length > 0 && (
                <span
                  className="mono flex items-center gap-1 text-git-added"
                  title={t("changesPanel.stagedFiles", { length: allCategories.staged.length })}
                  aria-label={t("changesPanel.stagedFiles", {
                    length: allCategories.staged.length,
                  })}
                >
                  <PackageCheck size={14} aria-hidden="true" />
                  {allCategories.staged.length}
                </span>
              )}

              {allCategories.unstaged.length + allCategories.untracked.length > 0 && (
                <span
                  className="mono flex items-center gap-1 text-git-modified"
                  title={t("changesPanel.unstagedFiles", {
                    value1: allCategories.unstaged.length + allCategories.untracked.length,
                  })}
                  aria-label={t("changesPanel.unstagedFiles", {
                    value1: allCategories.unstaged.length + allCategories.untracked.length,
                  })}
                >
                  <Pencil size={14} aria-hidden="true" />
                  {allCategories.unstaged.length + allCategories.untracked.length}
                </span>
              )}
            </>
          )}
        </div>

        <IconButton
          size="xs"
          title={t("workingFile.title")}
          aria-label={t("workingFile.title")}
          icon={<Plus />}
          disabled={!repositoryId || pending || writing}
          onClick={() => repositoryId && setWorkingFile({ id: repositoryId, path: "" })}
        />
        {(mailbox || status?.workflow?.kind === "am") && (
          <Button
            size="sm"
            disabled={!repositoryId || pending || writing}
            onClick={() => setMailboxId(repositoryId)}
          >
            {t("mailbox.preview")}
          </Button>
        )}
        <IconButton
          size="xs"
          title={t("patch.apply")}
          aria-label={t("patch.apply")}
          icon={<FileDiff />}
          disabled={
            !repositoryId ||
            pending ||
            writing ||
            applyingPatch ||
            status?.capabilities?.write === false
          }
          onClick={async () => {
            if (!repositoryId) return;
            setApplyingPatch(true);
            try {
              const result = await window.eda.repository.applyPatch(repositoryId);
              if (!result.ok && useRepositoryStore.getState().repositoryId === repositoryId)
                setCopyError(errorMessage(result.error));
            } catch (failure) {
              if (useRepositoryStore.getState().repositoryId === repositoryId)
                setCopyError(errorMessage(failure));
            } finally {
              setApplyingPatch(false);
            }
          }}
        />
        <IconButton
          size="xs"
          onClick={() => {
            if (repositoryId) updateFiles({ mode: files.mode === "tree" ? "path" : "tree" });
          }}
          aria-pressed={grouped}
          aria-label={
            grouped
              ? t("changesPanel.showChangesAsAFlatList")
              : t("changesPanel.groupChangesByFolder")
          }
          title={grouped ? t("changesPanel.showAsAFlatList") : t("changesPanel.groupByFolder")}
          className={grouped ? "text-accent-text" : undefined}
          icon={<TreeIcon />}
        />
      </PanelHeader>

      <ChangeFilters files={files} onChange={updateFiles} />

      {discard && repositoryId === discard.repositoryId && (
        <DiscardDialog
          repositoryId={repositoryId}
          paths={discard.paths}
          onClose={() => setDiscard(null)}
        />
      )}

      {ignoredRepository && repositoryId === ignoredRepository && (
        <IgnoredFilesDialog
          repositoryId={repositoryId}
          onClose={() => setIgnoredRepository(null)}
        />
      )}

      {pending ? (
        <LoadingContent label={t("changesPanel.loadingWorkingFiles")} />
      ) : (
        <ChangeList
          rows={rows}
          files={files}
          selection={selection}
          writing={writing}
          truncated={truncated}
          totalChanges={status?.changes.length}
          onUpdateFiles={updateFiles}
          onSelectChange={selectChange}
          onStage={stage}
          onUnstage={unstage}
          onOpenMenu={(position, change, area) => {
            if (pending || !repositoryId) return;

            const batch = checked.has(`${area}:${change.path}`);

            setMenu({
              repositoryId,
              identityId,
              change,
              area,
              stagePaths: batch
                ? [...new Set(checkedStage)]
                : area === "unstaged" || area === "untracked"
                  ? [change.path]
                  : [],
              unstagePaths: batch ? checkedUnstage : area === "staged" ? [change.path] : [],
              stashPaths: batch
                ? [...new Set([...checkedStage, ...checkedUnstage])]
                : [change.path],
              x: position.x,
              y: position.y,
            });
          }}
        />
      )}

      <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto whitespace-nowrap border-t border-border-subtle px-3 text-xs text-text-tertiary">
        {files.selected.length > 0 ? (
          <>
            {checkedStage.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 px-1"
                disabled={writing || !checkedStage.length || checkedStage.length > 256}
                onClick={() => void stage(checkedStage)}
                aria-label={t("changesPanel.stageSelectedFiles", { length: checkedStage.length })}
                title={t("changesPanel.stageSelectedFiles", { length: checkedStage.length })}
                icon={<Plus size={14} />}
              >
                {t("changesPanel.stage", { length: checkedStage.length })}
              </Button>
            )}

            {checkedUnstage.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 px-1"
                disabled={writing || !checkedUnstage.length || checkedUnstage.length > 256}
                onClick={() => void unstage(checkedUnstage)}
                aria-label={t("changesPanel.unstageSelectedFiles", {
                  length: checkedUnstage.length,
                })}
                title={t("changesPanel.unstageSelectedFiles", { length: checkedUnstage.length })}
                icon={<Minus size={14} />}
              >
                {t("changesPanel.unstage", { length: checkedUnstage.length })}
              </Button>
            )}

            <IconButton
              size="xs"
              disabled={writing || !checkedStage.length}
              onClick={() => {
                if (repositoryId) setDiscard({ repositoryId, paths: [...new Set(checkedStage)] });
              }}
              aria-label={t("changesPanel.discardChangesInSelectedWorkingFiles", {
                length: checkedStage.length,
              })}
              title={t("changesPanel.discardSelectedWorkingFiles", {
                length: checkedStage.length,
              })}
              icon={<Trash2 size={14} />}
            />
          </>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {files.selected.length > 0 && (
            <IconButton
              size="xs"
              onClick={() => updateFiles({ selected: [] })}
              aria-label={t("changesPanel.clearSelection")}
              title={t("changesPanel.clearSelection")}
              icon={<X size={14} />}
            />
          )}

          {files.selected.length === 0 && (
            <IconButton
              size="xs"
              disabled={writing || (!categories.unstaged.length && !categories.untracked.length)}
              onClick={() => {
                if (repositoryId)
                  setDiscard({
                    repositoryId,
                    paths: [...categories.unstaged, ...categories.untracked].map(
                      (change) => change.path,
                    ),
                  });
              }}
              aria-label={
                files.query || files.status
                  ? t("changesPanel.discardShownFiles")
                  : t("changesPanel.discardAllFiles")
              }
              title={
                files.query || files.status
                  ? t("changesPanel.discardShown")
                  : t("changesPanel.discardAll")
              }
              icon={<Trash2 size={14} />}
            />
          )}

          <IconButton
            size="xs"
            aria-label={t("changesPanel.inspectIgnoredFiles")}
            title={t("changesPanel.openIgnoredFiles")}
            icon={<EyeOff size={14} />}
            onClick={() => {
              if (repositoryId) setIgnoredRepository(repositoryId);
            }}
          />

          <IconButton
            size="xs"
            aria-label={t("changesPanel.recovery")}
            title={t("changesPanel.openRecovery")}
            icon={<History size={14} />}
            onClick={() => {
              if (repositoryId) setDiscard({ repositoryId, paths: null });
            }}
          />
        </div>
      </div>

      {menu && !pending && menu.repositoryId === repositoryId && menu.identityId === identityId && (
        <ContextPopover
          role="menu"
          aria-label={t("changesPanel.workingFileActions")}
          onClose={() => setMenu(null)}
          className="w-56"
          position={menu}
        >
          <MenuItem
            onClick={() => {
              void selectChange(menu.change, menu.area);
              setMenu(null);
            }}
          >
            <FileDiff size={14} />
            {menu.area === "conflicted"
              ? t("changes.changeRows.resolveConflict", { path: menu.change.path })
              : t("changesPanel.inspectFile")}
          </MenuItem>

          <MenuItem
            onClick={() => {
              setWorkingFile({ id: menu.repositoryId, path: menu.change.path });
              setMenu(null);
            }}
          >
            {t("workingFile.title")}
          </MenuItem>
          {menu.stagePaths.length > 0 && (
            <MenuItem
              disabled={writing || menu.stagePaths.length > 256}
              onClick={() => {
                void stage(menu.stagePaths);
                setMenu(null);
              }}
            >
              <Plus size={14} />
              {t("changesPanel.stageSelectedFiles", { length: menu.stagePaths.length })}
            </MenuItem>
          )}

          {menu.unstagePaths.length > 0 && (
            <MenuItem
              disabled={writing || menu.unstagePaths.length > 256}
              onClick={() => {
                void unstage(menu.unstagePaths);
                setMenu(null);
              }}
            >
              <Minus size={14} />
              {t("changesPanel.unstageSelectedFiles", { length: menu.unstagePaths.length })}
            </MenuItem>
          )}

          {menu.area !== "conflicted" && (
            <MenuItem
              disabled={
                writing ||
                !!status?.workflow ||
                status?.branch.unborn ||
                menu.stashPaths.length > 256
              }
              onClick={() => {
                void stash(menu.stashPaths);
                setMenu(null);
              }}
            >
              <Archive size={14} />
              {menu.stashPaths.length === 1
                ? t("changesPanel.stashFile")
                : t("changesPanel.stashSelectedFiles", { length: menu.stashPaths.length })}
            </MenuItem>
          )}

          <MenuItem
            onClick={() => {
              setWorkingFile({ id: menu.repositoryId, path: menu.change.path });
              setMenu(null);
            }}
          >
            {t("workingFile.title")}
          </MenuItem>
          {menu.stagePaths.length > 0 && (
            <MenuItem
              danger
              disabled={writing}
              onClick={() => {
                setDiscard({ repositoryId: menu.repositoryId, paths: menu.stagePaths });
                setMenu(null);
              }}
            >
              <Trash2 size={14} />
              {t("changesPanel.discardSelectedChanges")}
            </MenuItem>
          )}

          <MenuSubmenu label={t("common.copy")} icon={<Copy size={14} aria-hidden="true" />}>
            <MenuItem
              onClick={() => {
                void copyText(menu.change.path).catch(() =>
                  setCopyError(t("copyButton.clipboardCopyFailed")),
                );

                setMenu(null);
              }}
            >
              <FileIcon size={14} aria-hidden="true" />
              {t("changesPanel.filePath")}
            </MenuItem>
          </MenuSubmenu>
        </ContextPopover>
      )}

      <ErrorDialog onDismiss={() => setCopyError(null)}>{copyError}</ErrorDialog>
    </section>
  );
}
