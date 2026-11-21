import { ERROR_CODE, ERROR_MESSAGE_KEYS, errorText } from "@shared/error-codes";
import { AppError } from "@shared/errors";
import { join } from "node:path";

export function bundledGitLocation(
  packaged: boolean,
  appPath: string,
  resourcesPath: string,
  platform = process.platform,
  arch = process.arch,
): string {
  const os = { win32: "win", darwin: "mac", linux: "linux" }[
    platform as "win32" | "darwin" | "linux"
  ];
  if (!os || !["x64", "arm64"].includes(arch))
    throw new AppError(
      errorText(ERROR_MESSAGE_KEYS[ERROR_CODE.UNSUPPORTED_GIT_BUNDLE], {
        platform: platform,
        arch: arch,
      }),
    );
  return packaged ? join(resourcesPath, "git") : join(appPath, "vendor", "git", `${os}-${arch}`);
}

export function bundledGitBinary(root: string, platform = process.platform): string {
  return join(root, platform === "win32" ? "cmd/git.exe" : "bin/git");
}

export function bundledGitEnvironment(
  root: string,
  source: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  arch = process.arch,
): Record<string, string> {
  const windows = platform === "win32";
  const runtime = arch === "arm64" ? "clangarm64" : "ucrt64";
  const bins = windows
    ? [join(root, "cmd"), join(root, runtime, "bin"), join(root, "usr/bin")]
    : [join(root, "openssh/bin"), join(root, "bin")];
  const env: Record<string, string> = {
    PATH: [...bins, source["PATH"] ?? source["Path"] ?? ""].join(windows ? ";" : ":"),
    GIT_EXEC_PATH: join(root, windows ? `${runtime}/libexec/git-core` : "libexec/git-core"),
  };

  if (!windows) {
    env["GIT_TEMPLATE_DIR"] = join(root, "share/git-core/templates");
    if (!source["GIT_CONFIG_SYSTEM"]) env["GIT_CONFIG_SYSTEM"] = join(root, "etc/gitconfig");
  }

  if (platform === "linux") {
    env["PREFIX"] = root;
    env["GIT_SSL_CAINFO"] = source["GIT_SSL_CAINFO"] ?? join(root, "ssl/cacert.pem");
  }

  return env;
}
