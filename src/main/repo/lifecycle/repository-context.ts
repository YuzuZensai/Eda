import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { RepositorySummary } from "@shared/repository/repository";
import { invalidRequest } from "../../request-errors";
import type { RepositoryManager } from "./repository-manager";

export type RepositoryContext = Pick<RepositorySummary, "id" | "path" | "identityId">;

export function assertRepositoryContext(
  repositories: Pick<RepositoryManager, "resolveActiveRepository">,
  expected: RepositoryContext,
  operation?: string,
) {
  const current = repositories.resolveActiveRepository(expected.id);
  if (current.identityId === expected.identityId && current.path === expected.path) return current;
  const message = errorText("main.repositoryManager.theRepositoryChangedRefreshAndTryAgain");
  throw operation
    ? new GitError({ kind: "invalid-input", operation, message })
    : invalidRequest(message);
}

export async function readActiveRepository<T>(
  repositories: Pick<RepositoryManager, "resolveActiveRepository">,
  repositoryId: string,
  read: (root: string, identityId: string) => Promise<T>,
  operation = t("operations.readRepositoryState"),
) {
  const repository = repositories.resolveActiveRepository(repositoryId);
  const result = await read(repository.path, repository.identityId);
  assertRepositoryContext(repositories, repository, operation);
  return result;
}
