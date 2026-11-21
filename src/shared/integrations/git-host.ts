import { isOneOf, isRecord } from "../validation";
export const gitHostKinds = [
  "github-enterprise",
  "bitbucket-cloud",
  "bitbucket-server",
  "azure",
] as const;
export type GitHostKind = (typeof gitHostKinds)[number];
export interface GitHost {
  kind: GitHostKind;
  base: string;
  username: string;
}
export interface GitHostPage {
  entries: { name: string; url: string }[];
  next: number | string | null;
}
export function gitHostBase(kind: GitHostKind, input: string): string | null {
  try {
    const u = new URL(input);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !/^\/(?:[a-z0-9._/-]|%20)*$/i.test(u.pathname) ||
      /[\\\x00-\x1f]/.test(input)
    )
      return null;
    const path = u.pathname.replace(/\/$/, "");
    if (kind === "bitbucket-cloud" && (u.host !== "bitbucket.org" || !/^\/[\w.-]+$/.test(path)))
      return null;
    if (
      kind === "azure" &&
      (u.host !== "dev.azure.com" || !/^\/[\w.-]+\/(?:[\w.-]|%20)+$/.test(path))
    )
      return null;
    if (kind === "github-enterprise" && (path || u.hostname === "github.com")) return null;
    if (kind === "bitbucket-server" && u.hostname === "bitbucket.org") return null;
    return u.origin + path;
  } catch {
    return null;
  }
}
export function isGitHost(value: unknown): value is GitHost {
  return (
    isRecord(value) &&
    isOneOf(value["kind"], gitHostKinds) &&
    typeof value["username"] === "string" &&
    /^[^:\x00-\x1f]{1,254}$/.test(value["username"]) &&
    typeof value["base"] === "string" &&
    value["base"].length <= 2048 &&
    gitHostBase(value["kind"], value["base"]) === value["base"]
  );
}
