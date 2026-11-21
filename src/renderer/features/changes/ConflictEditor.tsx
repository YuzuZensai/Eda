import { errorAction, errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { GIT_FILE_MODE, isRegularFileMode } from "@shared/repository/git-file-mode";
import { conflictSides } from "@shared/workflows/conflict-sides";
import { scanConflictMarkers } from "@shared/workflows/conflict-markers";
import type {
  ConflictPreview,
  ConflictVersion,
  ResolveConflictRequest,
} from "@shared/workflows/workflow";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  CodeBlock,
  Dialog,
  Disclosure,
  IconButton,
  StateMessage,
  Select,
} from "../../components/ui/index";
import { ArrowLeftIcon } from "../../components/ui/icons";
import { ConflictBlockEditor } from "./ConflictBlockEditor";
import { conflictOutput, readConflictText, type ConflictText } from "./conflict-text";
import { useRepositoryStore } from "../../stores/repository-store";

const conflictTypes: Record<string, string> = {
  DD: t("conflicts.deletedOnBothSides"),
  AU: t("conflicts.addedOnCurrentSide"),
  UD: t("conflicts.deletedOnIncomingSide"),
  UA: t("conflicts.addedOnIncomingSide"),
  DU: t("conflicts.deletedOnCurrentSide"),
  AA: t("conflicts.addedOnBothSides"),
  UU: t("conflicts.modifiedOnBothSides"),
};

function canEdit(preview: ConflictPreview): boolean {
  return (
    preview.output !== null &&
    [preview.current, preview.incoming].every((value) => !value || isRegularFileMode(value.mode))
  );
}

function initialChoice(preview: ConflictPreview): ResolveConflictRequest["choice"] {
  if (canEdit(preview)) return "text";
  return [preview.base, preview.current, preview.incoming].some(
    (value) => value?.mode === GIT_FILE_MODE.submodule,
  )
    ? "current"
    : "worktree";
}

function Version({ title, value }: { title: string; value: ConflictVersion | string | null }) {
  let content = t("conflicts.absentSide");

  if (typeof value === "string") content = value;
  else if (value?.mode === GIT_FILE_MODE.submodule)
    content = t("conflicts.submoduleCommit", { oid: value.oid });
  else if (value)
    content = value.text ?? t("conflicts.binarySummary", { bytes: value.bytes, oid: value.oid });

  return (
    <section className="min-w-0 rounded border border-border-default">
      <h3 className="border-b border-border-subtle px-3 py-2 text-xs font-medium">{title}</h3>

      <CodeBlock label={title} className="max-h-36 rounded-none border-0">
        {content}
      </CodeBlock>
    </section>
  );
}

interface ConflictDraft {
  preview: ConflictPreview;
  parts: ConflictText;
  choice: ResolveConflictRequest["choice"];
}

function initialDraft(preview: ConflictPreview): ConflictDraft {
  return {
    preview,
    parts: readConflictText(preview.output ?? "", preview.markerSize),
    choice: initialChoice(preview),
  };
}

// Retain only unsaved edits when the user switches tabs. Keeping the original preview
// token lets Git reject a draft if its file or operation changed in the meantime.
const drafts = new Map<string, ConflictDraft>();

export function ConflictEditor({
  repositoryId,
  path,
  onBack,
}: {
  repositoryId: string;
  path: string;
  onBack: () => void;
}) {
  const status = useRepositoryStore((state) => state.status);
  const identityId = useRepositoryStore((state) => state.identityId);
  const owner = JSON.stringify([identityId, repositoryId, path]);
  const [file, setFile] = useState<ConflictDraft | null>(() => drafts.get(owner) ?? null);
  const preview = file?.preview;
  const parts = file?.parts ?? [];
  const output = conflictOutput(parts, true);
  const choice = file?.choice ?? "text";
  const [busy, setBusy] = useState(!file);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const request = useRef(0);
  const change = status?.changes.find((entry) => entry.path === path && entry.kind === "unmerged");
  const writable = !!change && status?.capabilities?.write !== false;

  const update = (next: ConflictDraft) => {
    if (
      conflictOutput(next.parts, true) === (next.preview.output ?? "") &&
      next.choice === initialChoice(next.preview)
    )
      drafts.delete(owner);
    else drafts.set(owner, next);
    setFile(next);
  };
  const guard = (next: () => void) => {
    if (busy) return;
    if (drafts.has(owner)) setLeave(() => next);
    else next();
  };

  const inspect = async (keepEdits = false) => {
    const revision = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const result = await window.eda.conflicts.inspect(repositoryId, path);
      if (request.current !== revision) return;
      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }
      const preview = result.value;
      if (keepEdits && file?.choice === "text" && !canEdit(preview)) {
        setError(t("conflicts.fileTypeChanged"));
        return;
      }
      update(keepEdits && file ? { ...file, preview } : initialDraft(preview));
    } catch (failure) {
      if (request.current === revision) setError(errorMessage(failure));
    } finally {
      if (request.current === revision) setBusy(false);
    }
  };

  useEffect(() => {
    heading.current?.focus();
    if (!drafts.has(owner)) void inspect();
    return () => {
      request.current++;
    };
  }, [owner]);

  const save = async (stage: boolean) => {
    if (!preview) return;

    setBusy(true);
    setError(null);
    setMessage(null);

    const revision = request.current;
    const submitted = drafts.get(owner);
    try {
      const result = await window.eda.conflicts.resolve({
        repositoryId,
        token: preview.token,
        choice,
        ...(choice === "text" ? { text: output } : {}),
        stage,
      });

      if (result.ok && drafts.get(owner) === submitted) drafts.delete(owner);
      if (request.current !== revision) return;
      if (!result.ok) {
        setError([errorMessage(result.error), errorAction(result.error)].filter(Boolean).join(" "));
        return;
      }

      await useRepositoryStore.getState().syncFromDisk();
      if (request.current !== revision) return;
      if (!stage) {
        setMessage(t("conflicts.savedOutput", { path }));
        await inspect();
        return;
      }

      const store = useRepositoryStore.getState();
      const next = store.status?.changes.find(
        (entry) => entry.kind === "unmerged" && entry.path !== path,
      );
      if (next) await store.selectChange(next, "conflicted");
      else onBack();
    } catch (failure) {
      if (request.current === revision) setError(errorMessage(failure));
    } finally {
      if (request.current === revision) setBusy(false);
    }
  };

  const external = async () => {
    if (!preview) return;

    setBusy(true);
    setError(null);
    setMessage(null);

    const revision = request.current;
    try {
      const result = await window.eda.conflicts.external(repositoryId, preview.token);

      if (request.current !== revision) return;
      await useRepositoryStore.getState().syncFromDisk();
      if (request.current !== revision) return;

      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }

      update({
        preview,
        parts: readConflictText(result.value.text, preview.markerSize),
        choice: "text",
      });
      setMessage(result.value.stale ? t("conflicts.toolResultStale") : t("conflicts.toolFinished"));
    } catch (failure) {
      if (request.current === revision) setError(errorMessage(failure));
    } finally {
      if (request.current === revision) setBusy(false);
    }
  };

  const submodule = [preview?.base, preview?.current, preview?.incoming].some(
    (value) => value?.mode === GIT_FILE_MODE.submodule,
  );
  const selectedSide = choice === "current" || choice === "incoming" ? preview?.[choice] : null;
  let resultContent: ConflictVersion | string =
    selectedSide ?? t("conflicts.deletionResult", { path });
  if (choice === "worktree" && preview && preview.outputKind !== "missing")
    resultContent = preview.output ?? t("conflicts.keepDiskContents");
  const indexOnly = submodule && (!selectedSide || selectedSide.mode === GIT_FILE_MODE.submodule);
  const markers =
    choice === "text" &&
    !!preview &&
    (parts.some((part) => typeof part !== "string" && !part.selection) ||
      scanConflictMarkers(preview.markerSize)(output, true));
  const sides = conflictSides(preview?.workflow?.kind);

  return (
    <section
      aria-label={t("conflicts.title")}
      className="app-canvas flex min-h-0 flex-1 flex-col bg-bg-base"
    >
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-3 border-b border-border-subtle bg-bg-surface px-3 py-1.5">
        <IconButton
          size="sm"
          aria-label={t("conflicts.backToWorkingTree")}
          title={t("conflicts.backToWorkingTree")}
          onClick={() =>
            guard(() => {
              drafts.delete(owner);
              onBack();
            })
          }
          disabled={busy}
          icon={<ArrowLeftIcon size={16} />}
        />
        <h2
          ref={heading}
          tabIndex={-1}
          className="min-w-0 flex-1 truncate text-sm font-semibold"
          title={path}
        >
          {path}
        </h2>
        {change && (
          <span className="text-xs text-git-conflict">
            {conflictTypes[change.index + change.worktree] ?? t("conflicts.unresolved")}
          </span>
        )}
        <Button
          size="sm"
          disabled={busy || !preview || !writable || indexOnly || choice === "worktree"}
          onClick={() => void save(false)}
        >
          {t("conflicts.saveOutput")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={
            busy ||
            !preview ||
            !writable ||
            markers ||
            (choice === "worktree" && preview.hasMarkers)
          }
          onClick={() => void save(true)}
        >
          {t("conflicts.saveAndMarkResolved")}
        </Button>
      </header>
      {message && (
        <p role="status" className="px-4 pt-2 text-xs text-git-added">
          {message}
        </p>
      )}
      {error && (
        <StateMessage
          tone="error"
          title={error}
          action={
            <Button disabled={busy} onClick={() => void inspect(!!file)}>
              {t("workspace.tryAgain")}
            </Button>
          }
        />
      )}
      {!preview && busy && (
        <StateMessage className="flex-1" tone="loading" title={t("conflicts.openingFile")} />
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
        {preview && (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex min-w-0 items-center gap-2 text-xs text-text-secondary">
              {t("conflicts.resolution")}

              <Select
                aria-label={t("conflicts.resolutionChoice")}
                value={choice}
                disabled={busy}
                onValueChange={(value) =>
                  update({ preview, parts, choice: value as ResolveConflictRequest["choice"] })
                }
                className="w-56"
              >
                {canEdit(preview) && <option value="text">{t("conflicts.editableResult")}</option>}

                {(["current", "incoming"] as const).map((side) => (
                  <option key={side} value={side}>
                    {t(preview[side] ? "conflicts.useWhole" : "conflicts.acceptDeletion", {
                      side: sides[side].toLowerCase(),
                    })}
                  </option>
                ))}

                <option value="delete">{t("conflicts.deletePath")}</option>

                {!submodule && <option value="worktree">{t("conflicts.workingFile")}</option>}
              </Select>
            </label>
            <div className="ml-auto flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy || !canEdit(preview)}
                onClick={() => guard(() => void external())}
              >
                {t("conflicts.externalTool")}
              </Button>
              <Button
                size="sm"
                variant="quiet"
                disabled={busy}
                onClick={() => void inspect(drafts.has(owner))}
                title={drafts.has(owner) ? t("conflicts.recheckDisk") : t("common.refresh")}
              >
                {t("common.refresh")}
              </Button>
            </div>
          </div>
        )}

        {preview && (
          <>
            {preview.workflow?.kind === "rebase" && (
              <p className="text-xs text-text-secondary">{sides.explanation}</p>
            )}

            {!canEdit(preview) && !submodule && (
              <p className="text-xs text-text-secondary">{t("conflicts.wholeFileOnly")}</p>
            )}

            {indexOnly && (
              <p className="text-xs text-text-secondary">{t("conflicts.submoduleIndex")}</p>
            )}

            {submodule && !indexOnly && preview.outputKind === "directory" && (
              <p className="text-xs text-text-secondary">{t("conflicts.directoryObstruction")}</p>
            )}

            {[preview.current, preview.incoming].some(
              (value) => value?.mode === GIT_FILE_MODE.symlink,
            ) && <p className="text-xs text-text-secondary">{t("conflicts.symlinkChoice")}</p>}

            {choice === "text" && (
              <ConflictBlockEditor
                key={preview.token}
                parts={parts}
                onChange={(parts) => update({ preview, parts, choice })}
                markerSize={preview.markerSize}
                busy={busy}
                markers={markers}
                sides={sides}
                branch={status?.branch.head}
              />
            )}

            {choice !== "text" && (
              <Version title={t("conflicts.resultFile")} value={resultContent} />
            )}
            {choice === "worktree" && preview.hasMarkers && (
              <p className="text-xs text-git-modified">{t("conflicts.markersOnDisk")}</p>
            )}
            <Disclosure title={t("conflicts.inspectVersions")}>
              <div className="space-y-2 pt-2">
                {preview.workflow?.kind !== "rebase" && (
                  <p className="text-xs text-text-secondary">{sides.explanation}</p>
                )}
                {preview.workflow && (
                  <p className="text-xs text-text-tertiary">
                    {t("conflicts.currentHead", {
                      value1: preview.workflow.head?.slice(0, 12) ?? t("conflicts.unborn"),
                      value2:
                        preview.workflow.incoming.length > 0
                          ? t("conflicts.operationSource", {
                              value1: preview.workflow.incoming
                                .map((oid) => oid.slice(0, 12))
                                .join(", "),
                            })
                          : "",
                    })}
                  </p>
                )}

                <div className="grid gap-3 md:grid-cols-3">
                  <Version
                    title={t("conflicts.baseStage", { base: sides.base })}
                    value={preview.base}
                  />

                  <Version
                    title={preview.workflow?.currentLabel ?? t("conflicts.currentStage")}
                    value={preview.current}
                  />

                  <Version
                    title={preview.workflow?.incomingLabel ?? t("conflicts.incomingStage")}
                    value={preview.incoming}
                  />
                </div>
              </div>
            </Disclosure>
          </>
        )}
      </div>

      {leave && (
        <Dialog
          title={t("conflicts.discardTitle")}
          onClose={() => setLeave(null)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setLeave(null)}>
                {t("conflicts.keepEditing")}
              </Button>

              <Button
                onClick={() => {
                  const next = leave;
                  setLeave(null);
                  next();
                }}
              >
                {t("conflicts.discardEditorEdits")}
              </Button>
            </>
          }
        >
          <p className="text-sm">{t("conflicts.saveBeforeLeaving")}</p>
        </Dialog>
      )}
    </section>
  );
}
