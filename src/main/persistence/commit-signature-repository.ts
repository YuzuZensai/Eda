import type { CommitSignatureVerification } from "@shared/repository/repository-read";
import { isOneOf, isRecord } from "@shared/validation";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { commitSignatures, repositories } from "./schema";
import type { Database } from "./types";

const FRESHNESS_MS = 60_000;
const PRUNE_BATCH = 64;

function parseEnvelope(value: string) {
  try {
    const envelope: unknown = JSON.parse(value);
    if (isRecord(envelope)) {
      const { checkedAt, signature } = envelope;
      if (typeof checkedAt === "number" && Number.isFinite(checkedAt) && isSignature(signature))
        return { checkedAt, signature };
    }
    return null;
  } catch {
    return null;
  }
}

export class CommitSignatureRepository {
  private lastPruned: number | undefined;
  private pruneCursor = 0;

  constructor(private readonly db: Database) {}

  read(profileId: string, repositoryId: string, oid: string): CommitSignatureVerification | null {
    const row = this.db
      .select()
      .from(commitSignatures)
      .where(
        and(
          eq(commitSignatures.profileId, profileId),
          eq(commitSignatures.repositoryId, repositoryId),
          eq(commitSignatures.oid, oid),
        ),
      )
      .get();

    if (!row || row.version !== 3) return null;

    const envelope = parseEnvelope(row.value);
    const now = Date.now();
    if (!envelope || envelope.checkedAt > now || now - envelope.checkedAt > FRESHNESS_MS)
      return null;
    return envelope.signature;
  }

  private pruneExpired(now: number) {
    if (
      this.lastPruned !== undefined &&
      now >= this.lastPruned &&
      now - this.lastPruned < FRESHNESS_MS
    )
      return;

    // Walk large caches across writes so one verification can't block on the whole history.
    const rowId = sql<number>`rowid`;
    const next = this.db.transaction(() => {
      const batch = this.db
        .select({ id: rowId, version: commitSignatures.version, value: commitSignatures.value })
        .from(commitSignatures)
        .where(gt(rowId, this.pruneCursor))
        .orderBy(rowId)
        .limit(PRUNE_BATCH)
        .all();
      const expired = batch.filter((row) => {
        const entry = row.version === 3 && parseEnvelope(row.value);
        return entry && now - entry.checkedAt > FRESHNESS_MS;
      });
      if (expired.length)
        this.db
          .delete(commitSignatures)
          .where(
            inArray(
              rowId,
              expired.map((row) => row.id),
            ),
          )
          .run();
      return batch.length === PRUNE_BATCH ? batch[batch.length - 1]!.id : 0;
    });
    this.pruneCursor = next;
    if (!next) this.lastPruned = now;
  }

  clear(profileId: string): void {
    this.db.delete(commitSignatures).where(eq(commitSignatures.profileId, profileId)).run();
  }

  record(
    profileId: string,
    repositoryId: string,
    oid: string,
    signature: CommitSignatureVerification,
  ): void {
    const owner = this.db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.identityId, profileId), eq(repositories.id, repositoryId)))
      .get();

    if (!owner) return;

    const now = Date.now();
    this.pruneExpired(now);
    const value = JSON.stringify({ checkedAt: now, signature });

    this.db
      .insert(commitSignatures)
      .values({ profileId, repositoryId, oid, version: 3, value })
      .onConflictDoUpdate({
        target: [commitSignatures.profileId, commitSignatures.repositoryId, commitSignatures.oid],
        set: { value, version: 3 },
      })
      .run();
  }
}

function isSignature(value: unknown): value is CommitSignatureVerification {
  if (!isRecord(value)) return false;

  return (
    isOneOf(value["status"], ["verified", "invalid", "unverified", "unsigned"]) &&
    (value["format"] === null || isOneOf(value["format"], ["openpgp", "ssh", "x509", "unknown"])) &&
    (value["reasonCode"] === null ||
      isOneOf(value["reasonCode"], [
        "bad-signature",
        "missing-key",
        "missing-trust",
        "untrusted-key",
        "expired-signature",
        "expired-key",
        "revoked-key",
        "verification-error",
        "unsupported-format",
      ])) &&
    (value["validity"] === undefined ||
      isOneOf(value["validity"], ["valid", "invalid", "unknown"])) &&
    (value["signerTrust"] === undefined ||
      isOneOf(value["signerTrust"], ["unknown", "local", "trusted", "distrusted"])) &&
    (value["keyDiscovery"] === undefined || value["keyDiscovery"] === "unavailable") &&
    typeof value["diagnostics"] === "string" &&
    [
      "signer",
      "keyId",
      "fingerprint",
      "primaryFingerprint",
      "authorEmail",
      "committerEmail",
      "keySource",
      "keyFetchedAt",
      "trustedIdentity",
    ].every((key) => value[key] === undefined || typeof value[key] === "string") &&
    (value["trustLevel"] === undefined ||
      isOneOf(value["trustLevel"], ["undefined", "never", "marginal", "fully", "ultimate"]))
  );
}
