import { Localized } from "@renderer/i18n/Localized";
import { getLocale, t } from "@shared/i18n";
import { useCallback, useEffect, useState } from "react";
import { Checkbox, Dialog, ErrorDialog, ReviewActions } from "../../components/ui/index";
import { useReviewedOperation } from "../../repository/hooks/useReviewedOperation";

export function MergeAbortDialog({
  repositoryId,
  kind = "merge",
  onClose,
}: {
  repositoryId: string;
  kind?: "merge" | "stash";
  onClose: () => void;
}) {
  const label =
    kind === "stash" ? t("mergeAbortDialog.stashApplication") : t("mergeAbortDialog.merge");

  const prepare = useCallback(
    () => window.eda.workflows.prepareAbort(repositoryId),
    [repositoryId, kind],
  );

  const { preview, preparing, busy, error, setError, review, execute } = useReviewedOperation(
    repositoryId,
    prepare,
  );

  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => setConfirmed(false), [preview]);

  const abort = () =>
    execute((preview) => window.eda.workflows.abortMerge(repositoryId, preview.token), onClose);

  return (
    <Dialog
      title={t("mergeAbortDialog.abort", { label: label })}
      description={t("mergeAbortDialog.gitWillTryToRestoreTheStateBefore", {
        label: label,
        value2: kind === "stash" ? t("mergeAbortDialog.theSourceStashIsRetained") : "",
      })}
      busy={busy}
      onClose={onClose}
      footer={
        <ReviewActions
          preparing={preparing}
          busy={busy}
          onClose={onClose}
          onReview={() => void review()}
          onConfirm={() => void abort()}
          confirmLabel={t("mergeAbortDialog.abort", { label: label })}
          confirmDisabled={!preview || !confirmed}
          confirmVariant="secondary"
        />
      }
    >
      <div className="space-y-3 text-xs">
        {preview && (
          <>
            <p>
              <Localized
                id="mergeAbortDialog.originalHead"
                values={{ code: <code>{preview.originalHead.slice(0, 12)}</code> }}
              />
            </p>

            <p>
              {t("mergeAbortDialog.aRecoveryCopyOfBytesWillPreserveThe", {
                bytes: preview.bytes.toLocaleString(getLocale()),
              })}
            </p>

            <p>{t("mergeAbortDialog.completedSnapshotsAreRetainedFor30DaysUpTo100")}</p>

            <ul className="max-h-48 overflow-auto font-mono">
              {preview.paths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>

            <Checkbox
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={busy}
            >
              {t("mergeAbortDialog.abortThisAndPreserveRecoveryCopies", { label: label })}
            </Checkbox>
          </>
        )}

        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      </div>
    </Dialog>
  );
}
