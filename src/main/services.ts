import { SignerRepository } from "./persistence/signer-repository";
import { SignerService } from "./repo/history/signer-service";
import { PublicKeyVerifier } from "./git/security/public-key-verifier";
import { PublicSigningKeys } from "./providers/public-signing-keys";
import { RepositoryTrustStore } from "./persistence/repository-trust-store";
import { RepositoryMemberships } from "./persistence/repository-memberships";
import { ProfileRepository } from "./persistence/profile-repository";
import { CommitSignatureRepository } from "./persistence/commit-signature-repository";
import { CommitSignatureService } from "./repo/history/commit-signature-service";
import { errorText } from "@shared/error-codes";
import { PACKAGE_MANAGER_NAMES, type InstallationInfo } from "@shared/application";
import { GitError } from "@shared/errors";
import { setLocale, t } from "@shared/i18n";
import { IPC_EVENTS } from "@shared/ipc";
import { updateFeedUrl, type UpdateCapability, type UpdatePlatform } from "@shared/updates";
import { app, net, powerMonitor } from "electron";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createVelopackUpdater, type VelopackUpdater } from "./application/velopack-updater";
import { detectInstallation } from "./application/installation";
import { HomebrewUpdater } from "./application/homebrew-updater";
import { checkReleaseFeed } from "./application/release-feed";
import { restartApplication } from "./application/restart";
import { prepareReleaseDataImport } from "./persistence/import-release-data";
import { clearDatabase } from "./persistence/reset-data";
import { WindowTrustPrompts } from "./application/window-trust-prompts";
import type { SshHostPrompt } from "@shared/identity/ssh";
import type { RepositoryTrustRequest } from "@shared/repository/repository";
import { UpdateService } from "./application/update-service";
import { AvatarCache } from "./avatars/avatar-cache";
import { createGitLabInsecureFetch } from "./providers/gitlab-insecure-fetch";
import { CredentialService } from "./credentials/credential-service";
import {
  bundledGitBinary,
  bundledGitEnvironment,
  bundledGitLocation,
} from "./git/execution/bundled-git";
import { resolveGitEngine, type GitEngine } from "./git/execution/git-engine";
import { NodeProcessRunner } from "./git/execution/node-process-runner";
import { ExternalMergeTool } from "./git/external-merge-tool";
import { GitService } from "./git/git-service";
import { GpgKeyService } from "./git/security/gpg-keys";
import { RepositoryExecutionInspector } from "./git/security/repository-execution";
import { RepositoryTrust } from "./git/security/repository-trust";
import { RepositoryVolumeIdentity } from "./git/security/repository-volume";
import { SshAgent } from "./git/security/ssh-agent";
import { SshHostTrustRunner } from "./git/security/ssh-host-trust";
import { IdentityManager } from "./identity/identity-manager";
import { ProfileService } from "./identity/profile-service";
import { ProfileSessions } from "./identity/profile-sessions";
import { beginUpdateInstall, broadcast } from "./ipc/transport";
import { OperationManager } from "./operations/operation-manager";
import { ContentRecoveryRepository } from "./persistence/content-recovery-repository";
import { openDatabase } from "./persistence/database";
import { FetchHistoryRepository } from "./persistence/fetch-history-repository";
import { ProviderAccountRepository } from "./persistence/provider-account-repository";
import { GitLabSelfHostedAccountRepository } from "./persistence/gitlab-self-hosted-account-repository";
import { IdentityRepository } from "./persistence/identity-repository";
import { OperationRepository } from "./persistence/operation-repository";
import { ProfileSessionRepository } from "./persistence/profile-session-repository";
import { SettingsRepository } from "./persistence/settings-repository";
import type { Database } from "./persistence/types";
import { WorkflowJournal } from "./persistence/workflow-journal";
import { GitLabAuth } from "./providers/gitlab-auth";
import { GitLabSelfHostedAuth } from "./providers/gitlab-self-hosted-auth";
import { GitHubAuth } from "./providers/github-auth";
import { HistoryRecoveryService } from "./repo/history/history-recovery-service";
import { HistoryReversalService } from "./repo/history/history-reversal-service";
import { RepositoryNavigationQueue } from "./repo/lifecycle/navigation";
import { RepositoryManager } from "./repo/lifecycle/repository-manager";
import { BackgroundFetchService } from "./repo/sync/background-fetch-service";
import { PullService } from "./repo/sync/pull-service";
import { RemoteService } from "./repo/sync/remote-service";
import { ConflictService } from "./repo/workflows/conflict-service";
import { RebaseService } from "./repo/workflows/rebase-service";
import { ReplayService } from "./repo/workflows/replay-service";
import { ResetService } from "./repo/workflows/reset-service";
import { StashService } from "./repo/workflows/stash-service";
import { WorkflowService } from "./repo/workflows/workflow-service";
import { RepositoryWriter } from "./repo/working-tree/repository-writer";
import { RepositoryReader } from "./repo/repository-reader";
import { KeychainSecretStore, vaultPathFor } from "./secrets/keychain-secret-store";
import type { SecretStore } from "./secrets/secret-store";
import { SshService } from "./ssh/ssh-service";

export interface Services {
  installation: InstallationInfo;
  updates: UpdateService;
  resetData(): Promise<void>;
  importReleaseData(): Promise<void>;
  cancelSignIns(): void;
  github: GitHubAuth;
  gitlab: GitLabAuth;
  gitlabSelfHosted: GitLabSelfHostedAuth;
  avatars: AvatarCache;
  backgroundFetch: BackgroundFetchService;
  pull: PullService;
  rebase: RebaseService;
  replay: ReplayService;
  reset: ResetService;
  historyReversal: HistoryReversalService;
  historyRecovery: HistoryRecoveryService;
  commitSignatures: CommitSignatureService;
  stashes: StashService;
  workflows: WorkflowService;
  conflicts: ConflictService;
  remotes: RemoteService;
  navigation: RepositoryNavigationQueue;
  db: Database;
  git: GitService;
  engine: GitEngine;
  identities: IdentityRepository;
  identity: IdentityManager;
  repositories: RepositoryManager;
  repositoryReader: RepositoryReader;
  writer: RepositoryWriter;
  secrets: SecretStore;
  ssh: SshService;
  sshHostTrust: WindowTrustPrompts<SshHostPrompt>;
  repositoryTrust: WindowTrustPrompts<Omit<RepositoryTrustRequest, "id">>;
  sshAgent: SshAgent;
  gpg: GpgKeyService;
  credentials: CredentialService;
  preferences: SettingsRepository;
  sessionStore: ProfileSessionRepository;
  sessions: ProfileSessions;
  profiles: ProfileService;
  operations: OperationManager;
}

export async function createServices(): Promise<Services> {
  const runner = new NodeProcessRunner();
  const db = openDatabase(join(app.getPath("userData"), "eda.db"));
  let sshAgent: SshAgent | undefined;

  try {
    const preferences = new SettingsRepository(db);
    const language = preferences.resolve("language").value;
    if (language !== "system") setLocale(language);

    const bundle = bundledGitLocation(
      app.isPackaged,
      resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      process.resourcesPath,
    );

    const engine = await resolveGitEngine(runner, {
      preferred: preferences.resolve("gitEngine").value,
      bundledPath: bundledGitBinary(bundle),
      bundledEnvironment: bundledGitEnvironment(bundle),
    });

    const operations = new OperationManager(new OperationRepository(db));
    // Git for Windows includes the OpenSSH/MSYS tools we need.
    const sshEnvironment =
      process.platform === "win32" ? { PATH: bundledGitEnvironment(bundle)["PATH"]! } : {};
    sshAgent = new SshAgent(preferences.resolve("sshAgent").value, "ssh-agent", sshEnvironment);
    await sshAgent.start();
    const transportEnvironment = Object.assign(sshAgent.environment, sshEnvironment);
    const sshHostTrust = new WindowTrustPrompts<SshHostPrompt>(IPC_EVENTS.sshHostTrustChanged);
    const transportRunner = new SshHostTrustRunner(runner, sshHostTrust.confirm);
    const neutralDirectory = join(app.getPath("userData"), "git-cwd");
    await mkdir(neutralDirectory, { recursive: true, mode: 0o700 });

    const repositoryTrust = new WindowTrustPrompts<Omit<RepositoryTrustRequest, "id">>(
      IPC_EVENTS.repositoryTrustChanged,
    );
    const trust = new RepositoryTrust(
      new RepositoryTrustStore(db),
      (path, reasons) => repositoryTrust.confirm({ path, ...(reasons && { reasons }) }),
      neutralDirectory,
      new RepositoryVolumeIdentity(runner),
      new RepositoryExecutionInspector(runner, engine, transportEnvironment),
    );

    const git = new GitService(transportRunner, engine, transportEnvironment, operations, trust);

    const identities = new IdentityRepository(db, preferences);
    const identity = new IdentityManager(identities, git, preferences);
    const repositories = new RepositoryManager(
      new RepositoryMemberships(db),
      git,
      identity,
      identities,
    );
    const secrets = await KeychainSecretStore.create(vaultPathFor(app.getPath("userData")));
    const ssh = new SshService(transportRunner, undefined, transportEnvironment, sshAgent);
    const credentials = new CredentialService(identities, secrets, ssh);
    const request: typeof fetch = (url, options) =>
      net.fetch(url instanceof URL ? url.href : url, options);
    const github = new GitHubAuth(new ProviderAccountRepository(db, "github"), secrets, request);
    const gitlab = new GitLabAuth(new ProviderAccountRepository(db, "gitlab"), secrets, request);

    const gitlabSelfHosted = new GitLabSelfHostedAuth(
      new GitLabSelfHostedAccountRepository(db),
      secrets,
      request,
      createGitLabInsecureFetch,
    );

    const providers = [github, gitlab, gitlabSelfHosted];

    const cancelSignIns = () => {
      for (const provider of providers) provider.cancelAll();
    };

    identity.onChange(cancelSignIns);
    const recovery = new ContentRecoveryRepository(db);
    const journal = new WorkflowJournal(db);

    const writer = new RepositoryWriter(
      git,
      repositories,
      identity,
      identities,
      operations,
      recovery,
      journal,
    );

    const sessionStore = new ProfileSessionRepository(db);
    const sessions = new ProfileSessions(identity, sessionStore);
    const profiles = new ProfileService(
      new ProfileRepository(db, identities, sessionStore),
      identities,
      identity,
      sessionStore,
      secrets,
    );
    const workflows = new WorkflowService(git, repositories, writer, identity, journal, recovery);

    const rebase = new RebaseService(
      git,
      repositories,
      writer,
      identity,
      workflows,
      journal,
      recovery,
    );

    const remotes = new RemoteService(
      git,
      repositories,
      writer,
      identity,
      identities,
      operations,
      new FetchHistoryRepository(db),
      github,
      gitlab,
      gitlabSelfHosted,
    );

    let suspended = false;

    powerMonitor.on("suspend", () => {
      suspended = true;
    });

    powerMonitor.on("resume", () => {
      suspended = false;
    });

    const backgroundFetch = new BackgroundFetchService(
      identity,
      sessionStore,
      preferences,
      repositories,
      remotes,
      () => ({ online: net.isOnline(), suspended }),
      (id) => broadcast(IPC_EVENTS.repositoryChanged, id),
    );

    const avatars = new AvatarCache(join(app.getPath("userData"), "cache", "avatars"), request);

    const platform: UpdatePlatform =
      process.platform === "win32" ? "win" : process.platform === "darwin" ? "osx" : "linux";
    const supportedArch = ["x64", "arm64"].includes(process.arch);

    const installation = await detectInstallation({
      packaged: app.isPackaged,
      executablePath: process.execPath,
      resourcesPath: process.resourcesPath,
    });

    const manager =
      installation.method === "homebrew"
        ? PACKAGE_MANAGER_NAMES.homebrew
        : installation.method === "system-package"
          ? PACKAGE_MANAGER_NAMES[installation.manager]
          : null;

    let capability: UpdateCapability =
      installation.method === "development"
        ? "development"
        : installation.method === "homebrew"
          ? "homebrew"
          : manager
            ? "managed"
            : "manual";
    let installedUpdater: VelopackUpdater | undefined;

    const initialFeedUrl = updateFeedUrl(
      platform,
      process.arch,
      preferences.resolve("includePrereleaseUpdates").value,
    );

    if (installation.method === "direct" && supportedArch) {
      try {
        installedUpdater = await createVelopackUpdater(
          initialFeedUrl,
          platform,
          process.arch,
          app.getVersion(),
          () => restartApplication({ relaunch: "external" }),
        );

        capability = "automatic";
      } catch {
        capability = "manual";
      }
    }

    const updates = new UpdateService({
      capability,
      reason: manager
        ? t("updates.managedBy", { manager })
        : installation.method === "unknown"
          ? t("main.services.installationMethodUnknown")
          : capability === "development"
            ? t("main.services.developmentBuildsAreNeverReplacedUseAnInstalled")
            : capability === "manual"
              ? t("main.services.useTheDownloadPageOrYourPackageManager")
              : null,
      platform,
      arch: process.arch,
      currentVersion: app.getVersion(),
      automaticChecks: () => preferences.resolve("automaticUpdateChecks").value,
      includePrereleases: () => preferences.resolve("includePrereleaseUpdates").value,
      checkRelease: (url) => checkReleaseFeed(url, platform, process.arch, request),
      ...(installation.method === "homebrew" && {
        homebrew: new HomebrewUpdater(
          runner,
          installation.executable,
          neutralDirectory,
          app.getVersion(),
          restartApplication,
        ),
      }),
      createDriver: (url) =>
        url === initialFeedUrl
          ? installedUpdater!
          : createVelopackUpdater(url, platform, process.arch, app.getVersion(), () =>
              restartApplication({ relaunch: "external" }),
            ),
      prepareInstall: async () => {
        const release = beginUpdateInstall();

        const rollback = () => {
          release();
          backgroundFetch.start();
        };

        try {
          await backgroundFetch.stop();

          if (operations.busy)
            throw new GitError({
              kind: "invalid-input",
              operation: t("operations.installUpdate"),
              message: errorText(
                "main.services.finishRunningGitOperationsBeforeInstallingAnUpdate",
              ),
            });

          await identity.serialize(async () => undefined);
          return rollback;
        } catch (error) {
          rollback();
          throw error;
        }
      },
    });

    const commitSignatures = new CommitSignatureService(
      git,
      repositories,
      new CommitSignatureRepository(db),
      new SignerService(
        new SignerRepository(db),
        new PublicKeyVerifier(runner, git, transportEnvironment),
        new PublicSigningKeys(request),
      ),
    );
    identity.onChange(() => commitSignatures.cancelAll());

    return {
      installation,
      updates,
      github,
      gitlab,
      gitlabSelfHosted,
      historyReversal: new HistoryReversalService(
        git,
        repositories,
        writer,
        workflows,
        journal,
        recovery,
      ),
      historyRecovery: new HistoryRecoveryService(git, repositories, writer, journal),
      repositoryReader: new RepositoryReader(git, repositories, (profileId) =>
        gitlabSelfHosted.status(profileId).accounts.map((account) => account.baseUrl),
      ),
      commitSignatures,
      backgroundFetch,
      pull: new PullService(git, repositories, writer, remotes, workflows, rebase, preferences),
      rebase,
      reset: new ResetService(git, repositories, writer, workflows, journal, recovery),
      replay: new ReplayService(git, repositories, writer, identity, workflows, journal, recovery),
      stashes: new StashService(git, repositories, writer, identity, workflows, recovery),
      workflows,
      conflicts: new ConflictService(
        git,
        repositories,
        writer,
        workflows,
        new ExternalMergeTool(runner, operations),
        preferences,
      ),
      remotes,
      avatars,
      cancelSignIns,
      async importReleaseData() {
        if (app.isPackaged || !process.env["VITE_DEV_SERVER_URL"])
          throw new GitError({
            kind: "invalid-input",
            operation: t("operations.importReleaseData"),
            message: errorText("main.appData.developmentOnly"),
          });

        const releasePath = join(app.getPath("appData"), "Eda");

        const release = beginUpdateInstall();
        try {
          await backgroundFetch.stop();
          if (operations.busy)
            throw new GitError({
              kind: "invalid-input",
              operation: t("operations.importReleaseData"),
              message: errorText("main.appData.finishOperations"),
            });
          await identity.serialize(async () => undefined);
          await prepareReleaseDataImport(releasePath, app.getPath("userData"));
          await restartApplication({ action: "import-release-data" });
        } catch (error) {
          release();
          backgroundFetch.start();
          throw error;
        }
      },
      async resetData() {
        await updates.discardDownload();
        operations.reset();
        await backgroundFetch.stop();

        try {
          await Promise.all(providers.map((provider) => provider.reset()));

          await identity.serialize(async () => {
            await avatars.clear();
            await secrets.clear();
            await rm(vaultPathFor(app.getPath("userData")), { force: true });
            await sshAgent!.reset();
            clearDatabase(db);
            sessions.clear();
            identity.notifyReset();
          });
        } finally {
          updates.refreshSchedule();
          backgroundFetch.start();
        }
      },
      navigation: new RepositoryNavigationQueue(),
      db,
      git,
      engine,
      identities,
      identity,
      repositories,
      writer,
      secrets,
      ssh,
      sshHostTrust,
      repositoryTrust,
      sshAgent,
      gpg: new GpgKeyService(runner, git, { ...engine.environment, ...transportEnvironment }),
      credentials,
      preferences,
      sessionStore,
      sessions,
      profiles,
      operations,
    };
  } catch (error) {
    await sshAgent?.stop();
    db.close();
    throw error;
  }
}
