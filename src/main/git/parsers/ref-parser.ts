import type { BranchSummary, TagSummary } from "@shared/repository/repository-write";

export const BRANCH_ARGUMENTS = [
  "for-each-ref",
  "--format=%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(refname)%00%(symref)%00%(worktreepath)%00",
  "refs/heads",
  "refs/remotes",
] as const;

export const TAG_ARGUMENTS = [
  "for-each-ref",
  "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(taggername)%00%(contents)%00%(creatordate:iso-strict)%00",
  "refs/tags",
] as const;

export function parseBranches(fields: readonly string[]): BranchSummary[] {
  const branches: BranchSummary[] = [];
  const defaults: { remote: string; name: string }[] = [];

  for (let index = 0; index + 6 < fields.length; index += 7) {
    const fullRef = fields[index + 4]!;
    const target = fields[index + 5];

    if (target) {
      const remote = /^refs\/remotes\/(.+)\/HEAD$/.exec(fullRef)?.[1];
      if (remote && target.startsWith(`refs/remotes/${remote}/`))
        defaults.push({ remote, name: target.slice("refs/remotes/".length) });
      continue;
    }

    branches.push({
      name: fullRef.replace(/^refs\/(?:heads|remotes)\//, ""),
      oid: fields[index + 1]!,
      isHead: fields[index + 2] === "*",
      remote: fullRef.startsWith("refs/remotes/"),
      ...(fields[index + 3] ? { upstream: fields[index + 3]! } : {}),
      ...(fields[index + 6] ? { worktreePath: fields[index + 6]! } : {}),
    });
  }

  if (!defaults.length) return branches;

  const remoteDefaults = new Set(defaults.map(({ name }) => name));
  const primary =
    defaults.find(({ remote }) => remote === "origin") ??
    (defaults.length === 1 ? defaults[0] : undefined);
  const localName = primary?.name.slice(primary.remote.length + 1);
  const tracking = primary
    ? branches.filter((branch) => !branch.remote && branch.upstream === primary.name)
    : [];
  const localDefault =
    branches.find(
      (branch) =>
        !branch.remote &&
        branch.name === localName &&
        (!branch.upstream || branch.upstream === primary?.name),
    ) ?? (tracking.length === 1 ? tracking[0] : undefined);

  return branches.map((branch) => {
    const isDefault = branch.remote ? remoteDefaults.has(branch.name) : branch === localDefault;
    return isDefault ? { ...branch, isDefault: true } : branch;
  });
}

export function parseTags(fields: readonly string[]): TagSummary[] {
  const tags: TagSummary[] = [];

  for (let index = 0; index + 6 < fields.length; index += 7) {
    tags.push({
      name: fields[index]!.replace(/^\n/, "").slice("refs/tags/".length),
      oid: fields[index + 2] || fields[index + 1]!,
      ...(fields[index + 6] ? { createdAt: fields[index + 6]! } : {}),
      ...(fields[index + 3] === "tag"
        ? {
            annotated: true,
            objectOid: fields[index + 1]!,
            tagger: fields[index + 4]!,
            message: fields[index + 5]!,
          }
        : {}),
    });
  }

  return tags;
}
