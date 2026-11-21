import { useEffect, useState } from "react";
import { errorMessage } from "@shared/errors";
import type { BranchSummary, TagSummary } from "@shared/repository/repository-write";

type References = { branches: BranchSummary[]; tags: TagSummary[] };

export function useLocalReferences(repositoryId: string) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    repositoryId: string;
    value?: References;
    error?: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    setResult(null);
    const load = async () => {
      try {
        const [branches, tags] = await Promise.all([
          window.eda.repository.listBranches(repositoryId),
          window.eda.repository.listTags(repositoryId),
        ]);
        if (!active) return;
        if (!branches.ok) setResult({ repositoryId, error: errorMessage(branches.error) });
        else if (!tags.ok) setResult({ repositoryId, error: errorMessage(tags.error) });
        else setResult({ repositoryId, value: { branches: branches.value, tags: tags.value } });
      } catch (error) {
        if (active) setResult({ repositoryId, error: errorMessage(error) });
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [repositoryId, revision]);
  const current = result?.repositoryId === repositoryId ? result : null;
  return {
    references: current?.value,
    loadError: current?.error,
    retry: () => setRevision((value) => value + 1),
  };
}
