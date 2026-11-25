import { english, t } from "@shared/i18n";
import { isOneOf, isRecord } from "@shared/validation";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { OperationRecord } from "@shared/operations";
import type { Database } from "./types";
import { identities, operations } from "./schema";

const RECENT_OPERATIONS = 200;

function isOperationRecord(value: unknown): value is OperationRecord {
  return (
    isRecord(value) &&
    [
      "id",
      "profileId",
      "repositoryId",
      "repositoryName",
      "kind",
      "startedAt",
      "updatedAt",
      "output",
      "message",
    ].every((key) => typeof value[key] === "string") &&
    isOneOf(value["state"], ["queued", "running", "succeeded", "failed", "interrupted"]) &&
    typeof value["durationMs"] === "number" &&
    Number.isFinite(value["durationMs"]) &&
    value["durationMs"] >= 0 &&
    typeof value["cancellable"] === "boolean" &&
    typeof value["retryable"] === "boolean" &&
    (value["recovery"] === undefined || typeof value["recovery"] === "string") &&
    (value["exitCode"] === undefined ||
      (typeof value["exitCode"] === "number" && Number.isSafeInteger(value["exitCode"]))) &&
    (value["kindKey"] === undefined ||
      (typeof value["kindKey"] === "string" && Object.hasOwn(english, value["kindKey"])))
  );
}

function decode(row: typeof operations.$inferSelect): OperationRecord | undefined {
  if (row.version !== 1) return undefined;
  try {
    const value: unknown = JSON.parse(row.record);
    if (
      isOperationRecord(value) &&
      value.id === row.id &&
      value.profileId === row.profileId &&
      value.updatedAt === row.updatedAt
    )
      return value;
  } catch {}
  return undefined;
}

function damagedRecord(row: typeof operations.$inferSelect): OperationRecord {
  return {
    id: row.id,
    profileId: row.profileId,
    repositoryId: "",
    repositoryName: t("main.persistence.operationRepository.unavailableRepository"),
    kind: t("main.persistence.operationRepository.damagedRecord"),
    state: "interrupted",
    startedAt: row.updatedAt,
    updatedAt: row.updatedAt,
    durationMs: 0,
    output: "",
    message: t("main.persistence.operationRepository.thisActivityRecordCouldNotBeRead"),
    recovery: t("main.persistence.operationRepository.theOriginalRecordIsRetainedInTheLocal"),
    cancellable: false,
    retryable: false,
  };
}

export class OperationRepository {
  constructor(private readonly db: Database) {}

  save(record: OperationRecord): void {
    if (
      !this.db
        .select({ id: identities.id })
        .from(identities)
        .where(eq(identities.id, record.profileId))
        .get()
    )
      return;

    const value = {
      version: 1,
      id: record.id,
      profileId: record.profileId,
      updatedAt: record.updatedAt,
      record: JSON.stringify(record),
    };

    this.db
      .insert(operations)
      .values(value)
      .onConflictDoUpdate({ target: operations.id, set: value })
      .run();
  }

  list(profileId: string): OperationRecord[] {
    return this.db
      .select()
      .from(operations)
      .where(eq(operations.profileId, profileId))
      .orderBy(desc(operations.updatedAt))
      .limit(RECENT_OPERATIONS)
      .all()
      .map((row) => decode(row) ?? damagedRecord(row));
  }

  recover(): void {
    const candidates = this.db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.version, 1),
          sql`CASE WHEN json_valid(${operations.record}) THEN
            json_extract(${operations.record}, '$.state') IN ('queued', 'running') OR
            json_extract(${operations.record}, '$.retryable') = 1 OR
            json_extract(${operations.record}, '$.cancellable') = 1 END`,
        ),
      )
      .all();

    for (const row of candidates) {
      const record = decode(row);
      if (!record) continue;

      if (record.state === "queued" || record.state === "running")
        this.save({
          ...record,
          state: "interrupted",
          cancellable: false,
          retryable: false,
          message: t("main.persistence.operationRepository.edaClosedBeforeThisOperationFinished"),
          recovery: t(
            "main.persistence.operationRepository.refreshThisRepositoryAndInspectItsStatusBefore",
          ),
          updatedAt: new Date().toISOString(),
        });
      else if (record.retryable || record.cancellable)
        this.save({ ...record, retryable: false, cancellable: false });
    }
  }

  prune(profileId: string): void {
    const profile = eq(operations.profileId, profileId);
    const cutoff = Date.now() - 30 * 86400_000;
    const recentCount = this.db
      .select({ value: count() })
      .from(operations)
      .where(and(profile, gte(operations.updatedAt, new Date(cutoff).toISOString())))
      .get()!.value;
    const retained = Math.min(recentCount, RECENT_OPERATIONS);
    const rows = this.db
      .select()
      .from(operations)
      .where(profile)
      .orderBy(desc(operations.updatedAt))
      .limit(-1)
      .offset(retained)
      .all();

    const expired = rows
      .filter((row, index) => {
        const record = decode(row);
        if (!record) return false;
        return (
          record.state !== "queued" &&
          record.state !== "running" &&
          (index + retained >= RECENT_OPERATIONS || Date.parse(record.updatedAt) < cutoff)
        );
      })
      .map((row) => row.id);

    if (expired.length) this.db.delete(operations).where(inArray(operations.id, expired)).run();
  }
}
