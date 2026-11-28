import { errorText } from "@shared/error-codes";
import { GitError, isExpectedKind } from "@shared/errors";
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
  private stopping = false;
  private fetching: { profileId: string; repositoryId: string } | null = null;

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
    if (this.fetching)
      this.remotes.cancelScheduled(this.fetching.profileId, this.fetching.repositoryId);
    return this.pending ?? Promise.resolve();
  }

  private due(history: FetchHistory | null, minutes: number): number | null {
    if (!minutes) return null;
    return (
      history?.retryAt ??
      (history?.lastSuccess != null ? history.lastSuccess + minutes * 60_000 : this.now())
    );
  }

  private interval(repositoryId: string) {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    return this.settings.resolve("backgroundFetchMinutes", {
      profileId: repository.identityId,
      repositoryId,
    }).value;
  }

  async inspect(repositoryId: string): Promise<BackgroundFetchState> {
    const remotes = await this.remotes.fetchStates(repositoryId);
    const intervalMinutes = this.interval(repositoryId);
    return {
      intervalMinutes,
      ...this.conditions(),
      fetching: this.fetching?.repositoryId === repositoryId,
      remotes: remotes.map((remote) => ({
        ...remote,
        nextFetch: remote.supported ? this.due(remote.history, intervalMinutes) : null,
      })),
    };
  }

  configure(repositoryId: string, minutes: number | null): void {
    const repository = this.repositories.resolveActiveRepository(repositoryId);
    const scope = { kind: "repository" as const, profileId: repository.identityId, repositoryId };
    if (minutes === null) this.settings.reset("backgroundFetchMinutes", scope);
    else this.settings.set("backgroundFetchMinutes", scope, minutes);
  }

  async retry(repositoryId: string, remote: string): Promise<void> {
    if (this.paused())
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.retryBackgroundFetch"),
        message: errorText(
          "main.backgroundFetchService.backgroundFetchIsPausedByNetworkConditionsOr",
        ),
      });

    const profileId = this.repositories.resolveActiveRepository(repositoryId).identityId;
    await this.remotes.fetch(this.fetchRequest(profileId, repositoryId, remote));
    this.changed(repositoryId);
  }

  private fetchRequest(profileId: string, repositoryId: string, remote: string) {
    const scope = { profileId, repositoryId };
    return {
      repositoryId,
      remote,
      prune: this.settings.resolve("fetchPrune", scope).value,
      tags: this.settings.resolve("fetchTags", scope).value,
    };
  }

  private paused(): boolean {
    const { online, suspended } = this.conditions();
    return !online || suspended;
  }

  tick(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopping) return Promise.resolve();
    this.pending = this.run()
      .catch(reportUnexpectedFailure)
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private async run(): Promise<void> {
    if (this.paused()) return;
    const profile = this.identity.getActive();

    if (!profile) return;

    const isCurrent = () => !this.stopping && this.identity.getActive()?.id === profile.id;
    const reportFailure = (error: unknown) => {
      if (isCurrent()) reportUnexpectedFailure(error);
    };
    for (const repositoryId of this.sessions.openRepositoryIds(profile.id)) {
      if (!isCurrent()) return;

      try {
        if (this.paused()) return;
        if (!this.interval(repositoryId)) continue;

        for (const remote of await this.remotes.fetchStates(repositoryId)) {
          if (!isCurrent() || this.paused()) return;
          if (!remote.supported) continue;

          const nextFetch = this.due(remote.history, this.interval(repositoryId));
          if (nextFetch === null) break;
          if (nextFetch > this.now()) continue;
          if (!this.sessions.openRepositoryIds(profile.id).includes(repositoryId)) break;

          this.fetching = { profileId: profile.id, repositoryId };

          try {
            await this.remotes.fetch(
              this.fetchRequest(profile.id, repositoryId, remote.name),
              t("main.backgroundFetchService.backgroundFetch"),
              "main.backgroundFetchService.backgroundFetch",
            );
          } catch (error) {
            reportFailure(error);
          } finally {
            this.fetching = null;
          }
          if (!isCurrent()) return;
          this.changed(repositoryId);
        }
      } catch (error) {
        reportFailure(error);
      }
    }
  }
}

function reportUnexpectedFailure(error: unknown): void {
  if (error instanceof GitError && isExpectedKind(error.kind)) return;

  console.error("Background fetch failed unexpectedly.");
}
