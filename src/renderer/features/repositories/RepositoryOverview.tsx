import { t } from "@shared/i18n";
import type { RepositorySummary } from "@shared/repository/repository";
import {
  ArrowDownIcon as ArrowDown,
  ArrowUpIcon as ArrowUp,
  CircleAlertIcon as CircleAlert,
  BranchIcon as GitBranch,
} from "../../components/ui/icons";
import { lazy, Suspense, useState } from "react";
import { Skeleton } from "../../components/ui/feedback/Skeleton";
import { cx, RefreshButton, TextButton } from "../../components/ui/index";
import { categorizeChanges } from "../../repository/working-changes";
import { openSettings } from "../../stores/shell-store";
import { useRepositoryStore } from "../../stores/repository-store";
import { BranchMenu } from "../references/BranchMenu";
import { RepositorySyncActions } from "../sync/RepositorySyncActions";
import { StashActions } from "../stashes/StashActions";
import { RepositoryWorkflowActions } from "../workflows/RepositoryWorkflowActions";

import { RepositoryTrustButton } from "./RepositoryTrustButton";

const ConflictDialog = lazy(() =>
  import("../repository-dialogs").then((module) => ({ default: module.ConflictDialog })),
);

export function RepositoryOverview({
  repository,
  onOpenCommit,
  pending = false,
}: {
  repository: RepositorySummary;
  onOpenCommit?: () => void;
  pending?: boolean;
}) {
  const [conflictsFor, setConflictsFor] = useState<string | null>(null);
  const status = useRepositoryStore((state) => state.status);
  const writing = useRepositoryStore((state) => state.writing);
  const truncated = useRepositoryStore((state) => state.truncatedChanges);
  const branch = status?.branch;
  const categories = categorizeChanges(status?.changes ?? []);
  const conflicts = categories.conflicted.length;

  return (
    <header
      data-tour="repository-overview"
      aria-label={t("repositoryOverview.repositoryOverview")}
      className="repository-overview app-surface-chrome flex h-9 min-w-0 shrink-0 items-center gap-4 border-b border-border-subtle bg-bg-surface px-3"
    >
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div className="flex min-w-0 shrink-0 items-center gap-2 text-xs">
          <h1 title={repository.path} className="max-w-32 truncate font-medium">
            {repository.name}
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
        <TextButton
          className="text-text-secondary hover:text-text-primary"
          onClick={() => openSettings("repository-remotes")}
        >
          {t("repositoryOverview.remotes")}
        </TextButton>

        {onOpenCommit && (
          <TextButton className="text-accent-text" onClick={onOpenCommit}>
            {t("repositoryOverview.commitDraft")}
          </TextButton>
        )}

        {!pending && (
          <RepositoryWorkflowActions
            repositoryId={repository.id}
            workflow={status?.workflow}
            writing={writing}
            conflicts={conflicts}
          />
        )}

        {!pending && (
          <>
            {conflicts > 0 && (
              <TextButton
                className="text-git-conflict"
                onClick={() => setConflictsFor(repository.id)}
              >
                {t("repositoryOverview.resolveConflicts", { conflicts: conflicts })}
              </TextButton>
            )}

            {truncated && (
              <CircleAlert
                size={14}
                className="text-git-modified"
                aria-label={t("repositoryOverview.changeListIsTruncated")}
              />
            )}
          </>
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

      {conflictsFor === repository.id && (
        <Suspense fallback={null}>
          <ConflictDialog
            key={repository.id}
            repositoryId={repository.id}
            onClose={() => setConflictsFor(null)}
          />
        </Suspense>
      )}
    </header>
  );
}
