import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GitService } from "@main/git/git-service";
import { buildGitEnvironment } from "@main/git/execution/environment";
import { resolveExecutable } from "@main/git/execution/executable";
import { NodeProcessRunner } from "@main/git/execution/node-process-runner";
import {
  commitSignatureFormat,
  parseCommitVerification,
} from "@main/git/security/commit-signature";
import { SshService } from "@main/ssh/ssh-service";
import { createTempRepo, resolveTestGitEngine } from "../../helpers/temp-repo";

const fingerprint = "A".repeat(40);
const valid = `[GNUPG:] VALIDSIG ${fingerprint} 2026-11-06 1793923200 0 4 0 22 8 00 ${fingerprint}`;
const good = `[GNUPG:] GOODSIG ${fingerprint.slice(-16)} Sample%20Author <sample@example.test>`;

function gpgFixturePath(path: string, executable: string, platform = process.platform): string {
  if (platform !== "win32" || !/\/usr\/bin\//i.test(executable.replaceAll("\\", "/"))) return path;

  return path
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

it.each([
  [
    "win32",
    "C:\\Program Files\\Git\\usr\\bin\\gpg.exe",
    "C:\\Users\\Runner\\gpg home",
    "/c/Users/Runner/gpg home",
  ],
  ["win32", "D:/Tools/Git/usr/bin/gpg.exe", "D:\\Temp\\public.asc", "/d/Temp/public.asc"],
  ["win32", "C:/Program Files/GnuPG/bin/gpg.exe", "C:\\Temp\\keyring", "C:\\Temp\\keyring"],
  ["linux", "/usr/bin/gpg", "/tmp/keyring", "/tmp/keyring"],
  ["darwin", "/opt/homebrew/bin/gpg", "/tmp/keyring", "/tmp/keyring"],
] as const)("uses paths understood by %s GPG at %s", (platform, executable, path, expected) => {
  expect(gpgFixturePath(path, executable, platform)).toBe(expected);
});

it("detects only signature headers, including alternate hash headers and supported formats", () => {
  expect(commitSignatureFormat("tree abc\n\ngpgsig -----BEGIN SSH SIGNATURE-----")).toBeNull();
  expect(commitSignatureFormat("gpgsig -----BEGIN PGP SIGNATURE-----\n body\n\nMessage")).toBe(
    "openpgp",
  );
  expect(
    commitSignatureFormat("gpgsig-sha256 -----BEGIN SSH SIGNATURE-----\n body\n\nMessage"),
  ).toBe("ssh");
  expect(commitSignatureFormat("gpgsig -----BEGIN SIGNED MESSAGE-----\n body\n\nMessage")).toBe(
    "x509",
  );
  expect(commitSignatureFormat("gpgsig unsupported\n\nMessage")).toBe("unknown");
});

it("requires a successful verifier result and trusted, valid signature evidence", () => {
  const output = `${good}\n${valid}\n[GNUPG:] TRUST_ULTIMATE 0 pgp`;
  expect(parseCommitVerification("openpgp", 0, output)).toMatchObject({
    status: "verified",
    reasonCode: null,
    signer: "Sample Author <sample@example.test>",
    fingerprint,
    trustLevel: "ultimate",
  });
  expect(parseCommitVerification("openpgp", 1, output).status).toBe("unverified");
  expect(parseCommitVerification("openpgp", 0, "[GNUPG:] TRUST_FULLY 0 pgp").status).toBe(
    "unverified",
  );
  expect(parseCommitVerification("x509", 0, output).status).toBe("verified");
  expect(parseCommitVerification("openpgp", 0, `${output}\n[GNUPG:] TRUST_UNDEFINED`).status).toBe(
    "unverified",
  );
  expect(
    parseCommitVerification("openpgp", 0, output.replace("Sample%20Author", "Invalid signature"))
      .status,
  ).toBe("verified");
});

it.each([
  ["BADSIG key Bad signer", "invalid", "bad-signature"],
  ["REVKEYSIG key Revoked signer", "invalid", "revoked-key"],
  ["EXPSIG key Expired signature", "unverified", "expired-signature"],
  ["EXPKEYSIG key Expired signer", "unverified", "expired-key"],
  ["NO_PUBKEY key", "unverified", "missing-key"],
  ["TRUST_UNDEFINED 0 pgp", "unverified", "untrusted-key"],
  ["TRUST_NEVER 0 pgp", "unverified", "untrusted-key"],
] as const)("preserves the meaning of verification status %s", (record, status, reasonCode) => {
  expect(
    parseCommitVerification("openpgp", 1, `${good}\n${valid}\n[GNUPG:] ${record}`),
  ).toMatchObject({
    status,
    reasonCode,
  });
});

it("keeps unsupported and malformed output unverified and redacts sensitive diagnostics", () => {
  expect(parseCommitVerification("unknown", 0, "Good signature")).toMatchObject({
    status: "unverified",
    reasonCode: "unsupported-format",
  });
  const result = parseCommitVerification(
    "openpgp",
    0,
    "[GNUPG:] VALIDSIG bad-data\n[GNUPG:] TRUST_FULLY\nAuthorization: Bearer secret",
  );
  expect(result.status).toBe("unverified");
  expect(result.diagnostics).not.toContain("secret");
});

it("verifies real SSH signatures, rejects tampering and reports missing trust or tools without losing commit details", async () => {
  const repo = await createTempRepo();

  try {
    await repo.writeFile("file.txt", "base\n");
    await repo.commit("Unsigned");
    const unsigned = (await repo.run(["rev-parse", "HEAD"])).trim();
    expect((await repo.git.inspectCommit(repo.path, unsigned)).signature.status).toBe("unsigned");

    const key = join(repo.home, "signing-key");
    await new SshService(new NodeProcessRunner(), repo.home).generateKey({
      path: key,
      type: "ed25519",
      comment: "Eda",
    });
    await repo.run([
      "-c",
      "gpg.format=ssh",
      "-c",
      `user.signingkey=${key}`,
      "commit",
      "--allow-empty",
      "-S",
      "-m",
      "Signed commit",
    ]);
    const oid = (await repo.run(["rev-parse", "HEAD"])).trim();

    expect((await repo.git.inspectCommit(repo.path, oid)).signature).toMatchObject({
      status: "unverified",
      format: "ssh",
      reasonCode: "missing-trust",
    });

    const allowed = join(repo.home, "allowed-signers");
    await writeFile(allowed, `test@eda.invalid ${await readFile(`${key}.pub`, "utf8")}`);
    await repo.run(["config", "gpg.ssh.allowedSignersFile", allowed]);
    const before = await repo.run(["show-ref"]);
    const verified = await repo.git.inspectCommit(repo.path, oid);
    expect(verified.signature).toMatchObject({
      status: "verified",
      format: "ssh",
      signer: "test@eda.invalid",
      trustLevel: "fully",
    });
    expect(verified.signature.fingerprint).toMatch(/^SHA256:/);
    expect(await repo.git.commitSignature(repo.path, oid)).toEqual(verified.signature);
    expect(await repo.run(["show-ref"])).toBe(before);
    expect(await repo.run(["status", "--porcelain"])).toBe("");

    const object = await repo.run(["cat-file", "commit", oid]);
    const tampered = await repo.git.exec(["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: repo.path,
      operation: "tamper fixture",
      stdin: object.replace("Signed commit", "Altered commit"),
    });
    expect((await repo.git.inspectCommit(repo.path, tampered.stdout.trim())).signature.status).toBe(
      "invalid",
    );

    await writeFile(allowed, "");
    expect((await repo.git.inspectCommit(repo.path, oid)).signature).toMatchObject({
      status: "unverified",
      reasonCode: "untrusted-key",
    });

    await writeFile(allowed, `test@eda.invalid ${await readFile(`${key}.pub`, "utf8")}`);
    await repo.run(["config", "gpg.ssh.revocationFile", `${key}.pub`]);
    const revoked = (await repo.git.inspectCommit(repo.path, oid)).signature;
    expect(revoked, revoked.diagnostics).toMatchObject({
      status: "invalid",
      reasonCode: "bad-signature",
    });
    await repo.run(["config", "--unset", "gpg.ssh.revocationFile"]);

    await repo.run(["config", "gpg.ssh.program", join(repo.home, "missing-verifier")]);
    const unavailable = await repo.git.inspectCommit(repo.path, oid);
    expect(unavailable.commit.oid).toBe(oid);
    expect(unavailable.signature.status).toBe("unverified");
  } finally {
    await repo.cleanup();
  }
});

it("verifies real GPG signatures and distinguishes missing and untrusted public keys from bad signatures", async () => {
  const repo = await createTempRepo();
  const trusted = join(repo.home, "gpg-trusted");
  const other = join(repo.home, "gpg-other");
  const homes = [trusted, other];
  let gpgExecutable: string | undefined;

  try {
    gpgExecutable = await resolveExecutable(process.env["EDA_GPG"] ?? "gpg", buildGitEnvironment());
    const toolPath = (path: string) => gpgFixturePath(path, gpgExecutable!);
    const gpg = (home: string, args: string[]) =>
      execFileSync(gpgExecutable!, ["--homedir", toolPath(home), "--batch", ...args], {
        encoding: "utf8",
        stdio: "pipe",
      });

    for (const home of homes) await mkdir(home, { mode: 0o700 });
    gpg(trusted, [
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      "",
      "--quick-generate-key",
      "Eda <test@eda.invalid>",
      "ed25519",
      "sign",
      "0",
    ]);
    const key = gpg(trusted, ["--with-colons", "--list-secret-keys"])
      .split("\n")
      .find((line) => line.startsWith("fpr:"))!
      .split(":")[9]!;
    const runner = new NodeProcessRunner();
    const engine = await resolveTestGitEngine();
    const service = (home: string) =>
      new GitService(runner, engine, {
        GNUPGHOME: toolPath(home),
        GIT_CONFIG_GLOBAL: join(repo.home, ".gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
      });
    const git = service(trusted);
    await repo.run(["config", "gpg.openpgp.program", gpgExecutable.replaceAll("\\", "/")]);
    await repo.writeFile("file.txt", "base\n");
    await repo.commit("Initial");
    await git.exec(
      [
        "-c",
        "gpg.format=openpgp",
        "-c",
        `user.signingkey=${key}`,
        "commit",
        "--allow-empty",
        "-S",
        "-m",
        "GPG signed commit",
      ],
      { cwd: repo.path, operation: "sign fixture" },
    );
    const oid = (await repo.run(["rev-parse", "HEAD"])).trim();
    expect((await git.inspectCommit(repo.path, oid)).signature).toMatchObject({
      status: "verified",
      format: "openpgp",
      fingerprint: key,
      trustLevel: "ultimate",
    });

    const unknown = service(other);
    expect((await unknown.inspectCommit(repo.path, oid)).signature).toMatchObject({
      status: "unverified",
      reasonCode: "missing-key",
    });
    const publicKey = join(repo.home, "public.asc");
    await writeFile(publicKey, gpg(trusted, ["--armor", "--export", key]));
    gpg(other, ["--import", toolPath(publicKey)]);
    expect((await unknown.inspectCommit(repo.path, oid)).signature).toMatchObject({
      status: "unverified",
      reasonCode: "untrusted-key",
    });

    const object = await repo.run(["cat-file", "commit", oid]);
    const tampered = await git.exec(["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: repo.path,
      operation: "tamper fixture",
      stdin: object.replace("GPG signed commit", "Changed signed commit"),
    });
    expect((await git.inspectCommit(repo.path, tampered.stdout.trim())).signature.status).toBe(
      "invalid",
    );
  } finally {
    for (const home of homes) {
      try {
        if (!gpgExecutable) continue;
        const gpgconf = join(
          dirname(gpgExecutable),
          process.platform === "win32" ? "gpgconf.exe" : "gpgconf",
        );
        execFileSync(
          gpgconf,
          ["--homedir", gpgFixturePath(home, gpgExecutable), "--kill", "gpg-agent"],
          { stdio: "pipe" },
        );
      } catch {}
    }
    await repo.cleanup();
  }
});
