import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { finishOnboarding } from "./helpers/onboarding.ts";
import assert from "node:assert/strict";
import { expect, type ElectronApplication } from "playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "eda-debug-gate-"));
const config = join(root, "gitconfig");

await writeFile(config, "[user]\nname = Fixture\nemail = fixture@example.com\n");

const env = {
  ...fixtureEnvironment(root),
  HOME: root,
  USERPROFILE: root,
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const modifier = process.platform === "darwin" ? "Meta" : "Control";
let app: ElectronApplication | undefined;

try {
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });

  const page = await app.firstWindow();

  page.setDefaultTimeout(20_000);
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Work");
  await page.getByRole("textbox", { name: /^Git author name/ }).fill("Eda");
  await page.getByRole("textbox", { name: /^Git email/ }).fill("work@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await finishOnboarding(page);
  await page.getByRole("button", { name: /Active profile: Work/ }).waitFor();
  await mkdir("screenshots", { recursive: true });
  await page.keyboard.press(`${modifier}+,`);
  await page.getByRole("button", { name: "About", exact: true }).click();

  const previousClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    for (const [label, icon, url] of [
      ["@YuzuZensai", null, "https://github.com/YuzuZensai"],
      ["Sponsor on GitHub", "heart", "https://github.com/sponsors/YuzuZensai"],
      ["Star the repo", "star", "https://github.com/YuzuZensai/Eda"],
    ] as const) {
      const button = page.locator("button").filter({ hasText: label });
      await expect(button).toBeEnabled();
      const originalBounds = await button.boundingBox();
      await button.focus();
      await page.keyboard.down(modifier);

      try {
        await expect(button).toHaveText(label);
        if (icon) await expect(button.locator(`.lucide-${icon}`)).toBeVisible();
        await expect(button.locator(".ui-action-visible .lucide-copy")).toBeVisible();
        const textBounds = await button.getByText(label, { exact: true }).boundingBox();
        const iconBounds = await button.locator(".ui-action-visible").boundingBox();
        assert.ok(textBounds && iconBounds);
        assert.ok(iconBounds.x >= textBounds.x + textBounds.width, `${label}: icon follows text`);
        await expect(button.locator(".lucide-external-link")).toHaveCount(0);
        assert.deepEqual(await button.boundingBox(), originalBounds);

        if (icon === "heart") await page.keyboard.press("Enter");
        else await button.click();
        await expect(button.locator(".ui-action-visible .lucide-check")).toBeVisible();
        assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), url);
        await expect(button.locator(".ui-action-visible .lucide-copy")).toBeVisible();
      } finally {
        await page.keyboard.up(modifier);
      }

      await expect(button.locator(".ui-action-visible .lucide-external-link")).toBeVisible();
    }
  } finally {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), previousClipboard);
  }

  await page.getByRole("checkbox", { name: "Enable developer settings", exact: true }).check();
  await page.getByRole("button", { name: "Components", exact: true }).click();
  await page.locator("#gallery-identity .profile-avatar").last().waitFor();

  const avatarSizes = await page
    .locator("#gallery-identity .profile-avatar")
    .evaluateAll((avatars) =>
      avatars.map((avatar) => {
        const { width, height } = avatar.getBoundingClientRect();
        return { width, height };
      }),
    );
  assert.equal(avatarSizes.length, 6);
  assert.deepEqual(avatarSizes.slice(3), avatarSizes.slice(0, 3));
  assert.ok(avatarSizes.every(({ width, height }) => width > 0 && width === height));

  await page.getByRole("textbox", { name: "Example input", exact: true }).fill("Gallery draft");
  await page.getByRole("tab", { name: "Activity", exact: true }).click();

  assert.equal(
    await page.getByRole("tab", { name: "Activity", exact: true }).getAttribute("aria-selected"),
    "true",
  );

  for (const [trigger, title] of [
    ["Open Dialog", "Dialog example"],
    ["Open right Dialog", "Right dialog example"],
    ["Open ModalSurface", "ModalSurface example"],
  ] as const) {
    await page.getByRole("button", { name: trigger, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  }

  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("menu", { name: "Example menu", exact: true }).waitFor();
  await page.keyboard.press("Escape");

  assert.equal(
    await page.getByRole("textbox", { name: "Example input", exact: true }).inputValue(),
    "Gallery draft",
  );

  await page.locator("#gallery-actions").scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve("screenshots/component-gallery-refactor.png") });
  await page.getByRole("button", { name: "Resilience testing", exact: true }).click();
  await page.getByRole("heading", { name: "Resilience testing", exact: true }).waitFor();
  await page.getByRole("button", { name: "Fail IPC request", exact: true }).click();

  await page
    .getByRole("alert")
    .filter({ hasText: "Eda debug simulation: unexpected IPC error." })
    .waitFor();

  await page.getByRole("button", { name: "Dismiss", exact: true }).click();

  const runtimeError = page.waitForEvent("pageerror");

  await page.getByRole("button", { name: "Throw runtime error", exact: true }).click();
  assert.match((await runtimeError).message, /Eda debug simulation: uncaught runtime error/);

  const rejection = page.waitForEvent("pageerror");

  await page.getByRole("button", { name: "Reject promise", exact: true }).click();
  assert.match((await rejection).message, /Eda debug simulation: unhandled promise rejection/);

  await page.screenshot({ path: resolve("screenshots/failure-simulations.png") });

  await page.getByRole("button", { name: "Trigger render error...", exact: true }).click();
  await page.getByRole("button", { name: "Trigger render error", exact: true }).click();

  await page
    .getByRole("heading", { name: "Eda could not display this screen", exact: true })
    .waitFor();

  await page.getByRole("button", { name: "Reload Eda", exact: true }).click();
  await page.getByRole("button", { name: /Active profile: Work/ }).waitFor();
  console.log("Render-error reload restored the active profile.");

  await app.evaluate(({ dialog }) => {
    const original = dialog.showMessageBox;

    dialog.showMessageBox = async (
      windowOrOptions: Electron.BaseWindow | Electron.MessageBoxOptions,
      options?: Electron.MessageBoxOptions,
    ) => {
      const title = (options ?? (windowOrOptions as Electron.MessageBoxOptions)).title;
      if (title === "Crash renderer?") return { response: 1, checkboxChecked: false };
      dialog.showMessageBox = original;
      assertRecoveryTitle(title);
      return { response: 0, checkboxChecked: false };
    };

    function assertRecoveryTitle(title: string | undefined) {
      if (title !== "Eda’s window stopped") throw new Error("Expected native renderer recovery.");
    }
  });

  await page.keyboard.press(`${modifier}+,`);
  await page.getByRole("button", { name: "Resilience testing", exact: true }).click();

  const crashed = app.evaluate(
    ({ BrowserWindow }) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Renderer did not recover.")), 20_000);

        BrowserWindow.getAllWindows()[0]!.webContents.once(
          "render-process-gone",
          (_event, details) => {
            BrowserWindow.getAllWindows()[0]!.webContents.once("did-finish-load", () => {
              clearTimeout(timer);
              resolve(details.reason);
            });
          },
        );
      }),
  );

  await page
    .getByRole("button", { name: "Crash renderer...", exact: true })
    .click()
    .catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("Target crashed")) throw error;
    });

  assert.match(await crashed, /^(crashed|killed)$/);

  // Playwright still considers the target crashed after Electron reloads it.
  const restored = await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;

    return contents.executeJavaScript(`new Promise((resolve, reject) => {
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error("The active profile was not restored after the crash."));
      }, 5000);
      function check() {
        const button = document.querySelector('button[aria-label^="Active profile: Work,"]');
        if (!button) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(button.getAttribute("aria-label"));
      }
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      check();
    })`);
  });

  assert.match(restored, /Active profile: Work, work@example.com/);

  console.log(
    "Debug gate passed: real runtime errors, unhandled rejections, sanitized IPC errors, render-error reload and native renderer-crash recovery.",
  );
} catch (error) {
  if (app)
    await app
      .windows()[0]
      ?.screenshot({ path: resolve("screenshots/debug-gate-failure.png") })
      .catch(() => {});

  throw error;
} finally {
  if (app) {
    const running = app;
    const timer = setTimeout(() => running.process().kill("SIGKILL"), 5000);
    await running.close().catch(() => running.process().kill());
    clearTimeout(timer);
  }

  assert.ok(resolve(root).startsWith(resolve(tmpdir(), "eda-debug-gate-")));

  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
