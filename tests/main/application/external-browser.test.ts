import { afterEach, expect, it, vi } from "vitest";
import { ExternalBrowser } from "@main/application/external-browser";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { SettingsRepository } from "@main/persistence/settings-repository";
import type { NodeProcessRunner } from "@main/git/execution/node-process-runner";
import type { Database } from "@main/persistence/types";

const databases: Database[] = [];
const url = "https://example.test/path?first=one&second=two";

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(platform: NodeJS.Platform = "linux") {
  const db = openInMemoryDatabase();
  databases.push(db);
  const identities = new IdentityRepository(db);
  const profiles = ["Work", "Home"].map((name) =>
    identities.create({
      name,
      gitName: name,
      gitEmail: `${name.toLowerCase()}@example.test`,
      hue: 210,
      signing: { format: "none", signCommits: false },
    }),
  );
  const settings = new SettingsRepository(db);
  const openDefault = vi.fn(async (_url: string) => {});
  const runner = {
    launch: vi.fn<NodeProcessRunner["launch"]>(async () => {}),
    run: vi.fn(async () => ({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      cancelled: false,
    })),
  };
  const browser = new ExternalBrowser(settings, runner, openDefault, platform);
  return { browser, settings, openDefault, runner, work: profiles[0]!, home: profiles[1]! };
}

it("uses OS defaults, inherits the global browser, and keeps profile overrides independent", async () => {
  const { browser, settings, openDefault, runner, work, home } = setup();
  await browser.open(url);
  await browser.open(url, work.id);
  expect(openDefault).toHaveBeenCalledTimes(2);
  expect(runner.launch).not.toHaveBeenCalled();

  settings.set("browserExecutable", { kind: "application" }, "/tools/global-browser");
  await browser.open(url, home.id);
  expect(runner.launch).toHaveBeenLastCalledWith(
    "/tools/global-browser",
    [url],
    expect.any(String),
    expect.any(Object),
  );

  const scope = { kind: "profile", profileId: work.id } as const;
  settings.set("browserExecutable", scope, "/tools/work-browser");
  await browser.open(url, work.id);
  expect(runner.launch.mock.lastCall?.[0]).toBe("/tools/work-browser");
  await browser.open(url, home.id);
  expect(runner.launch.mock.lastCall?.[0]).toBe("/tools/global-browser");

  settings.set("browserExecutable", scope, "");
  await browser.open(url, work.id);
  expect(openDefault).toHaveBeenCalledTimes(3);

  settings.reset("browserExecutable", scope);
  await browser.open(url, work.id);
  expect(runner.launch.mock.lastCall?.[0]).toBe("/tools/global-browser");
});

it("opens macOS application bundles through Launch Services with the URL as a separate argument", async () => {
  const { browser, settings, runner } = setup("darwin");
  settings.set("browserExecutable", { kind: "application" }, "/Applications/Custom Browser.app");
  await browser.open(url);
  expect(runner.run).toHaveBeenCalledWith(
    expect.objectContaining({
      executable: "/usr/bin/open",
      args: ["-a", "/Applications/Custom Browser.app", url],
    }),
  );
  expect(runner.launch).not.toHaveBeenCalled();

  runner.run.mockResolvedValueOnce({
    exitCode: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    cancelled: false,
  });
  await expect(browser.open(url)).rejects.toThrow("Could not open the link");
});

it.each(["win32", "linux", "darwin"] as const)(
  "passes the complete URL to a custom executable on %s and reports launch failures without switching browsers",
  async (platform) => {
    const { browser, settings, runner, openDefault } = setup(platform);
    const executable =
      platform === "win32" ? "C:\\Browser Folder\\browser.exe" : "/tools/custom browser";
    settings.set("browserExecutable", { kind: "application" }, executable);
    await browser.open(url);
    expect(runner.launch).toHaveBeenCalledWith(
      executable,
      [url],
      expect.any(String),
      expect.any(Object),
    );
    runner.launch.mockRejectedValueOnce(new Error("Missing executable"));
    await expect(browser.open(url)).rejects.toThrow("Could not open the link");
    expect(openDefault).not.toHaveBeenCalled();
  },
);

it.each([
  "file:///tmp/local",
  "javascript:alert(1)",
  "https://user:secret@example.test",
  "invalid",
])("rejects unsupported or credential-bearing URLs before launching: %s", async (value) => {
  const { browser, runner, openDefault } = setup();
  await expect(browser.open(value)).rejects.toThrow("HTTP or HTTPS");
  expect(runner.launch).not.toHaveBeenCalled();
  expect(runner.run).not.toHaveBeenCalled();
  expect(openDefault).not.toHaveBeenCalled();
});
