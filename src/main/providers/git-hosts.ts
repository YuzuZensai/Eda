import { GitError } from "@shared/errors";
import { errorText } from "@shared/error-codes";
import { t } from "@shared/i18n";
import { isGitHost, type GitHost, type GitHostPage } from "@shared/integrations/git-host";
import { isRecord } from "@shared/validation";
import { secretKeys, type SecretStore } from "../secrets/secret-store";
import { readResponseBytes } from "../network/response";

type Saved = GitHost & { token: string };

const invalid = (key: "hosts.invalid" | "hosts.access" | "hosts.offline" = "hosts.invalid") =>
  new GitError({
    kind: key === "hosts.access" ? "auth-failed" : "invalid-input",
    operation: t("hosts.title"),
    message: errorText(key),
  });

const secretKey = (profile: string) => secretKeys.identityPrefix(profile) + "git-hosts-v1";

function cloneUrl(account: GitHost, raw: unknown) {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    if (
      u.protocol !== "https:" ||
      u.password ||
      u.search ||
      u.hash ||
      /%(?:2f|5c|2e)/i.test(u.pathname)
    )
      return null;
    u.username = "";
    return u.href.startsWith(account.base + "/") ? u.href : null;
  } catch {
    return null;
  }
}

function repositoriesEndpoint(host: GitHost, page: number | string) {
  const offset = typeof page === "number" ? page : 0;
  switch (host.kind) {
    case "github-enterprise":
      return host.base + "/api/v3/user/repos?per_page=50&page=" + (offset + 1);
    case "bitbucket-cloud": {
      const workspace = new URL(host.base).pathname;
      const query = typeof page === "string" ? page : "?pagelen=50&page=" + (offset + 1);
      return "https://api.bitbucket.org/2.0/repositories" + workspace + query;
    }
    case "bitbucket-server":
      return host.base + "/rest/api/1.0/repos?limit=50&start=" + offset;
    case "azure":
      return host.base + "/_apis/git/repositories?api-version=7.1";
  }
}

export class GitHosts {
  constructor(
    private readonly secrets: SecretStore,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async read(profile: string): Promise<Saved[]> {
    if (!this.secrets.available) return [];
    const stored = await this.secrets.get(secretKey(profile));
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (
      !Array.isArray(parsed) ||
      parsed.length > 16 ||
      !parsed.every((s: unknown) => isGitHost(s) && "token" in s && typeof s.token === "string")
    )
      throw invalid();
    return parsed;
  }

  async accounts(profile: string): Promise<GitHost[]> {
    return (await this.read(profile)).map(({ kind, username, base }) => ({ kind, username, base }));
  }

  async connect(profile: string, host: GitHost, token: string) {
    if (!isGitHost(host) || !token || /[\x00-\x1f]/.test(token)) throw invalid();
    await this.page({ ...host, token }, 0);
    const list = (await this.read(profile)).filter((s) => s.base !== host.base);
    if (list.length >= 16) throw invalid();
    await this.secrets.set(
      secretKey(profile),
      JSON.stringify([
        ...list,
        { kind: host.kind, base: host.base, username: host.username, token },
      ]),
    );
  }

  async disconnect(profile: string, base: string) {
    const keep = (await this.read(profile)).filter((s) => s.base !== base);
    if (keep.length) await this.secrets.set(secretKey(profile), JSON.stringify(keep));
    else await this.secrets.delete(secretKey(profile));
  }

  async forFetch(profile: string, url: string) {
    if (!this.secrets.available) return undefined;
    const host = (await this.read(profile))
      .filter((s) => cloneUrl(s, url) === url)
      .sort((a, b) => b.base.length - a.base.length)[0];
    return host
      ? {
          username: host.kind === "bitbucket-cloud" ? "x-bitbucket-api-token-auth" : host.username,
          password: host.token,
        }
      : undefined;
  }

  async repositories(profile: string, base: string, page: number | string) {
    const host = (await this.read(profile)).find((s) => s.base === base);
    if (!host) throw invalid();
    return this.page(host, page);
  }

  private async page(host: Saved, page: number | string): Promise<GitHostPage> {
    const offset = typeof page === "number" ? page : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw invalid();
    if (
      typeof page === "string" &&
      (host.kind !== "bitbucket-cloud" || !/^\?[^#\s]{1,4095}$/.test(page))
    )
      throw invalid();
    const endpoint = repositoriesEndpoint(host, page);
    const auth =
      host.kind === "github-enterprise"
        ? "Bearer " + host.token
        : "Basic " + Buffer.from(host.username + ":" + host.token).toString("base64");
    const response = await this.request(endpoint, {
      headers: { Accept: "application/json", Authorization: auth },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    }).catch(() => {
      throw invalid("hosts.offline");
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw invalid(
        response.status === 401 || response.status === 403 ? "hosts.access" : "hosts.offline",
      );
    }
    const data: unknown = JSON.parse(
      (await readResponseBytes(response.body, 4 * 1024 * 1024, () => invalid())).toString("utf8"),
    );
    const rows = Array.isArray(data)
      ? data
      : isRecord(data)
        ? data[host.kind === "azure" ? "value" : "values"]
        : null;
    if (!Array.isArray(rows)) throw invalid();
    const entries = rows.flatMap((item: unknown) => {
      if (!isRecord(item)) return [];
      const links = item["links"];
      const clones = isRecord(links) ? links["clone"] : null;
      const http = Array.isArray(clones)
        ? clones.find(
            (c: unknown) => isRecord(c) && (c["name"] === "http" || c["name"] === "https"),
          )
        : null;
      const url = cloneUrl(
        host,
        item["clone_url"] ?? item["remoteUrl"] ?? (isRecord(http) ? http["href"] : null),
      );
      const name = item["full_name"] ?? item["name"];
      return url && typeof name === "string" ? [{ name, url }] : [];
    });
    let next: GitHostPage["next"] = null;
    if (host.kind === "github-enterprise" && /rel="next"/.test(response.headers.get("link") ?? ""))
      next = offset + 1;
    if (isRecord(data) && host.kind === "bitbucket-cloud" && typeof data["next"] === "string") {
      const current = new URL(endpoint);
      const link = URL.parse(data["next"], current);
      if (
        !link ||
        link.origin !== current.origin ||
        link.pathname !== current.pathname ||
        link.username ||
        link.password ||
        link.hash ||
        !link.search ||
        link.search.length > 4096
      )
        throw invalid();
      next = link.search;
    }
    if (
      isRecord(data) &&
      host.kind === "bitbucket-server" &&
      data["isLastPage"] === false &&
      typeof data["nextPageStart"] === "number" &&
      data["nextPageStart"] > offset
    )
      next = data["nextPageStart"];
    return { entries, next };
  }
}
