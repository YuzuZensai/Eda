import { createHash } from "node:crypto";
import { readResponseBytes } from "../network/response";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { isGitHubHttps } from "@shared/integrations/github";
import { isGitLabHttps } from "@shared/integrations/gitlab";
import {
  isGitLabInstanceHttps,
  normalizeGitLabInstanceUrl,
} from "@shared/integrations/gitlab-self-hosted";
import { hostCapabilities } from "@shared/integrations/provider-repositories";
import type {
  ProviderRepository,
  ProviderRepositoryPage,
  RepositoryProvider,
} from "@shared/integrations/provider-repositories";
import { isRecord } from "@shared/validation";

const pages = new Map<string, { etag: string; page: ProviderRepositoryPage }>();

export async function listProviderRepositories(
  fetch: typeof globalThis.fetch,
  provider: RepositoryProvider,
  accessToken: string,
  page: number,
  gitlabInstance?: { baseUrl: string; signal?: AbortSignal },
  profileId?: string,
): Promise<ProviderRepositoryPage> {
  const fail = (
    kind: "auth-failed" | "network-failed" | "invalid-input",
    key:
      | "loadFailed"
      | "invalidResponse"
      | "signInRequired"
      | "accessRequired"
      | "rateLimited"
      | "ssoRequired",
  ) =>
    new GitError({
      kind,
      operation: t("main.providerRepositories.operation"),
      message: errorText(`main.providerRepositories.${key}`),
    });

  if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
    throw fail("invalid-input", "invalidResponse");

  if (
    gitlabInstance &&
    (provider !== "gitlab" ||
      normalizeGitLabInstanceUrl(gitlabInstance.baseUrl) !== gitlabInstance.baseUrl)
  )
    throw fail("invalid-input", "invalidResponse");

  const url =
    provider === "github"
      ? `https://api.github.com/user/repos?sort=updated&direction=desc&per_page=50&page=${page}`
      : `${gitlabInstance?.baseUrl ?? "https://gitlab.com"}/api/v4/projects?membership=true&order_by=last_activity_at&sort=desc&per_page=50&page=${page}`;

  const cacheKey =
    profileId &&
    JSON.stringify([profileId, url, createHash("sha256").update(accessToken).digest("hex")]);
  const cached = cacheKey ? pages.get(cacheKey) : undefined;
  try {
    const response = await fetch(url, {
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: gitlabInstance?.signal
        ? AbortSignal.any([gitlabInstance.signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
      headers: {
        Accept: "application/json",
        "User-Agent": "Eda",
        ...(cached && { "If-None-Match": cached.etag }),
        ...(gitlabInstance
          ? { "PRIVATE-TOKEN": accessToken }
          : { Authorization: `Bearer ${accessToken}` }),
      },
    });

    if (response.status === 304 && cached) return cached.page;
    if (!response.ok || !response.body) {
      if (cacheKey) pages.delete(cacheKey);
      await response.body?.cancel();

      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")))
      )
        throw fail("network-failed", "rateLimited");
      if (
        response.status === 403 &&
        /^required\b/i.test(response.headers.get("x-github-sso") ?? "")
      )
        throw fail("auth-failed", "ssoRequired");
      throw response.status === 401
        ? fail("auth-failed", "signInRequired")
        : response.status === 403
          ? fail("auth-failed", "accessRequired")
          : fail("network-failed", "loadFailed");
    }

    const bytes = await readResponseBytes(response.body, 4 * 1024 * 1024, () =>
      fail("network-failed", "invalidResponse"),
    );

    const data: unknown = JSON.parse(bytes.toString("utf8"));

    if (!Array.isArray(data) || data.length > 50) throw fail("network-failed", "invalidResponse");

    const repositories = data.map((item: unknown): ProviderRepository => {
      if (!isRecord(item)) throw fail("network-failed", "invalidResponse");

      const fullName = provider === "github" ? item["full_name"] : item["path_with_namespace"];
      const cloneUrl = provider === "github" ? item["clone_url"] : item["http_url_to_repo"];

      const validUrl =
        provider === "github"
          ? isGitHubHttps
          : gitlabInstance
            ? (remote: string) => isGitLabInstanceHttps(remote, gitlabInstance.baseUrl)
            : isGitLabHttps;

      if (
        !Number.isSafeInteger(item["id"]) ||
        (item["id"] as number) <= 0 ||
        typeof fullName !== "string" ||
        fullName.length > 1024 ||
        typeof cloneUrl !== "string" ||
        !validUrl(cloneUrl) ||
        typeof item["archived"] !== "boolean" ||
        (provider === "github"
          ? typeof item["private"] !== "boolean"
          : typeof item["visibility"] !== "string")
      )
        throw fail("network-failed", "invalidResponse");

      return {
        id: String(item["id"]),
        name: fullName.split("/").at(-1)!,
        fullName,
        description:
          typeof item["description"] === "string" ? item["description"].slice(0, 2048) : null,
        cloneUrl,
        private:
          provider === "github" ? (item["private"] as boolean) : item["visibility"] !== "public",
        archived: item["archived"],
        updatedAt:
          typeof item[provider === "github" ? "updated_at" : "last_activity_at"] === "string"
            ? (item[provider === "github" ? "updated_at" : "last_activity_at"] as string)
            : null,
      };
    });

    const hasNext =
      hostCapabilities[provider].pagination === "link"
        ? /rel="next"/.test(response.headers.get("link") ?? "")
        : !!response.headers.get("x-next-page");

    const result = { repositories, nextPage: hasNext && page < 10000 ? page + 1 : null };
    const etag = response.headers.get("etag");
    if (cacheKey) {
      pages.delete(cacheKey);
      if (
        etag &&
        etag.length <= 512 &&
        !/no-store/i.test(response.headers.get("cache-control") ?? "")
      ) {
        pages.set(cacheKey, { etag, page: result });
        if (pages.size > 32) pages.delete(pages.keys().next().value!);
      }
    }
    return result;
  } catch (error) {
    if (error instanceof GitError) throw error;

    throw fail("network-failed", "loadFailed");
  }
}
