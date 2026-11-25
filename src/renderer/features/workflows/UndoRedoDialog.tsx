import { Localized } from "@renderer/i18n/Localized";
import { errorMessage, type Result } from "@shared/errors";
import { t } from "@shared/i18n";
import { stateLabel } from "@shared/i18n/labels";
import type { HistoryReversal } from "@shared/workflows/history-recovery";
import { ArrowRightIcon as ArrowRight } from "../../components/ui/icons";
import { useEffect, useState } from "react";
import {
  AsyncButton,
  Button,
  Checkbox,
  Dialog,
  Disclosure,
  ErrorDialog,
} from "../../components/ui/index";
import { useRepositoryStore } from "../../stores/repository-store";

export function UndoRedoDialog({
  repositoryId,
  onClose,
}: {
  repositoryId: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<HistoryReversal[]>([]);
  const [selected, setSelected] = useState<HistoryReversal | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setItems([]);
    setSelected(null);
    setConfirmed(false);
    setError(null);

    try {
      const response = await window.eda.historyRecovery.reversals(repositoryId);
      if (response.ok) setItems(response.value);
      else setError(errorMessage(response.error));
      return response.ok;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [repositoryId]);

  const run = async <Value,>(
    action: () => Promise<Result<Value>>,
    success: (value: Value) => string,
    { syncRepository = false } = {},
  ) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await action();
      const repository = useRepositoryStore.getState();
      if (syncRepository && repository.repositoryId === repositoryId)
        await repository.syncFromDisk();
      if (!response.ok) {
        setError(errorMessage(response.error));
        return;
      }

      setResult(success(response.value));
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const recovery = window.eda.historyRecovery;
  const resumeBranchCheckout = (item: HistoryReversal) => {
    const phase = item.resumeBranchCheckout;
    if (!phase) return;
    return run(
      () => recovery.resumeBranchCheckout(repositoryId, item.id, phase),
      () =>
        phase === "original"
          ? t("undoRedoDialog.branchCheckoutCompletedTheExistingBranchWasRetained")
          : t("undoRedoDialog.interruptedCompletedPreviouslyCompletedStepsWereRetained", {
              resumeBranchCheckout: phase,
            }),
      { syncRepository: true },
    );
  };

  const dismissUnstarted = (item: HistoryReversal) =>
    run(
      () => recovery.dismissUnstarted(repositoryId, item.id),
      () => t("undoRedoDialog.unstartedActionDismissedBranchesIndexAndWorkingFiles"),
    );

  const reconcile = (item: HistoryReversal) => {
    const state = item.reconciliation;
    if (!state) return;
    return run(
      () => recovery.reconcile(repositoryId, item.id, state),
      () => t("undoRedoDialog.recoveryRecordReconciledWithGitNoRefsIndex"),
    );
  };

  const resumeIndex = (item: HistoryReversal) =>
    run(
      () => recovery.resumeIndex(repositoryId, item.id, item.direction),
      ({ preservedNewerWork }) => {
        const restored =
          item.mode === "hard"
            ? t("undoRedoDialog.indexAndSavedWorkingFileRestorationCompleted")
            : t("undoRedoDialog.indexRestorationCompletedWorkingFilesWereRetained");
        return preservedNewerWork
          ? `${restored} ${t("undoRedoDialog.newerStatePreserved")}`
          : restored;
      },
      { syncRepository: true },
    );

  const resumeConfiguration = (item: HistoryReversal) =>
    run(
      () => recovery.resumeConfiguration(repositoryId, item.id, item.direction),
      () => t("undoRedoDialog.branchConfigurationRecoveryCompletedNoRefsIndexEntries"),
    );

  const resumeReset = (item: HistoryReversal) =>
    run(
      () => recovery.resumeReset(repositoryId, item.id, item.publishedCommits),
      ({ outcome }) =>
        outcome === "reset"
          ? t("undoRedoDialog.theInterruptedResetReachedItsReviewedTargetAnd")
          : t("undoRedoDialog.gitHadAlreadyReachedTheReviewedResetTarget"),
      { syncRepository: true },
    );

  const execute = () => {
    if (!selected) return;
    setConfirmed(false);
    return run(
      () =>
        recovery.reverse(repositoryId, selected.id, selected.direction, selected.publishedCommits),
      () =>
        t("undoRedoDialog.completed", {
          label: selected.label,
          value2: selected.publishedCommits
            ? t(
                "undoRedoDialog.publishedHistoryWasAffectedNothingWasPushedFetchAndReviewTheDestinationCoordinateAnIntendedReplacementAndUseForceWithLeaseInspectARejectedLeaseInsteadOfOverridingIt",
              )
            : "",
        }),
      { syncRepository: true },
    );
  };

  return (
    <Dialog
      title={t("undoRedoDialog.undoAndRedoLocalActions")}
      wide
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {t("common.close")}
          </Button>

          <AsyncButton
            label={t("undoRedoDialog.refreshActions")}
            disabled={busy}
            onAction={refresh}
          >
            {t("undoRedoDialog.refreshActions")}
          </AsyncButton>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        {busy && <p role="status">{t("undoRedoDialog.checkingRepositoryState")}</p>}
        {!busy && !error && !items.length && <p>{t("undoRedoDialog.noRecordedLocalActions")}</p>}

        <div className="grid gap-4 md:grid-cols-2">
          <ul className="max-h-[48vh] space-y-2 overflow-auto">
            {items.map((item) => (
              <li key={item.id} className="border-b border-border-subtle pb-2">
                <Button
                  aria-pressed={selected?.id === item.id}
                  variant={selected?.id === item.id ? "primary" : "secondary"}
                  disabled={busy || !item.available}
                  onClick={() => {
                    setSelected(item);
                    setConfirmed(false);
                    setResult(null);
                  }}
                >
                  {item.label}
                </Button>

                {item.reason && <p className="mt-1 text-text-tertiary">{item.reason}</p>}

                {item.resumeConfiguration && (
                  <div className="mt-2 space-y-1">
                    <p>{t("undoRedoDialog.theReferenceChangeFinishedRestoreItsSavedBranch")}</p>
                    <Button disabled={busy} onClick={() => void resumeConfiguration(item)}>
                      {t("undoRedoDialog.finishSettingsFor", { label: item.label })}
                    </Button>
                  </div>
                )}

                {item.resumeReset && (
                  <div className="mt-2 space-y-1">
                    <p>{item.reason}</p>

                    {item.publishedCommits > 0 && (
                      <p role="note">
                        {t("undoRedoDialog.thisResetAffectsPublishedCommitsKnownFromLocal", {
                          publishedCommits: item.publishedCommits,
                        })}
                      </p>
                    )}

                    <Button disabled={busy} onClick={() => void resumeReset(item)}>
                      {t("undoRedoDialog.resumeInterruptedReset", { mode: item.mode })}
                    </Button>
                  </div>
                )}

                {item.resumeIndex && (
                  <div className="mt-2 space-y-1">
                    <p>
                      {t("undoRedoDialog.headAlreadyReachedThisReversalSTarget", {
                        value1:
                          item.mode === "hard"
                            ? t("undoRedoDialog.affectedWorkingFilesAreRestoredFromSavedCopies")
                            : t(
                                "undoRedoDialog.workingFilesStayUnchangedNewerStagedChangesBlockRecovery",
                              ),
                      })}
                    </p>

                    <Button disabled={busy} onClick={() => void resumeIndex(item)}>
                      {t("undoRedoDialog.resumeFor", {
                        value1:
                          item.mode === "hard"
                            ? t("undoRedoDialog.filesAndIndex")
                            : t("undoRedoDialog.index"),
                        label: item.label,
                      })}
                    </Button>
                  </div>
                )}

                {item.resumeBranchCheckout && (
                  <div className="mt-2 space-y-1">
                    <p>
                      {item.resumeBranchCheckout === "undo"
                        ? t("undoRedoDialog.checkoutAlreadyReturnedToTheOriginalBranchResume")
                        : t("undoRedoDialog.theBranchWasCreatedButCheckoutIsUnfinished")}
                    </p>

                    <Button disabled={busy} onClick={() => void resumeBranchCheckout(item)}>
                      {t("undoRedoDialog.resume", {
                        value1:
                          item.resumeBranchCheckout === "undo"
                            ? t("undoRedoDialog.branchRemoval")
                            : t("undoRedoDialog.checkout"),
                        label: item.label,
                      })}
                    </Button>
                  </div>
                )}

                {item.dismissUnstarted && (
                  <div className="mt-2 space-y-1">
                    <p>{t("undoRedoDialog.gitStillMatchesTheRecordedStartingStateDismiss")}</p>
                    <Button disabled={busy} onClick={() => void dismissUnstarted(item)}>
                      {t("undoRedoDialog.dismissUnstartedAction", { label: item.label })}
                    </Button>
                  </div>
                )}

                {item.reconciliation && (
                  <div className="mt-2 space-y-1">
                    <p>
                      {t("undoRedoDialog.gitMatchesTheRecordedStateReconcileUpdatesEda", {
                        value1: stateLabel(item.reconciliation),
                      })}
                    </p>

                    <Button disabled={busy} onClick={() => void reconcile(item)}>
                      {t("undoRedoDialog.reconcile", { label: item.label })}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {selected && (
            <div className="min-w-0 space-y-3 rounded-md border border-border-subtle p-3">
              <h3 className="font-semibold">{selected.label}</h3>

              {selected.publishedCommits > 0 && (
                <p role="note">
                  {t("undoRedoDialog.thisReversalRemovesCommitsReachableFromLocallyKnown", {
                    publishedCommits: selected.publishedCommits,
                  })}
                </p>
              )}

              <p className="break-all">
                <Localized
                  id="undoRedoDialog.head"
                  values={{ code: <code>{selected.fromHead || t("common.unbornBranch")}</code> }}
                />
                <ArrowRight size={14} className="inline align-[-2px]" aria-hidden="true" />{" "}
                <code>{selected.toHead || t("common.unbornBranch")}</code>
              </p>

              <p>
                {selected.kind === "branch"
                  ? t("undoRedoDialog.onlyTheLocalBranchReferenceChangesCommitsThe")
                  : selected.kind === "checkout"
                    ? t("undoRedoDialog.theRecordedBranchOrDetachedHeadIsChecked")
                    : selected.kind === "rebase" ||
                        selected.kind === "cherry-pick" ||
                        selected.kind === "revert"
                      ? t("undoRedoDialog.theOriginalBranchTipIndexAndAffectedWorking")
                      : selected.mode === "soft"
                        ? t("undoRedoDialog.indexAndWorkingFilesAreRetained")
                        : selected.mode === "mixed"
                          ? t("undoRedoDialog.theSavedIndexIsRestoredWorkingFilesAreRetained")
                          : t("undoRedoDialog.theSavedIndexAndAffectedWorkingFilesAre")}
              </p>

              <Checkbox
                className="flex gap-2"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              >
                {t("undoRedoDialog.iReviewedThisReversal")}
              </Checkbox>

              <Button disabled={busy || !confirmed} onClick={() => void execute()}>
                {t("undoRedoDialog.apply", {
                  value1:
                    selected.direction === "undo"
                      ? t("undoRedoDialog.undo")
                      : t("undoRedoDialog.redo"),
                })}
              </Button>
            </div>
          )}

          {!selected && items.length > 0 && (
            <p className="text-text-tertiary">{t("undoRedoDialog.selectAction")}</p>
          )}
        </div>
        <Disclosure title={t("undoRedoDialog.supportedActions")}>
          {" "}
          <p>{t("undoRedoDialog.supportsCommitsAmendmentsReviewedResetsBranchCreateDelete")}</p>
          <p>{t("undoRedoDialog.reversalDoesNotPushToRemotesOrReverse")}</p>
        </Disclosure>
        {result && <p role="status">{result}</p>}
        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      </div>
    </Dialog>
  );
}
