import { useState, useMemo } from "react";
import { t } from "@shared/i18n";
import { errorMessage } from "@shared/errors";
import type { RepositoryStatus } from "@shared/repository/repository-read";
import { showOpenedRepository } from "../../repository/hooks/useRepositoryNavigation";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { useRepositoryStore } from "../../stores/repository-store";

export function useLinkedWorktrees(
  repositoryId: string | null,
  identityId: string | null,
  status: RepositoryStatus | null,
  pending: boolean,
) {
  const linkedRequest = useMemo(
    () => (repositoryId && status && !pending ? { repositoryId, status } : null),
    [repositoryId, status, pending],
  );
  const worktrees = useRepositoryRead(
    (request: { repositoryId: string }) => window.eda.repository.worktrees(request.repositoryId),
    linkedRequest,
  );
  const [worktreeError, setWorktreeError] = useState("");
  const linkedChanges = worktrees.value?.filter(
    (entry) => !entry.current && entry.available && !!entry.changedPaths,
  );
  const openLinkedChanges = async (path: string) => {
    if (!repositoryId || !identityId) return;
    try {
      const opened = await window.eda.repository.open(path);
      if (!opened.ok) throw opened.error;
      if (await showOpenedRepository(opened.value, identityId, repositoryId))
        useRepositoryStore.getState().showWorkingTree();
    } catch (error) {
      setWorktreeError(errorMessage(error));
    }
  };
  const linkedByOid = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const entry of worktrees.value ?? []) {
      if (entry.current || entry.bare || !entry.oid) continue;
      const label = t(
        entry.changedPaths === undefined ? "worktrees.graphLocation" : "worktrees.graphChanges",
        { path: entry.path, count: entry.changedPaths ?? 0 },
      );
      const previous = result.get(entry.oid);
      if (previous) previous.push(label);
      else result.set(entry.oid, [label]);
    }
    return result;
  }, [worktrees.value]);
  return { linkedChanges, openLinkedChanges, linkedByOid, worktreeError, setWorktreeError };
}
