import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import type { MergeContinuation } from "@shared/workflows/workflow";
import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  ErrorDialog,
  ReviewActions,
  Textarea,
} from "../../components/ui/index";
import { useRepositoryStore } from "../../stores/repository-store";

export function MergeContinueDialog({
  repositoryId,
  onClose,
}: {
  repositoryId: string;
  onClose: () => void;
}) {
  const [reviewWorktrees, setReviewWorktrees] = useState(false);
  const [review, setReview] = useState<MergeContinuation | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"prepare" | "execute" | null>(null);
  const busy = phase !== null;
  const [discard, setDiscard] = useState(false);

  const refresh = async (keepMessage = false) => {
    setPhase("prepare");
    setError(null);

    try {
      const result = await window.eda.workflows.prepareMerge(repositoryId);

      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }

      setReview(result.value);

      if (!keepMessage || !review) setMessage(result.value.message);
    } finally {
      setPhase(null);
    }
  };

  useEffect(() => {
    void refresh();
  }, [repositoryId]);

  const close = () => {
    if (review && message !== review.message) setDiscard(true);
    else onClose();
  };

  const complete = async () => {
    if (!review) return;

    setPhase("execute");
    setError(null);

    try {
      const result = await window.eda.workflows.continueMerge(repositoryId, review.id, message);

      if (!result.ok) {
        setError(errorMessage(result.error));
        return;
      }

      await useRepositoryStore.getState().syncFromDisk();
      onClose();
      if (reviewWorktrees && useRepositoryStore.getState().repositoryId === repositoryId)
        useRepositoryStore.setState({
          commandDialog: { kind: "repository.worktrees", oid: undefined },
        });
    } finally {
      setPhase(null);
    }
  };

  return (
    <Dialog
      title={t("mergeContinueDialog.completeMerge")}
      description={t("mergeContinueDialog.commitTheReviewedStagedResultUnstagedChangesRemain")}
      onClose={close}
      busy={busy}
      footer={
        <ReviewActions
          preparing={phase === "prepare"}
          busy={busy}
          onClose={close}
          onReview={() => void refresh(true)}
          onConfirm={() => void complete()}
          confirmLabel={t("mergeContinueDialog.completeMerge")}
          confirmDisabled={!review || !message.trim()}
          closeLabel={t("common.close")}
        />
      }
    >
      <Checkbox checked={reviewWorktrees} onChange={(e) => setReviewWorktrees(e.target.checked)}>
        {t("worktrees.reviewAfterMerge")}
      </Checkbox>
      <div className="space-y-3">
        {review && (
          <>
            <p className="text-xs text-text-secondary">
              {t("mergeContinueDialog.authorDetails", {
                author: review.author,
                email: review.email,
                value3: review.signing
                  ? t("mergeContinueDialog.signed")
                  : t("mergeContinueDialog.unsigned"),
              })}
            </p>

            <p className="text-xs text-text-tertiary">
              {review.squash
                ? t("mergeContinueDialog.squashCommitParentSource", {
                    head: review.head.slice(0, 8),
                    value2: review.incoming.map((oid) => oid.slice(0, 8)).join(", "),
                  })
                : t("mergeContinueDialog.parents", {
                    value1: [review.head, ...review.incoming]
                      .map((oid) => oid.slice(0, 8))
                      .join(" + "),
                  })}
            </p>

            {review.state === "paused" && (
              <p className="text-xs text-git-modified">
                {t(
                  "mergeContinueDialog.thePreviousAttemptDidNotFinishReviewTheRetainedMessageAndRetry",
                )}
              </p>
            )}

            <label className="block text-xs">
              {t("mergeContinueDialog.mergeMessage")}

              <Textarea
                aria-label={t("mergeContinueDialog.mergeMessage")}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                disabled={busy}
                className="mt-1 h-40"
              />
            </label>
          </>
        )}

        <ErrorDialog onDismiss={() => setError(null)}>{error}</ErrorDialog>
      </div>

      {discard && (
        <Dialog
          title={t("mergeContinueDialog.discardMessageEdits")}
          description={t("mergeContinueDialog.theMergeRemainsInProgressEditsMadeSince")}
          onClose={() => setDiscard(false)}
          footer={
            <>
              <Button onClick={() => setDiscard(false)}>
                {t("mergeContinueDialog.keepEditing")}
              </Button>
              <Button onClick={onClose}>{t("mergeContinueDialog.discardEdits")}</Button>
            </>
          }
        >
          <p className="text-xs">
            {t("mergeContinueDialog.aSubmittedMessageIsRetainedIfCommittingFails")}
          </p>
        </Dialog>
      )}
    </Dialog>
  );
}
