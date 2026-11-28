import { isGitLabLogin } from "@shared/integrations/gitlab";
import { readResponseBytes } from "../network/response";
import { createHash, randomUUID } from "node:crypto";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  gitLabTokenSettingsUrl,
  isGitLabInstanceHttps,
  normalizeGitLabInstanceUrl,
  type GitLabSelfHostedStatus,
  type GitLabTokenForm,
} from "@shared/integrations/gitlab-self-hosted";
import type { TransportCredentials } from "@shared/integrations/remotes";
import { isRecord } from "@shared/validation";
import type {
  GitLabSelfHostedAccountRepository,
  SavedGitLabSelfHostedAccount,
} from "../persistence/gitlab-self-hosted-account-repository";
import type { SecretStore } from "../secrets/secret-store";
import { listProviderRepositories } from "./provider-repositories";
import { ProviderProfileCache } from "./provider-profile-cache";
import { gitLabProfileDetails, type GitLabProfileDetails } from "./gitlab-profile";

type Failure =
  | "invalidUrl"
  | "invalidToken"
  | "invalidResponse"
  | "accessRequired"
  | "reconnectRequired"
  | "networkFailed"
  | "storageUnavailable"
  | "cancelled"
  | "overlappingInstance"
  | "rateLimited"
  | "connectFirst";

const fail = (
  key: Failure,
  kind:
    "invalid-input" | "auth-failed" | "network-failed" | "keychain-unavailable" = "invalid-input",
) =>
  new GitError({
    kind,
    operation: t("operations.gitLabSignIn"),
    message: errorText(`main.providers.gitlabSelfHosted.${key}`),
  });

export class GitLabSelfHostedAuth {
  private readonly profiles: ProviderProfileCache<GitLabProfileDetails>;
  private readonly pending = new Map<string, { profileId: string; controller: AbortController }>();
  private readonly saving = new Set<Promise<GitLabSelfHostedStatus>>();

  constructor(
    private readonly accounts: GitLabSelfHostedAccountRepository,
    private readonly secrets: SecretStore,
    private readonly fetch: typeof globalThis.fetch,
    private readonly insecureFetch?: (baseUrl: string) => typeof globalThis.fetch,
    now = Date.now,
  ) {
    this.profiles = new ProviderProfileCache(now);
  }

  status(profileId: string): GitLabSelfHostedStatus {
    return {
      secureStorage: this.secrets.available,
      accounts: this.accounts
        .list(profileId)
        .filter((account) => this.ownsCredential(account))
        .map(({ accountId, login, baseUrl, state, ignoreTlsErrors }) => ({
          id: accountId,
          login,
          baseUrl,
          state,
          ignoreTlsErrors,
        })),
    };
  }

  async profile(profileId: string, input: string) {
    const account = this.requireAccount(profileId, this.baseUrl(input));
    const details = await this.profiles.get(account.credentialRef, async () => {
      const credentials = await this.credentials(account);
      const user = await this.request(
        this.fetchFor(account.baseUrl, account.ignoreTlsErrors),
        `${account.baseUrl}/api/v4/user`,
        credentials.password,
        AbortSignal.timeout(15000),
      );
      this.assertCurrent(account);
      if (String(user["id"]) !== account.accountId) return null;
      return gitLabProfileDetails(account.accountId, user);
    });

    this.assertCurrent(account);
    return details ? { ...details, baseUrl: account.baseUrl } : null;
  }

  tokenSettingsUrl(input: string, form: GitLabTokenForm = "legacy"): string {
    const url = gitLabTokenSettingsUrl(input, form);

    if (!url) throw fail("invalidUrl");

    return url;
  }

  profileUrl(profileId: string, input: string): string {
    const account = this.requireAccount(profileId, this.baseUrl(input));

    if (!isGitLabLogin(account.login)) throw fail("invalidResponse");

    return `${account.baseUrl}/${account.login}`;
  }

  connect(
    profileId: string,
    input: string,
    rawToken: string,
    ignoreTlsErrors = false,
  ): Promise<GitLabSelfHostedStatus> {
    this.requireStorage();

    const baseUrl = this.baseUrl(input);
    const token = rawToken.trim();

    if (!token || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token))
      throw fail("invalidToken");

    this.assertNoOverlap(profileId, baseUrl);

    const key = JSON.stringify([profileId, baseUrl]);
    this.pending.get(key)?.controller.abort();

    const controller = new AbortController();
    const pending = { profileId, controller };
    this.pending.set(key, pending);

    const work = this.saveConnection(
      profileId,
      baseUrl,
      token,
      ignoreTlsErrors,
      controller.signal,
    ).finally(() => {
      if (this.pending.get(key) === pending) this.pending.delete(key);

      this.saving.delete(work);
    });

    this.saving.add(work);

    return work;
  }

  private async saveConnection(
    profileId: string,
    baseUrl: string,
    token: string,
    ignoreTlsErrors: boolean,
    signal: AbortSignal,
  ): Promise<GitLabSelfHostedStatus> {
    const { accountId, login, profile } = await this.validateConnection(
      baseUrl,
      token,
      ignoreTlsErrors,
      signal,
    );

    if (signal.aborted) throw fail("cancelled");

    this.assertNoOverlap(profileId, baseUrl);

    const previous = this.accounts.find(profileId, baseUrl);

    const account: SavedGitLabSelfHostedAccount = {
      profileId,
      baseUrl,
      ignoreTlsErrors,
      accountId,
      login,
      state: "connected",
      credentialRef: "",
    };

    account.credentialRef = this.credentialPrefix(account) + randomUUID();
    await this.secrets.set(account.credentialRef, token);

    try {
      if (signal.aborted) throw fail("cancelled");

      this.assertNoOverlap(profileId, baseUrl);
      this.accounts.save(account);
    } catch (error) {
      await this.secrets.delete(account.credentialRef);
      throw error;
    }

    this.profiles.set(account.credentialRef, profile);

    if (previous && this.ownsCredential(previous)) {
      await this.secrets.delete(previous.credentialRef);
      this.profiles.delete(previous.credentialRef);
    }

    return this.status(profileId);
  }

  private async validateConnection(
    baseUrl: string,
    token: string,
    ignoreTlsErrors: boolean,
    signal: AbortSignal,
  ) {
    const fetch = this.fetchFor(baseUrl, ignoreTlsErrors);
    const user = await this.request(fetch, `${baseUrl}/api/v4/user`, token, signal);

    if (
      !Number.isSafeInteger(user["id"]) ||
      (user["id"] as number) <= 0 ||
      !isGitLabLogin(user["username"])
    )
      throw fail("invalidResponse", "network-failed");

    try {
      await listProviderRepositories(fetch, "gitlab", token, 1, { baseUrl, signal });
    } catch (error) {
      if (signal.aborted) throw fail("cancelled");

      if (error instanceof GitError && error.kind === "auth-failed")
        throw fail("accessRequired", "auth-failed");

      throw error;
    }

    return {
      accountId: String(user["id"]),
      login: user["username"],
      profile: gitLabProfileDetails(String(user["id"]), user),
    };
  }

  cancel(profileId: string): void {
    for (const pending of this.pending.values())
      if (pending.profileId === profileId) pending.controller.abort();
  }

  cancelAll(): void {
    for (const pending of this.pending.values()) pending.controller.abort();
  }

  async reset(): Promise<void> {
    this.cancelAll();

    await Promise.allSettled([...this.saving]);
    await this.profiles.clear();
  }

  async disconnect(profileId: string, input: string): Promise<void> {
    const baseUrl = this.baseUrl(input);

    this.pending.get(JSON.stringify([profileId, baseUrl]))?.controller.abort();

    const account = this.accounts.find(profileId, baseUrl);

    if (!account) return;

    this.requireStorage();

    if (this.ownsCredential(account)) await this.secrets.delete(account.credentialRef);

    if (this.accounts.find(profileId, baseUrl)?.credentialRef === account.credentialRef)
      this.accounts.delete(profileId, baseUrl);
    this.profiles.delete(account.credentialRef);
  }

  async forFetch(profileId: string, url: string): Promise<TransportCredentials | undefined> {
    const account = this.accounts
      .list(profileId)
      .find((saved) => isGitLabInstanceHttps(url, saved.baseUrl));

    return account ? this.credentials(account) : undefined;
  }

  ignoresTlsErrors(profileId: string, url: string): boolean {
    const account = this.accounts
      .list(profileId)
      .find((saved) => isGitLabInstanceHttps(url, saved.baseUrl));

    return !!account && this.ownsCredential(account) && account.ignoreTlsErrors;
  }

  async repositories(profileId: string, input: string, page = 1) {
    const account = this.requireAccount(profileId, this.baseUrl(input));
    const credentials = await this.credentials(account);

    try {
      const result = await listProviderRepositories(
        this.fetchFor(account.baseUrl, account.ignoreTlsErrors),
        "gitlab",
        credentials.password,
        page,
        { baseUrl: account.baseUrl },
        profileId,
      );

      this.assertCurrent(account);

      return result;
    } catch (error) {
      if (
        error instanceof GitError &&
        error.text.key === "main.providerRepositories.signInRequired"
      )
        this.expired(account);

      throw error;
    }
  }

  private baseUrl(input: string): string {
    const url = normalizeGitLabInstanceUrl(input);

    if (!url) throw fail("invalidUrl");

    return url;
  }

  private assertNoOverlap(profileId: string, baseUrl: string): void {
    if (
      this.accounts
        .list(profileId)
        .some(
          (account) =>
            account.baseUrl !== baseUrl &&
            (account.baseUrl.startsWith(baseUrl + "/") ||
              baseUrl.startsWith(account.baseUrl + "/")),
        )
    )
      throw fail("overlappingInstance");
  }

  private requireAccount(profileId: string, baseUrl: string): SavedGitLabSelfHostedAccount {
    const account = this.accounts.find(profileId, baseUrl);

    if (!account || !this.ownsCredential(account)) throw fail("connectFirst", "auth-failed");

    return account;
  }

  private requireStorage(): void {
    if (!this.secrets.available) throw fail("storageUnavailable", "keychain-unavailable");
  }

  private credentialPrefix(account: SavedGitLabSelfHostedAccount): string {
    const owner = createHash("sha256")
      .update(JSON.stringify([account.baseUrl, account.accountId]))
      .digest("hex");

    return `identity:${account.profileId}:provider:gitlab-pat:${owner}:`;
  }

  private ownsCredential(account: SavedGitLabSelfHostedAccount): boolean {
    return (
      normalizeGitLabInstanceUrl(account.baseUrl) === account.baseUrl &&
      account.credentialRef.startsWith(this.credentialPrefix(account))
    );
  }

  private assertCurrent(account: SavedGitLabSelfHostedAccount): void {
    if (
      this.accounts.find(account.profileId, account.baseUrl)?.credentialRef !==
      account.credentialRef
    )
      throw fail("cancelled", "auth-failed");
  }

  private expired(account: SavedGitLabSelfHostedAccount): never {
    this.assertCurrent(account);
    this.accounts.save({ ...account, state: "expired" });

    throw fail("reconnectRequired", "auth-failed");
  }

  private async credentials(account: SavedGitLabSelfHostedAccount): Promise<TransportCredentials> {
    this.requireStorage();

    if (!this.ownsCredential(account) || account.state !== "connected")
      throw fail("reconnectRequired", "auth-failed");

    const token = await this.secrets.get(account.credentialRef);
    this.assertCurrent(account);

    if (!token || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token))
      return this.expired(account);

    return { username: "oauth2", password: token };
  }

  private fetchFor(baseUrl: string, ignoreTlsErrors: boolean): typeof globalThis.fetch {
    if (!ignoreTlsErrors) return this.fetch;
    if (!this.insecureFetch) throw fail("networkFailed", "network-failed");
    return this.insecureFetch(baseUrl);
  }

  private async request(
    fetch: typeof globalThis.fetch,
    url: string,
    token: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: { Accept: "application/json", "User-Agent": "Eda", "PRIVATE-TOKEN": token },
      });

      if (!response.ok || !response.body) {
        await response.body?.cancel();

        if (response.status === 401) throw fail("invalidToken", "auth-failed");
        if (response.status === 403) throw fail("accessRequired", "auth-failed");
        if (response.status === 429) throw fail("rateLimited", "network-failed");

        throw fail("networkFailed", "network-failed");
      }

      return await this.readResponse(response.body);
    } catch (error) {
      if (signal.aborted) throw fail("cancelled");
      if (error instanceof GitError) throw error;

      throw fail("networkFailed", "network-failed");
    }
  }

  private async readResponse(body: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
    const bytes = await readResponseBytes(body, 1024 * 1024, () =>
      fail("invalidResponse", "network-failed"),
    );

    const data: unknown = JSON.parse(bytes.toString("utf8"));

    if (!isRecord(data)) throw fail("invalidResponse", "network-failed");

    return data;
  }
}
