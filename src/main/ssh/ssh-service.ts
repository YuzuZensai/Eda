import { nullIfFileMissing } from "../filesystem/missing-file";
import { errorText } from "@shared/error-codes";
import { AppError, GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type {
  AgentStatus,
  ConnectionTestResult,
  GenerateKeyRequest,
  SshKey,
  UnlockKeyRequest,
} from "@shared/identity/ssh";
import { constants, existsSync } from "node:fs";
import { copyFile, lstat, mkdtemp, readdir, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { readRegularFile } from "../filesystem/read-regular-file";
import { basename, dirname, join } from "node:path";
import { buildGitEnvironment, SSH_HOST_TRUST_OPTIONS } from "../git/execution/environment";
import { type ProcessRunner, ProcessSpawnError } from "../git/execution/process-runner";
import type { SshAgent } from "../git/security/ssh-agent";
import { assertNotOptionLike, parseValidSshDestination } from "../git/validation";
import {
  isAgentUnreachable,
  isEncryptedFromProbe,
  parseAgentList,
  parseAuthenticatedUser,
  parseKeyLine,
  parsePublicKey,
} from "./parse";

export class SshService {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly home: string = homedir(),
    private readonly baseEnv: Readonly<Record<string, string>> = {},
    private readonly agent?: Pick<SshAgent, "source" | "unavailableReason">,
  ) {}

  private get sshDir(): string {
    return join(this.home, ".ssh");
  }

  async discoverKeys(): Promise<SshKey[]> {
    let entries: string[];

    try {
      entries = await readdir(this.sshDir);
    } catch {
      return [];
    }

    const candidates = entries
      .filter((name) => name.endsWith(".pub"))
      .map((name) => name.slice(0, -4))
      .filter((name) => entries.includes(name));

    const agent = await this.getAgentStatus();
    const loaded = new Set(agent.available ? agent.keys.map((k) => k.fingerprint) : []);

    const keys = await Promise.all(
      candidates.map((name) => this.describeKey(join(this.sshDir, name), loaded)),
    );

    return keys.filter((key): key is SshKey => key !== undefined);
  }

  async importKey(privateKeyPath: string): Promise<SshKey> {
    assertNotOptionLike(privateKeyPath, t("operations.importSshKey"), t("main.sshService.keyPath"));

    if (!existsSync(privateKeyPath)) {
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.importSshKey"),
        message: errorText("main.ssh.sshService.thereIsNoFileAt", {
          privateKeyPath: privateKeyPath,
        }),
        suggestedAction: errorText(
          "main.ssh.sshService.chooseThePrivateKeyFileWhichIsTheOneWithoutThePubExtension",
        ),
      });
    }

    if (privateKeyPath.endsWith(".pub")) {
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.importSshKey"),
        message: errorText("main.ssh.sshService.thatIsAPublicKey"),
        suggestedAction: errorText(
          "main.ssh.sshService.chooseThePrivateKeyInsteadWhichHasTheSameNameWithoutPub",
        ),
      });
    }

    const agent = await this.getAgentStatus();
    const loaded = new Set(agent.available ? agent.keys.map((k) => k.fingerprint) : []);
    const key = await this.describeKey(privateKeyPath, loaded);

    if (!key) {
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.importSshKey"),
        message: errorText("main.ssh.sshService.edaCouldNotReadAsAnSshKey", {
          value1: basename(privateKeyPath),
        }),
        suggestedAction: errorText(
          "main.ssh.sshService.checkThatItIsAnOpenSshPrivateKeyAndThatItsPubFileIsBesideIt",
        ),
      });
    }

    return key;
  }

  async generateKey(request: GenerateKeyRequest): Promise<SshKey> {
    assertNotOptionLike(request.path, t("operations.generateSshKey"), t("main.sshService.keyPath"));
    assertNotOptionLike(
      request.comment,
      t("operations.generateSshKey"),
      t("main.sshService.comment"),
    );

    if (
      /[\x00-\x1f\x7f]/.test(request.comment) ||
      (request.type === "rsa" && ![2048, 3072, 4096].includes(request.bits ?? 4096))
    )
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.generateSshKey"),
        message: errorText("main.sshHandlers.invalidKeyParameters"),
      });
    const publicPath = `${request.path}.pub`;
    if (
      (await lstat(request.path).catch(nullIfFileMissing)) ||
      (await lstat(publicPath).catch(nullIfFileMissing))
    ) {
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.generateSshKey"),
        message: errorText("main.ssh.sshService.aKeyAlreadyExistsAt", { path: request.path }),
        suggestedAction: errorText(
          "main.ssh.sshService.chooseADifferentNameEdaWillNotOverwriteAnExistingKey",
        ),
      });
    }

    const staging = await mkdtemp(join(dirname(request.path), ".eda-key-"));
    const temporary = join(staging, "key");
    try {
      const args = ["-t", request.type, "-f", temporary, "-C", request.comment, "-N", "", "-q"];

      if (request.type === "rsa") {
        args.push("-b", String(request.bits ?? 4096));
      }

      const result = await this.run("ssh-keygen", args, t("operations.generateSshKey"));

      if (result.exitCode !== 0) {
        throw new GitError({
          kind: "unknown",
          operation: t("operations.generateSshKey"),
          message: errorText("main.ssh.sshService.sshKeygenCouldNotCreateTheKey"),
          suggestedAction: errorText("main.ssh.sshService.checkThatTheFolderExistsAndIsWritable"),
          exitCode: result.exitCode,
          rawStderr: result.stderr,
        });
      }

      await copyFile(temporary, request.path, constants.COPYFILE_EXCL);
      try {
        await copyFile(`${temporary}.pub`, publicPath, constants.COPYFILE_EXCL);
      } catch (error) {
        await unlink(request.path);
        throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return this.importKey(request.path);
  }

  async getAgentStatus(): Promise<AgentStatus> {
    const source = this.agent?.source ?? "system";
    if (this.agent?.unavailableReason)
      return { available: false, source, reason: this.agent.unavailableReason };
    const result = await this.run("ssh-add", ["-l"], t("operations.readSshAgent"));
    const output = `${result.stdout}${result.stderr}`;

    if (result.exitCode === 2 || isAgentUnreachable(output)) {
      return {
        available: false,
        source,
        reason:
          source === "builtin"
            ? t("main.ssh.sshService.edaSBuiltInSshAgentIsUnavailableRestartEdaToUnlockKeys")
            : t("main.ssh.sshService.noSystemSshAgentIsReachableStartOne"),
      };
    }

    return { available: true, source, keys: parseAgentList(result.stdout) };
  }

  async unlockKey(request: UnlockKeyRequest, passphrase: string): Promise<AgentStatus> {
    assertNotOptionLike(
      request.keyPath,
      t("operations.unlockSshKey"),
      t("main.sshService.keyPath"),
    );

    const agent = await this.getAgentStatus();

    if (!agent.available) {
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.unlockSshKey"),
        message: errorText("errors.operationBlocked", { reason: agent.reason }),
        suggestedAction: errorText("main.ssh.sshService.checkTheSshAgentSelectionInTheGit"),
      });
    }

    const args: string[] = [];

    if (request.lifetimeSeconds !== undefined) {
      args.push("-t", String(request.lifetimeSeconds));
    }

    args.push(request.keyPath);

    const askpass = await createAskpassScript(passphrase);

    try {
      const result = await this.run("ssh-add", args, t("operations.unlockSshKey"), {
        askpassPath: askpass.path,
      });

      if (result.exitCode !== 0) {
        throw new GitError({
          kind: "auth-failed",
          operation: t("operations.unlockSshKey"),
          message: errorText("main.ssh.sshService.thatPassphraseDidNotUnlockTheKey"),
          suggestedAction: errorText("main.ssh.sshService.checkThePassphraseAndTryAgain"),
          exitCode: result.exitCode,
        });
      }
    } finally {
      await askpass.cleanup();
    }

    return this.getAgentStatus();
  }

  async lockKey(keyPath: string): Promise<AgentStatus> {
    assertNotOptionLike(keyPath, t("operations.lockSshKey"), t("main.sshService.keyPath"));
    await this.run("ssh-add", ["-d", keyPath], t("operations.lockSshKey"));
    return this.getAgentStatus();
  }

  async testConnection(host: string, keyPath: string): Promise<ConnectionTestResult> {
    const parsedHost = parseValidSshDestination(host, t("operations.testSshConnection"));

    assertNotOptionLike(keyPath, t("operations.testSshConnection"), t("main.sshService.keyPath"));

    const destinationArgs = [
      ...(parsedHost.port !== undefined ? ["-p", String(parsedHost.port)] : []),
      parsedHost.destination,
    ];
    const result = await this.run(
      "ssh",
      [
        "-T",
        "-i",
        keyPath,
        "-o",
        "IdentitiesOnly=yes",
        ...(this.agent?.source === "builtin" ? ["-o", "IdentityAgent=SSH_AUTH_SOCK"] : []),
        ...SSH_HOST_TRUST_OPTIONS,
        "-o",
        "ConnectTimeout=10",
        ...destinationArgs,
      ],
      t("operations.testSshConnection"),
      { timeoutMs: 330_000, hostTrust: true },
    );

    const output = `${result.stdout}${result.stderr}`;
    if (/remote host identification has changed|host key for .+ has changed/i.test(output)) {
      return {
        status: "host-key-changed",
        reachable: false,
        message: t("main.ssh.sshService.theSavedHostKeyForHasChangedStop", { host: host }),
      };
    }

    if (/no .+ host key is known/i.test(output)) {
      return {
        status: "host-key-unknown",
        reachable: false,
        message: t("main.ssh.sshService.theServerIdentityForHasNotBeenTrusted", { host: host }),
      };
    }

    if (/host key verification failed/i.test(output)) {
      return {
        status: "host-key-unverified",
        reachable: false,
        message: t("main.ssh.sshService.sshCouldNotVerifyTheServerIdentity", { host: host }),
      };
    }

    const authenticatedAs = parseAuthenticatedUser(output);

    if (authenticatedAs) {
      return {
        status: "authenticated",
        reachable: true,
        authenticatedAs,
        message: t("main.ssh.sshService.authenticatedToAs", {
          host: host,
          authenticatedAs: authenticatedAs,
        }),
      };
    }

    if (/permission denied/i.test(output)) {
      return {
        status: "key-rejected",
        reachable: true,
        message: t("main.ssh.sshService.refusedThisKeyItMayNotBeRegisteredOnThatAccount", {
          host: host,
        }),
      };
    }

    if (/could not resolve hostname|connection timed out|connection refused/i.test(output)) {
      return {
        status: "unreachable",
        reachable: false,
        message: t("main.ssh.sshService.couldNotReach", { host: host }),
      };
    }

    return {
      status: result.exitCode === 0 ? "authenticated" : "failed",
      reachable: result.exitCode === 0,
      message:
        result.exitCode === 0
          ? t("main.ssh.sshService.connectedTo", { host: host })
          : t("main.ssh.sshService.didNotAcceptThisKey", { host: host }),
    };
  }

  private async describeKey(
    privateKeyPath: string,
    loadedFingerprints: Set<string>,
  ): Promise<SshKey | undefined> {
    if (basename(privateKeyPath).startsWith("-")) return undefined;

    const publicKeyPath = `${privateKeyPath}.pub`;

    if (!existsSync(publicKeyPath)) return undefined;

    try {
      const info = await stat(privateKeyPath);
      if (!info.isFile()) return undefined;
    } catch {
      return undefined;
    }

    const publicKeyContents = await readRegularFile(
      publicKeyPath,
      64 * 1024,
      () =>
        new AppError(
          errorText("main.ssh.sshService.edaCouldNotReadAsAnSshKey", {
            value1: basename(publicKeyPath),
          }),
        ),
    ).then(
      ({ bytes }) => bytes.toString("utf8"),
      () => undefined,
    );

    if (publicKeyContents === undefined) return undefined;

    const parsedPublicKey = parsePublicKey(publicKeyContents);

    if (!parsedPublicKey) return undefined;

    const fingerprintResult = await this.run(
      "ssh-keygen",
      ["-l", "-f", publicKeyPath],
      t("operations.readSshKey"),
    );
    const parsedFingerprint = parseKeyLine(fingerprintResult.stdout);

    if (!parsedFingerprint) return undefined;

    const probe = await this.run(
      "ssh-keygen",
      ["-y", "-f", privateKeyPath, "-P", ""],
      t("operations.checkSshKey"),
    );
    const encrypted = isEncryptedFromProbe(probe.stdout, probe.stderr);

    if (probe.exitCode !== 0 && !encrypted) return undefined;

    return {
      path: privateKeyPath,
      publicKeyPath,
      type: parsedFingerprint.type,
      bits: parsedFingerprint.bits,
      fingerprint: parsedFingerprint.fingerprint,
      comment: parsedFingerprint.comment || parsedPublicKey.comment,
      publicKey: parsedPublicKey.publicKey,
      encrypted,
      loadedInAgent: loadedFingerprints.has(parsedFingerprint.fingerprint),
    };
  }

  private async run(
    executable: string,
    args: readonly string[],
    operation: string,
    envOptions: { askpassPath?: string; timeoutMs?: number; hostTrust?: boolean } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), envOptions.timeoutMs ?? 30_000);

    try {
      const result = await this.runner.run({
        executable:
          executable === "ssh" && this.baseEnv["EDA_SSH_EXECUTABLE"]
            ? this.baseEnv["EDA_SSH_EXECUTABLE"]
            : executable,
        args,
        signal: controller.signal,
        env: buildGitEnvironment({
          ...(envOptions.askpassPath !== undefined && { askpassPath: envOptions.askpassPath }),
          overrides: {
            ...this.baseEnv,
            HOME: this.home,
            ...(envOptions.hostTrust && { EDA_SSH_HOST_TRUST: "1" }),
          },
        }),
      });

      if (result.cancelled) {
        throw new GitError({
          kind: "network-failed",
          operation,
          message: errorText("main.ssh.sshService.didNotRespondAndWasStopped", {
            executable: executable,
          }),
          suggestedAction: errorText(
            "main.ssh.sshService.tryAgainIfItKeepsHappeningCheckYourSshAgentAndConfiguration",
          ),
        });
      }

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      };
    } catch (error) {
      if (error instanceof ProcessSpawnError) {
        throw new GitError({
          kind: "git-not-found",
          operation,
          message: errorText("main.ssh.sshService.edaCouldNotRun", { executable: executable }),
          suggestedAction: errorText(
            "main.ssh.sshService.checkThatOpenSshIsInstalledAndThatIsOnYourPath",
            {
              executable: executable,
            },
          ),
        });
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function createAskpassScript(
  passphrase: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const { writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");

  const dir = await mkdtemp(join(tmpdir(), "eda-askpass-"));
  const isWindows = process.platform === "win32";
  const scriptPath = join(dir, isWindows ? "askpass.bat" : "askpass.sh");
  const dataPath = join(dir, "passphrase");
  const script = isWindows
    ? '@echo off\r\nsetlocal DisableDelayedExpansion\r\nif exist "%~dp0asked" exit /b 1\r\ntype nul > "%~dp0asked"\r\ntype "%~dp0passphrase"\r\n'
    : '#!/bin/sh\ncd -- "${0%/*}" || exit 1\n(set -C; : > asked) 2>/dev/null || exit 1\nexec /bin/cat passphrase\n';
  try {
    await writeFile(dataPath, passphrase, { mode: 0o600, flag: "wx" });
    await writeFile(scriptPath, script, { mode: 0o700, flag: "wx" });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    path: scriptPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
