import { lazyRepositoryDialog } from "../repository-dialogs.lazy";
import { errorMessage } from "@shared/errors";
import { t } from "@shared/i18n";
import { replayActionLabel } from "@shared/i18n/labels";
import type { RebaseAction } from "@shared/workflows/rebase";
import type { ReplayAction, ReplayKind } from "@shared/workflows/replay";
import type { WorkflowState } from "@shared/workflows/workflow";
import { Suspense, useState } from "react";
import { Button, ErrorDialog, TextButton } from "../../components/ui/index";
import { useRepositoryStore } from "../../stores/repository-store";

const MergeAbortDialog = lazyRepositoryDialog("MergeAbortDialog");

const MergeContinueDialog = lazyRepositoryDialog("MergeContinueDialog");

const RebaseDialog = lazyRepositoryDialog("RebaseDialog");

const ReplayDialog = lazyRepositoryDialog("ReplayDialog");

export function RepositoryWorkflowActions({
  repositoryId,
  workflow,
  writing,
  conflicts,
}: {
  repositoryId: string;
  workflow: WorkflowState | null | undefined;
  writing: boolean;
  conflicts: number;
}) {
  const [rebaseAction, setRebaseAction] = useState<RebaseAction | null>(null);

  const [replayAction, setReplayAction] = useState<{
    kind: ReplayKind;
    action: ReplayAction;
  } | null>(null);

  const [mergeAction, setMergeAction] = useState<"continue" | "abort" | null>(null);
  const [stashError, setStashError] = useState<string | null>(null);
  const [finishingStash, setFinishingStash] = useState(false);

  return (
    <>
      {workflow?.kind === "rebase" && (
        <>
          {workflow.rebaseEdit && (
            <>
              <span className="text-xs text-text-secondary">
                {t("repositoryWorkflowActions.editPause")}
              </span>

              <TextButton
                disabled={writing}
                className="text-xs text-accent-text"
                onClick={() => setRebaseAction("amend")}
              >
                {t("repositoryWorkflowActions.amendPausedCommit")}
              </TextButton>
            </>
          )}

          <TextButton
            disabled={writing || conflicts > 0}
            onClick={() => setRebaseAction("continue")}
            className="text-xs text-accent-text disabled:opacity-50"
          >
            {t("repositoryWorkflowActions.continueRebase")}
          </TextButton>

          <TextButton
            disabled={writing || workflow.rebaseEdit}
            onClick={() => setRebaseAction("skip")}
            title={workflow.rebaseEdit ? t("repositoryWorkflowActions.editSkipHelp") : undefined}
            className="text-xs text-text-secondary"
          >
            {t("repositoryWorkflowActions.skipCommit")}
          </TextButton>

          <TextButton
            disabled={writing}
            onClick={() => setRebaseAction("abort")}
            className="text-xs text-git-deleted"
          >
            {t("repositoryWorkflowActions.abortRebase")}
          </TextButton>
        </>
      )}

      {(workflow?.kind === "cherry-pick" || workflow?.kind === "revert") &&
        (["continue", "skip", "abort"] as const).map((action) => (
          <TextButton
            key={action}
            disabled={writing || (action === "continue" && conflicts > 0)}
            className="text-xs text-accent-text disabled:opacity-50"
            onClick={() => setReplayAction({ kind: workflow!.kind as ReplayKind, action })}
          >
            {replayActionLabel(workflow!.kind as ReplayKind, action)}...
          </TextButton>
        ))}

      {(workflow?.kind === "merge" ||
        workflow?.kind === "squash" ||
        workflow?.kind === "stash") && (
        <Button
          size="sm"
          variant="quiet"
          disabled={writing}
          onClick={() => setMergeAction("abort")}
        >
          {workflow.kind === "stash"
            ? t("repositoryWorkflowActions.abortStashApplication")
            : t("repositoryWorkflowActions.abortMerge")}
        </Button>
      )}

      {workflow?.kind === "stash" && (
        <TextButton
          disabled={writing || finishingStash || conflicts > 0}
          title={t("repositoryWorkflowActions.finishStashHelp")}
          onClick={async () => {
            setFinishingStash(true);
            setStashError(null);

            try {
              const result = await window.eda.workflows.finishStash(repositoryId, workflow!.token);
              if (!result.ok) setStashError(errorMessage(result.error));
              await useRepositoryStore.getState().syncFromDisk();
            } finally {
              setFinishingStash(false);
            }
          }}
          className="text-xs text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          {t("repositoryWorkflowActions.finishStashApplication")}
        </TextButton>
      )}

      {stashError && <ErrorDialog>{stashError}</ErrorDialog>}

      {(workflow?.kind === "merge" || workflow?.kind === "squash") && conflicts === 0 && (
        <Button
          size="sm"
          variant="quiet"
          disabled={writing}
          title={t("repositoryWorkflowActions.continueMergeHelp")}
          onClick={() => setMergeAction("continue")}
        >
          {t("repositoryWorkflowActions.continueMerge")}
        </Button>
      )}

      <Suspense fallback={null}>
        {rebaseAction && (
          <RebaseDialog
            key={repositoryId}
            repositoryId={repositoryId}
            action={rebaseAction}
            onClose={() => setRebaseAction(null)}
          />
        )}

        {replayAction && (
          <ReplayDialog
            repositoryId={repositoryId}
            kind={replayAction.kind}
            action={replayAction.action}
            onClose={() => setReplayAction(null)}
          />
        )}

        {mergeAction === "continue" && (
          <MergeContinueDialog
            key={repositoryId}
            repositoryId={repositoryId}
            onClose={() => setMergeAction(null)}
          />
        )}

        {mergeAction === "abort" && (
          <MergeAbortDialog
            kind={workflow?.kind === "stash" ? "stash" : "merge"}
            key={repositoryId}
            repositoryId={repositoryId}
            onClose={() => setMergeAction(null)}
          />
        )}
      </Suspense>
    </>
  );
}
