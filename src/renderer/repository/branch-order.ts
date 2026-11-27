import type { BranchSummary } from "@shared/repository/repository-write";

export function defaultBranchesFirst(branches: readonly BranchSummary[]): BranchSummary[] {
  return branches.toSorted((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true));
}

export function defaultBranchTips(branches: readonly BranchSummary[]): string[] {
  const local = branches.find((branch) => branch.isDefault && !branch.remote);
  const remotes = branches.filter((branch) => branch.isDefault && branch.remote);
  const primary =
    remotes.find((branch) => branch.name.startsWith("origin/")) ??
    (remotes.length === 1 ? remotes[0] : undefined);
  return [...new Set([local?.oid, primary?.oid].filter((oid) => oid !== undefined))];
}
