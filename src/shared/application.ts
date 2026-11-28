export type DesktopPlatform = "mac" | "windows" | "linux";

export const PACKAGE_MANAGER_NAMES = {
  homebrew: "Homebrew",
  dpkg: "APT / dpkg",
  rpm: "RPM",
  pacman: "Pacman",
} as const;

export type InstallationInfo =
  | { method: "development" | "direct" | "unknown" }
  | { method: "homebrew" }
  | { method: "system-package"; manager: "dpkg" | "rpm" | "pacman" };

export interface GraphicsStatus {
  enabledAtStartup: boolean;
  compositing: "hardware" | "software" | "pending";
}

export const DEVELOPMENT_DESKTOP = {
  name: "Eda Dev",
  id: "cafe.kirameki.eda.dev",
  file: "cafe.kirameki.eda.dev.desktop",
} as const;

export const DEVELOPMENT_RESTART = {
  request: "eda:development:restart",
  importRequest: "eda:import-release-data:restart",
  ready: "eda:development:restart-ready",
  argument: "--eda-import-release-data",
} as const;

export type DevelopmentRestartAction = "restart" | "import-release-data";

export interface DetectedEditor {
  name: string;
  executable: string;
}
