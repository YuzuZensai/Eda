import { OAuthCredentials } from "./oauth-credentials";
import {
  requestOAuth,
  tokenText as text,
  tokenSeconds as secondsValue,
  type OAuthTokens as Tokens,
} from "./oauth";
import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { INTEGRATIONS } from "@shared/integrations/config";
import {
  isGitHubHttps,
  MAINTAINER_GITHUB_LOGIN,
  type GitHubSignIn,
  type GitHubSignInResult,
  type GitHubStatus,
} from "@shared/integrations/github";
import type { TransportCredentials } from "@shared/integrations/remotes";
import { randomUUID } from "node:crypto";
import type {
  ProviderAccountRepository,
  SavedProviderAccount,
} from "../persistence/provider-account-repository";
import type { SecretStore } from "../secrets/secret-store";
import { GitHubProfileCache, type GitHubProfileDetails } from "./github-profile-cache";

const DEVICE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_VERIFICATION_URL = "https://github.com/login/device";

const fail = (message: ErrorText) =>
  new GitError({ kind: "invalid-input", operation: t("operations.gitHubSignIn"), message });

interface Pending {
  profileId: string;
  deviceCode: string;
  controller: AbortController;
  signIn: GitHubSignIn;
  nextPoll: number;
}

export class GitHubAuth {
  private readonly clientId = INTEGRATIONS.github.clientId;
  private readonly credentialsStore: OAuthCredentials;
  private readonly pending = new Map<string, Pending>();
  private readonly beginning = new Map<string, AbortController>();
  private readonly profiles: GitHubProfileCache;

  constructor(
    accounts: ProviderAccountRepository,
    secrets: SecretStore,
    private readonly fetch: typeof globalThis.fetch,
    private readonly now = Date.now,
  ) {
    this.credentialsStore = new OAuthCredentials(
      "github",
      accounts,
      secrets,
      now,
      (account, refreshToken) => this.refresh(account, refreshToken),
    );
    this.profiles = new GitHubProfileCache((url) => this.request(url), now);
  }

  status(profileId: string): GitHubStatus {
    return this.credentialsStore.status(profileId);
  }

  async profile(profileId: string): Promise<GitHubProfileDetails | null> {
    const account = this.credentialsStore.visibleAccount(profileId);
    if (!account || !/^[1-9][0-9]{0,15}$/.test(account.accountId)) return null;
    const details = await this.profiles.get({ id: account.accountId, login: account.login });
    return this.credentialsStore.isCurrent(account) ? details : null;
  }

  maintainerProfile(): Promise<GitHubProfileDetails | null> {
    return this.profiles.get({ login: MAINTAINER_GITHUB_LOGIN });
  }

  profileUrl(profileId: string): string {
    const account = this.credentialsStore.visibleAccount(profileId);
    if (!account) throw fail(errorText("main.providers.githubAuth.connectAGitHubAccountFirst"));
    const login = this.profiles.peek(account.accountId)?.login ?? account.login;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login))
      throw fail(errorText("main.providers.githubAuth.theGitHubAccountProfileIsInvalid"));
    return `https://github.com/${login}`;
  }

  async begin(profileId: string): Promise<GitHubSignIn> {
    this.credentialsStore.requireStorage();
    this.cancelProfile(profileId);
    for (const [id, pending] of this.pending)
      if (pending.signIn.expiresAt <= this.now()) this.cancel(pending.profileId, id);

    if (this.pending.size + this.beginning.size >= 16)
      throw fail(
        errorText("main.providers.githubAuth.tooManyGitHubSignInsArePendingCancelOneAndTryAgain"),
      );

    const controller = new AbortController();
    this.beginning.set(profileId, controller);
    let response: Record<string, unknown>;

    try {
      response = await this.request(
        DEVICE_URL,
        { client_id: this.clientId, scope: "repo workflow" },
        controller.signal,
      );
    } finally {
      if (this.beginning.get(profileId) === controller) this.beginning.delete(profileId);
    }

    if (controller.signal.aborted)
      throw fail(errorText("main.providers.githubAuth.theGitHubConnectionWasCancelledSignInAgain"));

    if (response["error"]) throw this.oauthError(response["error"]);
    const deviceCode = text(response["device_code"]);
    const userCode = text(response["user_code"]);
    const seconds = secondsValue(response["expires_in"]);
    const interval = secondsValue(response["interval"]);

    if (
      !deviceCode ||
      !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode ?? "") ||
      !seconds ||
      seconds > 900 ||
      !interval ||
      interval > 900 ||
      response["verification_uri"] !== GITHUB_VERIFICATION_URL
    )
      throw fail(
        errorText("main.providers.githubAuth.gitHubReturnedAnInvalidDeviceAuthorizationResponse"),
      );

    const signIn = {
      id: randomUUID(),
      userCode: userCode!,
      expiresAt: this.now() + seconds * 1000,
      intervalMs: interval * 1000,
    };

    this.pending.set(signIn.id, {
      profileId,
      deviceCode,
      signIn,
      nextPoll: this.now() + signIn.intervalMs,
      controller: new AbortController(),
    });

    return signIn;
  }

  async poll(profileId: string, id: string): Promise<GitHubSignInResult> {
    const pending = this.requirePending(profileId, id);
    if (this.now() < pending.nextPoll)
      return { state: "pending", intervalMs: Math.max(1, pending.nextPoll - this.now()) };
    pending.nextPoll = this.now() + pending.signIn.intervalMs;

    try {
      const response = await this.request(
        TOKEN_URL,
        {
          client_id: this.clientId,
          device_code: pending.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        pending.controller.signal,
      );

      if (response["error"] === "authorization_pending" || response["error"] === "slow_down") {
        if (response["error"] === "slow_down")
          pending.signIn.intervalMs = Math.max(
            pending.signIn.intervalMs + 5000,
            (secondsValue(response["interval"]) ?? 0) * 1000,
          );

        pending.nextPoll = this.now() + pending.signIn.intervalMs;
        return { state: "pending", intervalMs: pending.signIn.intervalMs };
      }

      if (response["error"]) throw this.oauthError(response["error"]);
      const tokens = this.tokens(response);

      const user = await this.request(
        "https://api.github.com/user",
        undefined,
        pending.controller.signal,
        tokens.accessToken,
      );

      if (
        !Number.isSafeInteger(user["id"]) ||
        (user["id"] as number) <= 0 ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(text(user["login"]) ?? "")
      )
        throw fail(errorText("main.providers.githubAuth.gitHubReturnedAnInvalidAccountIdentity"));

      this.requirePending(profileId, id);
      this.cancel(profileId, id);

      await this.credentialsStore.commit({
        signInId: id,
        profileId,
        accountId: String(user["id"]),
        login: user["login"] as string,
        tokens,
      });

      return { state: "connected", status: this.status(profileId) };
    } catch (error) {
      this.cancel(profileId, id);
      throw error;
    }
  }

  verifyPending(profileId: string, id: string): string {
    return this.requirePending(profileId, id).signIn.userCode;
  }

  cancel(profileId: string, id: string): void {
    this.credentialsStore.cancel(profileId, id);

    const pending = this.pending.get(id);
    if (pending?.profileId !== profileId) return;
    pending.controller.abort();
    this.pending.delete(id);
  }

  cancelProfile(profileId: string): void {
    this.beginning.get(profileId)?.abort();
    this.beginning.delete(profileId);
    this.credentialsStore.cancel(profileId);
    for (const [id, pending] of this.pending)
      if (pending.profileId === profileId) this.cancel(profileId, id);
  }

  cancelAll(): void {
    for (const controller of this.beginning.values()) controller.abort();
    this.beginning.clear();
    this.credentialsStore.cancelAll();
    for (const [id, pending] of this.pending) this.cancel(pending.profileId, id);
  }

  async reset(): Promise<void> {
    this.cancelAll();
    await this.credentialsStore.settle();
    await this.profiles.clear();
  }

  selectAccount(profileId: string, accountId: string) {
    return this.credentialsStore.selectAccount(profileId, accountId, () =>
      this.cancelProfile(profileId),
    );
  }

  async disconnect(profileId: string): Promise<void> {
    this.cancelProfile(profileId);
    await this.credentialsStore.disconnect(profileId);
  }

  async forFetch(profileId: string, url: string): Promise<TransportCredentials | undefined> {
    if (!isGitHubHttps(url)) return undefined;

    return this.credentialsStore.forFetch(profileId);
  }

  repositories(profileId: string, page = 1) {
    return this.credentialsStore.repositories(profileId, page, this.fetch);
  }

  private async refresh(account: SavedProviderAccount, refreshToken: string): Promise<Tokens> {
    const response = await this.request(TOKEN_URL, {
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    if (response["error"]) {
      if (
        ["bad_refresh_token", "expired_token", "invalid_grant"].includes(String(response["error"]))
      )
        return this.credentialsStore.expired(account);

      throw this.oauthError(response["error"]);
    }

    const refreshed = this.tokens(response);

    const user = await this.request(
      "https://api.github.com/user",
      undefined,
      undefined,
      refreshed.accessToken,
    );

    if (String(user["id"]) !== account.accountId) return this.credentialsStore.expired(account);
    await this.credentialsStore.saveRefreshed(account, refreshed);
    return refreshed;
  }

  private tokens(response: Record<string, unknown>): Tokens {
    const accessToken = text(response["access_token"]);
    const refreshToken = text(response["refresh_token"]);
    const expires = secondsValue(response["expires_in"]);
    const refreshExpires = secondsValue(response["refresh_token_expires_in"]);

    if (
      !accessToken?.startsWith("gho_") ||
      typeof response["scope"] !== "string" ||
      !response["scope"].split(/[ ,]+/).includes("repo") ||
      response["token_type"] !== "bearer" ||
      (response["expires_in"] !== undefined && !expires) ||
      (response["refresh_token"] !== undefined && !refreshToken) ||
      (response["refresh_token_expires_in"] !== undefined && !refreshExpires)
    )
      throw fail(errorText("main.providers.githubAuth.gitHubReturnedAnInvalidAccessTokenResponse"));

    return {
      clientId: this.clientId,
      accessToken,
      ...(expires ? { expiresAt: this.now() + expires * 1000 } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(refreshExpires ? { refreshExpiresAt: this.now() + refreshExpires * 1000 } : {}),
    };
  }

  private requirePending(profileId: string, id: string): Pending {
    const pending = this.pending.get(id);

    if (!pending || pending.profileId !== profileId)
      throw fail(
        errorText(
          "main.providers.githubAuth.thisGitHubSignInWasCancelledOrBelongsToAnotherProfile",
        ),
      );

    if (pending.signIn.expiresAt <= this.now()) {
      this.cancel(profileId, id);

      throw fail(
        errorText("main.providers.githubAuth.theGitHubVerificationCodeExpiredStartSignInAgain"),
      );
    }

    return pending;
  }

  private oauthError(code: unknown): GitError {
    const messages: Record<string, ErrorText> = {
      access_denied: errorText(
        "main.providers.githubAuth.gitHubSignInWasDeclinedStartAgainWhenYouReReady",
      ),
      expired_token: errorText(
        "main.providers.githubAuth.theGitHubVerificationCodeExpiredStartSignInAgain",
      ),
      token_expired: errorText(
        "main.providers.githubAuth.theGitHubVerificationCodeExpiredStartSignInAgain",
      ),
      device_flow_disabled: errorText(
        "main.providers.githubAuth.enableDeviceFlowInEdaSGitHubAppSettingsThenTryAgain",
      ),
      incorrect_client_credentials: errorText(
        "main.providers.githubAuth.edaSGitHubAppClientIdIsInvalidCheckTheAppRegistrationAndRebuild",
      ),
    };

    return fail(
      messages[String(code)] ??
        errorText("main.providers.githubAuth.gitHubCouldNotCompleteSignInStart"),
    );
  }

  private async request(
    url: string,
    form?: Record<string, string>,
    signal?: AbortSignal,
    accessToken?: string,
  ): Promise<Record<string, unknown>> {
    return requestOAuth(this.fetch, "github", url, form, signal, accessToken);
  }
}
