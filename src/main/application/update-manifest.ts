import type { UpdateRelease } from "@shared/updates";
import { isRecord } from "@shared/validation";
import { isStableVersion } from "@shared/version";
import { AppError } from "@shared/errors";
import { ERROR_CODE } from "@shared/error-codes";
import { UPDATE_PACKAGE_ID } from "@shared/updates";

export function releaseFromManifest(info: unknown): UpdateRelease {
  if (
    !isRecord(info) ||
    info["PackageId"] !== UPDATE_PACKAGE_ID ||
    info["Type"] !== "Full" ||
    !isStableVersion(info["Version"]) ||
    (info["NotesMarkdown"] != null && typeof info["NotesMarkdown"] !== "string")
  )
    throw new AppError(ERROR_CODE.INVALID_STABLE_VERSION);

  return {
    version: info["Version"],
    name: `Eda ${info["Version"]}`,
    notes: info["NotesMarkdown"]?.slice(0, 16_000) || null,
    releasedAt: null,
  };
}
