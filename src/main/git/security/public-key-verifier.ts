import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t } from "@shared/i18n";
import type { CommitSignatureVerification } from "@shared/repository/repository-read";
import { buildGitEnvironment } from "../execution/environment";
import type { ProcessRunner } from "../execution/process-runner";
import type { GitService } from "../git-service";
import { parseCommitVerification } from "./commit-signature";
import { keyError, PUBLIC_KEY_LIMIT } from "../../providers/public-signing-keys";

// Keep the signed bytes unchanged when removing the signature header.
export function splitCommitSignature(object: string) {
  const end = object.indexOf("\n\n");
  if (end < 0) throw keyError();
  const lines = object.slice(0, end).split("\n");
  const payload: string[] = [];
  const signature: string[] = [];
  let collecting = false;
  for (const line of lines) {
    if (/^gpgsig(?:-sha256)? /.test(line)) {
      if (signature.length) throw keyError();
      signature.push(line.slice(line.indexOf(" ") + 1));
      collecting = true;
    } else if (collecting && line.startsWith(" ")) signature.push(line.slice(1));
    else {
      collecting = false;
      payload.push(line);
    }
  }
  if (!signature.length) throw keyError();
  return {
    payload: payload.join("\n") + object.slice(end),
    signature: signature.join("\n") + "\n",
  };
}

export class PublicKeyVerifier {
  private active = 0;
  constructor(
    private readonly runner: ProcessRunner,
    private readonly git: Pick<GitService, "exec" | "readConfig">,
    private readonly environment: Readonly<Record<string, string>> = {},
  ) {}

  async verify(
    path: string,
    oid: string,
    armoredKey: string | null | undefined,
    signal: AbortSignal,
  ) {
    if (this.active >= 4 || signal.aborted) throw keyError();
    this.active++;
    try {
      return await this.verifyIsolated(path, oid, armoredKey, signal);
    } finally {
      this.active--;
    }
  }

  private async verifyIsolated(
    path: string,
    oid: string,
    armoredKey: string | null | undefined,
    signal: AbortSignal,
  ): Promise<{
    signature: CommitSignatureVerification;
    armoredKey: string;
  }> {
    const executable =
      (await this.git.readConfig("gpg.openpgp.program", { scope: "global" })) ??
      (await this.git.readConfig("gpg.program", { scope: "global" })) ??
      "gpg";
    const directory = await mkdtemp(join(tmpdir(), "eda-verify-"));
    const env = buildGitEnvironment({
      overrides: {
        ...this.environment,
        ...(armoredKey === undefined ? {} : { GNUPGHOME: "." }),
      },
    });
    const run = async (executable: string, args: string[], stdin?: string | Uint8Array) => {
      const result = await this.runner.run({
        executable,
        args,
        cwd: directory,
        env,
        signal,
        ...(stdin === undefined ? {} : { stdin }),
        maxStdoutBytes: PUBLIC_KEY_LIMIT,
        maxStderrBytes: 64 * 1024,
      });
      if (result.cancelled || result.outputLimitExceeded) throw keyError();
      return result;
    };
    const gpg = (args: string[], stdin?: string | Uint8Array) =>
      run(
        executable,
        [
          ...(armoredKey === undefined ? [] : ["--no-options"]),
          "--no-autostart",
          ...(armoredKey === undefined ? [] : ["--homedir", "."]),
          "--batch",
          "--no-tty",
          "--no-auto-key-retrieve",
          "--no-auto-key-import",
          "--auto-key-locate",
          "clear",
          ...args,
        ],
        stdin,
      );
    try {
      const object = await this.git.exec(["cat-file", "commit", oid], {
        cwd: path,
        operation: t("operations.verifyCommitSignature"),
        signal,
        maxStdoutBytes: 1024 * 1024,
      });
      const { payload, signature } = splitCommitSignature(object.stdoutBytes.toString("latin1"));
      const signaturePath = "signature";
      await writeFile(join(directory, signaturePath), signature, { mode: 0o600 });
      if (armoredKey === null) {
        if (!signature.startsWith("-----BEGIN SSH SIGNATURE-----")) throw keyError();
        const result = await run(
          "ssh-keygen",
          ["-Y", "check-novalidate", "-n", "git", "-s", signaturePath],
          Buffer.from(payload, "latin1"),
        );
        return {
          signature: {
            ...parseCommitVerification(
              "ssh",
              result.exitCode,
              `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`,
            ),
            signerTrust: "unknown",
            trustLevel: "undefined",
          },
          armoredKey: "",
        };
      }
      if (armoredKey === undefined) {
        const result = await gpg(
          ["--status-fd", "1", "--verify", signaturePath, "-"],
          Buffer.from(payload, "latin1"),
        );
        return {
          signature: parseCommitVerification(
            "openpgp",
            result.exitCode,
            `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`,
          ),
          armoredKey: "",
        };
      }
      if (
        Buffer.byteLength(armoredKey) > PUBLIC_KEY_LIMIT ||
        !armoredKey.trimStart().startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----") ||
        armoredKey.includes("PRIVATE KEY")
      )
        throw keyError();
      const preview = await gpg(
        ["--with-colons", "--import-options", "show-only", "--dry-run", "--import"],
        armoredKey,
      );
      if (preview.exitCode !== 0 || /^(?:sec|ssb):/m.test(preview.stdout.toString("utf8")))
        throw keyError();
      const imported = await gpg(["--import-options", "import-minimal", "--import"], armoredKey);
      if (imported.exitCode !== 0) throw keyError();
      const result = await gpg(
        ["--status-fd", "1", "--verify", signaturePath, "-"],
        Buffer.from(payload, "latin1"),
      );
      const verification = parseCommitVerification(
        "openpgp",
        result.exitCode,
        `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`,
      );
      if (verification.validity !== "valid" || !verification.fingerprint) throw keyError();
      const exported = await gpg([
        "--armor",
        "--export",
        verification.primaryFingerprint ?? verification.fingerprint,
      ]);
      if (exported.exitCode !== 0 || !exported.stdout.length) throw keyError();
      return { signature: verification, armoredKey: exported.stdout.toString("utf8") };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
