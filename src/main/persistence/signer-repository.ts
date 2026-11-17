import { AppError } from "@shared/errors";
import { errorText } from "@shared/error-codes";
import { and, eq, or, like, count } from "drizzle-orm";
import type { SignerDecision } from "@shared/repository/repository-read";
import { signerDecisions, verificationKeys } from "./schema";
import type { Database } from "./types";

export class SignerRepository {
  constructor(private readonly db: Database) {}

  list(profileId: string, repositoryId: string): SignerDecision[] {
    return this.db
      .select()
      .from(signerDecisions)
      .where(
        and(
          eq(signerDecisions.profileId, profileId),
          or(eq(signerDecisions.scope, "profile"), eq(signerDecisions.scope, repositoryId)),
        ),
      )
      .all()
      .map((row) => ({
        fingerprint: row.fingerprint,
        identity: row.identity,
        decision: row.decision,
        scope: row.repositoryId === null ? "profile" : "repository",
      }));
  }

  decide(profileId: string, repositoryId: string, value: SignerDecision, remove = false): void {
    const scope = value.scope === "profile" ? "profile" : repositoryId;
    if (remove) {
      this.db
        .delete(signerDecisions)
        .where(
          and(
            eq(signerDecisions.profileId, profileId),
            eq(signerDecisions.scope, scope),
            eq(signerDecisions.fingerprint, value.fingerprint),
          ),
        )
        .run();
      return;
    }
    this.db
      .insert(signerDecisions)
      .values({
        ...value,
        profileId,
        scope,
        repositoryId: value.scope === "profile" ? null : repositoryId,
      })
      .onConflictDoUpdate({
        target: [signerDecisions.profileId, signerDecisions.scope, signerDecisions.fingerprint],
        set: { identity: value.identity, decision: value.decision },
      })
      .run();
  }

  findKey(profileId: string, fingerprint?: string, keyId?: string) {
    if (!fingerprint && (!keyId || !/^[A-F\d]{16}$/i.test(keyId))) return undefined;
    return this.db
      .select()
      .from(verificationKeys)
      .where(
        and(
          eq(verificationKeys.profileId, profileId),
          fingerprint
            ? eq(verificationKeys.fingerprint, fingerprint)
            : like(verificationKeys.fingerprint, `%${keyId!.toUpperCase()}`),
        ),
      )
      .get();
  }

  keyCount(profileId: string) {
    return this.db
      .select({ value: count() })
      .from(verificationKeys)
      .where(eq(verificationKeys.profileId, profileId))
      .get()!.value;
  }

  forgetKey(profileId: string, fingerprint: string) {
    this.db
      .delete(verificationKeys)
      .where(
        and(
          eq(verificationKeys.profileId, profileId),
          eq(verificationKeys.fingerprint, fingerprint),
        ),
      )
      .run();
  }

  saveKey(profileId: string, fingerprint: string, armoredKey: string, source: string): void {
    if (!this.findKey(profileId, fingerprint) && this.keyCount(profileId) >= 256)
      throw new AppError(errorText("main.signatureKeys.limit"));
    this.db
      .insert(verificationKeys)
      .values({ profileId, fingerprint, armoredKey, source, fetchedAt: new Date().toISOString() })
      .onConflictDoUpdate({
        target: [verificationKeys.profileId, verificationKeys.fingerprint],
        set: { armoredKey, source, fetchedAt: new Date().toISOString() },
      })
      .run();
  }
}
