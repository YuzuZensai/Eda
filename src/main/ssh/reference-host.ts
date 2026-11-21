import { AppError } from "@shared/errors";
import { ERROR_CODE } from "@shared/error-codes";
import { homedir } from "node:os";
import { join } from "node:path";
import { readRegularFile } from "../filesystem/read-regular-file";

// Resolve literal HostName entries for browser links without executing SSH configuration.
export function sshReferenceRemote(remote: string, config: string): string | undefined {
  const target = /^(?:git@([\w.-]+):|ssh:\/\/git@([\w.-]+)\/)([\w./-]+)$/.exec(remote);
  if (!target) return;
  const alias = (target[1] ?? target[2])!.toLowerCase();
  let applies = true;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.replace(/\s*#.*$/, "").trim();
    if (!line) continue;
    const [, key, value] = /^(\w+)(?:\s*=\s*|\s+)(.*)$/.exec(line) ?? [];
    if (!key || !value || /^(include|match)$/i.test(key)) return;
    if (key.toLowerCase() === "host") {
      const patterns = value.toLowerCase().split(/\s+/);
      if (patterns.some((pattern) => pattern !== "*" && !/^[\w.-]+$/.test(pattern))) return;
      applies = patterns.includes("*") || patterns.includes(alias);
    } else if (applies && key.toLowerCase() === "hostname") {
      if (!/^[a-z\d.-]+$/i.test(value)) return;
      return `https://${value}/${target[3]}`;
    }
  }
  return undefined;
}

export async function resolveSshReferenceRemote(remote: string) {
  if (!/^(?:git@|ssh:\/\/git@)/.test(remote)) return;
  try {
    const { bytes } = await readRegularFile(
      join(homedir(), ".ssh", "config"),
      128 * 1024,
      () => new AppError(ERROR_CODE.REMOTE_BROWSER_URL_UNAVAILABLE),
    );
    return sshReferenceRemote(remote, bytes.toString("utf8"));
  } catch (error) {
    if (
      (error instanceof AppError && error.code === ERROR_CODE.REMOTE_BROWSER_URL_UNAVAILABLE) ||
      ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return;
    throw error;
  }
}
