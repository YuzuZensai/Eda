import { errorMessage } from "@shared/errors";
import { getLocale, t } from "@shared/i18n";
import { stateLabel } from "@shared/i18n/labels";
import type { PartialStageRequest } from "@shared/repository/partial-stage";
import type { DiscardPreview, RecoverySummary } from "@shared/workflows/recovery";
import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  CodeBlock,
  Dialog,
  ErrorDialog,
  StateMessage,
  TextButton,
} from "../../components/ui/index";
import { useRepositoryStore } from "../../stores/repository-store";
import { formatDateTime } from "../../utils/format";

export function DiscardDialog({
  repositoryId,
  paths,
  partial,
  onClose,
}: {
  repositoryId: string;
  paths: string[] | null;
  partial?: PartialStageRequest;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<DiscardPreview | null>(null);
  const [records, setRecords] = useState<RecoverySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [readState, setReadState] = useState<"loading" | "failed" | "ready">("loading");
  const [revision, setRevision] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [forgetId, setForgetId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    setReadState("loading");
    setError(null);
    setPreview(null);
    setConfirmed(false);
    setForgetId(null);
    setRecords([]);
    const load = async () => {
      if (paths) {
        const result = partial
          ? await window.eda.repository.previewDiscardPartial(partial)
          : await window.eda.repository.previewDiscard(repositoryId, paths);

        if (!alive) return;
        setReadState(result.ok ? "ready" : "failed");
        if (result.ok) setPreview(result.value);
        else setError(errorMessage(result.error));
      } else {
        const result = await window.eda.repository.listRecovery(repositoryId);
        if (!alive) return;
        setReadState(result.ok ? "ready" : "failed");
        if (result.ok) setRecords(result.value);
        else setError(errorMessage(result.error));
      }
    };

    void load().catch((failure) => {
      if (alive) {
        setReadState("failed");
        setError(errorMessage(failure));
      }
    });

    return () => {
      alive = false;
    };
  }, [repositoryId, paths, partial, revision]);

  const run = async (snapshot?: string) => {
    setBusy(true);
    setError(null);

    try {
      const result = snapshot
        ? await window.eda.repository.restoreContent(repositoryId, snapshot)
        : preview
          ? await window.eda.repository.applyDiscard(repositoryId, preview.token)
          : null;

      if (!result) return;

      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }

      if (useRepositoryStore.getState().repositoryId === repositoryId)
        await useRepositoryStore.getState().syncFromDisk();

      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={
        paths ? t("discardDialog.discardWorkingChanges") : t("discardDialog.recoverLocalFiles")
      }
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" disabled={busy} onClick={onClose}>
            {t("common.close")}
          </Button>

          {paths && (
            <Button disabled={!preview || !confirmed || busy} onClick={() => void run()}>
              {t("discardDialog.discardSelectedFiles")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {readState === "loading" && (
          <StateMessage tone="loading" title={t("discardDialog.reading")} />
        )}
        {readState === "failed" && (
          <StateMessage
            tone="error"
            title={t("discardDialog.readFailed")}
            description={error}
            action={
              <Button onClick={() => setRevision((value) => value + 1)}>{t("common.retry")}</Button>
            }
          />
        )}
        {preview && (
          <>
            {preview.patch ? (
              <>
                <p>{t("discardDialog.onlyTheSelectedChangesInThisExactPatch")}</p>
                <CodeBlock label={t("discardDialog.patchToDiscard")} className="max-h-60">
                  {preview.patch}
                </CodeBlock>
              </>
            ) : (
              <p>
                {t("discardDialog.trackedFilesWillReturnToTheirStagedContents", {
                  tracked: preview.tracked,
                  untracked: preview.untracked,
                })}
              </p>
            )}

            <p>
              {t("discardDialog.aLocalSnapshotOfBytesWillBeSaved", {
                bytes: preview.bytes.toLocaleString(getLocale()),
              })}
            </p>

            <ul className="max-h-40 overflow-auto font-mono text-xs">
              {preview.paths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>

            <Checkbox checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}>
              {t("discardDialog.discardTheseWorkingFileChanges")}
            </Checkbox>
          </>
        )}

        {readState === "ready" && !paths && (
          <>
            <p>{t("discardDialog.restoreChecksTheFilesHaveNotChangedSince")}</p>
            {records.length === 0 && <p>{t("discardDialog.noSavedRecoverySnapshots")}</p>}

            {records.map((record) => (
              <div key={record.id} className="space-y-2 border-t border-border-subtle pt-2">
                <p>
                  {formatDateTime(record.createdAt)} ,{" "}
                  {record.source === "merge-abort"
                    ? t("discardDialog.mergeAbort")
                    : record.source === "stash-abort"
                      ? t("discardDialog.stashAbort")
                      : record.source === "rebase-recovery"
                        ? t("discardDialog.rebaseRecovery")
                        : record.source === "replay-recovery"
                          ? t("discardDialog.cherryPickRevertRecovery")
                          : record.source === "reset-recovery"
                            ? t("discardDialog.resetRecovery")
                            : record.source === "stash-file-restore"
                              ? t("discardDialog.stashFileRestore")
                              : t("discardDialog.discard")}{" "}
                  , {stateLabel(record.state)}
                </p>

                <p className="break-all text-xs text-text-tertiary">{record.paths.join(", ")}</p>

                {record.indexOnly && (
                  <p>
                    {t(
                      "discardDialog.indexVersionsOnlySubmoduleEntriesExportTheirRecordedCommitIDs",
                    )}
                  </p>
                )}

                {!record.indexOnly &&
                  record.paths.map((path) => (
                    <TextButton
                      key={path}
                      disabled={busy}
                      className="mr-3 text-xs text-accent-text"
                      onClick={() =>
                        void window.eda.repository
                          .exportRecoveryFile(repositoryId, record.id, path)
                          .then((result) => {
                            if (!result.ok) setError(errorMessage(result.error));
                          })
                      }
                    >
                      {t("discardDialog.saveCopyOf", { path: path })}
                    </TextButton>
                  ))}

                {record.indexVersions?.map(({ path, stage }) => (
                  <TextButton
                    key={`${stage}:${path}`}
                    disabled={busy}
                    className="mr-3 text-xs text-accent-text"
                    onClick={() =>
                      void window.eda.repository
                        .exportRecoveryFile(repositoryId, record.id, path, stage)
                        .then((result) => {
                          if (!result.ok) setError(errorMessage(result.error));
                        })
                    }
                  >
                    {t("discardDialog.saveIndexCopy", {
                      value1:
                        stage === 0
                          ? t("discardDialog.staged")
                          : t("discardDialog.indexStage", { stage: stage }),
                      path: path,
                    })}
                  </TextButton>
                ))}

                {!record.indexOnly && (
                  <Button
                    disabled={busy || record.state !== "completed"}
                    onClick={() => void run(record.id)}
                  >
                    {t("discardDialog.restoreFiles", { length: record.paths.length })}
                  </Button>
                )}

                {forgetId === record.id ? (
                  <div className="space-y-2 text-xs">
                    <p>
                      {t("discardDialog.removingThisSnapshotPermanentlyRemovesItsSavedRecovery")}
                    </p>

                    <Button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);

                        try {
                          const result = await window.eda.repository.forgetRecovery(
                            repositoryId,
                            record.id,
                          );

                          if (result.ok) {
                            setRecords((items) => items.filter((item) => item.id !== record.id));
                            setForgetId(null);
                          } else setError(errorMessage(result.error));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {t("discardDialog.permanentlyRemoveSnapshot")}
                    </Button>

                    <Button variant="quiet" onClick={() => setForgetId(null)}>
                      {t("discardDialog.keepSnapshot")}
                    </Button>
                  </div>
                ) : (
                  <Button variant="quiet" disabled={busy} onClick={() => setForgetId(record.id)}>
                    {t("discardDialog.removeSnapshot")}
                  </Button>
                )}
              </div>
            ))}
          </>
        )}

        <ErrorDialog onDismiss={() => setError(null)}>{readState === "ready" && error}</ErrorDialog>
      </div>
    </Dialog>
  );
}
