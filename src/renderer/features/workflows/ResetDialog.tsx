import { Localized } from "@renderer/i18n/Localized";
import { getLocale, t } from "@shared/i18n";
import type { ResetMode, ResetResult } from "@shared/workflows/reset";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  DefinitionList,
  Dialog,
  Disclosure,
  ErrorDialog,
  ReviewActions,
  Select,
} from "../../components/ui/index";
import { useReviewedOperation } from "../../repository/hooks/useReviewedOperation";

export function ResetDialog({
  repositoryId,
  target,
  onClose,
}: {
  repositoryId: string;
  target: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<ResetMode>("soft");
  const [result, setResult] = useState<ResetResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const inspect = useCallback(
    () => window.eda.reset.prepare(repositoryId, target, mode),
    [repositoryId, target, mode],
  );
  const {
    preview: review,
    busy,
    preparing,
    error,
    setError,
    review: prepare,
    execute,
  } = useReviewedOperation(repositoryId, inspect);

  useEffect(() => setConfirmed(false), [review]);

  return (
    <Dialog
      title={t("resetDialog.resetToCommit")}
      wide
      busy={busy}
      onClose={onClose}
      description={t("resetDialog.moveTheCurrentBranchOrDetachedHeadTo")}
      footer={
        result ? (
          <Button onClick={onClose}>{t("common.close")}</Button>
        ) : (
          <ReviewActions
            preparing={preparing}
            busy={busy}
            onClose={onClose}
            onReview={() => void prepare()}
            onConfirm={() =>
              void execute(
                (preview) => window.eda.reset.execute(repositoryId, preview.token),
                setResult,
              )
            }
            confirmLabel={t("resetDialog.reset", { mode: mode })}
            confirmDisabled={!review || !confirmed}
            confirmVariant={mode === "hard" ? "danger" : "primary"}
            closeVariant="secondary"
          />
        )
      }
    >
      <div className="space-y-3 text-xs">
        {result ? (
          <>
            <p role="status">{t("resetDialog.resetCompleted")}</p>

            {result.publishedCommits > 0 && (
              <p role="note">
                {t("resetDialog.thisResetRemovedPublishedCommitsFromTheCurrent", {
                  publishedCommits: result.publishedCommits,
                })}
              </p>
            )}

            <p>
              <Localized id="resetDialog.head" values={{ code: <code>{result.head}</code> }} />
            </p>
            {result.snapshotId && (
              <p>{t("resetDialog.savedWorkingIndexCopiesAreAvailableInRecoverLocalFiles")}</p>
            )}

            <Disclosure title={t("resetDialog.recoveryDetails")}>
              <p>
                <Localized
                  id="resetDialog.previousHead"
                  values={{ code: <code>{result.recoveryRef}</code> }}
                />
              </p>

              <p>{t("resetDialog.completedResetRecoveryRecordsAreRetainedFor30Days")}</p>
            </Disclosure>
          </>
        ) : (
          <>
            <label className="flex items-center gap-2">
              {t("resetDialog.resetMode")}

              <Select
                aria-label={t("resetDialog.resetMode")}
                value={mode}
                disabled={busy}
                surface="surface"
                onValueChange={(value) => setMode(value as ResetMode)}
              >
                <option value="soft">{t("resetDialog.softKeepIndexAndWorkingFiles")}</option>
                <option value="mixed">{t("resetDialog.mixedResetIndexKeepWorkingFiles")}</option>
                <option value="hard">{t("resetDialog.hardResetIndexAndWorkingFiles")}</option>
              </Select>
            </label>

            <DefinitionList
              items={[
                {
                  label: t("resetDialog.headLabel"),
                  value: (
                    <>
                      <Localized
                        id="resetDialog.movesTo"
                        values={{ code: <code>{target.slice(0, 12)}</code> }}
                      />
                    </>
                  ),
                },
                {
                  label: t("resetDialog.index"),
                  value:
                    mode === "soft"
                      ? t("resetDialog.contentsRetainedStagedStatusIsRelativeToTheNewHead")
                      : t("resetDialog.replacedIndex"),
                },
                {
                  label: t("resetDialog.workingFiles"),
                  value:
                    mode === "hard"
                      ? t("resetDialog.replacedWorkingTree")
                      : t("resetDialog.retained"),
                },
              ]}
            />

            {review && (
              <>
                <p>
                  <Localized
                    id="resetDialog.current"
                    values={{
                      value1: review.branch ?? t("resetDialog.detachedHead"),
                      code2: <code>{review.head}</code>,
                    }}
                  />
                </p>

                <p>
                  <Localized
                    id="resetDialog.target"
                    values={{ code: <code>{review.target}</code> }}
                  />
                </p>

                <p>
                  {t("resetDialog.indexPathsChangeWorkingPathsMayBeReplacedRecoveryCopiesBytes", {
                    length: review.indexPaths.length,
                    lengthValue: review.workingPaths.length,
                    recoveryBytes: review.recoveryBytes.toLocaleString(getLocale()),
                  })}
                </p>

                <ul className="max-h-48 overflow-auto font-mono">
                  {[...new Set([...review.indexPaths, ...review.workingPaths])].map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>

                {review.publishedCommits > 0 && (
                  <p role="note" className="text-git-modified">
                    {t("resetDialog.thisResetRemovesCommitsReachableFromLocallyKnown", {
                      publishedCommits: review.publishedCommits,
                    })}
                  </p>
                )}

                <p>{t("resetDialog.thePreviousHeadAndIndexTreeAreSaved")}</p>

                <Checkbox
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                >
                  {mode === "hard"
                    ? t("resetDialog.iReviewedTheFilesThatWillBeOverwrittenOrRemoved")
                    : t("resetDialog.iReviewedThisReset")}
                </Checkbox>
              </>
            )}
          </>
        )}

        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      </div>
    </Dialog>
  );
}
