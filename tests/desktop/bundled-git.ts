import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { expect } from "playwright/test";
import { trustFixture } from "./helpers/trust.ts";
import assert from "node:assert/strict";
import { type ElectronApplication } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Result } from "../../src/shared/errors.ts";

const root = await mkdtemp(join(tmpdir(), "eda-bundled-gate-"));
const packaged = process.argv.includes("--packaged");
const env = Object.fromEntries(
  Object.entries(fixtureEnvironment(root)).filter(
    (entry): entry is [string, string] =>
      entry[0].toLowerCase() !== "path" && entry[1] !== undefined,
  ),
);

const fixtureEnv = {
  ...env,
  PATH:
    process.platform === "win32"
      ? join(process.env["SystemRoot"] ?? "C:/Windows", "System32")
      : "/nonexistent",
  HOME: root,
  USERPROFILE: root,
  GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  NODE_OPTIONS: "--no-warnings=ExperimentalWarning",
};

let app: ElectronApplication | undefined;
const launch = async () => {
  const running = await electron.launch({
    ...(packaged ? { executablePath: resolve("release/win-unpacked/Eda.exe") } : {}),
    args: [...(packaged ? [] : ["dist/main/index.js"]), `--user-data-dir=${root}`],
    env: fixtureEnv,
  });

  app = running;

  await trustFixture(running, root);
  const page = await running.firstWindow();

  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.eda));
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .or(page.getByRole("button", { name: "Get started", exact: true }))
    .waitFor();

  return { running, page };
};

try {
  if (packaged && process.platform !== "win32")
    throw new Error("This packaged gate currently targets Windows.");

  await writeFile(fixtureEnv.GIT_CONFIG_GLOBAL, "");

  let launched = await launch();
  const page = launched.page;
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  const engine = await page.evaluate(async () => {
    const result = await window.eda.app.getGitEngine();
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });

  assert.equal(engine.source, "bundled");
  assert.ok(
    engine.path.includes(
      packaged ? `${process.platform === "win32" ? "\\" : "/"}resources` : "vendor",
    ),
  );

  if (packaged) assert.ok(!engine.path.includes("app.asar"));

  const path = join(root, "repo with spaces");

  await mkdir(path);

  const repository = await page.evaluate(async (path) => {
    const unwrap = <T>(result: Result<T>): T => {
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    const profile = unwrap(
      await window.eda.identity.create({
        name: "Bundled gate",
        gitName: "Eda",
        gitEmail: "bundle@example.com",
        hue: 210,
        signing: { format: "none", signCommits: false },
      }),
    );

    unwrap(await window.eda.settings.set("syncGlobalGitConfig", { kind: "application" }, false));
    unwrap(await window.eda.identity.setActive(profile.id));

    return unwrap(await window.eda.repository.init(path));
  }, path);

  await writeFile(join(path, "file.txt"), "no system Git needed\n");
  await mkdir(join(path, ".git/hooks"), { recursive: true });
  await writeFile(
    join(path, ".git/hooks/pre-commit"),
    "#!/bin/sh\ngit --version > hook-git-version.txt\n",
    { mode: 0o755 },
  );

  const trust = await page.evaluate((id) => window.eda.repository.reviewTrust(id), repository.id);

  assert.ok(trust.ok, JSON.stringify(trust));

  const commit = await page.evaluate(async (repositoryId) => {
    const result = await window.eda.repository.commit({
      repositoryId,
      message: "Commit with bundled Git",
      stagePaths: ["file.txt"],
    });

    if (!result.ok) throw new Error(result.error.message);

    return result.value;
  }, repository.id);

  assert.ok(commit);
  assert.match(await readFile(join(path, "hook-git-version.txt"), "utf8"), /git version/);

  const history = await page.evaluate(
    (repositoryId) => window.eda.repository.history({ repositoryId }),
    repository.id,
  );

  assert.equal(history.ok, true);

  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Git", exact: true })
    .click();
  assert.equal(
    await page.getByRole("radio", { name: "Bundled Git (recommended)", exact: true }).isChecked(),
    true,
  );

  await page.getByRole("radio", { name: "System Git (PATH)", exact: true }).check();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const setting = await window.eda.settings.resolve("gitEngine", {});
          return setting.ok && setting.value.value === "system";
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

  const selectedEngine = await page.evaluate(() => window.eda.app.getGitEngine());

  assert.ok(selectedEngine.ok, JSON.stringify(selectedEngine));
  assert.equal(selectedEngine.value.source, "bundled");

  await launched.running.close();
  app = undefined;
  launched = await launch();

  const reopened = launched.page;
  const fallback = await reopened.evaluate(async () => ({
    setting: await window.eda.settings.resolve("gitEngine", {}),
    engine: await window.eda.app.getGitEngine(),
  }));

  assert.ok(fallback.setting.ok && fallback.engine.ok, JSON.stringify(fallback));
  assert.equal(fallback.setting.value.value, "system");
  assert.equal(fallback.engine.value.source, "bundled");

  await launched.running.close();
  app = undefined;
  fixtureEnv.PATH = process.env["PATH"] ?? process.env["Path"] ?? "";
  launched = await launch();

  const systemPage = launched.page;
  const system = await systemPage.evaluate(() => window.eda.app.getGitEngine());

  assert.ok(system.ok, JSON.stringify(system));
  assert.equal(system.value.source, "system");
  assert.equal(errors.length, 0, errors.join("\n"));

  console.log(
    `Bundled Git gate passed (${packaged ? "packaged" : "development"}): no system Git, init/stage/commit/history, shell hook, default UI, persisted selection and missing-system fallback. Version ${engine.version}.`,
  );
} finally {
  if (app) await app.close();
  assert.ok(resolve(root).startsWith(resolve(tmpdir(), "eda-bundled-gate-")));
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
