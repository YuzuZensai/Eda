import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { expect } from "playwright/test";
import assert from "node:assert/strict";
import { accentComponents } from "../../src/shared/preferences/accent.ts";
import { defaultCommitPrefixes } from "../../src/shared/preferences/commit-prefix.ts";
import { type ElectronApplication, type Page } from "playwright";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertCompositorMotion, assertSmoothResize, sampleResize } from "../helpers/motion.ts";

const root = await mkdtemp(join(tmpdir(), "eda-onboarding-gate-"));
const config = join(root, "gitconfig");
const imagePath = join(root, "background.png");

const originalGit =
  "[user]\nname = Eda Example\nemail = eda@example.com\n[commit]\ngpgsign = false\n";

await writeFile(config, originalGit);

const errors: string[] = [];
let app: ElectronApplication | undefined;

async function openCustomAccent(page: Page) {
  await page.waitForFunction(() => {
    const group = [
      ...document.querySelectorAll('[role="radiogroup"][aria-label="Accent color"]'),
    ].find((element) => element.checkVisibility());

    return group && !group.closest("[inert]");
  });

  await page
    .getByRole("radiogroup", { name: "Accent color", exact: true })
    .getByTitle("Custom", { exact: true })
    .click();
}

async function launch() {
  app = await electron.launch({
    args: ["dist/main/index.js", `--user-data-dir=${root}`],
    env: {
      ...fixtureEnvironment(root),
      HOME: root,
      USERPROFILE: root,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      NODE_OPTIONS: "--no-warnings=ExperimentalWarning",
    },
  });

  const page = await app.firstWindow();

  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForLoadState("domcontentloaded");

  return page;
}

async function inspect(page: Page, profileId: string) {
  return page.evaluate(async (profileId) => {
    const keys = [
      "theme",
      "accentHue",
      "conventionalCommitsEnabled",
      "commitPrefixes",
      "syncGlobalGitConfig",
    ] as const;

    return Promise.all(
      keys.map(async (key) => {
        const result = await window.eda.settings.resolve(key, { profileId });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      }),
    );
  }, profileId);
}

try {
  let page = await launch();

  const fixtureImage = await app!.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(Buffer.alloc(16, 180), { width: 2, height: 2 })
      .toPNG()
      .toString("base64"),
  );

  await writeFile(imagePath, Buffer.from(fixtureImage, "base64"));
  await page.setViewportSize({ width: 700, height: 600 });
  await page.getByRole("heading", { name: "Hello, from Eda." }).waitFor();
  await page.getByRole("button", { name: "Get started", exact: true }).click();

  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => {})),
    );
  });

  await page.waitForFunction(
    () => document.querySelector<HTMLInputElement>("input")?.value === "Eda",
  );

  assert.equal(await page.getByRole("textbox", { name: /^Profile name/ }).inputValue(), "Eda");

  assert.equal(
    await page.getByRole("textbox", { name: /^Git author name/ }).inputValue(),
    "Eda Example",
  );

  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Personal");
  assert.equal(await page.getByRole("textbox", { name: /^Profile name/ }).inputValue(), "Personal");

  await page
    .getByRole("checkbox", { name: "Sync this profile with global Git", exact: true })
    .uncheck();

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Make Eda yours", exact: true }).waitFor();

  await page
    .getByRole("group", { name: "Appearance mode", exact: true })
    .getByRole("button", { name: "Dark", exact: true })
    .click();

  await page.getByRole("radio", { name: "Lavender", exact: true }).check();
  await page.getByTitle("Pink", { exact: true }).click();

  const accentHeight = await page
    .locator("form")
    .evaluate((form) => form.getBoundingClientRect().height);

  await openCustomAccent(page);

  let picker = page.getByRole("dialog", { name: "Custom accent color", exact: true });

  await picker.waitFor();
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "detached" });

  assert.equal(
    await page
      .getByRole("radio", { name: "Custom", exact: true })
      .evaluate((input) => input === document.activeElement),
    true,
  );

  await openCustomAccent(page);
  await picker.waitFor();

  assert.equal(
    await page.locator("form").evaluate((form) => form.getBoundingClientRect().height),
    accentHeight,
  );

  await picker.getByLabel("Choose custom accent color", { exact: true }).fill("#c46c9e");
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "detached" });

  const appearanceHeight = await page
    .locator("form")
    .evaluate((form) => form.getBoundingClientRect().height);

  await app!.evaluate(({ dialog }, imagePath) => {
    const original = dialog.showOpenDialog;

    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [imagePath] };
    };
  }, imagePath);

  await page.getByRole("button", { name: "Choose background image", exact: true }).click();
  const preview = page.getByRole("img", { name: "Selected background", exact: true });
  await preview.or(page.getByRole("alert")).waitFor();
  assert.deepEqual(await page.getByRole("alert").allTextContents(), []);

  const selectedImage = await preview.getAttribute("src");

  assert.ok(selectedImage?.startsWith("data:image/jpeg;base64,"));

  assert.equal(
    await page.locator("form").evaluate((form) => form.getBoundingClientRect().height),
    appearanceHeight,
  );

  await page.getByRole("button", { name: "Remove image", exact: true }).click();

  assert.equal(
    await page.locator("form").evaluate((form) => form.getBoundingClientRect().height),
    appearanceHeight,
  );

  assert.equal(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--background-strength"),
    ),
    "0",
  );

  assert.equal(await page.locator(".onboarding-background-controls").getAttribute("inert"), "");

  await app!.evaluate(({ dialog }, imagePath) => {
    const original = dialog.showOpenDialog;

    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [imagePath] };
    };
  }, imagePath);

  await page.getByRole("button", { name: "Choose background image", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset["customBackground"] === "true");

  assert.equal(
    await page.evaluate(() => document.documentElement.dataset["customBackground"]),
    "true",
  );

  const beforeSave = await page.evaluate(() => window.eda.settings.resolve("background", {}));

  assert.ok(beforeSave.ok && beforeSave.value.value.image === "");

  await page.waitForFunction(() => document.documentElement.dataset["theme"] === "lavender-dark");
  assert.equal(await readFile(config, "utf8"), originalGit);

  await page.getByRole("button", { name: "Back", exact: true }).click();
  assert.equal(await page.getByRole("textbox", { name: /^Profile name/ }).inputValue(), "Personal");

  assert.equal(
    await page
      .getByRole("checkbox", { name: "Sync this profile with global Git", exact: true })
      .isChecked(),
    false,
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Make Eda yours", exact: true }).waitFor();

  assert.equal(
    await page.evaluate(() =>
      document
        .getAnimations()
        .some((animation) =>
          (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith(
            "::view-transition",
          ),
        ),
    ),
    false,
  );

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("radio", { name: /^Conventional commits/ }).check();
  await page.getByRole("button", { name: "With emojis", exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Connect your tools", exact: true }).waitFor();
  await page.getByRole("region", { name: "GitHub connection", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Connect", exact: true }).count(), 0);
  assert.equal(await page.locator('details[aria-label="SSH setup"]').getAttribute("open"), null);
  await page.getByText("Additional Git hosts", { exact: true }).waitFor();
  assert.equal(await page.locator("summary").getByText("Coming soon", { exact: true }).count(), 0);

  assert.equal(
    await page
      .locator('details[aria-label="GitLab setup"] > summary')
      .getByText("Coming soon", { exact: true })
      .count(),
    0,
  );

  await page.getByRole("button", { name: "Connect instance", exact: true }).click();
  const setup = page.getByRole("region", { name: "Connect self-hosted GitLab", exact: true });
  const instance = "https://git.company.test/gitlab";
  await setup.getByLabel("Instance URL", { exact: true }).fill(instance);
  await setup.getByRole("button", { name: "Next", exact: true }).click();

  await app!.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & { fixtureGitLabTokenUrls: string[] };
    state.fixtureGitLabTokenUrls = [];
    const original = shell.openExternal;

    shell.openExternal = async (url) => {
      state.fixtureGitLabTokenUrls.push(url);
      if (state.fixtureGitLabTokenUrls.length === 3) shell.openExternal = original;
    };
  });

  await setup.getByRole("button", { name: "Legacy token", exact: true }).click();
  await setup.getByLabel("Personal access token", { exact: true }).waitFor();
  await setup.getByRole("button", { name: "Fine-grained token", exact: true }).click();
  await setup.getByRole("button", { name: "For older GitLab versions", exact: true }).click();

  const tokenUrls = await app!.evaluate(
    () =>
      (globalThis as typeof globalThis & { fixtureGitLabTokenUrls: string[] })
        .fixtureGitLabTokenUrls,
  );

  assert.equal(
    new URL(tokenUrls[0]!).pathname,
    "/gitlab/-/user_settings/personal_access_tokens/legacy/new",
  );

  assert.equal(new URL(tokenUrls[0]!).searchParams.get("scopes"), "read_api,write_repository");
  assert.equal(tokenUrls[1], `${instance}/-/user_settings/personal_access_tokens/granular/new`);
  assert.equal(new URL(tokenUrls[2]!).pathname, "/gitlab/-/user_settings/personal_access_tokens");
  assert.equal(new URL(tokenUrls[2]!).searchParams.get("scopes"), "read_api,write_repository");
  const gitlabScreenshot = process.env["EDA_GITLAB_SCREENSHOT"];
  if (gitlabScreenshot) await page.screenshot({ path: gitlabScreenshot });
  await setup.getByRole("button", { name: "Cancel", exact: true }).click();
  await setup.waitFor({ state: "detached" });
  assert.equal(await page.getByText("Commit signing", { exact: true }).count(), 0);
  await page.locator('details[aria-label="SSH setup"] > summary').click();
  await page.getByRole("button", { name: "Import key", exact: true }).waitFor();
  await page.getByRole("button", { name: "Generate key", exact: true }).waitFor();
  await page.getByRole("button", { name: "Start using Eda", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome to Eda.", exact: true }).waitFor();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "Take a tour", exact: true }).click();
  assert.equal(await page.locator("#setup-complete-title").count(), 1);
  await page.locator('.ui-tour-reveal[data-visible="true"]').waitFor();
  const tour = page.frameLocator("iframe");
  await tour.getByRole("heading", { name: "Your way around Eda", exact: true }).waitFor();
  assert.equal(await page.locator("#setup-complete-title").count(), 1);
  await tour.getByRole("button", { name: "Skip tour", exact: true }).click();
  await page.locator("iframe").waitFor({ state: "detached" });
  await page.getByRole("button", { name: /Active profile: Personal/ }).waitFor();
  assert.equal(await readFile(config, "utf8"), originalGit);

  {
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    await page
      .getByRole("navigation", { name: "Settings sections", exact: true })
      .getByRole("button", { name: "Integrations", exact: true })
      .click();

    await page.getByRole("heading", { name: "Integrations", exact: true }).waitFor();
    await page.getByRole("button", { name: "Connect instance", exact: true }).waitFor();

    const snapshot = async (suffix: string) => {
      await page.evaluate(async () => {
        await new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        );

        await Promise.all(
          document.getAnimations().map((animation) => animation.finished.catch(() => {})),
        );
      });

      if (gitlabScreenshot)
        await page.screenshot({ path: gitlabScreenshot.replace(/\.png$/, `-${suffix}.png`) });
    };

    await snapshot("card");

    const card = page.getByRole("region", { name: "GitLab Self-Hosted connection", exact: true });

    assertSmoothResize(
      await sampleResize(card, () =>
        page.getByRole("button", { name: "Connect instance", exact: true }).click(),
      ),
    );

    const setup = page.getByRole("region", { name: "Connect self-hosted GitLab", exact: true });
    assert.equal(await setup.locator('ol, [aria-current="step"]').count(), 0);
    await setup.getByLabel("Instance URL", { exact: true }).fill(instance);
    await snapshot("server");

    assertSmoothResize(
      await sampleResize(card, () =>
        setup.getByRole("button", { name: "Next", exact: true }).click(),
      ),
    );

    await snapshot("token");
    await setup.getByLabel("Personal access token", { exact: true }).waitFor();

    assert.equal(
      await setup.getByRole("button", { name: "I already have a token", exact: true }).count(),
      0,
    );

    assert.equal(await setup.locator("details").count(), 0);

    assertSmoothResize(
      await sampleResize(card, () =>
        setup.getByRole("button", { name: "Cancel", exact: true }).click(),
      ),
    );

    await page.emulateMedia({ reducedMotion: "reduce" });

    const reduced = await sampleResize(card, () =>
      page.getByRole("button", { name: "Connect instance", exact: true }).click(),
    );

    assert.ok(
      new Set(reduced.map(Math.round)).size <= 2,
      `Reduced motion should resize immediately: ${[...new Set(reduced.map(Math.round))].join(", ")}`,
    );

    await setup.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await assertCompositorMotion(page);
    await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  }

  const profile = await page.evaluate(async () => {
    const result = await window.eda.identity.getActive();
    if (!result.ok || !result.value) throw new Error("Onboarding profile missing");
    return result.value;
  });

  const choices = await inspect(page, profile.id);

  assert.deepEqual(
    choices.map((choice) => choice.source.kind),
    ["application", "application", "application", "application", "profile"],
  );

  assert.deepEqual(
    choices.map((choice) => choice.value),
    [
      { mode: "dark", light: "lavender-light", dark: "lavender-dark" },
      "#c46c9e",
      true,
      defaultCommitPrefixes(true),
      false,
    ],
  );

  await app!.close();
  app = undefined;
  page = await launch();
  await page.getByRole("button", { name: /Active profile: Personal/ }).waitFor();
  assert.deepEqual(await inspect(page, profile.id), choices);

  const savedBackground = await page.evaluate(() => window.eda.settings.resolve("background", {}));

  assert.ok(savedBackground.ok);

  if (savedBackground.ok) assert.equal(savedBackground.value.value.image, selectedImage);

  assert.equal(await readFile(config, "utf8"), originalGit);

  const second = await page.evaluate(async () => {
    const result = await window.eda.identity.create({
      name: "Work",
      gitName: "Eda Work",
      gitEmail: "eda.work@example.com",
      hue: 210,
      signing: { format: "none", signCommits: false },
    });

    if (!result.ok) throw new Error(result.error.message);

    return result.value;
  });

  const switched = await page.evaluate(async (id) => window.eda.identity.setActive(id), second.id);

  assert.equal(switched.ok, true);

  await page.getByRole("button", { name: /Active profile: Work/ }).waitFor();

  const inherited = await inspect(page, second.id);

  assert.deepEqual(inherited.slice(0, 4), choices.slice(0, 4));

  const inheritedBackground = await page.evaluate(
    (profileId) => window.eda.settings.resolve("background", { profileId }),
    second.id,
  );

  assert.deepEqual(inheritedBackground, savedBackground);
  assert.equal(inherited[4]?.value, true);
  assert.notEqual(inherited[4]?.source.kind, "profile");

  assert.deepEqual(await page.evaluate(() => window.eda.app.getGlobalGitUser()), {
    ok: true,
    value: { name: "Eda Work", email: "eda.work@example.com" },
  });

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Global settings: Appearance", exact: true }).click();
  await openCustomAccent(page);
  picker = page.getByRole("dialog", { name: "Custom accent color", exact: true });
  await picker.getByRole("textbox", { name: "Hex color", exact: true }).fill("#638f86");

  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const result = await window.eda.settings.resolve("accentHue", {});
          return result.ok && result.value.value === "#638f86";
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Profile: Appearance", exact: true }).click();
  await page.getByRole("combobox", { name: "Accent color source", exact: true }).click();
  await page.getByRole("option", { name: "Customize", exact: true }).click();
  await openCustomAccent(page);
  picker = page.getByRole("dialog", { name: "Custom accent color", exact: true });
  await picker.getByRole("textbox", { name: "Hex color", exact: true }).fill("#ac799f");

  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const profile = await window.eda.identity.getActive();
          return profile.ok && profile.value?.hue === "#ac799f";
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Global settings: Appearance", exact: true }).click();

  const waitForAccent = (hex: `#${string}`) =>
    page.waitForFunction(
      (hue) => {
        const rendered = document.documentElement.style.getPropertyValue("--identity-hue");
        return rendered !== "" && Math.abs(Number(rendered) - hue) < 0.0001;
      },
      accentComponents(hex).hue,
      { timeout: 10_000 },
    );

  await waitForAccent("#638f86");
  await page.getByRole("button", { name: "Profile: Appearance", exact: true }).click();
  await waitForAccent("#ac799f");
  await page.getByRole("combobox", { name: "Accent color source", exact: true }).click();
  await page.getByRole("option", { name: "Follow global", exact: true }).click();

  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const profile = await window.eda.identity.getActive();
          if (!profile.ok || !profile.value) return false;

          const result = await window.eda.settings.resolve("accentHue", {
            profileId: profile.value.id,
          });

          return (
            result.ok &&
            result.value.value === "#638f86" &&
            result.value.source.kind === "application"
          );
        }),
      { timeout: 30_000 },
    )
    .toBe(true);

  await page.getByRole("button", { name: "Global settings: Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Remove image", exact: true }).click();

  await page.waitForFunction(
    () => document.documentElement.dataset["customBackground"] === "false",
  );

  const backdrop = await page.evaluate(() => ({
    duration: getComputedStyle(document.body, "::before").transitionDuration,
    image: getComputedStyle(document.body, "::before").backgroundImage,
    strength: document.documentElement.style.getPropertyValue("--background-strength"),
  }));

  assert.notEqual(backdrop.duration, "0s");
  assert.notEqual(backdrop.image, "none");
  assert.equal(backdrop.strength, "0");

  await app!.evaluate(({ dialog }, imagePath) => {
    const original = dialog.showOpenDialog;

    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [imagePath] };
    };
  }, imagePath);

  await page.getByRole("button", { name: "Choose background image", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset["customBackground"] === "true");
  assert.equal(errors.length, 0, errors.join("\n"));

  console.log(
    "Onboarding acceptance passed: Git import, editable first name, retained steps, live appearance, reduced motion, emoji preset, global inheritance, atomic sync opt-out, unchanged Git configuration and restart persistence.",
  );
} finally {
  if (app) await app.close().catch(() => app?.process().kill());
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
