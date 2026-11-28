import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase, openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { RepositoryMemberships } from "@main/persistence/repository-memberships";
import { ProfileRepository } from "@main/persistence/profile-repository";
import { ProfileSessionRepository } from "@main/persistence/profile-session-repository";
import { CommitSignatureRepository } from "@main/persistence/commit-signature-repository";
import { commitSignatures, identities } from "@main/persistence/schema";
import type { Database } from "@main/persistence/types";
import type { CommitSignatureVerification } from "@shared/repository/repository-read";

function setup(db: Database) {
  const profiles = new IdentityRepository(db);
  const profile = (name: string) =>
    profiles.create({
      name,
      gitName: name,
      gitEmail: `${name.toLowerCase()}@example.test`,
      hue: 210,
      signing: { format: "none", signCommits: false },
    });
  const work = profile("Work");
  const home = profile("Home");
  const memberships = new RepositoryMemberships(db);
  const repository = memberships.register("/shared/repo", work.id);
  const other = memberships.register("/shared/repo", home.id);

  return { work, home, memberships, repository, other, cache: new CommitSignatureRepository(db) };
}

it("persists every signing status across restarts until its repository membership is removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eda-signatures-"));
  const path = join(directory, "eda.db");
  let db = openDatabase(path);

  try {
    const { work, home, repository, other, cache } = setup(db);
    const signatures = (["verified", "invalid", "unverified", "unsigned"] as const).map(
      (status, index) => ({
        oid: String(index + 1).repeat(40),
        signature: {
          status,
          format: status === "unsigned" ? null : "ssh",
          reasonCode: status === "invalid" ? "bad-signature" : null,
          diagnostics: "Verification output",
        } satisfies CommitSignatureVerification,
      }),
    );

    for (const { oid, signature } of signatures)
      cache.record(work.id, repository.id, oid, signature);
    cache.record(home.id, other.id, signatures[0]!.oid, signatures[3]!.signature);
    db.close();
    db = openDatabase(path);

    const restored = new CommitSignatureRepository(db);
    for (const { oid, signature } of signatures)
      expect(restored.read(work.id, repository.id, oid)).toEqual(signature);
    expect(restored.read(home.id, other.id, signatures[0]!.oid)?.status).toBe("unsigned");

    new RepositoryMemberships(db).remove(repository.id, work.id);
    for (const { oid } of signatures) expect(restored.read(work.id, repository.id, oid)).toBeNull();
    restored.record(work.id, repository.id, signatures[0]!.oid, signatures[0]!.signature);
    expect(db.select().from(commitSignatures).all()).toHaveLength(1);
    expect(restored.read(home.id, other.id, signatures[0]!.oid)?.status).toBe("unsigned");

    db.delete(identities).where(eq(identities.id, home.id)).run();
    expect(db.select().from(commitSignatures).all()).toEqual([]);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("isolates cached trust by owner and rejects unreadable or unsupported records without deleting them", () => {
  const db = openInMemoryDatabase();

  try {
    const { work, home, repository, cache } = setup(db);
    const oid = "a".repeat(40);
    const signature: CommitSignatureVerification = {
      status: "unsigned",
      format: null,
      reasonCode: null,
      diagnostics: "",
    };
    cache.record(work.id, repository.id, oid, signature);
    cache.record(home.id, repository.id, oid, { ...signature, status: "verified" });
    expect(cache.read(work.id, repository.id, oid)).toEqual(signature);
    expect(cache.read(home.id, repository.id, oid)).toBeNull();

    for (const value of [
      { status: "verified" },
      { ...signature, status: "unknown" },
      { ...signature, signer: 123 },
    ]) {
      db.update(commitSignatures)
        .set({ value: JSON.stringify(value) })
        .run();
      expect(cache.read(work.id, repository.id, oid)).toBeNull();
      expect(db.select().from(commitSignatures).all()).toHaveLength(1);
    }

    db.update(commitSignatures)
      .set({ version: 2, value: JSON.stringify(signature) })
      .run();
    expect(cache.read(work.id, repository.id, oid)).toBeNull();
    expect(db.select().from(commitSignatures).get()?.version).toBe(2);
  } finally {
    db.close();
  }
});

it.each([false, true])(
  "keeps destination trust independent when sharing or moving a repository (move=%s)",
  (move) => {
    const db = openInMemoryDatabase();
    try {
      const { work, home, repository, other, cache, memberships } = setup(db);
      const oid = "a".repeat(40);
      const source: CommitSignatureVerification = {
        status: "verified",
        format: "ssh",
        reasonCode: null,
        diagnostics: "",
      };
      const destination: CommitSignatureVerification = {
        status: "unsigned",
        format: null,
        reasonCode: null,
        diagnostics: "",
      };
      cache.record(work.id, repository.id, oid, source);
      cache.record(home.id, other.id, oid, destination);

      const profiles = new ProfileRepository(
        db,
        new IdentityRepository(db),
        new ProfileSessionRepository(db),
      );
      expect(profiles.assignRepository(repository.id, work.id, home.id, move)).toBe(other.id);
      expect(cache.read(home.id, other.id, oid)).toEqual(destination);
      expect(cache.read(work.id, repository.id, oid)).toEqual(move ? null : source);

      if (move) {
        const readded = memberships.register(repository.path, work.id);
        expect(readded.id).not.toBe(repository.id);
        expect(cache.read(work.id, readded.id, oid)).toBeNull();
        cache.record(work.id, repository.id, oid, source);
        expect(db.select().from(commitSignatures).all()).toHaveLength(1);
      }
    } finally {
      db.close();
    }
  },
);

it("expires verification evidence so local key and trust changes are rechecked", () => {
  const db = openInMemoryDatabase();
  const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
  try {
    const { cache, work, repository } = setup(db);
    const signature: CommitSignatureVerification = {
      status: "unverified",
      format: "openpgp",
      reasonCode: "missing-key",
      diagnostics: "",
    };
    cache.record(work.id, repository.id, "a".repeat(40), signature);
    expect(cache.read(work.id, repository.id, "a".repeat(40))).toEqual(signature);
    now.mockReturnValue(160_001);
    expect(cache.read(work.id, repository.id, "a".repeat(40))).toBeNull();
  } finally {
    now.mockRestore();
    db.close();
  }
});

it("prunes expired signatures and preserves fresh, damaged and unsupported records", () => {
  const db = openInMemoryDatabase();
  const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
  try {
    const { cache, work, repository } = setup(db);
    const signature = {
      status: "unsigned",
      format: null,
      reasonCode: null,
      diagnostics: "",
    } as const;
    cache.record(work.id, repository.id, "a".repeat(40), signature);
    const damaged = { checkedAt: 100_000, signature: { ...signature, signer: 23 } };
    db.insert(commitSignatures)
      .values([
        {
          profileId: work.id,
          repositoryId: repository.id,
          oid: "c".repeat(40),
          version: 3,
          value: JSON.stringify(damaged),
        },
        {
          profileId: work.id,
          repositoryId: repository.id,
          oid: "d".repeat(40),
          version: 4,
          value: JSON.stringify({ checkedAt: 100_000, signature }),
        },
      ])
      .run();
    clock.mockReturnValue(160001);
    cache.record(work.id, repository.id, "b".repeat(40), signature);
    expect(
      db
        .select({ oid: commitSignatures.oid })
        .from(commitSignatures)
        .orderBy(commitSignatures.oid)
        .all(),
    ).toEqual([{ oid: "b".repeat(40) }, { oid: "c".repeat(40) }, { oid: "d".repeat(40) }]);
  } finally {
    clock.mockRestore();
    db.close();
  }
});
