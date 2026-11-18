import { isFullObjectId } from "@shared/repository/object-id";
import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { GitService } from "../../git/git-service";
import type { WorkflowJournal, WorkflowJournalRecord } from "../../persistence/workflow-journal";

const invalid = (message: ErrorText) =>
  new GitError({
    kind: "invalid-input",
    operation: t("operations.retainHistoryRecovery"),
    message,
  });

export async function pruneHistoryRecords(
  git: GitService,
  journal: WorkflowJournal,
  root: string,
  commonDirectory: string,
) {
  const records = journal.historyActions(root, commonDirectory);
  const completed = (record: WorkflowJournalRecord) =>
    record.state === "completed" &&
    !["undoing", "redoing"].includes(record.refChange?.reversal?.state ?? "");

  if (records.filter((record) => !completed(record)).length >= 100)
    throw invalid(
      errorText("main.historyRetention.thereAreTooManyUnfinishedHistoryRecordsInspect"),
    );

  const complete = records.filter(completed);

  for (const [index, record] of complete.entries()) {
    const updatedAt = Date.parse(record.updatedAt);
    if (!Number.isFinite(updatedAt)) continue;
    if (index < 99 && updatedAt >= Date.now() - 30 * 86400_000) continue;

    const change = record.refChange;
    if (
      !change ||
      !/^[a-f0-9-]{36}$/.test(record.id) ||
      change.recoveryRef !== `refs/eda/recovery/${record.id}`
    )
      continue;

    const refs: [suffix: string, oid: string][] = [];
    if (record.head) refs.push(["head", record.head]);
    refs.push(["index", change.indexTree]);
    if (change.reversal)
      refs.push(["after-head", change.target], ["after-index", change.reversal.afterIndexTree]);

    if (!refs.every(([, oid]) => isFullObjectId(oid))) continue;

    const deletes: string[] = [];
    let changed = false;

    for (const [suffix, oid] of refs) {
      const ref = `${change.recoveryRef}/${suffix}`;
      const current = await git.exec(["rev-parse", "--verify", "--quiet", ref], {
        cwd: root,
        operation: t("operations.inspectExpiredHistoryRecovery"),
        allowedExitCodes: [0, 1],
      });

      if (current.exitCode === 1) continue;

      if (current.stdout.trim() !== oid) {
        changed = true;
        break;
      }

      deletes.push(`delete ${ref} ${oid}`);
    }

    if (changed) continue;

    if (deletes.length)
      await git.exec(["update-ref", "--stdin"], {
        cwd: root,
        operation: t("operations.pruneExpiredHistoryRecovery"),
        stdin: `${deletes.join("\n")}\n`,
      });

    journal.remove(record.id);
  }
}
