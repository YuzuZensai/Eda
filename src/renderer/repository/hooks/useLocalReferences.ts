import { ok } from "@shared/errors";
import { useRepositoryRead } from "./useRepositoryRead";

async function readReferences(repositoryId: string) {
  const [branches, tags] = await Promise.all([
    window.eda.repository.listBranches(repositoryId),
    window.eda.repository.listTags(repositoryId),
  ]);
  if (!branches.ok) return branches;
  if (!tags.ok) return tags;
  return ok({ branches: branches.value, tags: tags.value });
}

export function useLocalReferences(repositoryId: string) {
  const { value, error, retry } = useRepositoryRead(readReferences, repositoryId);
  return { references: value, loadError: error, retry };
}
