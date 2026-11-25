import type { PublicKeyVerifier } from "@main/git/security/public-key-verifier";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { RepositoryMemberships } from "@main/persistence/repository-memberships";
import { CommitSignatureRepository } from "@main/persistence/commit-signature-repository";
import { CommitSignatureService } from "@main/repo/history/commit-signature-service";
import type { Database } from "@main/persistence/types";
import {
  UNSIGNED_COMMIT_SIGNATURE,
  type CommitInspection,
  type CommitSignatureVerification,
} from "@shared/repository/repository-read";

const oid = "a".repeat(40);
const verified: CommitSignatureVerification = {
  status: "verified",
  format: "ssh",
  reasonCode: null,
  diagnostics: "Good signature",
};
const invalid: CommitSignatureVerification = {
  status: "invalid",
  format: "ssh",
  reasonCode: "bad-signature",
  diagnostics: "Bad signature",
};
let db: Database;

beforeEach(() => {
  db = openInMemoryDatabase();
});
afterEach(() => db.close());

function setup() {
  const profile = new IdentityRepository(db).create({
    name: "Work",
    gitName: "Work",
    gitEmail: "work@example.test",
    hue: 210,
    signing: { format: "none", signCommits: false },
  });
  const memberships = new RepositoryMemberships(db);
  const repository = memberships.register("/repo", profile.id);
  const repositories = {
    resolveActiveRepository: (id: string) => {
      const row = memberships.find(id, profile.id);
      if (!row) throw new Error("Repository is not in this profile");
      return row;
    },
  };
  const git = {
    commitSignature: vi.fn(async () => verified),
    inspectCommit: vi.fn(
      async (
        _path: string,
        commitOid: string,
        signature = UNSIGNED_COMMIT_SIGNATURE,
      ): Promise<CommitInspection> => ({
        commit: {
          oid: commitOid,
          parents: [],
          author: { name: "Work", email: "work@example.test", timestamp: "2026-11-11" },
          committerTimestamp: "2026-11-11",
          subject: "Commit",
          body: "",
          decorations: [],
        },
        containingRefs: [],
        shallow: false,
        signed: signature.status !== "unsigned",
        signature,
      }),
    ),
  };
  const cache = new CommitSignatureRepository(db);
  const service = new CommitSignatureService(git, repositories, cache);
  return { service, git, cache, repository, memberships, repositories, profile };
}

it("shares verification work and reuses persisted results for history and details until explicitly rechecked", async () => {
  const { service, git, cache, repository, repositories } = setup();
  await Promise.all([service.read(repository.id, oid), service.read(repository.id, oid)]);
  expect(git.commitSignature).toHaveBeenCalledOnce();

  const restarted = new CommitSignatureService(git, repositories, cache);
  expect((await restarted.inspect(repository.id, oid)).signature).toEqual(verified);
  expect(git.commitSignature).toHaveBeenCalledOnce();
  git.commitSignature.mockResolvedValueOnce(invalid);
  expect((await restarted.inspect(repository.id, oid, true)).signature).toEqual(invalid);
  expect(await restarted.read(repository.id, oid)).toEqual(invalid);
  expect(git.commitSignature).toHaveBeenCalledTimes(2);
});

it("rejects a cached signature if the repository moves before delivery", async () => {
  const { service, cache, repository, memberships, profile } = setup();
  cache.record(profile.id, repository.id, oid, verified);
  const result = service.read(repository.id, oid);
  memberships.relocate(repository.id, "/moved", "moved");
  await expect(result).rejects.toMatchObject({
    code: "main.repositoryManager.theRepositoryChangedRefreshAndTryAgain",
  });
});

it("drops commit details if the repository moves during inspection", async () => {
  const { service, git, repository, memberships } = setup();
  const details = await git.inspectCommit(repository.path, oid, verified);
  git.inspectCommit.mockImplementationOnce(async () => {
    memberships.relocate(repository.id, "/moved", "moved");
    return details;
  });
  await expect(service.inspect(repository.id, oid)).rejects.toMatchObject({
    code: "main.repositoryManager.theRepositoryChangedRefreshAndTryAgain",
  });
});

it.each(["background-first", "refresh-first"])(
  "returns the newer recheck to all readers (%s)",
  async (order) => {
    const { service, git, cache, repository, profile } = setup();
    const pending: Array<(signature: CommitSignatureVerification) => void> = [];
    git.commitSignature.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const background = service.read(repository.id, oid);
    const refresh = service.read(repository.id, oid, true);

    if (order === "background-first") {
      pending[0]!(verified);
      await Promise.resolve();
    }

    pending[1]!(invalid);
    await refresh;
    if (order === "refresh-first") pending[0]!(verified);
    expect(await background).toEqual(invalid);
    expect(cache.read(profile.id, repository.id, oid)).toEqual(invalid);
    expect(await service.read(repository.id, oid)).toEqual(invalid);
  },
);

it("does not recreate cached data when a repository is removed during verification", async () => {
  const { service, git, cache, repository, profile, memberships } = setup();
  let finish!: (signature: CommitSignatureVerification) => void;
  git.commitSignature.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const request = service.read(repository.id, oid);
  memberships.remove(repository.id, profile.id);
  finish(verified);
  await expect(request).rejects.toThrow("Repository is not in this profile");

  expect(cache.read(profile.id, repository.id, oid)).toBeNull();
  await expect(service.read(repository.id, oid)).rejects.toThrow(
    "Repository is not in this profile",
  );
});

it("retries failed requests and validates object IDs before consulting the cache or Git", async () => {
  const { service, git, cache, repository, profile } = setup();
  await expect(service.read(repository.id, "--all")).rejects.toThrow();
  expect(git.commitSignature).not.toHaveBeenCalled();
  git.commitSignature.mockRejectedValueOnce(new Error("Commit unavailable"));
  await expect(service.read(repository.id, oid)).rejects.toThrow("Commit unavailable");
  expect(cache.read(profile.id, repository.id, oid)).toBeNull();
  expect(await service.read(repository.id, oid)).toEqual(verified);
});

it.each(["cancel", "profile-change"])("does not save discovered keys after %s", async (action) => {
  const { git, cache, repository, repositories, profile } = setup();
  const { SignerRepository } = await import("@main/persistence/signer-repository");
  const { SignerService } = await import("@main/repo/history/signer-service");
  const store = new SignerRepository(db);
  const signature: CommitSignatureVerification = {
    ...verified,
    format: "openpgp",
    validity: "valid",
    signerTrust: "unknown",
    fingerprint: "A".repeat(40),
  };
  git.commitSignature.mockResolvedValue(signature);
  let finish!: (value: { signature: CommitSignatureVerification; armoredKey: string }) => void;
  const verifier = {
    verify: vi.fn(
      () =>
        new Promise<{ signature: CommitSignatureVerification; armoredKey: string }>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const signers = new SignerService(store, verifier, { find: vi.fn() });
  const service = new CommitSignatureService(git, repositories, cache, signers);
  const pending = service.discover(repository.id, oid, {
    source: "manual",
    armoredKey: "candidate",
  });
  await vi.waitFor(() => expect(verifier.verify).toHaveBeenCalledOnce());
  if (action === "cancel") service.cancelDiscovery(repository.id);
  else
    vi.spyOn(repositories, "resolveActiveRepository").mockImplementation(() => {
      throw new Error("Profile changed");
    });
  const failure = expect(pending).rejects.toThrow();
  finish({ signature, armoredKey: "export" });
  await failure;
  expect(store.keyCount(profile.id)).toBe(0);
});

async function automaticSetup() {
  const base = setup();
  const { SignerRepository } = await import("@main/persistence/signer-repository");
  const { SignerService } = await import("@main/repo/history/signer-service");
  const store = new SignerRepository(db);
  const missing: CommitSignatureVerification = {
    status: "unverified",
    format: "openpgp",
    reasonCode: "missing-key",
    keyId: "A".repeat(16),
    diagnostics: "",
  };
  const valid: CommitSignatureVerification = {
    ...missing,
    reasonCode: "untrusted-key",
    validity: "valid",
    signerTrust: "unknown",
    fingerprint: "A".repeat(40),
  };
  base.git.commitSignature.mockResolvedValue(missing);
  const verifier = {
    verify: vi.fn<PublicKeyVerifier["verify"]>(async () => ({
      signature: valid,
      armoredKey: "export",
    })),
  };
  const discovery = {
    find: vi.fn(async () => ({ armoredKey: "download", source: "https://keys.openpgp.org" })),
  };
  const signers = new SignerService(store, verifier, discovery);
  const service = new CommitSignatureService(base.git, base.repositories, base.cache, signers);
  return { ...base, service, store, verifier, discovery };
}

it("shares automatic lookup across commits but verifies each commit without granting trust", async () => {
  const { service, repository, discovery, verifier, store, profile } = await automaticSetup();
  const results = await Promise.all([
    service.read(repository.id, oid),
    service.read(repository.id, "b".repeat(40)),
  ]);
  expect(discovery.find).toHaveBeenCalledOnce();
  for (const result of results) {
    expect(result.validity).toBe("valid");
    expect(result.signerTrust).toBe("unknown");
  }
  expect(verifier.verify.mock.calls.map((call) => call[1])).toEqual(
    expect.arrayContaining([oid, "b".repeat(40)]),
  );
  expect(store.keyCount(profile.id)).toBe(1);
  expect(store.list(profile.id, repository.id)).toEqual([]);
});

it("cools down failed automatic lookups but permits an explicit retry", async () => {
  const { service, repository, discovery } = await automaticSetup();
  discovery.find.mockRejectedValue(new Error("Offline"));
  expect((await service.read(repository.id, oid)).keyDiscovery).toBe("unavailable");
  expect(discovery.find).toHaveBeenCalledTimes(4);
  await service.read(repository.id, "b".repeat(40));
  expect(discovery.find).toHaveBeenCalledTimes(4);
  await service.read(repository.id, oid, true);
  expect(discovery.find).toHaveBeenCalledTimes(8);
});

it("does not download a forgotten key again when trust review refreshes verification", async () => {
  const { service, repository, discovery, store, profile } = await automaticSetup();
  await service.read(repository.id, oid);
  service.forgetKey(repository.id, "A".repeat(40));
  expect((await service.read(repository.id, oid, true)).reasonCode).toBe("missing-key");
  expect(discovery.find).toHaveBeenCalledOnce();
  expect(store.keyCount(profile.id)).toBe(0);
});

it.each(["cancel", "profile-change", "remove"])(
  "does not save an automatic lookup after %s",
  async (action) => {
    const { service, repository, discovery, store, profile, repositories, memberships } =
      await automaticSetup();
    let finish!: (value: { armoredKey: string; source: string }) => void;
    discovery.find.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = service.read(repository.id, oid);
    await vi.waitFor(() => expect(discovery.find).toHaveBeenCalledOnce());
    if (action === "cancel") service.cancelAll();
    else if (action === "remove") memberships.remove(repository.id, profile.id);
    else
      vi.spyOn(repositories, "resolveActiveRepository").mockImplementation(() => {
        throw new Error("Profile changed");
      });
    const outcome = pending.catch(() => undefined);
    finish({ armoredKey: "download", source: "https://keys.openpgp.org" });
    await outcome;
    expect(store.keyCount(profile.id)).toBe(0);
  },
);

it("does not start key discovery in a different profile after local verification finishes", async () => {
  const { service, repository, repositories, git, discovery } = await automaticSetup();
  const missing = await git.commitSignature();
  let finish!: (value: CommitSignatureVerification) => void;
  git.commitSignature.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = service.read(repository.id, oid);
  vi.spyOn(repositories, "resolveActiveRepository").mockReturnValue({
    ...repository,
    identityId: "other-profile",
  });
  const failure = expect(pending).rejects.toThrow();
  finish(missing);
  await failure;
  expect(discovery.find).not.toHaveBeenCalled();
});

it("does not let an in-flight manual discovery restore a forgotten key", async () => {
  const { service, repository, discovery, store, profile } = await automaticSetup();
  let finish!: (value: { armoredKey: string; source: string }) => void;
  discovery.find.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = service.discover(repository.id, oid, {
    source: "keyserver",
    server: "https://keys.openpgp.org",
  });
  await vi.waitFor(() => expect(discovery.find).toHaveBeenCalledOnce());
  service.forgetKey(repository.id, "A".repeat(40));
  const failure = expect(pending).rejects.toThrow();
  finish({ armoredKey: "download", source: "https://keys.openpgp.org" });
  await failure;
  expect(store.keyCount(profile.id)).toBe(0);
});
