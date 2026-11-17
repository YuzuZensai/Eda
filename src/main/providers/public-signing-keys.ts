import { AppError } from "@shared/errors";
import { errorText } from "@shared/error-codes";
import type { PublicKeyRequest } from "@shared/repository/repository-read";
import { readResponseBytes } from "../network/response";

export const PUBLIC_KEY_LIMIT = 256 * 1024;
export function keyError() {
  return new AppError(errorText("main.signatureKeys.failed"));
}

export class PublicSigningKeys {
  constructor(private readonly request: typeof fetch) {}

  async find(
    input: Extract<PublicKeyRequest, { source: "github" | "keyserver" }>,
    keyId: string,
    signal: AbortSignal,
  ) {
    let url: URL;
    if (input.source === "github") {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(input.account)) throw keyError();
      url = new URL(`https://github.com/${input.account}.gpg`);
    } else {
      url = new URL(input.server);
      // Discovery never follows key-supplied URLs or redirects to other services.
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        !/^(?:[A-F\d]{16}|[A-F\d]{40}|[A-F\d]{64})$/i.test(keyId)
      )
        throw keyError();
      url.pathname = "/pks/lookup";
      url.search = new URLSearchParams({
        op: "get",
        options: "mr",
        search: `0x${keyId}`,
      }).toString();
    }
    const response = await this.request(url.href, {
      signal,
      redirect: "error",
      credentials: "omit",
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw keyError();
    }
    const bytes = await readResponseBytes(response.body, PUBLIC_KEY_LIMIT, keyError);
    return { armoredKey: bytes.toString("utf8"), source: url.origin + url.pathname };
  }
}
