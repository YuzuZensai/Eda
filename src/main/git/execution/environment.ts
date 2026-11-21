import { absoluteSearchPath } from "./executable";

export interface GitEnvironmentOptions {
  sshKeyPath?: string;
  askpassPath?: string;
  overrides?: Readonly<Record<string, string>>;
  configScope?: "default" | "none";
}

export const SSH_HOST_TRUST_OPTIONS = [
  "-o",
  "BatchMode=no",
  "-o",
  "StrictHostKeyChecking=ask",
  "-o",
  "FingerprintHash=sha256",
  "-o",
  "PreferredAuthentications=publickey",
  "-o",
  "PasswordAuthentication=no",
  "-o",
  "KbdInteractiveAuthentication=no",
  "-o",
  "NumberOfPasswordPrompts=0",
] as const;

const PASSTHROUGH_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "GNUPGHOME",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "SystemRoot",
  "ComSpec",
  "APPDATA",
  "LOCALAPPDATA",
  // Windows OpenSSH can exit silently if ProgramData is missing.
  "ProgramData",
  "DISPLAY",
  "XDG_RUNTIME_DIR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
] as const;

export function buildGitEnvironment(
  options: GitEnvironmentOptions = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of PASSTHROUGH_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }

  env["GIT_TERMINAL_PROMPT"] = "0";
  env["SSH_ASKPASS_REQUIRE"] = "never";

  env["LC_ALL"] = "C";
  env["LANG"] = "C";

  if (options.sshKeyPath !== undefined) {
    env["GIT_SSH_COMMAND"] = buildSshCommand(options.sshKeyPath);
  }

  if (options.askpassPath !== undefined) {
    env["SSH_ASKPASS"] = options.askpassPath;
    env["SSH_ASKPASS_REQUIRE"] = "force";
    // OpenSSH ignores SSH_ASKPASS unless DISPLAY is set.
    env["DISPLAY"] = env["DISPLAY"] ?? ":0";
  }

  if (options.configScope === "none") {
    env["GIT_CONFIG_GLOBAL"] = "/dev/null";
    env["GIT_CONFIG_SYSTEM"] = "/dev/null";
  }

  Object.assign(env, options.overrides ?? {});
  if (env["PATH"] !== undefined) {
    env["PATH"] =
      absoluteSearchPath(env["PATH"]) ||
      (process.platform === "win32"
        ? `${env["SystemRoot"] ?? "C:\\Windows"}\\System32`
        : "/usr/bin:/bin");
  }

  return env;
}

export function buildSshCommand(keyPath: string): string {
  return ["ssh", "-i", quoteForSshCommand(keyPath), "-o", "IdentitiesOnly=yes"].join(" ");
}

// GIT_SSH_COMMAND is shell text, so the key path needs shell escaping.
export function quoteForSshCommand(keyPath: string): string {
  return `"${keyPath.replace(/(["\\$`])/g, "\\$1")}"`;
}
