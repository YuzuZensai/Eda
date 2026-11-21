import { t } from "@shared/i18n";
export type RebaseAction = "start" | "continue" | "skip" | "abort" | "amend" | "reword";

export interface RebasePlanEntry {
  oid: string;
  action: "pick" | "reword" | "squash" | "drop" | "fixup" | "edit" | "fixup-reword";
  message: string;
}

export interface RebaseReview {
  token: string;
  action: RebaseAction;
  head: string;
  onto: string | null;
  branch: string | null;
  author: string;
  email: string;
  paths: string[];
  recoveryBytes: number;
  publishedCommits: number;
  rewordTarget?: string;
  rewrittenCount?: number;
  plan?: RebasePlanEntry[];
  message?: string;
}

export function autosquashPlan(original: RebasePlanEntry[]) {
  const plan: RebasePlanEntry[] = [];
  const warnings: string[] = [];
  const groups = new Map<string, string>();

  for (const [index, source] of original.entries()) {
    const entry: RebasePlanEntry = { ...source, action: "pick" };
    const subject = source.message.split("\n")[0]!;
    const match = /^(fixup|squash|amend)! (.+)$/.exec(subject);
    const candidates = original.slice(0, index);
    const targetName = match?.[2] ?? "";
    let targets = match
      ? candidates.filter(
          (item) => item.oid.startsWith(targetName) || item.message.split("\n")[0] === targetName,
        )
      : [];

    if (match && !targets.length)
      targets = candidates.filter((item) => item.message.split("\n")[0]!.startsWith(targetName));

    if (!match || targets.length !== 1) {
      if (match)
        warnings.push(
          t("shared.rebase.targetIsMissingOrAmbiguousLeftAsPick", { oid: source.oid.slice(0, 8) }),
        );
      plan.push(entry);
      groups.set(entry.oid, entry.oid);
      continue;
    }

    const group = groups.get(targets[0]!.oid)!;
    const last = plan.findLastIndex((item) => groups.get(item.oid) === group);

    entry.action =
      match[1] === "squash" ? "squash" : match[1] === "amend" ? "fixup-reword" : "fixup";

    if (entry.action === "squash") {
      const previous = plan
        .slice(0, last + 1)
        .findLast((item) => groups.get(item.oid) === group && item.action !== "fixup")!;
      entry.message = `${previous.message}\n\n${source.message}`;
    } else if (entry.action === "fixup-reword") {
      entry.message = source.message.split("\n").slice(2).join("\n");
    }

    groups.set(entry.oid, group);
    plan.splice(last + 1, 0, entry);
  }

  return { plan, warnings };
}

export interface RebaseResult {
  recoveryWarning?: string;
  state: "completed" | "needs-attention";
  head: string | null;
  publishedCommits?: number;
}
