import { OAuthCredentials } from "./oauth-credentials";
import {
  requestOAuth,
  readOAuthTokens,
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
import { listProviderRepositories } from "./provider-repositories";
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

const fail = (
  message: ErrorText,
  kind:
    | "invalid-input"
    | "network-failed"
    | "github-auth-required"
    | "keychain-unavailable" = "invalid-input",
) => new GitError({ kind, operation: t("operations.gitHubSignIn"), message });

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
    private readonly accounts: ProviderAccountRepository,
    private readonly secrets: SecretStore,
    private readonly fetch: typeof globalThis.fetch,
    private readonly now = Date.now,
  ) {
    this.credentialsStore = new OAuthCredentials("github", accounts, secrets, now);
    this.profiles = new GitHubProfileCache((url) => this.request(url), now);
  }

  status(profileId: string): GitHubStatus {
    return this.credentialsStore.status(profileId);
  }

  async profile(profileId: string): Promise<GitHubProfileDetails | null> {
    const account = this.accounts.find(profileId);
    if (this.credentialsStore.authorized.has(profileId)) return null;
    if (
      !account ||
      !this.credentialsStore.owns(account) ||
      !/^[1-9][0-9]{0,15}$/.test(account.accountId)
    )
      return null;
    return this.profiles.get({ id: account.accountId, login: account.login });
  }

  maintainerProfile(): Promise<GitHubProfileDetails | null> {
    return this.profiles.get({ login: MAINTAINER_GITHUB_LOGIN });
  }

  profileUrl(profileId: string): string {
    const account = this.accounts.find(profileId);
    if (
      !account ||
      !this.credentialsStore.owns(account) ||
      this.credentialsStore.authorized.has(profileId)
    )
      throw fail(errorText("main.providers.githubAuth.connectAGitHubAccountFirst"));
    const login = this.profiles.peek(account.accountId)?.login ?? account.login;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login))
      throw fail(errorText("main.providers.githubAuth.theGitHubAccountProfileIsInvalid"));
    return `https://github.com/${login}`;
  }

  async begin(profileId: string): Promise<GitHubSignIn> {
    this.requireStorage();
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
        { client_id: this.clientId, scope: "repo workflow offline_access" },
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
      const tokens = this.tokens(response, this.clientId);

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

      this.credentialsStore.authorized.set(profileId, {
        signInId: id,
        profileId,
        accountId: String(user["id"]),
        login: user["login"] as string,
        tokens,
      });

      await this.credentialsStore.commit(this.credentialsStore.authorized.get(profileId)!);
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
    if (this.credentialsStore.authorized.get(profileId)?.signInId === id) {
      this.credentialsStore.authorized.delete(profileId);
    }

    const pending = this.pending.get(id);
    if (pending?.profileId !== profileId) return;
    pending.controller.abort();
    this.pending.delete(id);
  }

  cancelProfile(profileId: string): void {
    this.beginning.get(profileId)?.abort();
    this.beginning.delete(profileId);
    this.credentialsStore.authorized.delete(profileId);
    for (const [id, pending] of this.pending)
      if (pending.profileId === profileId) this.cancel(profileId, id);
  }

  cancelAll(): void {
    for (const controller of this.beginning.values()) controller.abort();
    this.beginning.clear();
    this.credentialsStore.authorized.clear();
    for (const [id, pending] of this.pending) this.cancel(pending.profileId, id);
  }

  async reset(): Promise<void> {
    this.cancelAll();
    await this.credentialsStore.settle();
    await this.profiles.clear();
  }

  selectAccount(profileId: string, accountId: string) {
    const selected = this.accounts.find(profileId, accountId);
    if (!selected || !this.credentialsStore.owns(selected))
      throw fail(errorText("main.providerRepositories.signInRequired"));
    this.cancelProfile(profileId);
    this.accounts.save(selected);
    return this.status(profileId);
  }

  async disconnect(profileId: string): Promise<void> {
    this.cancelProfile(profileId);
    const account = this.accounts.find(profileId);
    if (!account) return;
    this.requireStorage();
    if (this.credentialsStore.owns(account)) await this.secrets.delete(account.credentialRef);
    this.accounts.delete(profileId, account.credentialRef);
  }

  async forFetch(profileId: string, url: string): Promise<TransportCredentials | undefined> {
    if (!isGitHubHttps(url)) return undefined;

    if (this.credentialsStore.authorized.has(profileId))
      throw fail(
        errorText("main.providers.githubAuth.finishConnectingGitHubInProfileSettingsThenRetry"),
        "github-auth-required",
      );

    const account = this.accounts.find(profileId);
    if (!account) return undefined;
    return this.credentials(account);
  }

  async repositories(profileId: string, page = 1) {
    const account = this.accounts.find(profileId);

    if (!account || this.credentialsStore.authorized.has(profileId))
      throw fail(errorText("main.providerRepositories.signInRequired"), "github-auth-required");

    const credentials = await this.credentials(account);

    const result = await listProviderRepositories(
      this.fetch,
      "github",
      credentials.password,
      page,
      undefined,
      profileId,
    );
    if (this.accounts.find(profileId)?.credentialRef !== account.credentialRef)
      throw fail(errorText("main.providerRepositories.signInRequired"));
    return result;
  }

  private async credentials(account: SavedProviderAccount): Promise<TransportCredentials> {
    this.requireStorage();

    if (account.state !== "connected")
      throw fail(
        errorText("main.providers.githubAuth.reconnectGitHubInTheIntegrationsSectionOf"),
        "github-auth-required",
      );

    const tokens = await this.credentialsStore.currentTokens(
      account,
      () => this.readTokens(account),
      (saved) => this.refresh(account, saved),
    );

    return { username: "x-access-token", password: tokens.accessToken };
  }

  private async refresh(account: SavedProviderAccount, tokens: Tokens): Promise<Tokens> {
    if (
      !tokens.refreshToken ||
      (tokens.refreshExpiresAt !== undefined && tokens.refreshExpiresAt <= this.now())
    )
      return this.expired(account);

    const response = await this.request(TOKEN_URL, {
      client_id: tokens.clientId,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    });

    if (response["error"]) {
      if (
        ["bad_refresh_token", "expired_token", "invalid_grant"].includes(String(response["error"]))
      )
        return this.expired(account);

      throw this.oauthError(response["error"]);
    }

    const refreshed = this.tokens(response, tokens.clientId);

    const user = await this.request(
      "https://api.github.com/user",
      undefined,
      undefined,
      refreshed.accessToken,
    );

    if (String(user["id"]) !== account.accountId) return this.expired(account);
    const current = this.accounts.find(account.profileId);

    if (current?.credentialRef !== account.credentialRef)
      throw fail(
        errorText("main.providers.githubAuth.theGitHubAccountChangedRetryThePull"),
        "github-auth-required",
      );

    await this.secrets.set(account.credentialRef, JSON.stringify(refreshed));
    return refreshed;
  }

  private expired(account: SavedProviderAccount): never {
    if (this.accounts.find(account.profileId)?.credentialRef === account.credentialRef)
      this.accounts.save({ ...account, state: "expired" });

    throw fail(
      errorText("main.providers.githubAuth.yourGitHubLoginExpiredReconnectGitHubThenRetryThePull"),
      "github-auth-required",
    );
  }

  private async readTokens(account: SavedProviderAccount): Promise<Tokens> {
    if (!this.credentialsStore.owns(account)) return this.expired(account);
    const raw = await this.secrets.get(account.credentialRef);
    const tokens = readOAuthTokens(raw, this.clientId);
    return tokens?.accessToken.startsWith("gho_") ? tokens : this.expired(account);
  }

  private tokens(response: Record<string, unknown>, clientId: string): Tokens {
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
      clientId,
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

  private requireStorage(): void {
    if (!this.secrets.available)
      throw fail(
        errorText("main.providers.githubAuth.secureCredentialStorageIsUnavailableUnlockYourOs"),
        "keychain-unavailable",
      );
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
