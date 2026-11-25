export function isStableVersion(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

export interface BuildInfo {
  version: string;
  displayVersion: string;
  commit: string | null;
  dirty: boolean | null;
}
