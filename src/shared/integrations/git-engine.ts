export type GitEnginePreference = "bundled" | "system" | "custom";
export type GitEngineSource = GitEnginePreference;

export interface GitEngineInfo {
  source: GitEngineSource;
  path: string;
  version: string;
}

export interface GitDiagnostics {
  executable: string;
  platform: string;
  build: string;
  commands: string[];
  wsl?: "linux" | "wslg";
  lfsVersion: string | null;
}
