import { join } from "node:path";

export function fixtureEnvironment(root: string, source: NodeJS.ProcessEnv = process.env) {
  const env: Record<string, string> = {};
  const allowed = new Set([
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PROGRAMDATA",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "CI",
    "TERM",
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;
  }
  return Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, "appdata"),
    LOCALAPPDATA: join(root, "localappdata"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    GNUPGHOME: join(root, "gnupg"),
    SSH_AUTH_SOCK: "",
    SSH_AGENT_PID: "",
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_PARAMETERS: "",
    GIT_ATTR_NOSYSTEM: "1",
    LANG: "C",
    LC_ALL: "C",
  });
}
