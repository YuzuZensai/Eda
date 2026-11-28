import { WriteQueue } from "../operations/write-queue";
import { errorText } from "@shared/error-codes";
import { GitError, type GitErrorKind } from "@shared/errors";
import { INTEGRATIONS } from "@shared/integrations/config";
import type { TransportCredentials } from "@shared/integrations/remotes";
import { t } from "@shared/i18n";
import { randomUUID } from "node:crypto";
import type {
  ProviderAccountRepository,
  SavedProviderAccount,
} from "../persistence/provider-account-repository";
import { secretKeys, type SecretStore } from "../secrets/secret-store";
import { readOAuthTokens, type OAuthTokens } from "./oauth";
import { listProviderRepositories } from "./provider-repositories";

interface AuthorizedAccount {
  signInId: string;
  profileId: string;
  accountId: string;
  login: string;
  tokens: OAuthTokens;
}

const messages = {
  github: {
    pending: "main.providers.githubAuth.finishConnectingGitHubInProfileSettingsThenRetry",
    reconnect: "main.providers.githubAuth.reconnectGitHubInTheIntegrationsSectionOf",
    storage: "main.providers.githubAuth.secureCredentialStorageIsUnavailableUnlockYourOs",
    cancelled: "main.providers.githubAuth.theGitHubConnectionWasCancelledSignInAgain",
    expired: "main.providers.githubAuth.yourGitHubLoginExpiredReconnectGitHubThenRetryThePull",
    changed: "main.providers.githubAuth.theGitHubAccountChangedRetryThePull",
  },
  gitlab: {
    pending: "main.providers.gitlabAuth.finishConnectingGitLabInProfileSettingsThenRetry",
    reconnect: "main.providers.gitlabAuth.reconnectGitLabInTheIntegrationsSectionOf",
    storage: "main.providers.gitlabAuth.secureCredentialStorageIsUnavailableUnlockYourOs",
    cancelled: "main.providers.gitlabAuth.theGitLabConnectionWasCancelledSignInAgain",
    expired: "main.providers.gitlabAuth.yourGitLabLoginExpiredReconnectGitLabThenRetryThePull",
    changed: "main.providers.gitlabAuth.theGitLabAccountChangedRetryThePull",
  },
} as const;

export class OAuthCredentials {
  private readonly authorized = new Map<string, AuthorizedAccount>();
  private readonly writes = new WriteQueue();
  private readonly reading = new Map<string, Promise<OAuthTokens>>();

  constructor(
    private readonly provider: "github" | "gitlab",
    private readonly accounts: ProviderAccountRepository,
    private readonly secrets: SecretStore,
    private readonly now: () => number,
    private readonly refresh: (
      account: SavedProviderAccount,
      refreshToken: string,
    ) => Promise<OAuthTokens>,
  ) {}

  private owns(account: SavedProviderAccount): boolean {
    return account.credentialRef.startsWith(this.prefix(account.profileId, account.accountId));
  }

  visibleAccount(profileId: string): SavedProviderAccount | undefined {
    const account = this.accounts.find(profileId);
    if (account && !this.authorized.has(profileId) && this.owns(account)) return account;
    return undefined;
  }

  isCurrent(account: SavedProviderAccount): boolean {
    return this.visibleAccount(account.profileId)?.credentialRef === account.credentialRef;
  }

  cancel(profileId: string, signInId?: string): void {
    if (signInId === undefined || this.authorized.get(profileId)?.signInId === signInId)
      this.authorized.delete(profileId);
  }

  cancelAll(): void {
    this.authorized.clear();
  }

  selectAccount(profileId: string, accountId: string, cancel: () => void) {
    const selected = this.accounts.find(profileId, accountId);
    if (!selected || !this.owns(selected)) throw this.failure("signInRequired", "invalid-input");
    cancel();
    this.accounts.save(selected);
    return this.status(profileId);
  }

  async disconnect(profileId: string): Promise<SavedProviderAccount | undefined> {
    const account = this.accounts.find(profileId);
    if (!account) return undefined;
    this.requireStorage();
    await this.writes.run(profileId, async () => {
      if (this.owns(account)) await this.secrets.delete(account.credentialRef);
      this.accounts.delete(profileId, account.credentialRef);
    });
    return account;
  }

  status(profileId: string) {
    const saved = this.accounts.find(profileId);
    const account = saved && this.owns(saved) ? saved : undefined;

    const alternatives = this.accounts
      .list(profileId)
      .filter((item) => item.accountId !== account?.accountId && this.owns(item))
      .map((item) => ({ id: item.accountId, login: item.login, state: item.state }));
    return {
      ...(alternatives.length && { alternatives }),
      secureStorage: this.secrets.available,
      account:
        account && !this.authorized.has(profileId)
          ? { id: account.accountId, login: account.login, state: account.state }
          : null,
    };
  }

  async settle(): Promise<void> {
    await Promise.allSettled([this.writes.settle(), ...this.reading.values()]);
  }

  commit(candidate: AuthorizedAccount): Promise<void> {
    const { profileId } = candidate;
    this.authorized.set(profileId, candidate);
    return this.writes.run(profileId, async () => {
      try {
        if (this.authorized.get(profileId) !== candidate) throw this.failure("cancelled");
        await this.save(candidate);
      } finally {
        if (this.authorized.get(profileId) === candidate) this.authorized.delete(profileId);
      }
    });
  }

  requireStorage() {
    if (!this.secrets.available) throw this.failure("storage", "keychain-unavailable");
  }

  async repositories(profileId: string, page: number, fetch: typeof globalThis.fetch) {
    const account = this.accounts.find(profileId);
    if (!account || this.authorized.has(profileId)) throw this.failure("signInRequired");

    const { password } = await this.credentials(account);
    const result = await listProviderRepositories(
      fetch,
      this.provider,
      password,
      page,
      undefined,
      profileId,
    );
    if (!this.isCurrent(account)) throw this.failure("signInRequired", "invalid-input");
    return result;
  }

  async forFetch(profileId: string) {
    if (this.authorized.has(profileId)) throw this.failure("pending");
    const account = this.accounts.find(profileId);
    return account ? this.credentials(account) : undefined;
  }

  async credentials(account: SavedProviderAccount): Promise<TransportCredentials> {
    this.requireStorage();
    if (account.state !== "connected") throw this.failure("reconnect");
    if (!this.owns(account)) return this.expired(account);

    let work = this.reading.get(account.credentialRef);

    if (!work) {
      work = this.readOrRefresh(account).finally(() => this.reading.delete(account.credentialRef));
      this.reading.set(account.credentialRef, work);
    }

    const tokens = await work;

    if (!this.isCurrent(account)) throw this.failure("changed");

    return {
      username: this.provider === "github" ? "x-access-token" : "oauth2",
      password: tokens.accessToken,
    };
  }

  expired(account: SavedProviderAccount): never {
    if (this.accounts.find(account.profileId)?.credentialRef === account.credentialRef)
      this.accounts.save({ ...account, state: "expired" });
    throw this.failure("expired");
  }

  saveRefreshed(account: SavedProviderAccount, tokens: OAuthTokens): Promise<void> {
    return this.writes.run(account.profileId, async () => {
      const saved = this.accounts.find(account.profileId, account.accountId);
      if (saved?.credentialRef !== account.credentialRef) throw this.failure("changed");
      await this.secrets.set(account.credentialRef, JSON.stringify(tokens));
    });
  }

  private async readOrRefresh(account: SavedProviderAccount): Promise<OAuthTokens> {
    const raw = await this.secrets.get(account.credentialRef);
    const tokens = readOAuthTokens(raw, INTEGRATIONS[this.provider].clientId);
    if (!tokens || (this.provider === "github" && !tokens.accessToken.startsWith("gho_")))
      return this.expired(account);
    if (!this.isCurrent(account)) throw this.failure("changed");
    if (tokens.expiresAt === undefined || tokens.expiresAt > this.now() + 60_000) return tokens;

    if (
      !tokens.refreshToken ||
      (tokens.refreshExpiresAt !== undefined && tokens.refreshExpiresAt <= this.now())
    )
      return this.expired(account);
    return this.refresh(account, tokens.refreshToken);
  }

  private async save(candidate: AuthorizedAccount): Promise<void> {
    const { profileId, accountId, login, tokens } = candidate;
    const previous = this.accounts.find(profileId, accountId);
    const credentialRef = this.prefix(profileId, accountId) + randomUUID();

    await this.secrets.set(credentialRef, JSON.stringify(tokens));

    try {
      if (this.authorized.get(profileId) !== candidate) throw this.failure("cancelled");

      this.accounts.save({ profileId, accountId, login, credentialRef, state: "connected" });
      this.authorized.delete(profileId);
    } catch (error) {
      await this.secrets.delete(credentialRef);
      throw error;
    }

    if (previous && this.owns(previous)) await this.secrets.delete(previous.credentialRef);
  }

  private prefix(profileId: string, accountId: string): string {
    return (
      secretKeys.provider(profileId, `${this.provider}-oauth`, `${this.provider}.com`, accountId) +
      ":"
    );
  }

  private failure(
    reason: keyof typeof messages.github | "signInRequired",
    kind: GitErrorKind = this.provider === "github" ? "github-auth-required" : "auth-failed",
  ): GitError {
    return new GitError({
      kind,
      operation: t(
        this.provider === "github" ? "operations.gitHubSignIn" : "operations.gitLabSignIn",
      ),
      message: errorText(
        reason === "signInRequired"
          ? "main.providerRepositories.signInRequired"
          : messages[this.provider][reason],
      ),
    });
  }
}
