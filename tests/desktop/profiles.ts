import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { trustFixture } from "./helpers/trust.ts";
import { finishOnboarding } from "./helpers/onboarding.ts";
import { chooseSelect } from "./select-control.ts";
import assert from "node:assert/strict";
import { expect } from "playwright/test";
import { type ElectronApplication } from "playwright";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  access,
  rename,
  readFile,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const root = await mkdtemp(join(tmpdir(), "eda-profile-gate-"));
const config = join(root, "gitconfig");
const modifier = process.platform === "darwin" ? "Meta" : "Control";

await writeFile(
  config,
  "[user]\nname = Eda\nemail = outside@example.com\n[commit]\ngpgsign = false\n",
);

const fixtureEnv = {
  ...fixtureEnvironment(root),
  HOME: root,
  USERPROFILE: root,
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const paths = { alpha: join(root, "alpha"), beta: join(root, "beta"), gamma: join(root, "gamma") };

for (const name of ["alpha", "beta", "gamma"] as const) {
  const path = paths[name];

  await mkdir(path);
  execFileSync("git", ["init", "-b", "main", path], { env: fixtureEnv, stdio: "pipe" });
  await writeFile(join(path, "file.txt"), "initial\n");
  execFileSync("git", ["-C", path, "add", "."], { env: fixtureEnv });
  execFileSync(
    "git",
    [
      "-C",
      path,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "initial",
    ],
    { env: fixtureEnv, stdio: "pipe" },
  );
  await writeFile(join(path, "file.txt"), "modified\n");
}

const keys = { work: join(root, "work-key"), home: join(root, "home-key") };

for (const path of Object.values(keys))
  execFileSync(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-f", path, "-C", "fixture@example.test"],
    {
      env: fixtureEnv,
      stdio: "pipe",
    },
  );

const errors: string[] = [];
let app: ElectronApplication | undefined;
const launch = async () => {
  const running = await electron.launch({
    args: ["dist/main/index.js", `--user-data-dir=${root}`],
    env: {
      ...fixtureEnvironment(root),
      HOME: root,
      USERPROFILE: root,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      NODE_OPTIONS: "--no-warnings=ExperimentalWarning",
    },
  });

  app = running;
  running.process().stderr?.on("data", (chunk) => process.stderr.write(chunk));

  await trustFixture(running, root);
  const page = await running.firstWindow();

  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForLoadState("domcontentloaded");

  return { running, page };
};

const globalEmail = () =>
  execFileSync("git", ["config", "--file", config, "--get", "user.email"], {
    encoding: "utf8",
  }).trim();

try {
  let launched = await launch();

  app = launched.running;

  let page = launched.page;
  const view = async (settings: boolean) => {
    const button = page.getByRole("button", { name: "Settings", exact: true });

    if (((await button.getAttribute("aria-current")) === "page") !== settings) {
      await button.click();
      if (settings)
        await page
          .getByRole("navigation", { name: "Settings sections" })
          .getByRole("button", { name: "Profiles", exact: true })
          .click();
    }
  };

  const section = async (name: string) => {
    await view(true);
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name, exact: true })
      .click();
    await page
      .getByRole("heading", { name: name.split(": ").at(-1)!, exact: true, level: 1 })
      .waitFor();
  };

  const openRepository = async (name: keyof typeof paths) => {
    const opened = await page.evaluate(
      async (path) => window.eda.repository.open(path),
      paths[name],
    );

    assert.equal(opened.ok, true);

    await view(false);
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+p`);
    await page
      .getByRole("dialog", { name: "Open a repository" })
      .getByRole("button", { name: new RegExp(`^${name} `) })
      .click();
    await page.getByRole("textbox", { name: "Commit title" }).waitFor();

    return opened.value;
  };

  const draftIs = async (message: string) =>
    page.waitForFunction((expected) => {
      const title = document.querySelector<HTMLInputElement>('input[aria-label="Commit title"]');
      const description = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Commit description"]',
      );

      if (!title || !description) return false;

      return `${title.value}${description.value ? `\n\n${description.value}` : ""}` === expected;
    }, message);

  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Work");
  await page.getByRole("textbox", { name: /^Git author name/ }).fill("Eda");
  await page.getByRole("textbox", { name: /^Git email/ }).fill("work@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await finishOnboarding(page);
  await page.getByRole("button", { name: /Active profile: Work/ }).waitFor();
  assert.equal(globalEmail(), "work@example.com");

  const browserLog = join(root, "browser-links.jsonl");
  const browserFixture = join(root, "browser-fixture.cjs");
  await writeFile(
    browserFixture,
    `
    require("node:fs").appendFileSync(${JSON.stringify(browserLog)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }) + "\\n");
    process.exit(0);
  `,
  );
  await app.evaluate(({ shell }, fixture) => {
    const previous = shell.openExternal;
    const options = process.env["NODE_OPTIONS"];
    const state = globalThis as typeof globalThis & {
      browserDefaultUrls: string[];
      restoreBrowserFixture: () => void;
    };
    state.browserDefaultUrls = [];
    shell.openExternal = async (url) => {
      state.browserDefaultUrls.push(url);
    };
    process.env["NODE_OPTIONS"] = `--require ${JSON.stringify(fixture)}`;
    state.restoreBrowserFixture = () => {
      shell.openExternal = previous;
      if (options === undefined) delete process.env["NODE_OPTIONS"];
      else process.env["NODE_OPTIONS"] = options;
    };
  }, browserFixture);

  await section("Global settings: Application");
  const browserChoice = page.getByRole("combobox", { name: "Web browser", exact: true });
  await expect(browserChoice).toHaveText("OS default");
  await app.evaluate(({ dialog }, executable) => {
    const previous = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = previous;
      return { canceled: false, filePaths: [executable] };
    };
  }, process.execPath);
  await chooseSelect(browserChoice, "manual");
  await expect(browserChoice).not.toHaveText("OS default");
  const link = "https://example.test/browser?first=one&second=two";
  await page.evaluate((url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, link);
  await expect(async () => {
    const { cwd, args } = JSON.parse((await readFile(browserLog, "utf8")).trim());

    expect(await realpath(cwd)).toBe(await realpath(root));
    // Node resolves its script argument against the child's cwd, which may use a Windows short path.
    expect(args).toEqual([resolve(cwd, link)]);
  }).toPass({ timeout: 5000 });

  await section("Profile: Application");
  await expect(browserChoice).toHaveText("Follow global");
  await chooseSelect(browserChoice, "none");
  await expect(browserChoice).toHaveText("OS default");
  await page.evaluate((url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, link);
  await expect
    .poll(() =>
      app!.evaluate(
        () =>
          (globalThis as typeof globalThis & { browserDefaultUrls: string[] }).browserDefaultUrls,
      ),
    )
    .toEqual([link]);
  await chooseSelect(browserChoice, "global");
  await expect(browserChoice).toHaveText("Follow global");
  await app.evaluate(() => {
    (
      globalThis as typeof globalThis & { restoreBrowserFixture: () => void }
    ).restoreBrowserFixture();
  });

  await section("Profile: Appearance");
  await page
    .getByRole("radiogroup", { name: "Appearance mode", exact: true })
    .getByRole("radio", { name: "Dark", exact: true })
    .check();
  await page.getByRole("radio", { name: "Nord Dark", exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const active = await window.eda.identity.getActive();

          if (!active.ok || !active.value) return false;

          const theme = await window.eda.settings.resolve("theme", { profileId: active.value.id });

          return (
            theme.ok &&
            (typeof theme.value.value === "string"
              ? theme.value.value === "nord"
              : theme.value.value.dark === "nord")
          );
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  await mkdir("screenshots", { recursive: true });
  await section("Global settings: Appearance");
  await page.getByRole("checkbox", { name: "Reduce motion", exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const result = await window.eda.settings.resolve("reducedMotion", {});
          return result.ok && result.value.value;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

  const firstWork = await page.evaluate(async () => {
    const result = await window.eda.identity.getActive();
    if (!result.ok || !result.value)
      throw new Error("Expected a successful IPC result: " + JSON.stringify(result));
    return result.value;
  });

  assert.equal(
    (
      await page.evaluate(async ({ path, id }) => window.eda.identity.assignSshKey(path, id), {
        path: keys.work,
        id: firstWork.id,
      })
    ).ok,
    true,
  );

  await section("Commit");
  await page.getByText("Choose a repository", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Use this profile", exact: true }).count(),
    0,
  );

  const alpha = await openRepository("alpha");
  const alphaConfigBeforeApply = await readFile(join(paths.alpha, ".git", "config"), "utf8");
  const betaConfigBeforeApply = await readFile(join(paths.beta, ".git", "config"), "utf8");

  await section("Profile: Git");
  assert.equal(
    await page.getByRole("button", { name: "Use this profile", exact: true }).count(),
    0,
  );

  await section("Commit");
  await page.getByRole("heading", { name: "Repository: alpha", exact: true }).waitFor();

  const authorSettings = page.getByRole("region", { name: "Author", exact: true });

  await authorSettings.getByText("work@example.com").waitFor();
  assert.equal(await readFile(join(paths.alpha, ".git", "config"), "utf8"), alphaConfigBeforeApply);
  assert.equal(await page.getByRole("button", { name: /^Remove (local|both local)/ }).count(), 0);

  await page.getByRole("button", { name: "Use this profile", exact: true }).click();
  await page.getByText("Profile saved for this repository.", { exact: true }).waitFor();
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const result = await window.eda.identity.inspectGit(id);

          return (
            result.ok &&
            result.value.repository?.some(
              (entry) =>
                entry.key === "user.email" &&
                entry.value === "work@example.com" &&
                entry.scope === "local",
            )
          );
        }, alpha.id),
      { timeout: 30_000 },
    )
    .toBe(true);
  assert.equal(
    execFileSync("git", ["-C", paths.alpha, "config", "--local", "--get", "user.email"], {
      env: fixtureEnv,
      encoding: "utf8",
    }).trim(),
    "work@example.com",
  );
  assert.equal(globalEmail(), "work@example.com");
  assert.equal(await readFile(join(paths.beta, ".git", "config"), "utf8"), betaConfigBeforeApply);

  await page.getByRole("button", { name: "Remove both local overrides", exact: true }).waitFor();
  assert.equal(await authorSettings.getByText("This repository", { exact: true }).count(), 2);

  await page.getByRole("button", { name: "Remove local author", exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const result = await window.eda.identity.inspectGit(id);
          return result.ok && result.value.localOverrides?.join(",") === "commit.gpgsign";
        }, alpha.id),
      { timeout: 30_000 },
    )
    .toBe(true);
  await authorSettings.getByText("Global Git configuration", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Remove local signing", exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const result = await window.eda.identity.inspectGit(id);

          return (
            result.ok &&
            result.value.localOverrides?.length === 0 &&
            result.value.repository?.some(
              (entry) =>
                entry.key === "user.email" &&
                entry.value === "work@example.com" &&
                entry.scope === "global",
            )
          );
        }, alpha.id),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page
    .getByText("No local author or signing overrides in this repository.", { exact: true })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: /^Remove (local|both local)/ }).count(), 0);
  assert.equal(globalEmail(), "work@example.com");
  assert.equal(await readFile(join(paths.beta, ".git", "config"), "utf8"), betaConfigBeforeApply);

  execFileSync("git", ["-C", paths.alpha, "config", "user.email", "outside@example.com"], {
    env: fixtureEnv,
  });
  await page.getByRole("button", { name: "Refresh Git settings", exact: true }).click();
  await authorSettings.getByText("outside@example.com").waitFor();
  await page
    .getByRole("region", { name: "Use profile “Work”", exact: true })
    .getByText(/work@example.com/)
    .waitFor();
  await page.getByRole("button", { name: "Use this profile", exact: true }).click();
  await authorSettings.getByText("work@example.com").waitFor();
  await page.getByRole("button", { name: "Remove both local overrides", exact: true }).click();
  await page
    .getByText("No local author or signing overrides in this repository.", { exact: true })
    .waitFor();

  const currentHeadingId = await page
    .getByRole("heading", { name: "Current Git settings", exact: true })
    .getAttribute("id");

  await page.waitForFunction((id) => document.activeElement?.id === id, currentHeadingId);
  await view(false);
  await page.getByRole("textbox", { name: "Commit title" }).fill("Work alpha draft");
  await page.getByRole("textbox", { name: "Commit description" }).fill("private details");
  await page.getByRole("button", { name: "Collapse history", exact: true }).click();

  const beta = await openRepository("beta");

  await page.getByLabel("Amend the previous commit").check();
  await draftIs("initial");
  await page.getByRole("textbox", { name: "Commit title" }).fill("Work beta draft");
  await page.getByRole("tab", { name: "alpha", exact: true }).click();
  await draftIs("Work alpha draft\n\nprivate details");
  assert.equal(await page.getByRole("button", { name: "Expand History", exact: true }).count(), 1);
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["alpha", "beta"]);

  await page.getByRole("tab", { name: "beta", exact: true }).focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["beta", "alpha"]);

  await page.keyboard.press(`${modifier}+1`);
  await draftIs("Work beta draft");
  await page.keyboard.press(`${modifier}+w`);
  await draftIs("Work alpha draft\n\nprivate details");
  await page.keyboard.press(`${modifier}+Shift+t`);
  await draftIs("Work beta draft");
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["beta", "alpha"]);

  await page
    .getByRole("tab", { name: "beta", exact: true })
    .dragTo(page.getByRole("tab", { name: "alpha", exact: true }));
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["alpha", "beta"]);

  await page.keyboard.press(`${modifier}+1`);
  await draftIs("Work alpha draft\n\nprivate details");

  await page.getByRole("tab", { name: "beta", exact: true }).click();
  await page.evaluate(() => window.eda.repository.watch(null));

  const oldAlpha = paths.alpha;
  const movedParent = join(root, "moved");

  await mkdir(movedParent);
  paths.alpha = join(movedParent, "alpha");
  assert.ok(
    resolve(oldAlpha).startsWith(`${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`),
  );
  assert.ok(
    resolve(paths.alpha).startsWith(`${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`),
  );

  const localConfig = await readFile(join(oldAlpha, ".git", "config"), "utf8");

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(oldAlpha, paths.alpha);
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EBUSY" ||
        attempt >= 19
      )
        throw error;

      await delay(100);
    }
  }

  await page.evaluate((path) => window.eda.repository.open(path), paths.beta);
  await page.getByRole("tab", { name: "alpha", exact: true }).click();
  await page.getByRole("heading", { name: "Repository unavailable", exact: true }).waitFor();
  await app.evaluate(({ dialog }, path) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [path] };
    };
  }, paths.alpha);
  await page.getByRole("button", { name: "Locate repository...", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Update repository location?" })
    .getByRole("button", { name: "Use this folder", exact: true })
    .click();
  await draftIs("Work alpha draft\n\nprivate details");

  const relocated = await page.evaluate(async (id) => {
    const result = await window.eda.repository.list();
    if (!result.ok) throw new Error("Expected a successful IPC result: " + JSON.stringify(result));
    return result.value.find((r) => r.id === id);
  }, alpha.id);

  assert.ok(relocated);
  assert.equal(await realpath(relocated.path), await realpath(paths.alpha));
  assert.equal(await readFile(join(paths.alpha, ".git", "config"), "utf8"), localConfig);
  assert.equal(
    await page.getByRole("tab", { name: "alpha", exact: true }).getAttribute("title"),
    relocated.path,
  );

  await view(true);

  const search = page.getByRole("searchbox", { name: "Search settings" });

  await search.fill("reduced motion");
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Global settings: Appearance", exact: true })
    .click();
  await page.getByRole("heading", { name: "Appearance", level: 1, exact: true }).waitFor();
  await search.fill("no-such-setting");
  await page.getByRole("status").filter({ hasText: "No settings match" }).waitFor();
  await search.press("Escape");
  await section("Profiles");
  await page.getByRole("button", { name: "New profile", exact: true }).click();

  const create = page.getByRole("dialog", { name: "New profile" });

  await create.getByRole("textbox", { name: /^Git email/ }).focus();
  await page.keyboard.type("typing@example.com");
  assert.equal(
    await create.getByRole("textbox", { name: /^Git email/ }).inputValue(),
    "typing@example.com",
  );
  await expect(create.getByRole("textbox", { name: /^Git email/ })).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(create).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New profile", exact: true })).toBeFocused();

  await page.getByRole("button", { name: "New profile", exact: true }).click();
  await create.getByRole("textbox", { name: /^Profile name/ }).fill("Home");
  await create.getByRole("textbox", { name: /^Git name/ }).fill("Eda");
  await create.getByRole("textbox", { name: /^Git email/ }).fill("home@example.com");
  await create.getByRole("button", { name: "Create profile", exact: true }).click();
  await page.getByRole("button", { name: /Active profile: Home/ }).waitFor();
  assert.equal(globalEmail(), "home@example.com");

  const profiles = await page.evaluate(async () => {
    const result = await window.eda.identity.list();
    if (!result.ok) throw new Error("Expected a successful IPC result: " + JSON.stringify(result));
    return result.value;
  });
  const work = profiles.find((profile) => profile.name === "Work");
  const home = profiles.find((profile) => profile.name === "Home");

  assert.ok(work && home);
  assert.equal(
    (
      await page.evaluate(async ({ path, id }) => window.eda.identity.assignSshKey(path, id), {
        path: keys.home,
        id: home.id,
      })
    ).ok,
    true,
  );

  const gamma = await openRepository("gamma");

  await draftIs("");
  await page.getByRole("textbox", { name: "Commit title" }).fill("Home gamma draft");
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["gamma"]);

  await view(true);
  await writeFile(`${config}.lock`, "fixture lock");
  await page
    .getByTestId(`profile-${work.id}`)
    .getByRole("button", { name: "Switch", exact: true })
    .click();
  await page.getByRole("button", { name: "Dismiss", exact: true }).waitFor();
  assert.equal(
    (
      await page.evaluate(async () => {
        const result = await window.eda.identity.getActive();
        if (!result.ok || !result.value)
          throw new Error("Expected a successful IPC result: " + JSON.stringify(result));
        return result.value;
      })
    ).id,
    home.id,
  );

  await rm(`${config}.lock`);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await view(false);
  await draftIs("Home gamma draft");
  await view(true);

  const inspect = async (profile: { id: string }) =>
    page.evaluate(async (profileId) => {
      const theme = await window.eda.settings.resolve("theme", { profileId });
      const motion = await window.eda.settings.resolve("reducedMotion", { profileId });

      if (!theme.ok || !motion.ok) throw new Error("Could not inspect profile settings");

      const value = theme.value.value;

      return {
        theme: {
          ...theme.value,
          value:
            typeof value === "string" ? value : value.mode === "light" ? value.light : value.dark,
        },
        motion: motion.value,
      };
    }, profile.id);

  assert.equal((await inspect(home)).theme.value, "eda-dark");
  assert.equal((await inspect(home)).motion.value, true);

  await section("Profile: Git");
  await page.getByLabel("Sync this profile’s identity to Git").uncheck();
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const result = await window.eda.settings.resolve("syncGlobalGitConfig", {
            profileId: id,
          });
          if (!result.ok) return false;
          return result.value.value === false;
        }, home.id),
      { timeout: 30_000 },
    )
    .toBe(true);
  await section("Global settings: Appearance");
  await page
    .getByRole("radiogroup", { name: "Appearance mode", exact: true })
    .getByRole("radio", { name: "Light", exact: true })
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const result = await window.eda.settings.resolve("theme", {});
          if (!result.ok) return false;
          return typeof result.value.value === "string"
            ? result.value.value === "eda-light"
            : result.value.value.mode === "light" && result.value.value.light === "eda-light";
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  await section("Profiles");
  await page.getByRole("button", { name: "Switch", exact: true }).click();
  await page.getByRole("button", { name: /Active profile: Work/ }).waitFor();
  assert.equal((await inspect(work)).theme.value, "nord");
  assert.equal((await inspect(work)).motion.value, true);
  assert.equal(globalEmail(), "work@example.com");

  await view(false);
  await draftIs("Work alpha draft\n\nprivate details");
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["alpha", "beta"]);

  await page.getByRole("tab", { name: "beta", exact: true }).click();
  await draftIs("Work beta draft");
  assert.equal(await page.getByLabel("Amend the previous commit").isChecked(), true);

  await page.getByRole("button", { name: "Close beta", exact: true }).click();
  await draftIs("Work alpha draft\n\nprivate details");
  await openRepository("beta");
  await draftIs("Work beta draft");
  await page.getByRole("tab", { name: "beta", exact: true }).focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["beta", "alpha"]);

  await view(true);

  const invalid = await page.evaluate(
    async (id) => window.eda.settings.set("uiZoom", { kind: "profile", profileId: id }, 1000),
    work.id,
  );

  assert.equal(invalid.ok, false);

  await page.getByRole("button", { name: "Switch", exact: true }).click();
  await page.getByRole("button", { name: /Active profile: Home/ }).waitFor();
  assert.equal(globalEmail(), "work@example.com");

  await view(false);
  await draftIs("Home gamma draft");
  await view(true);

  await expect(page.getByRole("button", { name: "Move Work up", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Move Home up", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid^="profile-"]').first()).toHaveAttribute(
    "data-testid",
    `profile-${home.id}`,
  );
  await expect(page.getByRole("button", { name: "Move Home down", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Move Work down", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: /Active profile: Home/ }).waitFor();

  const homeCard = page.getByTestId(`profile-${home.id}`);

  await homeCard.getByRole("button", { name: "Edit", exact: true }).click();

  const edit = page.getByRole("dialog", { name: "Edit profile" });

  await edit.getByRole("textbox", { name: /^Profile name/ }).fill("Personal");
  await edit.getByRole("textbox", { name: /^Git email/ }).fill("personal@example.com");
  await edit.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.getByRole("button", { name: /Active profile: Personal/ }).waitFor();
  assert.equal(
    (
      await page.evaluate(async () => {
        const result = await window.eda.identity.getActive();
        if (!result.ok || !result.value)
          throw new Error("Expected a successful IPC result: " + JSON.stringify(result));
        return result.value;
      })
    ).id,
    home.id,
  );
  assert.equal(globalEmail(), "work@example.com");

  await view(false);
  await page.getByRole("textbox", { name: "Commit title" }).fill("Saved at close without a delay");
  await app.close();
  app = undefined;
  execFileSync("git", [
    "config",
    "--file",
    config,
    "user.email",
    "external-after-close@example.com",
  ]);
  launched = await launch();
  app = launched.running;
  page = launched.page;
  await page.getByRole("button", { name: /Active profile: Personal/ }).waitFor();
  assert.equal(globalEmail(), "external-after-close@example.com");
  const restoredBrowser = await page.evaluate(() =>
    window.eda.settings.resolve("browserExecutable", {}),
  );
  assert.ok(restoredBrowser.ok);
  assert.equal(restoredBrowser.value.value, process.execPath);
  assert.equal((await inspect(home)).theme.value, "eda-light");
  assert.equal((await inspect(home)).motion.value, true);

  await draftIs("Saved at close without a delay");
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["gamma"]);
  assert.equal(
    await page.getByRole("tab", { name: "gamma", exact: true }).getAttribute("aria-selected"),
    "true",
  );

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).first().waitFor();
  await expect(page.locator('[data-testid^="profile-"]').first()).toHaveAttribute(
    "data-testid",
    `profile-${home.id}`,
  );
  await expect(page.getByRole("button", { name: "Move Personal up", exact: true })).toBeDisabled();
  await page
    .getByTestId(`profile-${work.id}`)
    .getByRole("button", { name: "Switch", exact: true })
    .click();
  await page.getByRole("button", { name: /Active profile: Work/ }).waitFor();
  await view(false);
  await draftIs("Work beta draft");
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["beta", "alpha"]);

  await page.keyboard.press(`${modifier}+9`);
  await draftIs("Work alpha draft\n\nprivate details");
  await view(true);
  await page
    .getByTestId(`profile-${home.id}`)
    .getByRole("button", { name: "Switch", exact: true })
    .click();
  await page.getByRole("button", { name: /Active profile: Personal/ }).waitFor();

  const personalCard = page.getByTestId(`profile-${home.id}`);

  await personalCard.getByRole("button", { name: "Duplicate", exact: true }).click();

  const duplicate = page.getByRole("dialog", { name: "Duplicate profile", exact: true });

  await duplicate.getByRole("textbox", { name: /^Profile name/ }).fill("Personal copy");
  await duplicate.getByRole("button", { name: "Create copy", exact: true }).click();
  await duplicate.waitFor({ state: "hidden" });

  const copy = (
    await page.evaluate(async () => {
      const result = await window.eda.identity.list();
      if (!result.ok)
        throw new Error("Expected a successful IPC result: " + JSON.stringify(result));
      return result.value;
    })
  ).find((p) => p.name === "Personal copy");

  assert.ok(copy);
  assert.notEqual(copy.id, home.id);
  assert.equal(copy.sshKeyPath, undefined);
  assert.equal(copy.signing.format, "none");

  await page
    .getByTestId(`profile-${copy.id}`)
    .getByRole("button", { name: "Switch", exact: true })
    .click();
  await page.getByRole("button", { name: /Active profile: Personal copy/ }).waitFor();

  const copiedRepos = await page.evaluate(async () => {
    const result = await window.eda.repository.list();
    if (!result.ok) throw new Error("Expected a successful IPC result: " + JSON.stringify(result));
    return result.value;
  });

  assert.equal(copiedRepos.length, 1);
  assert.ok(copiedRepos[0]);
  assert.notEqual(copiedRepos[0].id, gamma.id);
  assert.equal(copiedRepos[0].path, gamma.path);

  await view(false);
  await draftIs("");
  await view(true);
  await page
    .getByTestId(`profile-${copy.id}`)
    .getByRole("button", { name: "Delete", exact: true })
    .click();

  const deletion = page.getByRole("dialog", { name: "Delete Personal copy?", exact: true });

  assert.match(await deletion.innerText(), /switch to Personal/);

  await deletion.getByRole("button", { name: "Delete profile", exact: true }).click();
  await page.getByRole("button", { name: /^Active profile: Personal,/ }).waitFor();
  await view(false);
  await draftIs("Saved at close without a delay");
  await section("Profile: Appearance");
  await page
    .getByRole("radiogroup", { name: "Appearance mode", exact: true })
    .getByRole("radio", { name: "Dark", exact: true })
    .click();
  await page.getByRole("radio", { name: "Nord Dark", exact: true }).focus();
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.documentElement.dataset["theme"] === "eda-dark");
  await page.setViewportSize({ width: 700, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.getByRole("radio", { name: "Eda Light", exact: true }).isVisible(), true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await section("Profiles");
  assert.equal(errors.length, 0, errors.join("\n"));

  for (const profile of [work, { ...home, name: "Personal" }]) {
    await page
      .getByTestId(`profile-${profile.id}`)
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: `Delete ${profile.name}?`, exact: true })
      .getByRole("button", { name: "Delete profile", exact: true })
      .click();

    if (profile.id === work.id)
      await page.getByTestId(`profile-${work.id}`).waitFor({ state: "hidden" });
  }

  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("textbox", { name: /^Profile name/ }).waitFor();
  await page.setViewportSize({ width: 700, height: 600 });
  await page.locator("form").evaluate(async (form) => {
    await Promise.all(form.getAnimations().map((animation) => animation.finished));
  });
  await page.getByRole("button", { name: "Continue", exact: true }).scrollIntoViewIfNeeded();
  assert.ok(
    await page
      .getByRole("button", { name: "Continue", exact: true })
      .evaluate((button) => button.getBoundingClientRect().bottom <= window.innerHeight),
  );

  for (const path of [
    ...Object.values(paths).map((p) => join(p, ".git", "config")),
    ...Object.values(keys),
  ])
    await access(path);

  assert.equal(errors.length, 0, errors.join("\n"));
  assert.ok(alpha.id && beta.id);

  console.log(
    "Profile acceptance passed: isolated authors/keys/themes/drafts/layout, tab reorder and reopen shortcuts with restart persistence, moved-folder recovery, settings search, dialog typing and focus restoration, failed-switch rollback, safe duplicate/delete, default sync/opt-out and shared global preferences.",
  );
} catch (error) {
  console.error(error);

  if (app) {
    const page = app.windows()[0];

    if (page && !page.isClosed()) {
      await mkdir("screenshots", { recursive: true });
      await page
        .screenshot({ path: resolve("screenshots/profile-gate-failure.png"), fullPage: true })
        .catch(() => {});
    }
  }

  throw error;
} finally {
  if (app) await app.close().catch(() => app?.process().kill());
  assert.ok(resolve(root).startsWith(resolve(tmpdir(), "eda-profile-gate-")));
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
