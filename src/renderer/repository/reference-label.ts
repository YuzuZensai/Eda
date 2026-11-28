import { isFullObjectId } from "@shared/repository/object-id";
import type { HistoryPage } from "@shared/repository/repository-read";

export function revisionLabel(pages: readonly HistoryPage[], revision: string): string {
  if (!isFullObjectId(revision)) return revision;
  for (const page of pages) {
    const commit = page.commits.find((entry) => entry.oid === revision);
    if (!commit) continue;
    const [branch, other] = commit.decorations.filter(
      (ref) => ref.type === "local-branch" || ref.type === "remote-branch",
    );
    if (branch && !other) return branch.name;
    break;
  }
  return revision.slice(0, 8);
}
