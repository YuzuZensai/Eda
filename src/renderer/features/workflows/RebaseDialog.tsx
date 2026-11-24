import { Localized } from "@renderer/i18n/Localized";
import { errorMessage } from "@shared/errors";
import { getLocale, t, type MessageKey } from "@shared/i18n";
import type { RebaseAction, RebasePlanEntry, RebaseReview } from "@shared/workflows/rebase";
import { useEffect, useRef, useState } from "react";
import { CommitMessageEditor } from "../../components/ui/forms/CommitMessageEditor";
import {
  Button,
  NoticeBanner,
  Checkbox,
  Dialog,
  ErrorDialog,
  ReviewActions,
} from "../../components/ui/index";
import { useRepositoryStore } from "../../stores/repository-store";
import { usePreferencesStore } from "../../stores/preferences-store";
import { RebasePlanEditor } from "./RebasePlanEditor";

const labels: Record<RebaseAction, string> = {
  reword: t("commitMenu.editMessage"),
  start: t("rebaseDialog.rebaseCurrentBranch"),
  continue: t("rebaseDialog.continueRebase"),
  skip: t("rebaseDialog.skipCurrentCommit"),
  abort: t("rebaseDialog.abortRebase"),
  amend: t("rebaseDialog.amendPausedCommit"),
};

const descriptions = {
  start: "rebaseDialog.replayTheCurrentBranchSCommitsOnThe",
  skip: "rebaseDialog.discardTheCurrentReplayedCommitAndItsResolution",
  abort: "rebaseDialog.returnToTheBranchStateBeforeTheRebase",
  amend: "rebaseDialog.replaceThePausedCommitWithTheStagedChanges",
  continue: "rebaseDialog.commitTheStagedResolutionAndResumeTheRemaining",
  reword: undefined,
} satisfies Record<RebaseAction, MessageKey | undefined>;

interface RebaseDialogProps {
  repositoryId: string;
  action: RebaseAction;
  onto?: string;
  onClose: () => void;
}

export function RebaseDialog(props: RebaseDialogProps) {
  return (
    <RebaseForm key={JSON.stringify([props.repositoryId, props.action, props.onto])} {...props} />
  );
}

function RebaseForm({ repositoryId, action, onto, onClose }: RebaseDialogProps) {
  const preferences = usePreferencesStore((state) => state.values);
  const [review, setReview] = useState<RebaseReview | null>(null);
  const [phase, setPhase] = useState<"prepare" | "execute" | null>("prepare");
  const busy = phase !== null;
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interactive, setInteractive] = useState(false);
  const [plan, setPlan] = useState<RebasePlanEntry[] | undefined>();
  const [message, setMessage] = useState("");
  const [rewritten, setRewritten] = useState(0);
  const [recoveryWarning, setRecoveryWarning] = useState<string | null>(null);

  const request = useRef(0);
  const [fresh, setFresh] = useState(false);
  const [replacement, setReplacement] = useState<RebaseReview | null>(null);

  const reword = action === "reword";
  const description = descriptions[action];
  const editsMessage = reword || action === "amend";
  const needsConfirmation = !reword || (review?.publishedCommits ?? 0) > 0;
  const canExecute =
    !!review &&
    fresh &&
    (!needsConfirmation || confirmed) &&
    (!reword || (!!message.trim() && message !== review.message));

  const adopt = (next: RebaseReview) => {
    setReview(next);
    setPlan(next.plan);
    setMessage(next.message ?? "");
    setReplacement(null);
    setConfirmed(false);
    setFresh(true);
  };

  const prepare = async () => {
    const generation = ++request.current;
    setPhase("prepare");
    setError(null);
    setFresh(false);
    setConfirmed(false);
    setReplacement(null);

    try {
      const result = await window.eda.rebase.prepare(repositoryId, action, onto, interactive);
      if (generation !== request.current) return;
      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }
      const next = result.value;
      if (!review) adopt(next);
      else if (
        review.head === next.head &&
        review.branch === next.branch &&
        review.onto === next.onto &&
        review.message === next.message &&
        review.plan?.length === next.plan?.length &&
        (review.plan ?? []).every((entry, index) => entry.oid === next.plan?.[index]?.oid)
      ) {
        setReview(next);
        setFresh(true);
      } else setReplacement(next);
    } catch (failure) {
      if (generation === request.current) setError(errorMessage(failure));
    } finally {
      if (generation === request.current) setPhase(null);
    }
  };

  useEffect(() => {
    void prepare();
    return () => {
      request.current++;
    };
  }, [repositoryId, action, onto, interactive]);

  const execute = async () => {
    if (!review || !canExecute || busy) return;
    const generation = request.current;

    setPhase("execute");
    setError(null);

    try {
      const result = await window.eda.rebase.execute(
        repositoryId,
        review.token,
        plan,
        editsMessage ? message : undefined,
      );

      if (generation !== request.current) return;
      if (useRepositoryStore.getState().repositoryId === repositoryId)
        await useRepositoryStore.getState().syncFromDisk();
      if (generation !== request.current) return;

      if (!result.ok) {
        setError(errorMessage(result.error));
        setConfirmed(false);
        setFresh(false);
        return;
      }

      if (result.value.state === "completed" && result.value.publishedCommits)
        setRewritten(result.value.publishedCommits);
      if (result.value.recoveryWarning) setRecoveryWarning(result.value.recoveryWarning);
      else if (!result.value.publishedCommits) onClose();
    } catch (failure) {
      if (generation === request.current) {
        setError(errorMessage(failure));
        setFresh(false);
        setConfirmed(false);
      }
    } finally {
      if (generation === request.current) setPhase(null);
    }
  };

  return (
    <Dialog
      wide={interactive}
      title={labels[action]}
      busy={busy}
      onClose={onClose}
      description={description ? t(description) : ""}
      footer={
        <ReviewActions
          preparing={phase === "prepare"}
          busy={busy}
          onClose={onClose}
          onReview={
            reword && (busy || fresh || replacement || rewritten || recoveryWarning)
              ? undefined
              : () => void prepare()
          }
          onConfirm={() => void execute()}
          confirmLabel={reword ? t("reword.save") : labels[action]}
          confirmDisabled={!canExecute || rewritten > 0 || !!recoveryWarning}
          confirmVariant={reword ? "primary" : "secondary"}
          closeLabel={rewritten || recoveryWarning ? t("common.close") : t("common.cancel")}
          closeVariant="secondary"
          reviewDisabled={rewritten > 0 || !!recoveryWarning}
        />
      }
    >
      <div className="space-y-3 text-xs">
        {recoveryWarning && <p role="status">{recoveryWarning}</p>}

        {rewritten > 0 && (
          <p role="status">
            {t("rebaseDialog.rebaseCompletedTheOriginalRangeIncludedPublishedCommits", {
              rewritten: rewritten,
            })}
          </p>
        )}

        {action === "start" && !rewritten && (
          <Checkbox
            checked={interactive}
            disabled={busy}
            onChange={(event) => {
              setReview(null);
              setFresh(false);
              setConfirmed(false);
              setInteractive(event.target.checked);
            }}
          >
            {t("rebaseDialog.editCommitOrderAndMessages")}
          </Checkbox>
        )}

        {replacement && (
          <NoticeBanner
            tone="warning"
            action={
              <Button onClick={() => adopt(replacement)}>{t("rebaseDialog.useNewReview")}</Button>
            }
          >
            {t("rebaseDialog.rangeChanged")}
          </NoticeBanner>
        )}

        {review && !rewritten && (
          <>
            {!reword && review.publishedCommits > 0 && !rewritten && (
              <p role="note">
                {t("rebaseDialog.thisRangeIncludesCommitsReachableFromLocallyKnown", {
                  publishedCommits: review.publishedCommits,
                })}
              </p>
            )}

            {reword ? (
              <p className="text-text-secondary">
                {t("reword.target", {
                  oid: onto?.slice(0, 10) ?? "",
                  count: review.rewrittenCount ?? 1,
                })}
              </p>
            ) : (
              <p>
                <Localized
                  id="rebaseDialog.originalHead"
                  values={{ code: <code>{review.head}</code> }}
                />
              </p>
            )}

            {!reword && review.branch && (
              <p>
                <Localized
                  id="rebaseDialog.originalBranch"
                  values={{ code: <code>{review.branch}</code> }}
                />
              </p>
            )}

            {!reword && review.onto && (
              <p>
                <Localized
                  id="rebaseDialog.newBase"
                  values={{ code: <code>{review.onto}</code> }}
                />
              </p>
            )}

            {!reword && (
              <p>
                {t("rebaseDialog.committerDetails", { author: review.author, email: review.email })}
              </p>
            )}

            {action === "amend" && (
              <p>
                {t("rebaseDialog.stagedPathsIncluded", {
                  value1: review.paths.length
                    ? review.paths.join(", ")
                    : t("rebaseDialog.noneMessageOnlyAmendment"),
                })}
              </p>
            )}

            {editsMessage && (
              <CommitMessageEditor
                message={message}
                onChange={(value) => {
                  setMessage(value);
                  setConfirmed(false);
                }}
                conventional={preferences.conventionalCommitsEnabled.value}
                prefixes={preferences.commitPrefixes.value}
                summaryLimit={preferences.commitSummaryLimit.value}
                disabled={busy}
                autoFocus={reword}
              />
            )}

            {plan && (
              <RebasePlanEditor
                original={review.plan!}
                plan={plan}
                disabled={busy}
                onChange={(next) => {
                  setPlan(next);
                  setConfirmed(false);
                }}
              />
            )}

            {(action === "abort" || action === "skip") && (
              <>
                <p>
                  {t("rebaseDialog.recoveryWillPreserveAffectedPathsBytesBeforeChanging", {
                    length: review.paths.length,
                    recoveryBytes: review.recoveryBytes.toLocaleString(getLocale()),
                  })}
                </p>

                <ul className="max-h-40 overflow-auto font-mono">
                  {review.paths.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              </>
            )}

            {needsConfirmation && (
              <Checkbox
                checked={confirmed}
                disabled={busy || !fresh}
                onChange={(event) => setConfirmed(event.target.checked)}
              >
                {t(reword ? "reword.confirmPublished" : "rebaseDialog.iReviewedThisRebaseAction")}
              </Checkbox>
            )}
          </>
        )}

        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      </div>
    </Dialog>
  );
}
