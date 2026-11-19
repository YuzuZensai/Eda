import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { expect } from "playwright/test";
import assert from "node:assert/strict";
import { type ElectronApplication } from "playwright";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { UpdateState } from "../../src/shared/updates.ts";

type NavigationProbe = { motion: string | undefined; finished: boolean; error?: string };

declare global {
  interface Window {
    __updateNavigation: NavigationProbe[];
  }
}

const fixtureRoot = await mkdtemp(join(tmpdir(), "eda-updates-gate-"));
const config = join(fixtureRoot, "gitconfig");
await writeFile(config, "[user]\nname = Fixture\nemail = fixture@example.test\n");
let app: ElectronApplication | undefined;
function launch() {
  return electron.launch({
    args: [
      "dist/main/index.js",
      "--no-sandbox",
      `--user-data-dir=${fixtureRoot}`,
      ...(process.platform === "linux" ? ["--ozone-platform=x11", "--disable-gpu"] : []),
    ],
    env: {
      ...fixtureEnvironment(fixtureRoot),
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

try {
  app = await launch();
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(15_000);
  await page.getByRole("button", { name: "Get started", exact: true }).waitFor();
  await page.evaluate(async () => {
    const initial = await window.eda.updates.state();
    if (!initial.ok || initial.value.capability !== "development")
      throw new Error("Development updater is not isolated.");
    for (const action of ["check", "download", "install"] as const) {
      if ((await window.eda.updates[action]()).ok)
        throw new Error(`Development update action was allowed: ${action}`);
    }
    const created = await window.eda.identity.create(
      {
        name: "Update fixture",
        gitName: "Fixture",
        gitEmail: "fixture@example.test",
        hue: 45,
        signing: { format: "none", signCommits: false },
      },
      { syncGlobalGitConfig: false },
    );
    if (!created.ok) throw new Error(created.error.message);
    const active = await window.eda.identity.setActive(created.value.id);
    if (!active.ok) throw new Error(active.error.message);
  });
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "About", exact: true }).click();
  const version = await page.evaluate(() => window.eda.app.version);
  assert.ok(version.displayVersion.startsWith(`${version.version}-`));
  assert.ok(!version.displayVersion.includes("+g"));
  await page.getByText(version.displayVersion, { exact: true }).waitFor();
  await page
    .locator("dl")
    .filter({ has: page.getByText("Installation", { exact: true }) })
    .getByText("Development", { exact: true })
    .waitFor();
  await page
    .getByText(
      "Development builds are never replaced. Use an installed build to check for updates.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Check for updates", exact: true }).count(),
    0,
  );
  const prereleases = page.getByRole("checkbox", {
    name: "Include pre-release updates",
    exact: true,
  });
  assert.equal(await prereleases.isChecked(), true);
  await prereleases.click();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const result = await window.eda.settings.resolve("includePrereleaseUpdates", {});
          return result.ok && result.value.value === false;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page
    .getByRole("checkbox", { name: "Check for updates automatically", exact: true })
    .click();
  await page.waitForFunction(() => {
    const control = document.querySelector<HTMLInputElement>(
      '#settings-about input[type="checkbox"]',
    );
    return control && !control.checked && !control.disabled;
  });
  const setting = await page.evaluate(() =>
    window.eda.settings.resolve("automaticUpdateChecks", {}),
  );
  assert.ok(setting.ok && setting.value.value === false);
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "About", exact: true }).click();
  await page.waitForFunction(() => {
    const control = document.querySelector<HTMLInputElement>(
      '#settings-about input[type="checkbox"]',
    );
    return control && !control.checked && !control.disabled;
  });
  assert.equal(
    await page
      .getByRole("checkbox", { name: "Check for updates automatically", exact: true })
      .isChecked(),
    false,
  );
  assert.equal(await prereleases.isChecked(), false);

  await page.getByRole("checkbox", { name: "Enable developer settings", exact: true }).check();
  await page.getByRole("button", { name: "State simulations", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Reset preview", exact: true }).count(), 0);

  const simulation = page.getByRole("combobox", { name: "Update state", exact: true });

  await simulation.click();
  await page.getByRole("option", { name: "Update available", exact: true }).click();

  const updateBanner = page.getByRole("complementary", { name: "App update", exact: true });

  await updateBanner.getByText("Eda 0.0.3 is available.", { exact: true }).waitFor();

  assert.equal((await updateBanner.textContent())?.includes("Installed:"), false);
  assert.equal((await updateBanner.textContent())?.includes("Preview"), false);
  assert.equal(
    await updateBanner.evaluate((element) => element.getBoundingClientRect().height),
    32,
  );
  assert.equal(
    await updateBanner
      .getByRole("button", { name: "View update", exact: true })
      .getAttribute("data-variant"),
    "quiet",
  );

  await page.waitForFunction(() => !document.documentElement.dataset["navigationMotion"]);
  await page.evaluate(() => {
    window.__updateNavigation = [];

    const original = document.startViewTransition.bind(document);

    document.startViewTransition = (update) => {
      const probe: NavigationProbe = {
        motion: document.documentElement.dataset["navigationMotion"],
        finished: false,
      };
      const transition = original(update);

      window.__updateNavigation.push(probe);
      void transition.ready.catch((error: unknown) => {
        probe.error = String(error);
      });
      void transition.finished.then(() => {
        probe.finished = true;
      });

      return transition;
    };
  });

  const expectNavigation = async (action: () => Promise<unknown>, motion: string) => {
    const before = await page.evaluate(() => window.__updateNavigation.length);

    await action();
    await page.waitForFunction((index) => window.__updateNavigation[index]?.finished, before);

    const probes = await page.evaluate((index) => window.__updateNavigation.slice(index), before);

    assert.deepEqual(probes, [{ motion, finished: true }]);
  };
  const viewUpdate = updateBanner.getByRole("button", { name: "View update", exact: true });
  const simulations = page.getByRole("button", { name: "State simulations", exact: true });

  await expectNavigation(() => viewUpdate.click(), "section");
  await page.locator("#settings-about").waitFor();
  await page.getByText(`Installed: ${version.displayVersion}`, { exact: true }).waitFor();
  await page.locator("dl").getByText("Direct download", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Update preview is active. Update actions are simulated.").count(),
    0,
  );
  await expectNavigation(() => simulations.click(), "section");
  await expectNavigation(
    () => page.getByRole("button", { name: "Back to workspace", exact: true }).click(),
    "back",
  );
  await expectNavigation(() => viewUpdate.click(), "forward");
  await page.locator("#settings-about").waitFor();
  await expectNavigation(() => simulations.click(), "section");
  await page.emulateMedia({ reducedMotion: "reduce" });

  const beforeReduced = await page.evaluate(() => window.__updateNavigation.length);

  await viewUpdate.click();
  await page.locator("#settings-about").waitFor();
  assert.equal(await page.evaluate(() => window.__updateNavigation.length), beforeReduced);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expectNavigation(() => simulations.click(), "section");

  const installation = page.getByRole("combobox", { name: "Installation method", exact: true });

  for (const manager of ["Homebrew", "APT / dpkg", "RPM", "Pacman"]) {
    await installation.click();
    await page.getByRole("option", { name: manager, exact: true }).click();
    assert.equal(await updateBanner.getByRole("button").count(), 2);
    assert.doesNotMatch(await updateBanner.innerText(), /Installed:|Managed by/);
    assert.equal(
      await page.getByRole("button", { name: "Download update", exact: true }).count(),
      0,
    );

    await expectNavigation(() => viewUpdate.click(), "section");
    await page
      .locator('[aria-labelledby="about-updates-heading"]')
      .getByText(`Managed by ${manager}.`, { exact: true })
      .waitFor();
    await page
      .locator("dl")
      .getByText(manager === "Homebrew" ? manager : `System package (${manager})`, { exact: true })
      .waitFor();

    if (manager === "Homebrew") {
      await page.getByRole("button", { name: "Update with Homebrew", exact: true }).waitFor();
      await page.locator('[aria-labelledby="about-updates-heading"]').screenshot({
        path: join(tmpdir(), "eda-updates-managed-light.png"),
      });
    }

    await expectNavigation(() => simulations.click(), "section");
    assert.equal(
      await page.getByRole("button", { name: "Restart and install", exact: true }).count(),
      0,
    );

    if (manager === "Homebrew") {
      await page.screenshot({ path: join(tmpdir(), "eda-homebrew-simulation.png") });
      await simulation.click();

      assert.equal(await page.getByRole("option", { name: "Downloading", exact: true }).count(), 0);
      assert.equal(
        await page.getByRole("option", { name: "Ready to install", exact: true }).count(),
        0,
      );
      await page.keyboard.press("Escape");
    }

    await updateBanner.getByRole("button", { name: "Dismiss App update", exact: true }).click();
    await updateBanner.waitFor({ state: "detached" });
  }

  await installation.click();
  await page.getByRole("option", { name: "Direct download", exact: true }).click();
  await viewUpdate.waitFor();

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
  await page.screenshot({
    path: join(tmpdir(), "eda-update-banner-available.png"),
    clip: { x: 0, y: 0, width: 1440, height: 120 },
  });

  await simulation.click();
  await page.getByRole("option", { name: "Ready to install", exact: true }).click();
  await updateBanner.getByText("Eda 0.0.3 is available.", { exact: true }).waitFor();
  await expectNavigation(() => viewUpdate.click(), "section");
  await page
    .locator('[aria-labelledby="about-updates-heading"]')
    .getByText("Downloaded and verified. Restart to install.")
    .waitFor();
  await page.locator('[aria-labelledby="about-updates-heading"]').screenshot({
    path: join(tmpdir(), "eda-updates-ready-light.png"),
  });
  await expectNavigation(() => simulations.click(), "section");

  await page.evaluate(() =>
    window.eda.settings.set(
      "theme",
      { kind: "application" },
      { mode: "dark", light: "eda-light", dark: "eda-dark" },
    ),
  );
  await page.waitForFunction(() => document.documentElement.dataset["appearance"] === "dark");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(940, 900));

  assert.equal(
    await updateBanner.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
  );

  await page.screenshot({
    path: join(tmpdir(), "eda-update-banner-ready.png"),
    clip: { x: 0, y: 0, width: 940, height: 120 },
  });

  await simulation.click();
  await page.getByRole("option", { name: "Use live status", exact: true }).click();
  await updateBanner.waitFor({ state: "detached" });

  await expectNavigation(
    () => page.getByRole("button", { name: "About", exact: true }).click(),
    "section",
  );
  await page.locator("dl").getByText("Development", { exact: true }).waitFor();
  await expectNavigation(() => simulations.click(), "section");

  const savedGitConfig = await readFile(config, "utf8");
  const gitSimulation = page.getByRole("combobox", { name: "Git identity state", exact: true });

  await gitSimulation.click();
  await page.getByRole("option", { name: "Commit identity mismatch", exact: true }).click();

  const gitWarning = page.getByRole("complementary", {
    name: "Global Git configuration warning",
    exact: true,
  });

  await gitWarning.waitFor();

  assert.equal(await page.getByRole("button", { name: "Reset preview", exact: true }).count(), 0);
  await page.screenshot({ path: join(tmpdir(), "eda-state-simulations-git.png") });

  assert.equal(await gitWarning.count(), 1);
  assert.equal(await gitWarning.evaluate((element) => element.closest("main") === null), true);
  assert.equal((await gitWarning.textContent())?.includes("Simulation"), false);

  await simulation.click();
  await page.getByRole("option", { name: "Update available", exact: true }).click();
  await updateBanner.waitFor();

  const notices = page.getByRole("region", { name: "App notifications", exact: true });

  assert.deepEqual(
    await notices
      .locator("aside")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label"))),
    ["Global Git configuration warning", "App update"],
  );

  const warningBounds = await gitWarning.boundingBox();
  const updateBounds = await updateBanner.boundingBox();

  assert.ok(warningBounds && updateBounds);
  assert.equal(warningBounds.y + warningBounds.height, updateBounds.y);

  await notices.getByRole("button", { name: "Dismiss App update", exact: true }).click();
  await updateBanner.waitFor({ state: "detached" });
  await gitWarning.waitFor();

  await simulation.click();
  await page.getByRole("option", { name: "Ready to install", exact: true }).click();
  await updateBanner.waitFor();
  await notices.getByRole("button", { name: "Dismiss App update", exact: true }).click();
  await updateBanner.waitFor({ state: "detached" });

  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await gitWarning.waitFor();

  assert.equal(await gitWarning.count(), 1);
  assert.equal(await updateBanner.count(), 0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-debug-states").waitFor();
  await gitWarning.waitFor();

  assert.equal(await gitWarning.count(), 1);

  await page.screenshot({
    path: join(tmpdir(), "eda-git-warning-top-bar.png"),
    clip: { x: 0, y: 0, width: 940, height: 100 },
  });

  await gitWarning.getByRole("button", { name: "Review global Git settings", exact: true }).click();

  const gitDetails = page.getByRole("dialog", { name: "Review global Git settings", exact: true });

  await gitDetails.getByRole("cell", { name: "simulation@example.invalid", exact: true }).waitFor();

  await gitDetails.getByRole("button", { name: "Apply profile globally", exact: true }).click();
  await gitDetails.waitFor({ state: "detached" });
  await gitWarning.waitFor({ state: "detached" });

  assert.equal(await readFile(config, "utf8"), savedGitConfig);

  await gitSimulation.click();
  await page
    .getByRole("option", { name: "Identity mismatch with repair failure", exact: true })
    .click();
  await gitWarning.getByRole("button", { name: "Review global Git settings", exact: true }).click();
  await gitDetails.getByRole("button", { name: "Apply profile globally", exact: true }).click();
  await gitDetails
    .getByRole("alert")
    .getByText("Simulated repair failure: Git configuration is read-only.", { exact: true })
    .waitFor();

  await page.keyboard.press("Escape");
  await gitDetails.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Reset all simulations", exact: true }).click();
  await gitWarning.waitFor({ state: "detached" });

  assert.equal(await readFile(config, "utf8"), savedGitConfig);

  await page.getByRole("button", { name: "Components", exact: true }).click();
  const preview = page.locator("#gallery-states");
  await preview.getByRole("button", { name: "Download update", exact: true }).click();
  await preview.getByRole("progressbar", { name: "Update download", exact: true }).waitFor();
  assert.equal(
    await preview
      .getByRole("progressbar", { name: "Update download", exact: true })
      .getAttribute("value"),
    "45",
  );
  await preview.getByRole("button", { name: "Preview completed download", exact: true }).click();
  await preview.getByRole("button", { name: "Restart and install", exact: true }).waitFor();
  await mkdir("screenshots", { recursive: true });
  await preview.locator("div.mb-6").screenshot({ path: resolve("screenshots/updates-ready.png") });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(940, 900));
  await page.evaluate(async () => {
    const result = await window.eda.settings.set(
      "theme",
      { kind: "application" },
      { mode: "dark", light: "eda-light", dark: "eda-dark" },
    );
    if (!result.ok) throw new Error(result.error.message);
  });
  await page.waitForFunction(() => document.documentElement.dataset["appearance"] === "dark");
  assert.equal(
    await preview.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
  );
  await preview
    .locator("div.mb-6")
    .screenshot({ path: resolve("screenshots/updates-ready-dark.png") });
  await preview.getByRole("button", { name: "Restart and install", exact: true }).click();
  await preview.getByRole("button", { name: "Restarting Eda...", exact: true }).waitFor();
  const live = await page.evaluate(() => window.eda.updates.state());
  assert.ok(live.ok && live.value.phase === "idle" && live.value.capability === "development");

  const managed: UpdateState = {
    ...live.value,
    revision: live.value.revision + 1,
    capability: "managed",
    phase: "available",
    reason: "Managed by Homebrew.",
    release: { version: "0.0.4", name: "Eda 0.0.4", notes: "Release notes", releasedAt: null },
  };

  await app.evaluate(({ ipcMain }, state) => {
    ipcMain.removeHandler("updates:state");
    ipcMain.handle("updates:state", () => ({ ok: true, value: state }));
    ipcMain.removeHandler("app:installation");
    ipcMain.handle("app:installation", () => ({ ok: true, value: { method: "homebrew" } }));
  }, managed);
  await page.reload();
  await updateBanner.getByText("Eda 0.0.4 is available.", { exact: true }).waitFor();
  assert.doesNotMatch(await updateBanner.innerText(), /Installed:|Managed by/);

  assert.equal(await updateBanner.getByRole("button").count(), 2);
  assert.equal(
    await updateBanner.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
  );

  await page.screenshot({
    path: join(tmpdir(), "eda-update-banner-managed.png"),
    clip: { x: 0, y: 0, width: 940, height: 120 },
  });

  await viewUpdate.click();

  const updates = page.locator('[aria-labelledby="about-updates-heading"]');

  await updates.getByText("Eda 0.0.4 is available.", { exact: true }).waitFor();
  await updates.getByText("Managed by Homebrew.", { exact: true }).waitFor();
  await updates.screenshot({ path: join(tmpdir(), "eda-updates-managed-dark.png") });

  assert.equal(
    await updates.getByRole("button", { name: "Download update", exact: true }).count(),
    0,
  );
  assert.equal(
    await updates.getByRole("button", { name: "Restart and install", exact: true }).count(),
    0,
  );
  assert.doesNotMatch(await updates.innerText(), /brew upgrade|sudo |Use your package manager/);

  const waiting: UpdateState = {
    ...managed,
    revision: managed.revision + 1,
    capability: "homebrew",
    phase: "current",
    release: null,
    reason: "Eda 0.0.4 is not available through Homebrew yet. Check again later.",
  };

  await app.evaluate(({ BrowserWindow }, state) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send("updates:changed", state);
  }, waiting);
  await updates.getByText(waiting.reason!, { exact: true }).waitFor();
  assert.equal(
    await updates.getByRole("button", { name: "Update with Homebrew", exact: true }).count(),
    0,
  );

  const homebrew: UpdateState = {
    ...managed,
    revision: waiting.revision + 1,
    capability: "homebrew",
    reason: null,
  };

  await app.evaluate(({ BrowserWindow, ipcMain }, state) => {
    ipcMain.removeHandler("updates:install");
    ipcMain.handle("updates:install", (event) => {
      const installing = { ...state, revision: state.revision + 1, phase: "installing" };
      event.sender.send("updates:changed", installing);
      return { ok: true, value: installing };
    });
    BrowserWindow.getAllWindows()[0]!.webContents.send("updates:changed", state);
  }, homebrew);
  await updates.getByRole("button", { name: "Update with Homebrew", exact: true }).click();
  await updates
    .getByText("Updating with Homebrew. Eda will restart when finished…", { exact: true })
    .waitFor();
  await updates.getByRole("button", { name: "Updating with Homebrew…", exact: true }).waitFor();
  assert.equal(
    await updates.getByRole("button", { name: "Update with Homebrew", exact: true }).count(),
    0,
  );
  assert.equal(await prereleases.isDisabled(), true);
  await updates.screenshot({ path: join(tmpdir(), "eda-updates-homebrew-installing.png") });

  assert.deepEqual(errors, []);

  const savedProfile = await page.evaluate(() => window.eda.identity.getActive());
  assert.ok(savedProfile.ok && savedProfile.value);

  const closed = app.waitForEvent("close", { timeout: 10_000 });

  await app.evaluate(({ app }) => app.quit());
  await closed;

  app = await launch();
  const restored = await app.firstWindow();

  await restored.getByRole("button", { name: "Settings", exact: true }).waitFor();
  assert.deepEqual(await restored.evaluate(() => window.eda.identity.getActive()), savedProfile);
  assert.equal(await restored.getByRole("button", { name: "Get started", exact: true }).count(), 0);

  console.log(
    "Update desktop gate passed: source-build protection, persisted preferences, update navigation, direct and managed previews, one-click Homebrew updates, single-request quit, and profile restoration after restart.",
  );
} finally {
  await app?.close();
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
