import { isRecord } from "@shared/validation";

export function nullIfFileMissing(error: unknown): null {
  if (isRecord(error) && error["code"] === "ENOENT") return null;
  throw error;
}
