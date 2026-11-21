export interface GitLabAccount {
  id: string;
  login: string;
  state: "connected" | "expired" | "revoked";
}
export interface GitLabStatus {
  alternatives?: GitLabAccount[];
  secureStorage: boolean;
  account: GitLabAccount | null;
}
export interface GitLabAccountProfile {
  id: string;
  name: string | null;
  bio: string | null;
  location: string | null;
  avatarDataUrl: string | null;
}
export interface GitLabSignIn {
  id: string;
  expiresAt: number;
}
export type GitLabSignInResult =
  { state: "pending" } | { state: "connected"; status: GitLabStatus };

export function isGitLabHttps(url: string): boolean {
  try {
    const value = new URL(url);
    return (
      value.protocol === "https:" &&
      value.hostname === "gitlab.com" &&
      !value.port &&
      !value.username &&
      !value.password &&
      !value.search &&
      !value.hash &&
      /^\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\/?$/.test(value.pathname) &&
      !value.pathname.split("/").some((part) => part === "." || part === "..")
    );
  } catch {
    return false;
  }
}
