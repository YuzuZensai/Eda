import type { CommitSignatureVerification } from "@shared/repository/repository-read";
import { isOneOf, isRecord } from "@shared/validation";
import { and, eq } from "drizzle-orm";
import { commitSignatures, repositories } from "./schema";
import type { Database } from "./types";

export class CommitSignatureRepository {
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

    let value: unknown;

    try {
      const envelope = JSON.parse(row.value) as { checkedAt?: unknown; signature?: unknown };
      if (
        typeof envelope.checkedAt !== "number" ||
        !Number.isFinite(envelope.checkedAt) ||
        envelope.checkedAt > Date.now() ||
        Date.now() - envelope.checkedAt > 60_000
      )
        return null;
      value = envelope.signature;
    } catch {
      return null;
    }

    return isSignature(value) ? value : null;
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

    const value = JSON.stringify({ checkedAt: Date.now(), signature });

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
