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
  isGitLabHttps,
  type GitLabSignIn,
  type GitLabSignInResult,
  type GitLabStatus,
} from "@shared/integrations/gitlab";
import type { TransportCredentials } from "@shared/integrations/remotes";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ProviderAccountRepository,
  SavedProviderAccount,
} from "../persistence/provider-account-repository";
import type { SecretStore } from "../secrets/secret-store";
import { ProviderProfileCache } from "./provider-profile-cache";
import { GitLabOAuthCallback } from "./gitlab-oauth-callback";
import { gitLabProfileDetails, type GitLabProfileDetails } from "./gitlab-profile";

const TOKEN_URL = "https://gitlab.com/oauth/token";
const USER_URL = "https://gitlab.com/api/v4/user";

const fail = (message: ErrorText) =>
  new GitError({ kind: "invalid-input", operation: t("operations.gitLabSignIn"), message });

interface Pending {
  profileId: string;
  controller: AbortController;
  signIn: GitLabSignIn;
  callback: GitLabOAuthCallback;
  verifier: string;
  authorizationUrl: string;
  result?: GitLabStatus;
  error?: unknown;
}

export class GitLabAuth {
  private readonly profiles: ProviderProfileCache<GitLabProfileDetails>;
  private readonly clientId = INTEGRATIONS.gitlab.clientId;
  private readonly credentialsStore: OAuthCredentials;
  private readonly pending = new Map<string, Pending>();

  constructor(
    accounts: ProviderAccountRepository,
    secrets: SecretStore,
    private readonly fetch: typeof globalThis.fetch,
    private readonly now = Date.now,
  ) {
    this.credentialsStore = new OAuthCredentials(
      "gitlab",
      accounts,
      secrets,
      now,
      (account, refreshToken) => this.refresh(account, refreshToken),
    );
    this.profiles = new ProviderProfileCache(now);
  }

  status(profileId: string): GitLabStatus {
    return this.credentialsStore.status(profileId);
  }

  async profile(profileId: string): Promise<GitLabProfileDetails | null> {
    const account = this.credentialsStore.visibleAccount(profileId);
    if (!account) return null;

    const details = await this.profiles.get(account.credentialRef, async () => {
      const credentials = await this.credentialsStore.credentials(account);
      const user = await this.request(USER_URL, undefined, undefined, credentials.password);

      if (String(user["id"]) !== account.accountId || !this.credentialsStore.isCurrent(account))
        return null;

      return gitLabProfileDetails(account.accountId, user);
    });

    return this.credentialsStore.isCurrent(account) ? details : null;
  }

  profileUrl(profileId: string): string {
    const account = this.credentialsStore.visibleAccount(profileId);
    if (!account) throw fail(errorText("main.providers.gitlabAuth.connectAGitLabAccountFirst"));
    const login = account.login;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/.test(login))
      throw fail(errorText("main.providers.gitlabAuth.theGitLabAccountProfileIsInvalid"));
    return `https://gitlab.com/${login}`;
  }

  async begin(profileId: string): Promise<GitLabSignIn> {
    this.credentialsStore.requireStorage();
    this.cancelAll();
    const signIn = { id: randomUUID(), expiresAt: this.now() + 10 * 60_000 };
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");

    const callback = new GitLabOAuthCallback(
      INTEGRATIONS.gitlab.redirectUri,
      state,
      (code, error) => {
        const session = this.pending.get(signIn.id);
        if (!session) return;

        if (!code || error) {
          session.error = fail(errorText("main.providers.gitlabAuth.signInDeclined"));
          return;
        }

        void this.finish(session, code).catch((error: unknown) => {
          session.error = error;
        });
      },
    );

    const session: Pending = {
      profileId,
      controller: new AbortController(),
      signIn,
      callback,
      verifier,
      authorizationUrl: "",
    };

    this.pending.set(signIn.id, session);

    try {
      await callback.listen();
      this.requirePending(profileId, signIn.id);
      const url = new URL("https://gitlab.com/oauth/authorize");

      url.search = new URLSearchParams({
        client_id: this.clientId,
        redirect_uri: INTEGRATIONS.gitlab.redirectUri,
        response_type: "code",
        state,
        scope: "read_user read_api write_repository",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      }).toString();

      session.authorizationUrl = url.href;
      return signIn;
    } catch (error) {
      this.cancel(profileId, signIn.id);
      throw error;
    }
  }

  poll(profileId: string, id: string): GitLabSignInResult {
    const session = this.requirePending(profileId, id);

    if (session.error) {
      this.cancel(profileId, id);
      throw session.error;
    }

    if (session.result) {
      this.cancel(profileId, id);
      return { state: "connected", status: session.result };
    }

    return { state: "pending" };
  }

  authorizationUrl(profileId: string, id: string): string {
    return this.requirePending(profileId, id).authorizationUrl;
  }

  private async finish(session: Pending, code: string): Promise<void> {
    const { profileId, signIn, controller } = session;

    const response = await this.request(
      TOKEN_URL,
      {
        client_id: this.clientId,
        code,
        grant_type: "authorization_code",
        redirect_uri: INTEGRATIONS.gitlab.redirectUri,
        code_verifier: session.verifier,
      },
      controller.signal,
    );

    if (response["error"]) throw this.oauthError(response["error"]);
    const tokens = this.tokens(response);
    const user = await this.request(USER_URL, undefined, controller.signal, tokens.accessToken);

    if (
      !Number.isSafeInteger(user["id"]) ||
      (user["id"] as number) <= 0 ||
      !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/.test(text(user["username"]) ?? "")
    )
      throw fail(errorText("main.providers.gitlabAuth.gitLabReturnedAnInvalidAccountIdentity"));

    this.requirePending(profileId, signIn.id);

    const accountId = String(user["id"]);
    await this.credentialsStore.commit({
      signInId: signIn.id,
      profileId,
      accountId,
      login: user["username"] as string,
      tokens,
    });
    this.requirePending(profileId, signIn.id);
    const account = this.credentialsStore.visibleAccount(profileId);

    if (account?.accountId === accountId)
      this.profiles.set(account.credentialRef, gitLabProfileDetails(accountId, user));

    session.result = this.status(profileId);
  }

  cancel(profileId: string, id: string): void {
    this.credentialsStore.cancel(profileId, id);

    const pending = this.pending.get(id);
    if (pending?.profileId !== profileId) return;
    pending.controller.abort();
    pending.callback.close();
    this.pending.delete(id);
  }

  cancelProfile(profileId: string): void {
    this.credentialsStore.cancel(profileId);
    for (const [id, pending] of this.pending)
      if (pending.profileId === profileId) this.cancel(profileId, id);
  }

  cancelAll(): void {
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
    const account = await this.credentialsStore.disconnect(profileId);
    if (account) this.profiles.delete(account.credentialRef);
  }

  async forFetch(profileId: string, url: string): Promise<TransportCredentials | undefined> {
    if (!isGitLabHttps(url)) return undefined;

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
      redirect_uri: INTEGRATIONS.gitlab.redirectUri,
    });

    if (response["error"]) {
      if (
        ["bad_refresh_token", "expired_token", "invalid_grant"].includes(String(response["error"]))
      )
        return this.credentialsStore.expired(account);

      throw this.oauthError(response["error"]);
    }

    const refreshed = this.tokens(response);
    const user = await this.request(USER_URL, undefined, undefined, refreshed.accessToken);
    if (String(user["id"]) !== account.accountId) return this.credentialsStore.expired(account);
    await this.credentialsStore.saveRefreshed(account, refreshed);
    this.profiles.set(account.credentialRef, gitLabProfileDetails(account.accountId, user));
    return refreshed;
  }

  private tokens(response: Record<string, unknown>): Tokens {
    const accessToken = text(response["access_token"]);
    const refreshToken = text(response["refresh_token"]);
    const expires = secondsValue(response["expires_in"]);
    const refreshExpires = secondsValue(response["refresh_token_expires_in"]);

    if (
      !accessToken ||
      !refreshToken ||
      !expires ||
      typeof response["token_type"] !== "string" ||
      response["token_type"].toLowerCase() !== "bearer" ||
      (response["expires_in"] !== undefined && !expires) ||
      (response["refresh_token"] !== undefined && !refreshToken) ||
      (response["refresh_token_expires_in"] !== undefined && !refreshExpires)
    )
      throw fail(errorText("main.providers.gitlabAuth.gitLabReturnedAnInvalidAccessTokenResponse"));

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
          "main.providers.gitlabAuth.thisGitLabSignInWasCancelledOrBelongsToAnotherProfile",
        ),
      );

    if (!pending.result && pending.signIn.expiresAt <= this.now()) {
      this.cancel(profileId, id);

      throw fail(
        errorText("main.providers.gitlabAuth.theGitLabVerificationCodeExpiredStartSignInAgain"),
      );
    }

    return pending;
  }

  private oauthError(_code: unknown): GitError {
    return fail(errorText("main.providers.gitlabAuth.gitLabCouldNotCompleteSignInStart"));
  }

  private async request(
    url: string,
    form?: Record<string, string>,
    signal?: AbortSignal,
    accessToken?: string,
  ): Promise<Record<string, unknown>> {
    return requestOAuth(this.fetch, "gitlab", url, form, signal, accessToken);
  }
}
