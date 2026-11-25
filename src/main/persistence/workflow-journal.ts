import { isFullObjectId } from "@shared/repository/object-id";
import type { HistoryDirection } from "@shared/workflows/history-recovery";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Identity } from "@shared/identity/identity";
import type { MergeContinuation, MergeMode } from "@shared/workflows/workflow";
import type { Database } from "./types";
import type { ResetMode } from "@shared/workflows/reset";
import { workflowJournal } from "./schema";

export interface RefOperation {
  recoveryRef?: string;
  kind: "branch-create" | "branch-delete" | "branch-rename" | "checkout";
  beforeHead: string | null;
  beforeBranch: string | null;
  beforeFingerprint: string;
  startContentFingerprint?: string;
  cleanStart?: boolean;
  beforeIndexFlags?: string;
  afterIndexFlags?: string;
  afterHead: string | null;
  afterBranch: string | null;
  afterFingerprint: string;
  tip?: string;
  from?: string;
  to?: string;
  checkedOut?: boolean;
  beforeConfig?: [string, string][];
  afterConfig?: [string, string][];
  beforeFromConfig?: [string, string][];
  afterFromConfig?: [string, string][];
  state: "applied" | "undone" | "undoing" | "redoing";
  blockedReason?: string;
}

export interface WorkflowJournalRecord extends MergeContinuation {
  recoveryWarning?: string;
  pullAutostash?: string;
  nativeInstance?: string;
  mode?:
    | MergeMode
    | "stash"
    | "rebase"
    | "cherry-pick"
    | "revert"
    | "reset"
    | "commit"
    | "amend"
    | "branch"
    | "checkout";
  refOperation?: RefOperation;
  refChange?: {
    commonDirectory: string;
    mode: ResetMode;
    target: string;
    indexTree: string;
    recoveryRef: string;
    snapshotId?: string;
    beforeFlags?: string;
    beforeWorking?: string;
    beforeFingerprint: string;
    afterHead?: string;
    afterFingerprint?: string;
    reversal?: {
      state: "applied" | "undone" | "undoing" | "redoing";
      expectedFingerprint: string;
      afterIndexTree: string;
      beforeFlags: string;
      afterFlags: string;
      redoSnapshotId?: string;
      blockedReason?: string;
    };
  };
  rewriteStart?: { flags: string; fingerprint: string };
  interactive?: boolean;
  publishedCommits?: number;
  publishedReversal?: {
    fromHead: string;
    toHead: string;
    count: number;
    direction: HistoryDirection;
    recordedAt: string;
  };
  resultHead?: string;
  amendMessage?: string;
  introducedPaths?: string[];
  branch?: string;
  version: 1;
  profileId: string;
  repositoryId: string;
  root: string;
  workflowToken: string;
  tree: string;
  identity: Identity;
}

export class WorkflowJournal {
  constructor(private readonly db: Database) {}

  publishedRewrites(
    profileId: string,
    repositoryId: string,
    root: string,
    offset: number,
    limit: number,
  ): WorkflowJournalRecord[] {
    return this.db
      .select()
      .from(workflowJournal)
      .where(
        and(
          eq(workflowJournal.profileId, profileId),
          eq(workflowJournal.repositoryId, repositoryId),
          eq(workflowJournal.root, root),
          sql`(json_extract(${workflowJournal.record}, '$.publishedReversal.count') > 0 OR (json_extract(${workflowJournal.record}, '$.publishedCommits') > 0 AND (json_extract(${workflowJournal.record}, '$.state') <> 'completed' OR coalesce(json_extract(${workflowJournal.record}, '$.refChange.afterHead'), json_extract(${workflowJournal.record}, '$.resultHead'), '') <> json_extract(${workflowJournal.record}, '$.head'))))`,
        ),
      )
      .orderBy(desc(workflowJournal.updatedAt))
      .limit(limit)
      .offset(offset)
      .all()
      .flatMap((row) => {
        const record = decodeRecord(row);
        return record ? [record] : [];
      })
      .filter(
        (record) =>
          record.version === 1 &&
          record.profileId === profileId &&
          record.repositoryId === repositoryId &&
          record.root === root,
      );
  }

  historyActions(root: string, commonDirectory?: string): WorkflowJournalRecord[] {
    return this.db
      .select()
      .from(workflowJournal)
      .where(
        and(
          commonDirectory
            ? eq(workflowJournal.commonDirectory, commonDirectory)
            : eq(workflowJournal.root, root),
          inArray(workflowJournal.mode, [
            "reset",
            "commit",
            "amend",
            "rebase",
            "cherry-pick",
            "revert",
          ]),
        ),
      )
      .orderBy(desc(workflowJournal.updatedAt))
      .all()
      .flatMap((row) => {
        const record = decodeRecord(row);
        return record ? [record] : [];
      })
      .filter(
        (record) =>
          record.version === 1 &&
          ["reset", "commit", "amend", "rebase", "cherry-pick", "revert"].includes(
            record.mode ?? "",
          ) &&
          (record.refChange || (!commonDirectory && record.recoveryWarning)) &&
          (commonDirectory
            ? record.refChange?.commonDirectory === commonDirectory
            : record.root === root),
      );
  }

  refActions(root: string): WorkflowJournalRecord[] {
    return this.db
      .select()
      .from(workflowJournal)
      .where(
        and(eq(workflowJournal.root, root), inArray(workflowJournal.mode, ["branch", "checkout"])),
      )
      .orderBy(desc(workflowJournal.updatedAt))
      .all()
      .flatMap((row) => {
        const record = decodeRecord(row);
        return record ? [record] : [];
      })
      .filter(
        (record) =>
          record.version === 1 &&
          ["branch", "checkout"].includes(record.mode ?? "") &&
          !!record.refOperation &&
          record.root === root,
      );
  }

  expiredRefActions(root: string, keep = 100) {
    const records = this.refActions(root);

    return records
      .filter(
        (record) =>
          record.state === "completed" &&
          !["undoing", "redoing"].includes(record.refOperation?.state ?? ""),
      )
      .filter(
        (record, index) =>
          index >= keep || Date.parse(record.updatedAt) < Date.now() - 30 * 86400_000,
      );
  }

  remove(id: string) {
    this.db.delete(workflowJournal).where(eq(workflowJournal.id, id)).run();
  }

  activeLocal(
    root: string,
    kind: "local" | "rebase" | "cherry-pick" | "revert" = "local",
  ): WorkflowJournalRecord | undefined {
    const row = this.db
      .select()
      .from(workflowJournal)
      .where(
        and(
          eq(workflowJournal.root, root),
          kind !== "local"
            ? eq(workflowJournal.mode, kind)
            : inArray(workflowJournal.mode, ["squash", "stash"]),
          ne(workflowJournal.state, "completed"),
        ),
      )
      .orderBy(desc(workflowJournal.updatedAt))
      .get();

    if (!row) return undefined;

    const record = decodeRecord(row);

    if (!record || (kind === "local" && !record.branch) || !isFullObjectId(record.head))
      return undefined;

    return record;
  }

  save(record: WorkflowJournalRecord): void {
    const row = {
      id: record.id,
      profileId: record.profileId,
      repositoryId: record.repositoryId,
      updatedAt: record.updatedAt,
      record: JSON.stringify(record),
    };

    this.db
      .insert(workflowJournal)
      .values(row)
      .onConflictDoUpdate({
        target: workflowJournal.id,
        set: row,
      })
      .run();
  }

  latest(profileId: string, repositoryId: string): WorkflowJournalRecord | undefined {
    const row = this.db
      .select()
      .from(workflowJournal)
      .where(
        and(
          eq(workflowJournal.profileId, profileId),
          eq(workflowJournal.repositoryId, repositoryId),
        ),
      )
      .orderBy(desc(workflowJournal.updatedAt))
      .get();

    return row ? decodeRecord(row) : undefined;
  }
}

function decodeRecord(row: typeof workflowJournal.$inferSelect): WorkflowJournalRecord | undefined {
  try {
    const record = JSON.parse(row.record) as WorkflowJournalRecord;
    return record &&
      record.version === 1 &&
      record.id === row.id &&
      record.profileId === row.profileId &&
      record.repositoryId === row.repositoryId &&
      record.identity?.id === row.profileId &&
      record.updatedAt === row.updatedAt &&
      typeof record.root === "string" &&
      typeof record.message === "string" &&
      typeof record.workflowToken === "string" &&
      typeof record.tree === "string" &&
      ["prepared", "running", "paused", "completed"].includes(record.state)
      ? record
      : undefined;
  } catch {
    return undefined;
  }
}
