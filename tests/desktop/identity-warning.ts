import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { expect } from "playwright/test";
import { trustFixture } from "./helpers/trust.ts";
import { finishOnboarding } from "./helpers/onboarding.ts";
import assert from "node:assert/strict";
import { type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "eda-identity-warning-"));
const repository = join(root, "identity-fixture");
const config = join(root, "gitconfig");
await mkdir(repository);
await writeFile(
  config,
  "[user]\nname = Fixture\nemail = fixture@example.invalid\n[commit]\ngpgsign = false\n",
);
const env = fixtureEnvironment(root);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], { env, encoding: "utf8", stdio: "pipe" });
git("init", "-b", "main");
await writeFile(join(repository, "file.txt"), "base\n");
git("add", ".");
git("commit", "-m", "Initial");

let app: ElectronApplication | undefined;
const errors: string[] = [];
try {
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });
  await trustFixture(app, root);
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Work");
  await page.getByRole("textbox", { name: /^Git author name/ }).fill("Work Author");
  await page.getByRole("textbox", { name: /^Git email/ }).fill("work@example.invalid");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await finishOnboarding(page);
  const opened = await page.evaluate((path) => window.eda.repository.open(path), repository);
  assert(opened.ok);
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+p`);
  const picker = page.getByRole("dialog", { name: "Open a repository", exact: true });
  await picker.getByRole("button", { name: /^identity-fixture / }).press("Enter");
  await page.getByRole("heading", { name: "identity-fixture", exact: true }).waitFor();

  git("config", "--global", "user.email", "outside@example.invalid");
  const warning = page.locator('aside[aria-label="Global Git configuration warning"]');
  await warning.waitFor();
  const toolbar = await page.locator("header").first().boundingBox();
  const bounds = await warning.boundingBox();
  assert(toolbar && bounds);
  assert(bounds.height <= 32, `Warning consumed ${bounds.height}px`);
  assert(
    Math.abs(bounds.y - toolbar.y - toolbar.height) <= 1,
    "Warning must sit immediately below the app title bar",
  );
  assert.equal(await warning.getByRole("dialog").count(), 0);
  await page.screenshot({ path: "/tmp/eda-identity-warning-compact.png" });

  await warning.getByRole("button", { name: "Review global Git settings" }).click();
  const details = page.getByRole("dialog", { name: "Review global Git settings", exact: true });
  await details.getByRole("cell", { name: "outside@example.invalid", exact: true }).waitFor();
  assert.equal(await details.getAttribute("aria-modal"), "true");
  await page.screenshot({ path: "/tmp/eda-identity-warning-modal.png" });
  await page.keyboard.press("Escape");
  await details.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "Review global Git settings",
  );
  await warning.getByRole("button", { name: "Review global Git settings" }).click();
  await details.waitFor();
  await details.getByRole("button", { name: "Global Git settings", exact: true }).click();
  await page.locator("#settings-global-git").waitFor();
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await warning.getByRole("button", { name: "Review global Git settings" }).click();
  await details.waitFor();
  assert.equal(
    (await warning.boundingBox())?.height,
    bounds.height,
    "Opening details must not expand the warning strip",
  );
  assert.equal(git("config", "--global", "user.email").trim(), "outside@example.invalid");
  await details.getByRole("button", { name: "Apply profile globally" }).click();
  await warning.waitFor({ state: "hidden" });
  assert.equal(git("config", "--global", "user.email").trim(), "work@example.invalid");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Commit", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Commit author name", exact: true })
    .fill("Repository Author");
  await page
    .getByRole("textbox", { name: "Commit author email", exact: true })
    .fill("repo@example.invalid");
  await page.getByRole("button", { name: "Save repository identity", exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const active = await window.eda.identity.getActive();
          if (!active.ok || !active.value) return false;
          const result = await window.eda.settings.resolve("repositoryCommitIdentity", {
            profileId: active.value.id,
            repositoryId: id,
          });
          return result.ok && result.value.value?.email === "repo@example.invalid";
        }, opened.value.id),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await page
    .getByLabel("Commit identity: Repository Author <repo@example.invalid>", { exact: true })
    .waitFor();
  git("config", "user.email", "unapproved@example.invalid");
  await writeFile(join(repository, "file.txt"), "changed\n");
  const committed = await page.evaluate(
    async (repositoryId) =>
      window.eda.repository.commit({
        repositoryId,
        message: "Approved repository identity",
        stagePaths: ["file.txt"],
      }),
    opened.value.id,
  );
  assert(committed.ok, JSON.stringify(committed));
  assert.equal(
    git("log", "-1", "--format=%an:%ae:%cn:%ce").trim(),
    "Repository Author:repo@example.invalid:Repository Author:repo@example.invalid",
  );
  assert.equal(git("config", "--local", "user.email").trim(), "unapproved@example.invalid");

  const disabled = await page.evaluate(() =>
    window.eda.settings.set("syncGlobalGitConfig", { kind: "application" }, false),
  );
  assert(disabled.ok);
  git("config", "--global", "user.email", "outside@example.invalid");
  const enabled = await page.evaluate(async () => {
    const active = await window.eda.identity.getActive();
    if (!active.ok || !active.value) throw new Error("Missing profile");
    return window.eda.settings.set(
      "syncGlobalGitConfig",
      { kind: "profile", profileId: active.value.id },
      true,
    );
  });
  assert(enabled.ok);
  await warning.waitFor();
  await page.setViewportSize({ width: 900, height: 700 });
  assert((await warning.boundingBox())!.height <= 32);
  assert.deepEqual(errors, []);
  console.log(
    "Identity warning: compact placement, explicit repair, scoped sync and approved commit identity passed.",
  );
} finally {
  await app?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
