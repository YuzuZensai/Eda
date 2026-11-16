import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { BackgroundFetchState, FetchHistory } from "@shared/integrations/background-fetch";
import type { IdentityManager } from "../../identity/identity-manager";
import type { ProfileSessionRepository } from "../../persistence/profile-session-repository";
import type { SettingsRepository } from "../../persistence/settings-repository";
import type { RepositoryManager } from "../lifecycle/repository-manager";
import type { RemoteService } from "./remote-service";

export interface FetchConditions {
  online: boolean;
  suspended: boolean;
}

export class BackgroundFetchService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | null = null;
  private fetchingProfile: string | null = null;
  private stopping = false;
  private fetchingRepository: string | null = null;

  constructor(
    private readonly identity: IdentityManager,
    private readonly sessions: ProfileSessionRepository,
    private readonly settings: SettingsRepository,
    private readonly repositories: RepositoryManager,
    private readonly remotes: RemoteService,
    private readonly conditions: () => FetchConditions,
    private readonly changed: (repositoryId: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, 15_000);
    this.timer.unref();
  }

  stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.fetchingProfile && this.fetchingRepository)
      this.remotes.cancelScheduled(this.fetchingProfile, this.fetchingRepository);
    return this.pending ?? Promise.resolve();
  }

  private due(history: FetchHistory | null, minutes: number): number | null {
    if (!minutes) return null;
    return (
      history?.retryAt ??
      (history?.lastSuccess ? history.lastSuccess + minutes * 60_000 : this.now())
    );
  }

  private interval(repositoryId: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    return this.settings.resolve("backgroundFetchMinutes", {
      profileId: repository.identityId,
      repositoryId,
    }).value;
  }

  private async remoteStates(repositoryId: string, intervalMinutes: number) {
    return (await this.remotes.fetchStates(repositoryId)).map((remote) => ({
      ...remote,
      nextFetch: remote.supported ? this.due(remote.history, intervalMinutes) : null,
    }));
  }

  async inspect(repositoryId: string): Promise<BackgroundFetchState> {
    const intervalMinutes = this.interval(repositoryId);
    return {
      intervalMinutes,
      ...this.conditions(),
      fetching: this.fetchingRepository === repositoryId,
      remotes: await this.remoteStates(repositoryId, intervalMinutes),
    };
  }

  configure(repositoryId: string, minutes: number | null): void {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const scope = { kind: "repository" as const, profileId: repository.identityId, repositoryId };
    if (minutes === null) this.settings.reset("backgroundFetchMinutes", scope);
    else this.settings.set("backgroundFetchMinutes", scope, minutes);
  }

  async retry(repositoryId: string, remote: string): Promise<void> {
    const state = await this.inspect(repositoryId);

    if (!state.online || state.suspended)
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.retryBackgroundFetch"),
        message: errorText(
          "main.backgroundFetchService.backgroundFetchIsPausedByNetworkConditionsOr",
        ),
      });

    await this.remotes.fetch({
      repositoryId,
      remote,
      prune: this.settings.resolve("fetchPrune", {
        profileId: this.repositories.resolveActiveRepository(repositoryId).identityId,
        repositoryId,
      }).value,
      tags: this.settings.resolve("fetchTags", {
        profileId: this.repositories.resolveActiveRepository(repositoryId).identityId,
        repositoryId,
      }).value,
    });
    this.changed(repositoryId);
  }

  tick(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopping) return Promise.resolve();
    this.pending = this.run().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async run(): Promise<void> {
    try {
      const profile = this.identity.getActive();

      if (!profile) return;

      for (const repositoryId of this.sessions.openRepositoryIds(profile.id)) {
        if (this.stopping || this.identity.getActive()?.id !== profile.id) return;

        try {
          const { online, suspended } = this.conditions();
          if (!online || suspended) return;
          const interval = this.interval(repositoryId);
          if (!interval) continue;

          for (const remote of await this.remoteStates(repositoryId, interval)) {
            if (this.stopping || this.identity.getActive()?.id !== profile.id) return;

            const currentConditions = this.conditions();

            if (!currentConditions.online || currentConditions.suspended) return;

            if (!remote.supported || remote.nextFetch === null || remote.nextFetch > this.now())
              continue;

            this.fetchingRepository = repositoryId;
            this.fetchingProfile = profile.id;

            try {
              await this.remotes.fetch(
                {
                  repositoryId,
                  remote: remote.name,
                  prune: this.settings.resolve("fetchPrune", {
                    profileId: profile.id,
                    repositoryId,
                  }).value,
                  tags: this.settings.resolve("fetchTags", {
                    profileId: profile.id,
                    repositoryId,
                  }).value,
                },
                t("main.backgroundFetchService.backgroundFetch"),
                "main.backgroundFetchService.backgroundFetch",
              );
            } catch {
            } finally {
              this.fetchingRepository = null;
              this.fetchingProfile = null;
              this.changed(repositoryId);
            }
          }
        } catch {}
      }
    } finally {
      this.fetchingRepository = null;
      this.fetchingProfile = null;
    }
  }
}
