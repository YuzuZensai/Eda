import {
  isGitHubServiceSigningHint,
  isVerifiedGitHubWebSignature,
} from "@shared/integrations/github";
import type {
  CommitSignatureVerification,
  PublicKeyRequest,
  SignerDecision,
} from "@shared/repository/repository-read";
import type { SignerRepository } from "../../persistence/signer-repository";
import type { PublicKeyVerifier } from "../../git/security/public-key-verifier";
import type { PublicSigningKeys } from "../../providers/public-signing-keys";
import { keyError } from "../../providers/public-signing-keys";

export class SignerService {
  constructor(
    readonly store: SignerRepository,
    private readonly verifier: Pick<PublicKeyVerifier, "verify">,
    private readonly discovery: Pick<PublicSigningKeys, "find">,
  ) {}

  async verifyLocal(path: string, oid: string): Promise<CommitSignatureVerification> {
    try {
      return (await this.verifier.verify(path, oid, undefined, AbortSignal.timeout(15_000)))
        .signature;
    } catch {
      return {
        status: "unverified",
        format: "openpgp",
        reasonCode: "verification-error",
        validity: "unknown",
        signerTrust: "unknown",
        diagnostics: "",
      };
    }
  }

  async verify(
    profileId: string,
    path: string,
    oid: string,
    signature: CommitSignatureVerification,
  ) {
    if (
      signature.format === "ssh" &&
      signature.validity !== "valid" &&
      signature.status !== "invalid"
    ) {
      try {
        return {
          ...(await this.verifier.verify(path, oid, null, AbortSignal.timeout(15_000))).signature,
          ...(signature.authorEmail ? { authorEmail: signature.authorEmail } : {}),
          ...(signature.committerEmail ? { committerEmail: signature.committerEmail } : {}),
        };
      } catch {
        return signature;
      }
    }
    if (signature.format !== "openpgp") return signature;
    const key = this.store.findKey(profileId, signature.fingerprint, signature.keyId);
    if (!key) return signature;
    try {
      const result = await this.verifier.verify(
        path,
        oid,
        key.armoredKey,
        AbortSignal.timeout(15_000),
      );
      // The cached key may be older, so keep any local revocation or expiry warnings.
      if (
        ["bad-signature", "revoked-key", "expired-key", "expired-signature"].includes(
          signature.reasonCode ?? "",
        )
      )
        return signature;
      return {
        ...result.signature,
        ...(signature.authorEmail ? { authorEmail: signature.authorEmail } : {}),
        ...(signature.committerEmail ? { committerEmail: signature.committerEmail } : {}),
        signerTrust:
          signature.signerTrust === "local" || signature.signerTrust === "distrusted"
            ? signature.signerTrust
            : (result.signature.signerTrust ?? "unknown"),
        keySource: key.source,
        keyFetchedAt: key.fetchedAt,
      };
    } catch {
      return signature;
    }
  }

  decorate(profileId: string, repositoryId: string, signature: CommitSignatureVerification) {
    const author = (
      isVerifiedGitHubWebSignature(signature) ? signature.committerEmail : signature.authorEmail
    )?.toLowerCase();
    const claimed = signature.signer?.match(/<([^>]+)>/)?.[1]?.toLowerCase();
    signature = {
      ...signature,
      identityMismatch: Boolean(author && claimed && author !== claimed),
    };
    if (!signature.fingerprint) return signature;
    const decisions = this.store
      .list(profileId, repositoryId)
      .filter((entry) => entry.fingerprint === signature.fingerprint);
    // Distrust wins even if the key is trusted in another scope.
    const decision =
      decisions.find((entry) => entry.decision === "distrusted") ??
      decisions.find((entry) => entry.scope === "repository") ??
      decisions[0];
    if (!decision) return signature;
    return {
      ...signature,
      signerTrust: signature.signerTrust === "distrusted" ? "distrusted" : decision.decision,
      identityMismatch:
        signature.identityMismatch || Boolean(author && decision.identity.toLowerCase() !== author),
      trustedIdentity: decision.identity,
      trustScope: decision.scope,
    };
  }

  async discover(
    profileId: string,
    path: string,
    oid: string,
    signature: CommitSignatureVerification,
    request: PublicKeyRequest,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    if (signature.format !== "openpgp") throw keyError();
    const previous = this.store.findKey(profileId, signature.fingerprint, signature.keyId);
    const requests: Exclude<PublicKeyRequest, { source: "automatic" }>[] = [];
    if (request.source === "automatic") {
      const account = signature.authorEmail?.match(
        /^(?:\d+\+)?([A-Za-z\d-]+)@users\.noreply\.github\.com$/,
      )?.[1];
      if (isGitHubServiceSigningHint(signature))
        requests.push({ source: "github", account: "web-flow" });
      else if (account) requests.push({ source: "github", account });
      for (const server of [
        "https://keys.openpgp.org",
        "https://keyserver.ubuntu.com",
        "https://keys.mailvelope.com",
        "https://pgpkeys.eu",
      ])
        requests.push({ source: "keyserver", server });
    } else if (request.source === "github" && request.account !== "web-flow") {
      requests.push(request, { source: "github", account: "web-flow" });
      if (isGitHubServiceSigningHint(signature)) requests.reverse();
    } else requests.push(request);

    for (const [index, lookup] of requests.entries()) {
      signal.throwIfAborted();
      try {
        const candidate =
          lookup.source === "manual"
            ? { armoredKey: lookup.armoredKey, source: "manual" }
            : await this.discovery.find(
                lookup,
                signature.fingerprint ?? signature.keyId ?? "",
                AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
              );
        const keyMaterial = previous
          ? `${previous.armoredKey}\n${candidate.armoredKey}`
          : candidate.armoredKey;
        const candidateResult = await this.verifier.verify(path, oid, candidate.armoredKey, signal);
        const verified = previous
          ? await this.verifier.verify(path, oid, keyMaterial, signal)
          : candidateResult;
        if (!verified.signature.fingerprint) throw keyError();
        return {
          fingerprint: verified.signature.fingerprint,
          armoredKey: verified.armoredKey,
          source: candidate.source,
        };
      } catch (error) {
        if (signal.aborted || index === requests.length - 1) throw error;
      }
    }
    throw keyError();
  }

  decide(profileId: string, repositoryId: string, decision: SignerDecision, remove: boolean) {
    if (
      !/^(?:[A-F\d]{40}|[A-F\d]{64}|SHA256:[A-Za-z\d+/]{43})$/.test(decision.fingerprint) ||
      !decision.identity.trim() ||
      decision.identity.length > 320 ||
      /[\u0000-\u001f\u007f]/.test(decision.identity) ||
      !["profile", "repository"].includes(decision.scope) ||
      !["trusted", "distrusted"].includes(decision.decision)
    )
      throw keyError();
    this.store.decide(profileId, repositoryId, decision, remove);
  }
}
