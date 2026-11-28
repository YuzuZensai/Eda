import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { isRecord } from "@shared/validation";
import { readResponseBytes } from "../network/response";

export interface OAuthTokens {
  clientId: string;
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}

const responseMessages = {
  github: {
    rejected: "main.providers.githubAuth.gitHubRejectedThisLoginSignInAgain",
    requestFailed: "main.providers.githubAuth.gitHubCouldNotCompleteTheRequestCheck",
    tooLarge: "main.providers.githubAuth.gitHubSResponseExceededTheSupportedSize",
    invalid: "main.providers.githubAuth.gitHubReturnedAnInvalidResponse",
    unreachable:
      "main.providers.githubAuth.couldNotReachGitHubCheckYourConnectionAndTrySigningInAgain",
  },
  gitlab: {
    rejected: "main.providers.gitlabAuth.gitLabRejectedThisLoginSignInAgain",
    requestFailed: "main.providers.gitlabAuth.gitLabCouldNotCompleteTheRequestCheck",
    tooLarge: "main.providers.gitlabAuth.gitLabSResponseExceededTheSupportedSize",
    invalid: "main.providers.gitlabAuth.gitLabReturnedAnInvalidResponse",
    unreachable:
      "main.providers.gitlabAuth.couldNotReachGitLabCheckYourConnectionAndTrySigningInAgain",
  },
} as const;

export async function requestOAuth(
  fetch: typeof globalThis.fetch,
  provider: "github" | "gitlab",
  url: string,
  form?: Record<string, string>,
  signal?: AbortSignal,
  accessToken?: string,
): Promise<Record<string, unknown>> {
  const messages = responseMessages[provider];
  const authKind = provider === "github" ? "github-auth-required" : "auth-failed";

  const fail = (
    message: ErrorText,
    kind: "invalid-input" | "network-failed" | typeof authKind = "invalid-input",
  ) =>
    new GitError({
      kind,
      operation: t(provider === "github" ? "operations.gitHubSignIn" : "operations.gitLabSignIn"),
      message,
    });

  try {
    const response = await fetch(url, {
      method: form ? "POST" : "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        "User-Agent": "Eda",
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });

    if ((!response.ok && !(form && response.status === 400)) || !response.body) {
      await response.body?.cancel();

      throw fail(
        response.status === 401 ? errorText(messages.rejected) : errorText(messages.requestFailed),
        response.status === 401 ? authKind : "network-failed",
      );
    }

    const bytes = await readResponseBytes(response.body, 64 * 1024, () =>
      fail(errorText(messages.tooLarge)),
    );

    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value)) throw fail(errorText(messages.invalid));
    return value;
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw fail(errorText(messages.unreachable), "network-failed");
  }
}

export function tokenText(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\s\0]/.test(value)
    ? value
    : undefined;
}

export function tokenSeconds(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 366 * 24 * 60 * 60
    ? value
    : undefined;
}

export function parseTokenResponse(
  response: Record<string, unknown>,
  clientId: string,
  now: number,
): OAuthTokens | undefined {
  const accessToken = tokenText(response["access_token"]);
  const refreshToken = tokenText(response["refresh_token"]);
  const expires = tokenSeconds(response["expires_in"]);
  const refreshExpires = tokenSeconds(response["refresh_token_expires_in"]);

  if (
    !accessToken ||
    (response["expires_in"] !== undefined && !expires) ||
    (response["refresh_token"] !== undefined && !refreshToken) ||
    (response["refresh_token_expires_in"] !== undefined && !refreshExpires)
  )
    return undefined;

  return {
    clientId,
    accessToken,
    ...(expires ? { expiresAt: now + expires * 1000 } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(refreshExpires ? { refreshExpiresAt: now + refreshExpires * 1000 } : {}),
  };
}

export function readOAuthTokens(
  raw: string | undefined,
  expectedClientId: string,
): OAuthTokens | undefined {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!isRecord(value)) return undefined;

    const accessToken = tokenText(value["accessToken"]);
    const clientId = tokenText(value["clientId"]);
    const expiresAt = value["expiresAt"];
    const refreshToken = tokenText(value["refreshToken"]);
    const refreshExpiresAt = value["refreshExpiresAt"];

    if (
      accessToken &&
      clientId === expectedClientId &&
      (expiresAt === undefined ||
        (typeof expiresAt === "number" && Number.isSafeInteger(expiresAt))) &&
      (value["refreshToken"] === undefined || refreshToken !== undefined) &&
      (refreshExpiresAt === undefined ||
        (typeof refreshExpiresAt === "number" && Number.isSafeInteger(refreshExpiresAt)))
    )
      return {
        accessToken,
        clientId,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(refreshToken !== undefined ? { refreshToken } : {}),
        ...(refreshExpiresAt !== undefined ? { refreshExpiresAt } : {}),
      };
  } catch {
    return undefined;
  }

  return undefined;
}
