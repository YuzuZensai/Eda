import { isVerifiedGitHubWebSignature } from "@shared/integrations/github";
import { t } from "@shared/i18n";
import type { CommitSignatureVerification } from "@shared/repository/repository-read";
import {
  CircleHelpIcon,
  GitHubIcon,
  CircleDashedIcon,
  SpinnerIcon,
  CircleCheckIcon,
  CircleXIcon,
  CircleAlertIcon,
} from "../icons";
import { commitSignatureLabel } from "./commit-signature-label";

export function commitSignatureTone(signature: CommitSignatureVerification | null | undefined) {
  if (
    signature?.status === "invalid" ||
    signature?.validity === "invalid" ||
    signature?.signerTrust === "distrusted" ||
    signature?.reasonCode === "revoked-key"
  )
    return "text-git-deleted";
  if (
    signature?.identityMismatch ||
    signature?.reasonCode === "expired-key" ||
    signature?.reasonCode === "expired-signature"
  )
    return "text-git-modified";
  if (signature && isVerifiedGitHubWebSignature(signature)) return "text-text-secondary";
  if (signature?.validity === "valid")
    return signature.signerTrust === "trusted" || signature.signerTrust === "local"
      ? "text-git-added"
      : "text-git-modified";
  switch (signature?.status) {
    case "verified":
      return "text-git-added";
    case "unsigned":
    case "unverified":
      return "text-git-modified";
    default:
      return "text-text-tertiary";
  }
}

export function CommitSignatureIcon({
  signature,
  verifying = false,
  focusable = true,
}: {
  signature: CommitSignatureVerification | null | undefined;
  verifying?: boolean;
  focusable?: boolean;
}) {
  const label =
    verifying || signature === undefined
      ? t("diff.commitDetails.checkingSignature")
      : signature
        ? commitSignatureLabel(signature)
        : t("diff.commitDetails.signatureUnverified");

  let Icon: typeof GitHubIcon | typeof CircleHelpIcon = CircleHelpIcon;
  if (
    signature?.status === "invalid" ||
    signature?.validity === "invalid" ||
    signature?.signerTrust === "distrusted" ||
    signature?.reasonCode === "revoked-key"
  )
    Icon = CircleXIcon;
  else if (
    signature?.identityMismatch ||
    signature?.reasonCode === "expired-key" ||
    signature?.reasonCode === "expired-signature"
  )
    Icon = CircleAlertIcon;
  else if (signature && isVerifiedGitHubWebSignature(signature)) Icon = GitHubIcon;
  else if (
    (signature?.validity === "valid" &&
      (signature.signerTrust === "trusted" || signature.signerTrust === "local")) ||
    (signature?.status === "verified" && signature.validity === undefined)
  )
    Icon = CircleCheckIcon;

  return (
    <span
      role="img"
      tabIndex={focusable ? 0 : undefined}
      aria-label={label}
      title={[label, signature?.signer, signature?.fingerprint ?? signature?.keyId]
        .filter(Boolean)
        .join("\n")}
      className={`flex size-3.5 shrink-0 items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-text ${commitSignatureTone(verifying ? null : signature)}`}
    >
      {verifying ? (
        <SpinnerIcon size={14} className="animate-spin-fast" aria-hidden="true" />
      ) : signature?.status === "unsigned" ? (
        <CircleDashedIcon size={14} aria-hidden="true" />
      ) : (
        <Icon size={Icon === GitHubIcon ? 12 : 14} aria-hidden="true" />
      )}
    </span>
  );
}
