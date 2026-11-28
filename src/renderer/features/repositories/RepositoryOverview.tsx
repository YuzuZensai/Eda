import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { usePreferencesStore } from "../../stores/preferences-store";
import { useState, useMemo } from "react";
import { WorktreesDialog } from "./WorktreesDialog";
import { t } from "@shared/i18n";
import { workflowLabel } from "@shared/i18n/labels";
import { revisionLabel } from "../../repository/reference-label";
import type { RepositorySummary } from "@shared/repository/repository";
import {
  ArrowDownIcon as ArrowDown,
  ArrowUpIcon as ArrowUp,
  CircleAlertIcon as CircleAlert,
  BranchIcon as GitBranch,
} from "../../components/ui/icons";
import { Skeleton } from "../../components/ui/feedback/Skeleton";
import { Button, cx, StatusBanner, RefreshButton, TextButton } from "../../components/ui/index";
import { categorizeChanges } from "../../repository/working-changes";
import { useRepositoryStore } from "../../stores/repository-store";
import { BranchMenu } from "../references/BranchMenu";
import { RepositorySyncActions } from "../sync/RepositorySyncActions";
import { StashActions } from "../stashes/StashActions";
import { RepositoryWorkflowActions } from "../workflows/RepositoryWorkflowActions";

import { RepositoryTrustButton } from "./RepositoryTrustButton";

export function RepositoryOverview({
  repository,
  onOpenCommit,
  pending = false,
}: {
  repository: RepositorySummary;
  onOpenCommit?: () => void;
  pending?: boolean;
}) {
  const [worktrees, setWorktrees] = useState(false);
  const selection = useRepositoryStore((state) => state.selection);
  const editingConflict =
    useRepositoryStore((state) => state.contentView === "diff") &&
    selection?.kind === "change" &&
    selection.area === "conflicted";
  const status = useRepositoryStore((state) => state.status);
  const writing = useRepositoryStore((state) => state.writing);
  const truncated = useRepositoryStore((state) => state.truncatedChanges);
  const branch = status?.branch;
  const workflow = status?.workflow;
  const incoming = workflow?.incoming[0];
  const source = useRepositoryStore((state) =>
    incoming ? revisionLabel(state.pages, incoming) : "",
  );
  const direction =
    source && branch?.head && (workflow?.kind === "merge" || workflow?.kind === "squash")
      ? t("repositoryWorkflowActions.mergeDirection", { source, target: branch.head })
      : null;
  const predict = usePreferencesStore((state) => state.values.predictUpstreamConflicts.value);
  const upstreamRequest = useMemo(
    () =>
      predict &&
      !pending &&
      !writing &&
      !status?.workflow &&
      branch?.ahead &&
      branch.behind &&
      branch.upstream
        ? { id: repository.id, branch }
        : null,
    [predict, pending, writing, status?.workflow, branch, repository.id],
  );
  const prediction = useRepositoryRead(
    ({ id }: { id: string }) => window.eda.workflows.predictUpstream(id),
    upstreamRequest,
  );
  const categories = categorizeChanges(status?.changes ?? []);
  const conflicts = categories.conflicted.length;

  return (
    <>
      <header
        data-tour="repository-overview"
        aria-label={t("repositoryOverview.repositoryOverview")}
        className="repository-overview app-surface-chrome flex h-9 min-w-0 shrink-0 items-center gap-4 border-b border-border-subtle bg-bg-surface px-3"
      >
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <div className="flex min-w-0 shrink-0 items-center gap-2 text-xs">
            <h1
              aria-label={repository.name}
              title={repository.path}
              className="max-w-32 truncate font-medium"
            >
              <TextButton
                disabled={pending}
                aria-label={t("worktrees.title")}
                title={t("worktrees.title")}
                onClick={() => setWorktrees(true)}
              >
                {repository.name}
              </TextButton>
            </h1>
            {repository.trusted === false && (
              <RepositoryTrustButton
                key={repository.id}
                repositoryId={repository.id}
                badge
                disabled={pending || writing}
              />
            )}

            <span className="text-text-tertiary">/</span>

            {pending ? (
              <Skeleton className="w-24" />
            ) : branch?.head ? (
              <BranchMenu head={branch.head} />
            ) : (
              <span className="flex items-center gap-1.5 text-git-modified">
                <GitBranch size={14} />
                {t("repositoryOverview.detachedHead", { oid: branch?.oid?.slice(0, 7) })}
              </span>
            )}

            {!pending && branch?.unborn && (
              <span className="text-xs text-text-tertiary">
                {t("repositoryOverview.noCommitsYet")}
              </span>
            )}
          </div>

          <div className="flex min-w-0 items-center gap-2 text-xs text-text-tertiary">
            {pending ? (
              <Skeleton className="w-32" />
            ) : branch?.upstream ? (
              <>
                <span
                  title={t("repositoryOverview.commitsAheadOfTheLocallyKnownUpstream")}
                  className={cx(
                    "flex shrink-0 items-center gap-1",
                    branch.ahead > 0 && "text-git-added",
                  )}
                >
                  <ArrowUp size={12} />
                  {branch.ahead}
                </span>

                <span
                  title={t("repositoryOverview.commitsBehindTheLocallyKnownUpstream")}
                  className={cx(
                    "flex shrink-0 items-center gap-1",
                    branch.behind > 0 && "text-git-modified",
                  )}
                >
                  <ArrowDown size={12} />
                  {branch.behind}
                </span>
              </>
            ) : (
              <span className="truncate">
                {branch?.detached
                  ? t("repositoryOverview.inspectingACommitOutsideABranch")
                  : t("repositoryOverview.noUpstreamConfigured")}
              </span>
            )}
          </div>
        </div>

        <RepositorySyncActions />

        <StashActions pending={pending} />

        <div
          aria-label={t("repositoryOverview.repositoryActions")}
          className="flex min-w-0 flex-1 items-center justify-end gap-4 text-xs"
        >
          {onOpenCommit && (
            <TextButton className="text-accent-text" onClick={onOpenCommit}>
              {t("repositoryOverview.commitDraft")}
            </TextButton>
          )}

          {!pending && truncated && (
            <CircleAlert
              size={14}
              className="text-git-modified"
              aria-label={t("repositoryOverview.changeListIsTruncated")}
            />
          )}

          <RefreshButton
            label={t("repositoryOverview.refreshRepository")}
            disabled={pending || writing}
            onRefresh={async () => {
              const store = useRepositoryStore.getState();
              const id = store.repositoryId;
              const identityId = store.identityId;

              await store.refresh();

              const current = useRepositoryStore.getState();

              return (
                current.repositoryId === id &&
                current.identityId === identityId &&
                !current.error &&
                !current.historyError
              );
            }}
          />
        </div>
      </header>
      {upstreamRequest && (prediction.error || prediction.value?.state === "unavailable") && (
        <p role="status" className="px-3 text-xs text-text-secondary">
          {t("mergePrediction.unavailable", {
            reason: prediction.error ?? prediction.value?.reason,
          })}
        </p>
      )}
      {upstreamRequest && prediction.value?.state === "conflicted" && (
        <details className="border-b border-border-subtle px-3 py-1 text-xs">
          <summary>
            {t("mergePrediction.conflicts", {
              count: prediction.value.totalPaths,
              upstream: branch?.upstream,
            })}
          </summary>
          <ul>
            {prediction.value.paths.map((path) => (
              <li key={path} className="mono selectable">
                {path}
              </li>
            ))}
          </ul>
        </details>
      )}

      {worktrees && (
        <WorktreesDialog
          key={repository.id}
          repository={repository}
          onClose={() => setWorktrees(false)}
        />
      )}
      {!pending && (
        <div hidden={editingConflict || (!workflow && conflicts === 0)} className="shrink-0">
          <StatusBanner
            label={t("repositoryOverview.repositoryActions")}
            tone={conflicts > 0 ? "warning" : "info"}
            action={
              <>
                <RepositoryWorkflowActions
                  repositoryId={repository.id}
                  workflow={workflow}
                  writing={writing}
                  conflicts={conflicts}
                />

                {conflicts > 0 && (
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      const first = categories.conflicted[0];
                      if (first)
                        void useRepositoryStore.getState().selectChange(first, "conflicted");
                    }}
                  >
                    {t("repositoryOverview.resolveConflicts", { count: conflicts })}
                  </Button>
                )}
              </>
            }
          >
            <span
              className="inline-block font-medium text-text-primary first-letter:uppercase"
              title={workflow ? `${workflow.currentLabel}; ${workflow.incomingLabel}` : undefined}
            >
              {workflow
                ? t("repositoryWorkflowActions.inProgress", {
                    kind: workflowLabel(workflow.kind),
                    value2:
                      workflow.step !== null ? `, ${workflow.step}/${workflow.total ?? "?"}` : "",
                  })
                : t("changes.changeListModel.conflicts")}
            </span>
            {direction && (
              <span className="ms-2" title={direction}>
                {direction}
              </span>
            )}
          </StatusBanner>
        </div>
      )}
    </>
  );
}
