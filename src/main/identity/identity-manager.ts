import { ERROR_CODE, ERROR_MESSAGE_KEYS, errorText } from "@shared/error-codes";
import { AppError, GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type {
  EffectiveIdentityCheck,
  Identity,
  IdentityDraft,
  IdentitySwitchReport,
  IdentitySwitchStep,
} from "@shared/identity/identity";
import { isCommitIdentity, profileGitConfig } from "@shared/identity/identity";
import { commitConfigKeys, type ProfileGitInspection } from "@shared/identity/profile-session";
import { existsSync } from "node:fs";
import type { GitService } from "../git/git-service";
import type { IdentityRepository } from "../persistence/identity-repository";
import type { SettingsRepository } from "../persistence/settings-repository";

export interface OperationIdentity {
  identityId: string;
  identityName: string;
  sshKeyPath?: string;
  gitName: string;
  gitEmail: string;
  signing: Identity["signing"];
  gitExecutable: string;
  gitVersion: string;
}

export class IdentityManager {
  private queue: Promise<unknown> = Promise.resolve();

  private listeners = new Set<(identity: Identity | null) => void>();

  constructor(
    private readonly identities: IdentityRepository,
    private readonly git: GitService,
    private readonly preferences?: Pick<SettingsRepository, "resolve">,
  ) {}

  onChange(listener: (identity: Identity | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notifyReset(): void {
    this.emit(null);
  }

  getActive(): Identity | null {
    const id = this.identities.getActiveId();
    return id ? (this.identities.findById(id) ?? null) : null;
  }

  async inspectGit(path?: string): Promise<ProfileGitInspection> {
    const active = this.getActive();

    if (!active)
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.inspectGitConfiguration"),
        message: errorText("main.requestErrors.thatIdentityNoLongerExists"),
      });

    const keys = commitConfigKeys("all");
    const [global, repository, local] = await Promise.all([
      Promise.all(keys.map((key) => this.git.inspectConfig(key, { scope: "global" }))),
      path ? Promise.all(keys.map((key) => this.git.inspectConfig(key, { cwd: path }))) : null,
      path ? this.git.localConfigKeys(path) : null,
    ]);

    return {
      profileId: active.id,
      global,
      repository,
      localOverrides: local?.filter((key) => keys.includes(key)) ?? null,
    };
  }

  serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async setActive(id: string): Promise<IdentitySwitchReport> {
    return this.serialize(async () => this.activate(this.requireIdentity(id)));
  }

  reapplyGlobal(id: string): Promise<void> {
    return this.serialize(async () => {
      if (this.getActive()?.id !== id)
        throw new GitError({
          kind: "invalid-input",
          operation: t("operations.applyGlobalGitSettings"),
          message: errorText(
            "main.identity.identityManager.theActiveProfileChangedReviewItsGitSettingsBeforeApplyingThem",
          ),
        });

      if (!(this.preferences?.resolve("syncGlobalGitConfig", { profileId: id }).value ?? true))
        throw new GitError({
          kind: "invalid-input",
          operation: t("operations.applyGlobalGitSettings"),
          message: errorText(
            "main.identity.identityManager.globalGitSynchronizationIsDisabledForThisProfile",
          ),
        });

      await this.activate(this.requireIdentity(id));
    });
  }

  forRepository(repositoryId: string, profile: Identity): Identity {
    const override = this.preferences?.resolve("repositoryCommitIdentity", {
      profileId: profile.id,
      repositoryId,
    }).value;

    const identity = override
      ? { ...profile, gitName: override.name, gitEmail: override.email }
      : profile;

    this.assertOperationIdentity(identity);
    return { ...identity, signing: { ...identity.signing } };
  }

  assertOperationIdentity(identity: Identity): void {
    if (!isCommitIdentity({ name: identity.gitName, email: identity.gitEmail }))
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.commitIdentity"),
        message: errorText("main.identity.identityManager.theSavedCommitIdentityIsInvalid"),
        suggestedAction: errorText(
          "main.identity.identityManager.setAValidAuthorNameAndEmailInProfileOrRepositorySettings",
        ),
      });
  }

  replaceAfterDelete(
    id: string,
    fallbackId: string | null,
    cleanup: () => Promise<void>,
  ): Promise<void> {
    return this.serialize(async () => {
      this.requireIdentity(id);

      if (this.getActive()?.id !== id) {
        await cleanup();
        return;
      }

      if (fallbackId) {
        const fallback = this.requireIdentity(fallbackId);

        await this.activate(fallback, async () => {
          await cleanup();
          return fallback;
        });
      } else {
        await cleanup();
        this.identities.setActiveId(null);
        this.emit(null);
      }
    });
  }

  async update(id: string, draft: Partial<IdentityDraft>): Promise<Identity> {
    return this.serialize(async () => {
      const previous = this.requireIdentity(id);

      const proposed = {
        ...previous,
        ...draft,
        signing: { ...previous.signing, ...draft.signing },
      };

      this.identities.requireAvailableName(proposed.name, id);

      if (this.getActive()?.id !== id) return this.identities.update(id, draft)!;

      const report = await this.activate(proposed, () => this.identities.update(id, draft)!);

      return report.identity;
    });
  }

  private requireIdentity(id: string): Identity {
    const identity = this.identities.findById(id);

    if (!identity)
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.profile"),
        message: errorText("main.identity.identityManager.thatProfileNoLongerExists"),
        suggestedAction: errorText("main.identity.identityManager.refreshProfilesAndTryAgain"),
      });

    return identity;
  }

  private async activate(
    candidate: Identity,
    persist?: () => Identity | Promise<Identity>,
  ): Promise<IdentitySwitchReport> {
    const enabled =
      this.preferences?.resolve("syncGlobalGitConfig", { profileId: candidate.id }).value ?? true;
    const steps: IdentitySwitchStep[] = [];
    this.assertOperationIdentity(candidate);

    const identity = await this.configure(
      enabled ? profileGitConfig(candidate) : {},
      { scope: "global" },
      {
        verify: (key) =>
          new GitError({
            kind: "config-write-refused",
            operation: t("operations.switchProfile"),
            message: errorText("main.identity.identityManager.gitDidNotRecordCorrectly", { key }),
            suggestedAction: errorText(
              "main.identity.identityManager.checkWhetherYourGlobalGitConfigurationIsWritable",
            ),
          }),
        rollback: (incomplete) =>
          new GitError({
            kind: "config-write-refused",
            operation: t("operations.switchProfile"),
            message: errorText(
              "main.identity.identityManager.theProfileWasNotSwitchedSomeGlobalGitValuesCouldNotBeRestored",
            ),
            suggestedAction: errorText(
              "main.identity.identityManager.inspectInYourGlobalGitConfigurationExternalEditsWerePreserved",
              { incomplete: incomplete.join(", ") },
            ),
          }),
      },
      async () => {
        for (const name of [
          "write-global-config",
          "verify-read-back",
          "write-signing-config",
        ] as const) {
          steps.push({ name, status: enabled ? "ok" : "skipped" });
        }

        steps.push({
          name: "activate-ssh-key",
          status: candidate.sshKeyPath
            ? existsSync(candidate.sshKeyPath)
              ? "ok"
              : "failed"
            : "skipped",
          ...(candidate.sshKeyPath
            ? {
                detail: existsSync(candidate.sshKeyPath)
                  ? candidate.sshKeyPath
                  : t(
                      "main.identity.identityManager.theAssignedSshKeyIsMissingRestoreItBeforeRemoteOperations",
                    ),
              }
            : {}),
        });

        const identity = persist ? await persist() : candidate;
        this.identities.setActiveId(identity.id);
        return identity;
      },
    );

    this.emit(identity);

    return { identity, steps, verified: steps.every((step) => step.status !== "failed") };
  }

  captureForOperation(): Promise<OperationIdentity | undefined> {
    const identity = this.getActive();

    if (!identity) return Promise.resolve(undefined);

    const captured: OperationIdentity = {
      identityId: identity.id,
      identityName: identity.name,
      gitName: identity.gitName,
      gitEmail: identity.gitEmail,
      signing: { ...identity.signing },
      gitExecutable: this.git.gitPath,
      gitVersion: this.git.gitVersion,
      ...(identity.sshKeyPath !== undefined && { sshKeyPath: identity.sshKeyPath }),
    };

    return this.serialize(async () => {
      this.requireIdentity(captured.identityId);
      return captured;
    });
  }

  async verifyEffectiveIdentity(
    repositoryPath: string,
    expected: Identity,
  ): Promise<EffectiveIdentityCheck> {
    const [name, email] = await Promise.all([
      this.git.readConfig("user.name", { cwd: repositoryPath }),
      this.git.readConfig("user.email", { cwd: repositoryPath }),
    ]);

    return {
      matches: name === expected.gitName && email === expected.gitEmail,
      expected: { name: expected.gitName, email: expected.gitEmail },
      actual: { ...(name !== undefined && { name }), ...(email !== undefined && { email }) },
    };
  }

  async applyToRepository(repositoryPath: string, identity: Identity): Promise<void> {
    const options = { scope: "local" as const, cwd: repositoryPath };

    const expected = profileGitConfig(
      identity.signing.keyRef
        ? identity
        : { ...identity, signing: { format: "none", signCommits: false } },
    );

    await this.configure(
      expected,
      options,
      {
        verify: (key) =>
          new AppError(errorText(ERROR_MESSAGE_KEYS[ERROR_CODE.IDENTITY_NOT_RECORDED], { key })),
        rollback: (incomplete) =>
          new GitError({
            kind: "config-write-refused",
            operation: t("operations.applyProfile"),
            message: errorText(
              "main.identity.identityManager.someLocalGitValuesCouldNotBeRestoredExternalEditsWerePreserved",
              { incomplete: incomplete.join(", ") },
            ),
            repositoryPath,
          }),
      },
      async () => {},
    );
  }

  private async configure<T>(
    expected: Record<string, string | undefined>,
    options: { scope: "global" | "local"; cwd?: string },
    errors: { verify: (key: string) => Error; rollback: (keys: string[]) => Error },
    complete: () => Promise<T>,
  ): Promise<T> {
    const writes: { key: string; previous: string | undefined; written: string | undefined }[] = [];

    const write = (key: string, value: string | undefined) =>
      value === undefined
        ? this.git.unsetConfig(key, options)
        : this.git.writeConfig(key, value, options);

    try {
      for (const [key, written] of Object.entries(expected)) {
        const previous = await this.git.readConfig(key, options);
        if (previous === written) continue;

        // Git can change the config even when the write reports a failure.
        writes.push({ key, previous, written });
        await write(key, written);
      }

      for (const [key, value] of Object.entries(expected)) {
        if ((await this.git.readConfig(key, options)) !== value) throw errors.verify(key);
      }

      return await complete();
    } catch (error) {
      const incomplete: string[] = [];

      for (const { key, previous, written } of writes.reverse()) {
        try {
          const current = await this.git.readConfig(key, options);
          if (current === previous) continue;

          if (current !== written) {
            incomplete.push(key);
            continue;
          }

          await write(key, previous);
        } catch {
          incomplete.push(key);
        }
      }

      if (incomplete.length) throw errors.rollback(incomplete);
      throw error;
    }
  }

  private emit(identity: Identity | null): void {
    for (const listener of this.listeners) listener(identity);
  }
}
