import type { SignerService } from "./signer-service";
import type { PublicKeyRequest, SignerDecision } from "@shared/repository/repository-read";
import { keyError } from "../../providers/public-signing-keys";
import { t } from "@shared/i18n";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import type { CommitSignatureVerification } from "@shared/repository/repository-read";
import type { GitService } from "../../git/git-service";
import { assertFullObjectId } from "../../git/validation";
import type { CommitSignatureRepository } from "../../persistence/commit-signature-repository";
import type { RepositoryManager } from "../lifecycle/repository-manager";

export class CommitSignatureService {
  private revision = 0;
  private readonly automatic = new Map<
    string,
    { repositoryId: string; controller: AbortController; work: Promise<void> }
  >();
  private readonly lookupCooldown = new Map<string, { until: number; paused: boolean }>();
  private readonly discoveries = new Map<string, AbortController>();
  private readonly pending = new Map<string, Promise<CommitSignatureVerification>>();

  constructor(
    private readonly git: Pick<GitService, "commitSignature" | "inspectCommit">,
    private readonly repositories: Pick<RepositoryManager, "resolveActiveRepository">,
    private readonly cache: CommitSignatureRepository,
    private readonly signers?: SignerService,
  ) {}

  async read(
    repositoryId: string,
    oid: string,
    refresh = false,
  ): Promise<CommitSignatureVerification> {
    const signature = await this.readRaw(repositoryId, oid, refresh);
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    return this.signers?.decorate(repository.identityId, repository.id, signature) ?? signature;
  }

  private async readRaw(
    repositoryId: string,
    oid: string,
    refresh = false,
    discoverMissing = true,
  ): Promise<CommitSignatureVerification> {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    assertFullObjectId(oid, t("operations.verifyCommitSignature"));
    const revision = this.revision;
    const key = JSON.stringify([repository.identityId, repository.id, oid, revision]);

    if (!refresh) {
      const pending = this.pending.get(key);
      if (pending) return pending;

      const cached = this.cache.read(repository.identityId, repository.id, oid);
      if (cached) return cached;
    }

    const assertCurrent = () => {
      const current = this.repositories.resolveActiveRepository(repositoryId);
      if (current.identityId !== repository.identityId || current.path !== repository.path)
        throw new GitError({
          kind: "invalid-input",
          operation: t("operations.verifyCommitSignature"),
          message: errorText("main.repositoryManager.theRepositoryChangedRefreshAndTryAgain"),
        });
    };
    const signers = this.signers;
    const request: Promise<CommitSignatureVerification> = this.git
      .commitSignature(
        repository.path,
        oid,
        signers ? (path, id) => signers.verifyLocal(path, id) : undefined,
      )
      .then((signature) => {
        assertCurrent();
        return signers
          ? signers.verify(repository.identityId, repository.path, oid, signature)
          : signature;
      })
      .then((signature) => {
        assertCurrent();
        return discoverMissing && revision === this.revision
          ? this.findMissingKey(repositoryId, oid, signature, refresh)
          : signature;
      })
      .then((signature) => {
        assertCurrent();

        if (revision !== this.revision) return this.readRaw(repositoryId, oid);

        const latest = this.pending.get(key);
        if (latest === request) {
          this.cache.record(repository.identityId, repository.id, oid, signature);
          return signature;
        }

        // Readers waiting on superseded work must receive the recheck's result too.
        return latest ?? this.cache.read(repository.identityId, repository.id, oid) ?? signature;
      });

    this.pending.set(key, request);

    try {
      return await request;
    } finally {
      if (this.pending.get(key) === request) this.pending.delete(key);
    }
  }

  private async findMissingKey(
    repositoryId: string,
    oid: string,
    signature: CommitSignatureVerification,
    refresh: boolean,
  ): Promise<CommitSignatureVerification> {
    const signers = this.signers;
    if (!signers || signature.format !== "openpgp" || signature.reasonCode !== "missing-key")
      return signature;
    const identifier = signature.fingerprint ?? signature.keyId;
    if (!identifier || !/^(?:[A-F\d]{16}|[A-F\d]{40}|[A-F\d]{64})$/i.test(identifier))
      return signature;
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const key = JSON.stringify([repository.identityId, identifier.slice(-16).toUpperCase()]);
    const unavailable: CommitSignatureVerification = { ...signature, keyDiscovery: "unavailable" };
    let lookup = this.automatic.get(key);
    if (!lookup) {
      const cooldown = this.lookupCooldown.get(key);
      if (cooldown && cooldown.until > Date.now() && (!refresh || cooldown.paused))
        return unavailable;
      if (this.automatic.size >= 2) return signature;
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      const revision = this.revision;
      const work = (async () => {
        const candidate = await signers.discover(
          repository.identityId,
          repository.path,
          oid,
          signature,
          { source: "automatic" },
          signal,
        );
        const current = this.repositories.resolveActiveRepository(repositoryId);
        if (
          signal.aborted ||
          revision !== this.revision ||
          current.identityId !== repository.identityId ||
          current.path !== repository.path
        )
          throw keyError();
        signers.store.saveKey(
          repository.identityId,
          candidate.fingerprint,
          candidate.armoredKey,
          candidate.source,
        );
        this.cache.clear(repository.identityId);
      })();
      lookup = { repositoryId, controller, work };
      this.automatic.set(key, lookup);
      this.pauseLookup(key, false);
    }
    try {
      await lookup.work;
      const current = this.repositories.resolveActiveRepository(repositoryId);
      if (current.identityId !== repository.identityId || current.path !== repository.path)
        throw keyError();
      const verified = await signers.verify(repository.identityId, repository.path, oid, signature);
      return verified.reasonCode === "missing-key" ? unavailable : verified;
    } catch {
      return unavailable;
    } finally {
      if (this.automatic.get(key) === lookup) this.automatic.delete(key);
    }
  }

  private pauseLookup(key: string, paused: boolean) {
    this.lookupCooldown.delete(key);
    this.lookupCooldown.set(key, { until: Date.now() + 15 * 60_000, paused });
    if (this.lookupCooldown.size > 512)
      this.lookupCooldown.delete(this.lookupCooldown.keys().next().value!);
  }

  cancelDiscovery(repositoryId: string) {
    this.repositories.resolveActiveRepository(repositoryId);
    this.discoveries.get(repositoryId)?.abort();
    for (const lookup of this.automatic.values())
      if (lookup.repositoryId === repositoryId) lookup.controller.abort();
  }

  cancelAll() {
    for (const controller of this.discoveries.values()) controller.abort();
    for (const lookup of this.automatic.values()) lookup.controller.abort();
  }

  async discover(repositoryId: string, oid: string, input: PublicKeyRequest) {
    if (!this.signers || this.discoveries.has(repositoryId) || this.discoveries.size >= 2)
      throw keyError();
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const revision = this.revision;
    const controller = new AbortController();
    this.discoveries.set(repositoryId, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    try {
      const signature = await this.readRaw(repositoryId, oid, true, false);
      const candidate = await this.signers.discover(
        repository.identityId,
        repository.path,
        oid,
        signature,
        input,
        signal,
      );
      const current = this.repositories.resolveActiveRepository(repositoryId);
      if (
        signal.aborted ||
        revision !== this.revision ||
        current.identityId !== repository.identityId ||
        current.path !== repository.path
      )
        throw keyError();
      this.signers.store.saveKey(
        repository.identityId,
        candidate.fingerprint,
        candidate.armoredKey,
        candidate.source,
      );
      this.invalidate(repository.identityId);
      return await this.read(repositoryId, oid, true);
    } finally {
      this.discoveries.delete(repositoryId);
    }
  }

  forgetKey(repositoryId: string, fingerprint: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    if (!this.signers || !/^(?:[A-F\d]{40}|[A-F\d]{64})$/.test(fingerprint)) throw keyError();
    this.signers.store.forgetKey(repository.identityId, fingerprint);
    this.pauseLookup(JSON.stringify([repository.identityId, fingerprint.slice(-16)]), true);
    this.invalidate(repository.identityId);
  }

  listSigners(repositoryId: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    return this.signers?.store.list(repository.identityId, repository.id) ?? [];
  }

  decide(repositoryId: string, decision: SignerDecision, remove: boolean) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    if (!this.signers) throw keyError();
    this.signers.decide(repository.identityId, repository.id, decision, remove);
    this.invalidate(repository.identityId);
  }

  private invalidate(profileId: string) {
    this.revision++;
    this.cache.clear(profileId);
  }

  async inspect(repositoryId: string, oid: string, refresh = false) {
    const signature = await this.read(repositoryId, oid, refresh);
    const repository = this.repositories.resolveActiveRepository(repositoryId);

    return this.git.inspectCommit(repository.path, oid, signature);
  }
}
