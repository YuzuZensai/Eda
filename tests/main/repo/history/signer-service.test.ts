import type { PublicSigningKeys } from "@main/providers/public-signing-keys";
import type { PublicKeyVerifier } from "@main/git/security/public-key-verifier";
import { eq } from "drizzle-orm";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { RepositoryMemberships } from "@main/persistence/repository-memberships";
import { SignerRepository } from "@main/persistence/signer-repository";
import { identities } from "@main/persistence/schema";
import { SignerService } from "@main/repo/history/signer-service";
import type {
  CommitSignatureVerification,
  SignerDecision,
} from "@shared/repository/repository-read";

const fingerprint = "A".repeat(40);
const valid: CommitSignatureVerification = {
  status: "unverified",
  validity: "valid",
  signerTrust: "unknown",
  format: "openpgp",
  reasonCode: "untrusted-key",
  fingerprint,
  authorEmail: "author@example.test",
  diagnostics: "",
};
const decision: SignerDecision = {
  fingerprint,
  identity: "author@example.test",
  scope: "repository",
  decision: "trusted",
};

function setup() {
  const db = openInMemoryDatabase();
  const profiles = new IdentityRepository(db);
  const create = (name: string) =>
    profiles.create({
      name,
      gitName: name,
      gitEmail: `${name}@example.test`,
      hue: 210,
      rules: [],
      signing: { format: "none", signCommits: false },
    });
  const work = create("work");
  const home = create("home");
  const memberships = new RepositoryMemberships(db);
  const repo = memberships.register("/repo", work.id);
  const other = memberships.register("/other", work.id);
  const homeRepo = memberships.register("/repo", home.id);
  const store = new SignerRepository(db);
  const verifier = {
    verify: vi.fn<PublicKeyVerifier["verify"]>(async () => ({
      signature: valid,
      armoredKey: "verified export",
    })),
  };
  const discovery = {
    find: vi.fn<PublicSigningKeys["find"]>(async () => ({
      armoredKey: "download",
      source: "https://github.com/example.gpg",
    })),
  };
  return {
    db,
    work,
    home,
    repo,
    other,
    homeRepo,
    store,
    memberships,
    verifier,
    discovery,
    service: new SignerService(store, verifier, discovery),
  };
}

it("isolates repository/profile decisions, preserves distrust, and never transfers trust to a rotated key", () => {
  const { db, service, work, home, repo, other, homeRepo, memberships, store } = setup();
  try {
    service.decide(work.id, repo.id, decision, false);
    expect(service.decorate(work.id, repo.id, valid).signerTrust).toBe("trusted");
    expect(service.decorate(work.id, other.id, valid).signerTrust).toBe("unknown");
    expect(service.decorate(home.id, homeRepo.id, valid).signerTrust).toBe("unknown");
    expect(
      service.decorate(work.id, repo.id, { ...valid, fingerprint: "B".repeat(40) }).signerTrust,
    ).toBe("unknown");
    service.decide(
      work.id,
      repo.id,
      { ...decision, scope: "profile", decision: "distrusted" },
      false,
    );
    expect(service.decorate(work.id, repo.id, valid).signerTrust).toBe("distrusted");
    service.decide(
      work.id,
      repo.id,
      { ...decision, scope: "profile", decision: "distrusted" },
      true,
    );
    expect(
      service.decorate(work.id, repo.id, { ...valid, signerTrust: "distrusted" }).signerTrust,
    ).toBe("distrusted");
    expect(
      service.decorate(work.id, repo.id, { ...valid, authorEmail: "impostor@example.test" })
        .identityMismatch,
    ).toBe(true);
    expect(() => store.decide(home.id, repo.id, decision)).toThrow();
    memberships.remove(repo.id, work.id);
    expect(store.list(work.id, repo.id)).toEqual([]);
  } finally {
    db.close();
  }
});

it("keeps discovery evidence separate from trust and reimports prior key material to preserve revocations", async () => {
  const { db, service, work, repo, store, verifier, discovery } = setup();
  try {
    store.saveKey(work.id, fingerprint, "old revocation material", "manual");
    const candidate = await service.discover(
      work.id,
      repo.path,
      "b".repeat(40),
      valid,
      { source: "github", account: "example" },
      new AbortController().signal,
    );
    expect(verifier.verify.mock.calls[1]?.[2]).toBe("old revocation material\ndownload");
    expect(candidate.armoredKey).toBe("verified export");
    expect(discovery.find).toHaveBeenCalledOnce();
    expect(store.list(work.id, repo.id)).toEqual([]);
    expect(service.decorate(work.id, repo.id, valid).signerTrust).toBe("unknown");
    service.decide(work.id, repo.id, decision, false);
    const revoked = service.decorate(work.id, repo.id, {
      ...valid,
      reasonCode: "revoked-key",
      status: "invalid",
    });
    expect(revoked.reasonCode).toBe("revoked-key");
    expect(revoked.status).toBe("invalid");
    db.delete(identities).where(eq(identities.id, work.id)).run();
    expect(store.keyCount(work.id)).toBe(0);
  } finally {
    db.close();
  }
});

it("rejects short fingerprints and malformed identity decisions", () => {
  const { db, service, work, repo } = setup();
  try {
    for (const input of [
      { ...decision, fingerprint: "DEADBEEF" },
      { ...decision, identity: "" },
      { ...decision, identity: "Author\nOther" },
    ])
      expect(() => service.decide(work.id, repo.id, input, false)).toThrow();
  } finally {
    db.close();
  }
});

it("tries GitHub's service signing key only after the account candidate fails verification", async () => {
  const { db, service, work, repo, verifier, discovery } = setup();
  try {
    verifier.verify.mockRejectedValueOnce(new Error("Different key"));
    discovery.find
      .mockResolvedValueOnce({
        armoredKey: "account key",
        source: "https://github.com/example.gpg",
      })
      .mockResolvedValueOnce({
        armoredKey: "service key",
        source: "https://github.com/web-flow.gpg",
      });
    const result = await service.discover(
      work.id,
      repo.path,
      "b".repeat(40),
      valid,
      { source: "github", account: "example" },
      new AbortController().signal,
    );
    expect(result.source).toBe("https://github.com/web-flow.gpg");
    expect(discovery.find.mock.calls.map((call) => call[0])).toEqual([
      { source: "github", account: "example" },
      { source: "github", account: "web-flow" },
    ]);
  } finally {
    db.close();
  }
});

it("forgets cached public keys without granting or removing signer trust", () => {
  const { db, store, service, work, repo } = setup();
  try {
    store.saveKey(work.id, fingerprint, "export", "manual");
    service.decide(work.id, repo.id, decision, false);
    store.forgetKey(work.id, fingerprint);
    expect(store.findKey(work.id, fingerprint)).toBeUndefined();
    expect(store.list(work.id, repo.id)).toEqual([decision]);
  } finally {
    db.close();
  }
});

it.each([
  { keyId: "B5690EEEBB952194" },
  { keyId: "4aee18f83afdeb23" },
  { committerEmail: `noreply@${"github.com"}` },
])("looks up GitHub's service key directly from a signing hint %j", async (hint) => {
  const { db, service, work, repo, discovery, store } = setup();
  try {
    await service.discover(
      work.id,
      repo.path,
      "b".repeat(40),
      {
        ...valid,
        ...hint,
        authorEmail: "author@example.test",
      },
      { source: "github", account: "example" },
      new AbortController().signal,
    );
    expect(discovery.find.mock.calls.map((call) => call[0])).toEqual([
      { source: "github", account: "web-flow" },
    ]);
    expect(store.list(work.id, repo.id)).toEqual([]);
  } finally {
    db.close();
  }
});

it("does not accept a service-key hint as proof that GitHub signed a commit", async () => {
  const { db, service, work, repo, discovery, verifier, store } = setup();
  verifier.verify.mockRejectedValue(new Error("Signature does not match"));
  try {
    await expect(
      service.discover(
        work.id,
        repo.path,
        "b".repeat(40),
        {
          ...valid,
          committerEmail: `noreply@${"github.com"}`,
        },
        { source: "github", account: "web-flow" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Signature does not match");
    expect(discovery.find.mock.calls.map((call) => call[0])).toEqual([
      { source: "github", account: "web-flow" },
    ]);
    expect(store.keyCount(work.id)).toBe(0);
    expect(store.list(work.id, repo.id)).toEqual([]);
  } finally {
    db.close();
  }
});

it("attributes verified web signing to the service without trusting it or comparing it to the author", () => {
  const { db, service, work, repo } = setup();
  try {
    const signature = {
      ...valid,
      signer: `GitHub <noreply@${"github.com"}>`,
      committerEmail: `noreply@${"github.com"}`,
    };
    expect(service.decorate(work.id, repo.id, signature).identityMismatch).toBe(true);
    const result = service.decorate(work.id, repo.id, {
      ...signature,
      keySource: "https://github.com/web-flow.gpg",
    });
    expect(result.identityMismatch).toBe(false);
    expect(result.signerTrust).toBe("unknown");
  } finally {
    db.close();
  }
});

it.each(["local", "distrusted"] as const)(
  "preserves %s GPG trust when verifying a downloaded key",
  async (trust) => {
    const { db, service, work, repo, store } = setup();
    try {
      store.saveKey(work.id, fingerprint, "export", "manual");
      expect(
        (await service.verify(work.id, repo.path, "b".repeat(40), { ...valid, signerTrust: trust }))
          .signerTrust,
      ).toBe(trust);
    } finally {
      db.close();
    }
  },
);
