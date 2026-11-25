import { ERROR_CODE, errorText, type ErrorText } from "@shared/error-codes";
import { AppError, GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { localizedUpdateApiError } from "@shared/update-api-errors";
import type {
  UpdateCapability,
  UpdatePlatform,
  UpdateProgress,
  UpdateRelease,
  UpdateState,
} from "@shared/updates";
import { updateFeedUrl } from "@shared/updates";
import { isStableVersion } from "@shared/version";

export interface UpdateCheckResult {
  available: boolean;
  release: UpdateRelease;
}

export interface UpdateDriver {
  check(): Promise<UpdateCheckResult>;
  download(progress: (value: UpdateProgress) => void): Promise<void>;
  discardDownload(): void;
  install(): void | Promise<void>;
}

export interface UpdateOptions {
  capability: UpdateCapability;
  reason: string | null;
  platform: UpdatePlatform;
  arch: string;
  currentVersion: string;
  automaticChecks: () => boolean;
  includePrereleases: () => boolean;
  createDriver: (url: string) => UpdateDriver | Promise<UpdateDriver>;
  checkRelease?: (url: string) => Promise<UpdateCheckResult>;
  homebrew?: {
    check(version: string): Promise<string | null>;
    install(version: string): Promise<void>;
    restart(): void | Promise<void>;
  };
  prepareInstall: () => Promise<() => void>;
  now?: () => number;
}

export const UPDATE_STARTUP_DELAY = 3_000;
export const UPDATE_CHECK_INTERVAL = 6 * 60 * 60_000;

export class UpdateService {
  private state: UpdateState;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private driver: UpdateDriver | undefined;
  private checking: Promise<UpdateState> | undefined;
  private downloading: Promise<UpdateState> | undefined;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private cancelled = false;
  private rollbackInstall: (() => void) | undefined;
  private installingHomebrew = false;

  constructor(private readonly options: UpdateOptions) {
    this.state = {
      revision: 0,
      capability: options.capability,
      reason: options.reason,
      phase: "idle",
      checkedAt: null,
      release: null,
      progress: null,
      error: null,
      feedUrl: ["automatic", "homebrew", "managed"].includes(options.capability)
        ? updateFeedUrl(options.platform, options.arch, options.includePrereleases())
        : null,
    };
  }

  snapshot(): UpdateState {
    return this.state;
  }

  get blocksQuit(): boolean {
    return this.installingHomebrew;
  }

  onChange(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(change: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...change, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.state);
    return this.state;
  }

  start(): void {
    this.running = true;
    this.refreshSchedule();
  }

  refreshSchedule(): void {
    clearTimeout(this.timer);
    this.refreshFeed();

    if (!this.running || !this.canCheck() || !this.options.automaticChecks()) return;

    const pending = ["available", "downloading", "ready", "installing"].includes(this.state.phase);
    const delay = pending
      ? UPDATE_CHECK_INTERVAL
      : this.state.checkedAt
        ? Math.max(
            UPDATE_STARTUP_DELAY,
            UPDATE_CHECK_INTERVAL -
              ((this.options.now ?? Date.now)() - Date.parse(this.state.checkedAt)),
          )
        : UPDATE_STARTUP_DELAY;
    this.timer = setTimeout(() => {
      void this.check().catch(() => undefined);
    }, delay);

    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);

    if (this.downloading) {
      this.cancelled = true;
      this.driver?.discardDownload();
    }
  }

  private refreshFeed(): void {
    if (!this.canCheck() || ["checking", "downloading", "installing"].includes(this.state.phase))
      return;

    const feedUrl = updateFeedUrl(
      this.options.platform,
      this.options.arch,
      this.options.includePrereleases(),
    );

    if (feedUrl === this.state.feedUrl) return;

    this.driver?.discardDownload();
    this.driver = undefined;

    this.publish({
      feedUrl,
      phase: "idle",
      reason: this.state.capability !== "automatic" ? this.options.reason : null,
      checkedAt: null,
      release: null,
      progress: null,
      error: null,
    });
  }

  private async native(): Promise<UpdateDriver> {
    this.requireAutomatic();

    return (this.driver ??= await this.options.createDriver(this.state.feedUrl!));
  }

  private requireAutomatic(): void {
    if (this.state.capability !== "automatic")
      throw updateRequest(
        errorText("errors.operationBlocked", {
          reason: this.state.reason ?? t("main.updateService.useTheDownloadPageToUpdateEda"),
        }),
      );
  }

  private canCheck(): boolean {
    return ["automatic", "homebrew", "managed"].includes(this.state.capability);
  }

  check(): Promise<UpdateState> {
    if (!this.canCheck()) this.requireAutomatic();
    this.refreshFeed();

    if (this.checking) return this.checking;

    if (["downloading", "ready", "installing"].includes(this.state.phase))
      return Promise.resolve(this.state);

    this.publish({ phase: "checking", error: null, release: null, progress: null });

    this.checking = Promise.resolve().then(async () => {
      try {
        const result =
          this.state.capability !== "automatic"
            ? await this.options.checkRelease?.(this.state.feedUrl!)
            : await (await this.native()).check();

        if (!result) throw new AppError(ERROR_CODE.UPDATER_UNAVAILABLE);

        const newer = newerRelease(result.release.version, this.options.currentVersion);
        const homebrewReason =
          newer && result.available && this.state.capability === "homebrew"
            ? await this.options.homebrew?.check(result.release.version)
            : null;

        if (this.state.capability === "homebrew" && !this.options.homebrew)
          throw new AppError(ERROR_CODE.UPDATER_UNAVAILABLE);

        const available = result.available && newer && !homebrewReason;

        this.publish({
          phase: available ? "available" : "current",
          release: available ? result.release : null,
          reason:
            homebrewReason ??
            (this.state.capability === "managed"
              ? this.options.reason
              : newer && !result.available
                ? t("main.updateService.aNewerReleaseExistsButIsNotOffered")
                : null),
          checkedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
        });
      } catch (error) {
        this.publish({
          phase: "error",
          error: error instanceof GitError ? error.message : updateError(error, "check"),
          checkedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
        });
      } finally {
        this.checking = undefined;
        this.refreshSchedule();
      }

      return this.state;
    });

    return this.checking;
  }

  download(): Promise<UpdateState> {
    this.requireAutomatic();

    if (this.downloading) return this.downloading;

    if (this.state.phase !== "available" || !this.state.release)
      throw updateRequest(errorText("main.updateService.checkForAnUpdateBeforeDownloading"));

    this.cancelled = false;
    this.publish({ phase: "downloading", progress: null, error: null });

    this.downloading = Promise.resolve().then(async () => {
      try {
        const driver = await this.native();

        if (!this.cancelled) {
          await driver.download((progress) => {
            if (!this.cancelled && this.state.phase === "downloading") this.publish({ progress });
          });
        }

        this.publish({ phase: this.cancelled ? "available" : "ready", progress: null });
      } catch (error) {
        this.publish({
          phase: "available",
          progress: null,
          error: this.cancelled ? null : updateError(error, "download"),
        });
      } finally {
        this.downloading = undefined;
        this.refreshSchedule();
      }

      return this.state;
    });

    return this.downloading;
  }

  async discardDownload(): Promise<UpdateState> {
    if (this.downloading) {
      this.cancelled = true;
      this.driver?.discardDownload();
      await this.downloading;
    }

    return this.state;
  }

  async install(): Promise<UpdateState> {
    const homebrew = this.state.capability === "homebrew";

    if (!homebrew) this.requireAutomatic();

    if (this.state.phase !== (homebrew ? "available" : "ready") || !this.state.release)
      throw updateRequest(
        errorText("main.updateService.downloadAndVerifyAnUpdateBeforeInstallingIt"),
      );

    const version = this.state.release.version;

    this.installingHomebrew = homebrew;
    this.publish({ phase: "installing", error: null });

    try {
      this.rollbackInstall = await this.options.prepareInstall();

      if (homebrew) {
        if (!this.options.homebrew) throw new AppError(ERROR_CODE.UPDATER_UNAVAILABLE);

        await this.options.homebrew.install(version);
        this.installingHomebrew = false;
        await this.options.homebrew.restart();
      } else {
        const driver = await this.native();

        await driver.install();
      }
    } catch (error) {
      this.installingHomebrew = false;
      this.rollbackInstall?.();
      this.rollbackInstall = undefined;

      this.publish({
        phase: homebrew ? "idle" : "ready",
        ...(homebrew && { release: null }),
        error: error instanceof GitError ? error.message : updateError(error, "install"),
      });

      this.refreshSchedule();
    }

    return this.state;
  }
}

export function newerRelease(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    if (!isStableVersion(value)) throw new AppError(ERROR_CODE.INVALID_STABLE_VERSION);
    return value.split(".").map((part) => BigInt(part));
  };
  const next = parse(candidate),
    installed = parse(current);
  for (let index = 0; index < 3; index++) {
    if (next[index]! > installed[index]!) return true;
    if (next[index]! < installed[index]!) return false;
  }
  return false;
}

function updateRequest(message: ErrorText): GitError {
  return new GitError({ kind: "invalid-input", operation: t("operations.updateEda"), message });
}

export function updateError(error: unknown, action: "check" | "download" | "install"): string {
  const apiMessage = localizedUpdateApiError(error);

  if (apiMessage) return apiMessage;

  if (error instanceof AppError && error.code === ERROR_CODE.INVALID_STABLE_VERSION)
    return t("main.updateService.theUpdateCouldNotBeVerifiedNothingWas");

  const details =
    error instanceof Error ? `${"code" in error ? error.code : ""} ${error.message}` : "";

  if (/404/.test(details))
    return t("main.updateService.theUpdateServiceIsNotAvailableYetTryAgainLater");

  if (/sha256|checksum|signature|invalid.*(?:hash|package)/i.test(details))
    return t("main.updateService.theUpdateCouldNotBeVerifiedNothingWas");

  if (
    /TIMEDOUT|TIMEOUT|ECONN|ENOTFOUND|ERR_INTERNET|network|fetch failed|ENET|EAI_AGAIN/i.test(
      details,
    )
  )
    return t("main.updateService.couldNotReachTheUpdateServiceCheckYourConnectionAndTryAgain");

  return action === "install"
    ? t("main.updateService.edaCouldNotStartTheInstallerTryAgainOrUseTheDownloadPage")
    : action === "download"
      ? t("main.updateService.theUpdateCouldNotBeDownloadedTryAgainOrUseTheDownloadPage")
      : t("main.updateService.couldNotCheckForUpdatesTryAgainLater");
}
