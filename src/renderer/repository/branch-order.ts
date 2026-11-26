import type { BranchSummary } from "@shared/repository/repository-write";

export function defaultBranchesFirst(branches: readonly BranchSummary[]): BranchSummary[] {
  return branches.toSorted((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true));
}
