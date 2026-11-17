import {
  isGitHubServiceSigningHint,
  isVerifiedGitHubWebSignature,
} from "@shared/integrations/github";
import { t, type MessageKey } from "@shared/i18n";
import type { CommitSignatureVerification } from "@shared/repository/repository-read";

const reasons: Record<NonNullable<CommitSignatureVerification["reasonCode"]>, MessageKey> = {
  "bad-signature": "diff.commitDetails.signatureInvalid",
  "missing-key": "diff.commitDetails.signatureMissingKey",
  "missing-trust": "diff.commitDetails.signatureMissingTrust",
  "untrusted-key": "diff.commitDetails.signatureUntrusted",
  "expired-signature": "diff.commitDetails.signatureExpired",
  "expired-key": "diff.commitDetails.signatureKeyExpired",
  "revoked-key": "diff.commitDetails.signatureKeyRevoked",
  "verification-error": "diff.commitDetails.signatureUnverified",
  "unsupported-format": "diff.commitDetails.signatureUnsupported",
};

export function commitSignatureLabel(signature: CommitSignatureVerification): string {
  if (signature.validity === "valid") {
    if (
      signature.reasonCode &&
      ["revoked-key", "expired-key", "expired-signature"].includes(signature.reasonCode)
    )
      return `${t("signature.valid")} · ${t(reasons[signature.reasonCode])}`;
    if (signature.signerTrust === "distrusted")
      return `${t("signature.valid")} · ${t("signature.distrusted")}`;
    if (signature.identityMismatch) return `${t("signature.valid")} · ${t("signature.mismatch")}`;
    if (isVerifiedGitHubWebSignature(signature)) return t("signature.githubWebValid");
    return t(
      signature.signerTrust === "trusted" || signature.signerTrust === "local"
        ? "signature.validTrusted"
        : "signature.validUnknown",
    );
  }
  if (signature.reasonCode === "missing-key" && isGitHubServiceSigningHint(signature))
    return `${t("signature.githubWebHint")} · ${t(signature.keyDiscovery === "unavailable" ? "signature.lookupUnavailable" : "diff.commitDetails.signatureMissingKey")}`;
  if (signature.keyDiscovery === "unavailable" && signature.reasonCode === "missing-key")
    return t("signature.lookupUnavailable");
  if (signature.status === "unsigned") return t("diff.commitDetails.unsigned");
  if (signature.status === "verified") return t("diff.commitDetails.signatureVerified");
  if (signature.reasonCode) return t(reasons[signature.reasonCode]);
  return t("diff.commitDetails.signatureUnverified");
}

export function commitSignatureFormatLabel(signature: CommitSignatureVerification): string {
  const formats: Record<NonNullable<CommitSignatureVerification["format"]>, MessageKey> = {
    openpgp: "diff.commitDetails.signatureOpenPgp",
    ssh: "diff.commitDetails.signatureSsh",
    x509: "diff.commitDetails.signatureX509",
    unknown: "diff.commitDetails.signatureUnsupported",
  };
  return signature.format ? t(formats[signature.format]) : "";
}

export function commitSignatureTrustLabel(signature: CommitSignatureVerification): string {
  if (isVerifiedGitHubWebSignature(signature)) return "";
  const trustLabels: Record<NonNullable<CommitSignatureVerification["signerTrust"]>, MessageKey> = {
    unknown: "signature.unknown",
    local: "signature.local",
    trusted: "signature.trusted",
    distrusted: "signature.distrusted",
  };
  if (signature.signerTrust) return t(trustLabels[signature.signerTrust]);
  const levels: Record<NonNullable<CommitSignatureVerification["trustLevel"]>, MessageKey> = {
    undefined: "diff.commitDetails.trustUnknown",
    never: "diff.commitDetails.trustNever",
    marginal: "diff.commitDetails.trustMarginal",
    fully: "diff.commitDetails.trustFully",
    ultimate: "diff.commitDetails.trustUltimate",
  };
  return signature.trustLevel ? t(levels[signature.trustLevel]) : "";
}

export function commitSignatureWarning(signature: CommitSignatureVerification): string | null {
  if (
    signature.reasonCode &&
    ["revoked-key", "expired-key", "expired-signature"].includes(signature.reasonCode)
  )
    return t(reasons[signature.reasonCode]);
  if (signature.identityMismatch) return t("signature.mismatch");
  return null;
}

export function commitSignatureOrigin(signature: CommitSignatureVerification): string | null {
  if (isVerifiedGitHubWebSignature(signature)) return t("signature.githubWebSource");
  if (isGitHubServiceSigningHint(signature)) return t("signature.githubWebHint");
  return signature.keySource === "manual"
    ? t("signature.manualSource")
    : (signature.keySource ?? null);
}
