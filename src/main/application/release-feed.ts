import { readResponseBytes } from "../network/response";
import { ERROR_CODE, errorText } from "@shared/error-codes";
import { AppError } from "@shared/errors";
import {
  UPDATE_PACKAGE_ID,
  updateChannel,
  type UpdatePlatform,
  type UpdateRelease,
} from "@shared/updates";
import { isRecord } from "@shared/validation";
import { releaseFromManifest } from "./update-manifest";
import { newerRelease, type UpdateCheckResult } from "./update-service";

const MAX_FEED_BYTES = 256 * 1024;

export async function readFeed(response: Response): Promise<unknown> {
  if (!response.body) throw new AppError(ERROR_CODE.INVALID_STABLE_VERSION);

  const bytes = await readResponseBytes(
    response.body,
    MAX_FEED_BYTES,
    () => new AppError(ERROR_CODE.INVALID_STABLE_VERSION),
  );

  const text = bytes.toString("utf8");
  let feed: unknown;

  try {
    feed = JSON.parse(text);
  } catch {
    if (!response.ok)
      throw new AppError(errorText("main.releaseFeed.httpFailed", { status: response.status }));

    throw new AppError(ERROR_CODE.INVALID_STABLE_VERSION);
  }

  if (!response.ok)
    throw new AppError(
      errorText("main.releaseFeed.httpFailed", { status: response.status }),
      isRecord(feed) && typeof feed["error"] === "string" ? feed["error"] : undefined,
    );

  return feed;
}

function latestFullRelease(feed: unknown): UpdateRelease {
  if (!isRecord(feed) || !Array.isArray(feed["Assets"]))
    throw new AppError(ERROR_CODE.INVALID_STABLE_VERSION);

  let latest: UpdateRelease | undefined;

  for (const asset of feed["Assets"]) {
    if (!isRecord(asset) || asset["PackageId"] !== UPDATE_PACKAGE_ID || asset["Type"] !== "Full")
      continue;

    const release = releaseFromManifest(asset);

    if (!latest || newerRelease(release.version, latest.version)) latest = release;
  }

  if (!latest) throw new AppError(ERROR_CODE.INVALID_STABLE_VERSION);

  return latest;
}

export async function checkReleaseFeed(
  feedUrl: string,
  platform: UpdatePlatform,
  arch: string,
  request: typeof fetch = fetch,
): Promise<UpdateCheckResult> {
  const url = new URL(`releases.${updateChannel(platform, arch)}.json`, feedUrl);

  const response = await request(url.href, {
    headers: { Accept: "application/json" },
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });

  const feed = await readFeed(response);

  return { available: true, release: latestFullRelease(feed) };
}
