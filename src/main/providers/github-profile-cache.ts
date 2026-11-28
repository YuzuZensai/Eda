import { isGitHubLogin, type GitHubAccountProfile } from "@shared/integrations/github";
import { isRecord } from "@shared/validation";
import { ProviderProfileCache } from "./provider-profile-cache";

export type GitHubProfileDetails = Omit<GitHubAccountProfile, "avatarDataUrl"> & {
  avatarUrl: string | null;
};
type PublicProfile = GitHubProfileDetails;
type Account = { id?: string; login: string };

const ID = /^[1-9][0-9]{0,15}$/;

function field(value: unknown, limit: number): string | null {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, limit) || null
    : null;
}

function profile(value: unknown): PublicProfile | null {
  if (!isRecord(value)) return null;

  const id = String(value["id"]);
  const login = value["login"];

  if (!ID.test(id) || !isGitHubLogin(login)) return null;

  return {
    id,
    login,
    name: field(value["name"], 128),
    bio: field(value["bio"], 160),
    location: field(value["location"], 128),
    avatarUrl: typeof value["avatar_url"] === "string" ? value["avatar_url"] : null,
  };
}

function matches(key: string, value: PublicProfile): boolean {
  return key.startsWith("login:") ? key === `login:${value.login.toLowerCase()}` : key === value.id;
}

export class GitHubProfileCache {
  private readonly cache: ProviderProfileCache<PublicProfile>;

  constructor(
    private readonly request: (url: string) => Promise<Record<string, unknown>>,
    now = Date.now,
  ) {
    this.cache = new ProviderProfileCache(now);
  }

  peek(id: string): PublicProfile | null {
    return this.cache.peek(id);
  }

  async get(account: Account): Promise<PublicProfile | null> {
    if (!isGitHubLogin(account.login) || (account.id !== undefined && !ID.test(account.id)))
      return null;
    const key = account.id ?? `login:${account.login.toLowerCase()}`;
    const fallback = account.id
      ? {
          id: account.id,
          login: account.login,
          name: null,
          bio: null,
          location: null,
          avatarUrl: null,
        }
      : null;
    return this.cache.get(
      key,
      async () => {
        const raw = await this.request(
          account.id
            ? `https://api.github.com/user/${account.id}`
            : `https://api.github.com/users/${account.login}`,
        );
        const details = profile(raw);
        return typeof raw["id"] === "number" &&
          Number.isSafeInteger(raw["id"]) &&
          details &&
          matches(key, details)
          ? details
          : null;
      },
      fallback,
    );
  }

  clear(): Promise<void> {
    return this.cache.clear();
  }
}
