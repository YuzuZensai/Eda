import { errorFixture } from "../helpers/error";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as FileSystem from "node:fs";
import { join } from "node:path";

const appData = "/eda-test-missing-user-data";

const startup = vi.hoisted(() => ({
  createServices: vi.fn(),
  applyReleaseDataImport: vi.fn(),
  migrateMacosKeychain: vi.fn(),
  showErrorBox: vi.fn(),
  showMessageBox: vi.fn(),
  exit: vi.fn(),
  hasSwitch: vi.fn(() => false),
  setPath: vi.fn(),
  setName: vi.fn(),
  setDesktopName: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  readdirSync: vi.fn(() => [] as string[]),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystem>()),
  existsSync: startup.existsSync,
  mkdirSync: startup.mkdirSync,
  chmodSync: vi.fn(),
  renameSync: startup.renameSync,
  readdirSync: startup.readdirSync,
}));
vi.mock("@main/git/execution/shell-path", () => ({
  restoreShellPath: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@main/persistence/import-release-data", () => ({
  applyReleaseDataImport: startup.applyReleaseDataImport,
}));
vi.mock("@main/services", () => ({ createServices: startup.createServices }));
vi.mock("@main/secrets/migrate-macos-keychain", () => ({
  migrateMacosKeychain: startup.migrateMacosKeychain,
}));
vi.mock("@main/ipc/register", () => ({ registerIpcHandlers: vi.fn() }));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    commandLine: { hasSwitch: startup.hasSwitch },
    getPath: () => appData,
    setPath: startup.setPath,
    setName: startup.setName,
    setDesktopName: startup.setDesktopName,
    setAppUserModelId: vi.fn(),
    getName: () => "Eda",
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPreferredSystemLanguages: () => ["en-US"],
    on: vi.fn(),
    exit: startup.exit,
  },
  BrowserWindow: vi.fn(),
  dialog: { showErrorBox: startup.showErrorBox, showMessageBox: startup.showMessageBox },
  Menu: { setApplicationMenu: vi.fn() },
  session: {
    defaultSession: {
      clearStorageData: vi.fn(),
      clearCache: vi.fn(),
      webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn() },
    },
  },
  shell: {},
}));

beforeEach(() => {
  startup.createServices.mockImplementation(() => new Promise(() => {}));
  startup.migrateMacosKeychain.mockResolvedValue(undefined);
  startup.existsSync.mockReturnValue(false);
  startup.readdirSync.mockReturnValue([]);
  startup.showMessageBox.mockResolvedValue({ response: 0 });
  vi.stubEnv("VITE_DEV_SERVER_URL", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  { devServer: "", name: "Eda" },
  { devServer: "http://localhost:5173", name: "Eda-Dev" },
])("preserves existing data when renaming the $name directory", async ({ devServer, name }) => {
  vi.stubEnv("VITE_DEV_SERVER_URL", devServer);
  startup.existsSync.mockImplementation((path?: unknown) =>
    String(path).endsWith(name.toLowerCase()),
  );
  const userData = join(appData, name);
  const legacyData = join(appData, name.toLowerCase());
  startup.readdirSync.mockReturnValue([name.toLowerCase()]);

  await import("@main/index");

  expect(startup.renameSync).toHaveBeenCalledExactlyOnceWith(legacyData, userData);
  expect(startup.setPath).toHaveBeenCalledExactlyOnceWith("userData", userData);
});

it("keeps an existing capitalized data directory without replacing it", async () => {
  startup.existsSync.mockReturnValue(true);
  startup.readdirSync.mockReturnValue(["Eda", "eda"]);

  await import("@main/index");

  expect(startup.renameSync).not.toHaveBeenCalled();
  expect(startup.setPath).toHaveBeenCalledWith("userData", join(appData, "Eda"));
});

it("capitalizes the existing folder on a case-insensitive filesystem", async () => {
  startup.existsSync.mockReturnValue(true);
  startup.readdirSync.mockReturnValue(["eda"]);

  await import("@main/index");

  expect(startup.renameSync).toHaveBeenCalledExactlyOnceWith(
    join(appData, "eda"),
    join(appData, "Eda"),
  );
});

it("preserves an explicit user-data-dir override", async () => {
  startup.hasSwitch.mockReturnValueOnce(true);

  await import("@main/index");

  expect(startup.mkdirSync).not.toHaveBeenCalled();
  expect(startup.renameSync).not.toHaveBeenCalled();
  expect(startup.setPath).not.toHaveBeenCalled();
});

it("reports a missing Git installation visibly and exits instead of remaining windowless", async () => {
  const { GitError } = await import("@shared/errors");
  const failure = new GitError(
    errorFixture({
      kind: "git-not-found",
      operation: "locate Git",
      message: "Eda could not find a working Git installation.",
      suggestedAction: "Install Git and restart Eda.",
    }),
  );

  startup.createServices.mockRejectedValueOnce(failure);

  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

  await import("@main/index");

  await vi.waitFor(() => expect(startup.exit).toHaveBeenCalledWith(1));
  expect(startup.showErrorBox).toHaveBeenCalledExactlyOnceWith(
    "Eda could not start",
    `${failure.message}\n\n${failure.suggestedAction}`,
  );
  expect(log).toHaveBeenCalledWith("Eda could not start:", failure.message);
  expect(startup.showErrorBox.mock.invocationCallOrder[0]).toBeLessThan(
    startup.exit.mock.invocationCallOrder[0]!,
  );
});

it("offers startup recovery for migration history mismatches instead of an exit-only error box", async () => {
  const { AppError } = await import("@shared/errors");
  const { ERROR_CODE } = await import("@shared/error-codes");
  startup.createServices.mockRejectedValueOnce(new AppError(ERROR_CODE.MIGRATION_HISTORY_MISMATCH));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await import("@main/index");
  await vi.waitFor(() => expect(startup.exit).toHaveBeenCalledWith(1));
  expect(startup.showMessageBox).toHaveBeenCalledWith(
    expect.objectContaining({
      buttons: ["Quit", "Clear data and start over"],
      defaultId: 0,
      cancelId: 0,
    }),
  );
  expect(startup.showErrorBox).not.toHaveBeenCalled();
});

it.each([true, false])(
  "checks for a staged release snapshot before opening the development database (explicit restart=%s)",
  async (restart) => {
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
    const argv = [...process.argv];
    if (restart) process.argv.push("--eda-import-release-data");
    try {
      await import("@main/index");
      await vi.waitFor(() => expect(startup.createServices).toHaveBeenCalled());
      expect(startup.applyReleaseDataImport).toHaveBeenCalledWith(appData, restart);
      expect(startup.applyReleaseDataImport.mock.invocationCallOrder[0]).toBeLessThan(
        startup.createServices.mock.invocationCallOrder[0]!,
      );
      expect(process.argv).not.toContain("--eda-import-release-data");
    } finally {
      process.argv.splice(0, process.argv.length, ...argv);
    }
  },
);

it("rejects the import startup argument outside a development session", async () => {
  const argv = [...process.argv];
  process.argv.push("--eda-import-release-data");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await import("@main/index");
    await vi.waitFor(() => expect(startup.exit).toHaveBeenCalledWith(1));
    expect(startup.applyReleaseDataImport).not.toHaveBeenCalled();
    expect(startup.createServices).not.toHaveBeenCalled();
  } finally {
    process.argv.splice(0, process.argv.length, ...argv);
    log.mockRestore();
  }
});

it("identifies live development windows without changing the development profile path", async () => {
  vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
  await import("@main/index");

  expect(startup.setName).toHaveBeenCalledWith("Eda Dev");
  if (process.platform === "linux")
    expect(startup.setDesktopName).toHaveBeenCalledWith("cafe.kirameki.eda.dev.desktop");
  expect(startup.setPath).toHaveBeenCalledWith("userData", join(appData, "Eda-Dev"));
});

it("keeps ordinary launches out of the live development desktop identity", async () => {
  await import("@main/index");

  expect(startup.setName).toHaveBeenCalledWith("Eda");
  expect(startup.setDesktopName).not.toHaveBeenCalled();
});
