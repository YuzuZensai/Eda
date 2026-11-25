import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  RECOVERY_SOURCES,
  RECOVERY_STATES,
  type RecoverySummary,
} from "@shared/workflows/recovery";
import { isOneOf, isRecord } from "@shared/validation";
import { createHash } from "node:crypto";
import type { Database } from "./types";
import { contentRecovery, workflowJournal } from "./schema";
import { isRegularFileMode } from "@shared/repository/git-file-mode";
import { isFullObjectId } from "@shared/repository/object-id";

export interface SavedFile {
  path: string;
  content: string | null;
  mode: number;
  hash: string;
  tracked: boolean;
  gitMode?: string;
}

export interface ContentRecoveryRecord extends RecoverySummary {
  savedIndex?: { path: string; stage: number; mode: string; content: string }[];
  profileId: string;
  repositoryId: string;
  root: string;
  files: SavedFile[];
  after?: Record<string, string>;
}

export function recoveryFileHash(data: Buffer, mode: number): string {
  return createHash("sha256")
    .update(data)
    .update(String(mode & 0o777))
    .digest("hex");
}

function isIndexVersion(
  value: unknown,
): value is NonNullable<RecoverySummary["indexVersions"]>[number] {
  return (
    isRecord(value) &&
    typeof value["path"] === "string" &&
    typeof value["stage"] === "number" &&
    Number.isInteger(value["stage"]) &&
    value["stage"] >= 0 &&
    value["stage"] <= 3 &&
    typeof value["mode"] === "string" &&
    /^[0-7]{6}$/.test(value["mode"])
  );
}

function isRecoverySummary(value: unknown): value is RecoverySummary {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["createdAt"] === "string" &&
    Array.isArray(value["paths"]) &&
    value["paths"].every((path: unknown) => typeof path === "string") &&
    isOneOf(value["state"], RECOVERY_STATES) &&
    typeof value["bytes"] === "number" &&
    Number.isSafeInteger(value["bytes"]) &&
    value["bytes"] >= 0 &&
    (value["source"] === undefined || isOneOf(value["source"], RECOVERY_SOURCES)) &&
    (value["indexOnly"] === undefined || typeof value["indexOnly"] === "boolean") &&
    (value["indexVersions"] === undefined ||
      (Array.isArray(value["indexVersions"]) && value["indexVersions"].every(isIndexVersion)))
  );
}

function isBase64(value: unknown): value is string {
  return typeof value === "string" && Buffer.from(value, "base64").toString("base64") === value;
}

function isSavedFile(value: unknown): value is SavedFile {
  if (
    !isRecord(value) ||
    typeof value["path"] !== "string" ||
    typeof value["tracked"] !== "boolean" ||
    (value["gitMode"] !== undefined &&
      (typeof value["gitMode"] !== "string" || !isRegularFileMode(value["gitMode"]))) ||
    typeof value["mode"] !== "number" ||
    !Number.isInteger(value["mode"]) ||
    value["mode"] < 0 ||
    value["mode"] > 0o777
  )
    return false;
  if (value["content"] === null) return value["hash"] === "missing" && value["mode"] === 0;
  return (
    isBase64(value["content"]) &&
    recoveryFileHash(Buffer.from(value["content"], "base64"), value["mode"]) === value["hash"]
  );
}

type RecoveryAccess = "restore" | "inspect";

function isRecoveryRecord(value: unknown, access: RecoveryAccess): value is ContentRecoveryRecord {
  if (
    !isRecord(value) ||
    !isRecoverySummary(value) ||
    typeof value["profileId"] !== "string" ||
    typeof value["repositoryId"] !== "string" ||
    typeof value["root"] !== "string" ||
    !Array.isArray(value["files"]) ||
    !value["files"].every(isSavedFile)
  )
    return false;
  const paths = new Set(value.paths);
  if (
    paths.size !== value.paths.length ||
    value["files"].some((file: SavedFile) => !paths.has(file.path)) ||
    (access === "restore" &&
      value.source === "rewrite-recovery" &&
      value["files"].some((file: SavedFile) => file.content !== null && file.mode === 0)) ||
    new Set(value["files"].map((file: SavedFile) => file.path)).size !== value["files"].length
  )
    return false;
  const savedIndex = value["savedIndex"];
  const after = value["after"];
  return (
    (savedIndex === undefined ||
      (Array.isArray(savedIndex) &&
        savedIndex.every(
          (entry: unknown) =>
            isIndexVersion(entry) &&
            paths.has(entry.path) &&
            "content" in entry &&
            isBase64(entry.content),
        ))) &&
    (after === undefined ||
      (isRecord(after) &&
        Object.values(after).every(
          (hash) => typeof hash === "string" && (hash === "missing" || /^[a-f0-9]{64}$/.test(hash)),
        ) &&
        value["files"].every(
          (file: SavedFile) =>
            Object.hasOwn(after, file.path) || (access === "inspect" && file.path === "__proto__"),
        )))
  );
}

export class ContentRecoveryRepository {
  constructor(private readonly db: Database) {}

  originalRewriteTree(record: ContentRecoveryRecord): string | undefined {
    const row = this.db
      .select({
        tree: sql<unknown>`json_extract(${workflowJournal.record}, '$.refChange.indexTree')`,
      })
      .from(workflowJournal)
      .where(
        and(
          eq(workflowJournal.profileId, record.profileId),
          eq(workflowJournal.repositoryId, record.repositoryId),
          eq(workflowJournal.root, record.root),
          sql`json_extract(${workflowJournal.record}, '$.refChange.snapshotId') = ${record.id}`,
        ),
      )
      .get();
    return isFullObjectId(row?.tree) ? row.tree : undefined;
  }

  remove(profileId: string, repositoryId: string, id: string): void {
    this.db
      .delete(contentRecovery)
      .where(
        and(
          eq(contentRecovery.profileId, profileId),
          eq(contentRecovery.repositoryId, repositoryId),
          eq(contentRecovery.id, id),
        ),
      )
      .run();
  }

  save(record: ContentRecoveryRecord): void {
    const value = {
      version: 1,
      id: record.id,
      profileId: record.profileId,
      repositoryId: record.repositoryId,
      createdAt: record.createdAt,
      value: JSON.stringify(record),
    };

    this.db
      .insert(contentRecovery)
      .values(value)
      .onConflictDoUpdate({ target: contentRecovery.id, set: value })
      .run();
  }

  get(
    profileId: string,
    repositoryId: string,
    id: string,
    access: RecoveryAccess = "restore",
  ): ContentRecoveryRecord | undefined {
    const row = this.db
      .select()
      .from(contentRecovery)
      .where(
        and(
          eq(contentRecovery.profileId, profileId),
          eq(contentRecovery.repositoryId, repositoryId),
          eq(contentRecovery.id, id),
        ),
      )
      .get();

    if (!row || row.version !== 1) return undefined;
    try {
      const record: unknown = JSON.parse(row.value);
      return isRecoveryRecord(record, access) &&
        record.createdAt === row.createdAt &&
        record.id === row.id &&
        record.profileId === row.profileId &&
        record.repositoryId === row.repositoryId
        ? record
        : undefined;
    } catch {
      return undefined;
    }
  }

  list(profileId: string, repositoryId: string): RecoverySummary[] {
    return this.db
      .select({
        id: contentRecovery.id,
        createdAt: contentRecovery.createdAt,
        value: sql<string | null>`CASE WHEN json_valid(${contentRecovery.value}) THEN
          json_remove(${contentRecovery.value}, '$.files', '$.savedIndex', '$.after', '$.root') END`,
      })
      .from(contentRecovery)
      .where(
        and(
          eq(contentRecovery.profileId, profileId),
          eq(contentRecovery.repositoryId, repositoryId),
          eq(contentRecovery.version, 1),
        ),
      )
      .orderBy(desc(contentRecovery.createdAt))
      .all()
      .flatMap((row) => {
        try {
          if (row.value === null) return [];
          const record: unknown = JSON.parse(row.value);
          if (!isRecord(record)) return [];
          const { profileId: owner, repositoryId: membership, ...summary } = record;
          return owner === profileId &&
            membership === repositoryId &&
            isRecoverySummary(summary) &&
            summary.id === row.id &&
            summary.createdAt === row.createdAt
            ? [summary]
            : [];
        } catch {
          return [];
        }
      });
  }

  prune(profileId: string, repositoryId: string) {
    let bytes = 0;
    const expired = this.list(profileId, repositoryId)
      .filter((record, index) => {
        bytes += record.bytes;

        return (
          record.state !== "prepared" &&
          (index >= 100 ||
            bytes > 256 * 1024 * 1024 ||
            Date.parse(record.createdAt) < Date.now() - 30 * 86400_000)
        );
      })
      .filter((record) => this.get(profileId, repositoryId, record.id) !== undefined)
      .map((record) => record.id);

    if (expired.length)
      this.db
        .delete(contentRecovery)
        .where(
          and(
            eq(contentRecovery.profileId, profileId),
            eq(contentRecovery.repositoryId, repositoryId),
            inArray(contentRecovery.id, expired),
          ),
        )
        .run();
  }
}
