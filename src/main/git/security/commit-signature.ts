import { redactDiagnostic } from "@shared/diagnostics";
import type {
  CommitSignatureFormat,
  CommitSignatureVerification,
} from "@shared/repository/repository-read";

export function commitSignatureFormat(object: string): CommitSignatureFormat | null {
  const headers = object.split("\n\n", 1)[0] ?? "";
  const signatures = headers.split("\n").filter((line) => /^gpgsig(?:-sha256)? /.test(line));

  if (!signatures.length) return null;
  if (signatures.some((line) => line.includes("-----BEGIN PGP SIGNATURE-----"))) return "openpgp";
  if (signatures.some((line) => line.includes("-----BEGIN SSH SIGNATURE-----"))) return "ssh";
  if (signatures.some((line) => line.includes("-----BEGIN SIGNED MESSAGE-----"))) return "x509";
  return "unknown";
}

function statusText(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseCommitVerification(
  format: CommitSignatureFormat,
  exitCode: number,
  output: string,
): CommitSignatureVerification {
  const diagnostics = redactDiagnostic(output)
    .trim()
    .slice(0, 64 * 1024);
  const records = diagnostics.split(/\r?\n/).flatMap((line) => {
    const match = /^\[GNUPG:\] ([A-Z_]+)(?: (.*))?$/.exec(line);
    return match ? [{ code: match[1]!, value: match[2] ?? "" }] : [];
  });
  const has = (code: string) => records.some((record) => record.code === code);
  const identity = records.find((record) =>
    ["GOODSIG", "BADSIG", "EXPSIG", "EXPKEYSIG", "REVKEYSIG"].includes(record.code),
  );
  const valid = records.find((record) => record.code === "VALIDSIG")?.value.split(" ");
  const trusts = new Set(
    records
      .filter((record) => record.code.startsWith("TRUST_"))
      .map((record) => record.code.slice(6).toLowerCase()),
  );
  const trust = ["never", "undefined", "marginal", "fully", "ultimate"].find((level) =>
    trusts.has(level),
  );
  const missingKey = records.find(
    (record) => record.code === "NO_PUBKEY" || record.code === "ERRSIG",
  );
  const keyId = (identity ?? missingKey)?.value.split(" ", 1)[0];
  const signer = identity ? statusText(identity.value.slice((keyId?.length ?? 0) + 1)) : "";
  const ssh = /^Good "git" signature(?: for (.+?))? with \S+ key (SHA256:\S+)$/m.exec(diagnostics);
  const validFingerprint =
    valid?.[0] && /^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/.test(valid[0])
      ? valid[0].toUpperCase()
      : undefined;
  const fingerprint = validFingerprint ?? ssh?.[2];
  const primaryFingerprint =
    valid?.[9] && /^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/.test(valid[9])
      ? valid[9].toUpperCase()
      : undefined;
  const trustLevel =
    trust === "undefined" ||
    trust === "never" ||
    trust === "marginal" ||
    trust === "fully" ||
    trust === "ultimate"
      ? trust
      : format === "ssh" && exitCode === 0
        ? "fully"
        : undefined;

  let status: CommitSignatureVerification["status"] = "unverified";
  let reasonCode: CommitSignatureVerification["reasonCode"] = "verification-error";

  if (
    has("BADSIG") ||
    (format === "ssh" &&
      /^Signature verification failed: (?:incorrect|invalid) signature/im.test(diagnostics))
  ) {
    status = "invalid";
    reasonCode = "bad-signature";
  } else if (
    has("REVKEYSIG") ||
    (format === "ssh" && /^(?:Key|Signing key).*revoked/im.test(diagnostics))
  ) {
    status = "invalid";
    reasonCode = "revoked-key";
  } else if (has("EXPSIG")) {
    reasonCode = "expired-signature";
  } else if (has("EXPKEYSIG")) {
    reasonCode = "expired-key";
  } else if (has("NO_PUBKEY")) {
    reasonCode = "missing-key";
  } else if (
    format === "ssh" &&
    /gpg\.ssh\.allowedSignersFile needs to be configured/i.test(diagnostics)
  ) {
    reasonCode = "missing-trust";
  } else if (format === "unknown") {
    reasonCode = "unsupported-format";
  } else if (
    trustLevel === "undefined" ||
    trustLevel === "never" ||
    (format === "ssh" && /^No principal matched[.!]?$/im.test(diagnostics))
  ) {
    reasonCode = "untrusted-key";
  } else if (exitCode === 0 && (validFingerprint || (format === "ssh" && ssh))) {
    if (trustLevel) {
      status = "verified";
      reasonCode = null;
    } else {
      reasonCode = "untrusted-key";
    }
  } else if (validFingerprint) {
    reasonCode = "untrusted-key";
  }

  const validity =
    reasonCode === "bad-signature"
      ? "invalid"
      : (validFingerprint || ssh) && reasonCode !== "missing-key"
        ? "valid"
        : "unknown";
  const signerTrust =
    trustLevel === "never"
      ? "distrusted"
      : trustLevel === "fully" || trustLevel === "ultimate"
        ? "local"
        : "unknown";

  return {
    validity,
    signerTrust,
    status,
    format,
    reasonCode,
    ...(signer || ssh?.[1] ? { signer: signer || ssh![1]! } : {}),
    ...(keyId ? { keyId } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(primaryFingerprint && primaryFingerprint !== fingerprint ? { primaryFingerprint } : {}),
    ...(trustLevel ? { trustLevel } : {}),
    diagnostics,
  };
}
