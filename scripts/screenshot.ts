import { electron } from "../tests/helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../tests/helpers/fixture-environment.ts";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, type Page } from "playwright";

const project = fileURLToPath(new URL("..", import.meta.url));
const output = join(project, "screenshots");
const userData = await mkdtemp(join(tmpdir(), "eda-screenshot-"));
const backgroundPath = join(project, "tests/fixtures/backgrounds/sakura.jpg");
const errors: string[] = [];
let app: ElectronApplication | undefined;

async function waitForPaint(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))),
  );
}

try {
  await mkdir(output, { recursive: true });
  await rm(join(output, "eda-preview-light.png"), { force: true });
  app = await electron.launch({
    args: [
      "dist/main/index.js",
      "--no-sandbox",
      `--user-data-dir=${userData}`,
      ...(process.platform === "linux" ? ["--ozone-platform=x11", "--disable-gpu"] : []),
    ],
    env: {
      ...fixtureEnvironment(userData),
      HOME: userData,
      USERPROFILE: userData,
      GIT_CONFIG_GLOBAL: join(userData, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });

  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.eda);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 1000));

  const image = await app.evaluate(({ nativeImage }, path) => {
    const source = nativeImage.createFromPath(path);
    if (source.isEmpty()) throw new Error(`Could not load screenshot background: ${path}`);
    return `data:image/jpeg;base64,${source.resize({ width: 1920 }).toJPEG(88).toString("base64")}`;
  }, backgroundPath);

  const profileId = await page.evaluate(async (background) => {
    const created = await window.eda.identity.create(
      {
        name: "Mika Chen",
        gitName: "Mika Chen",
        gitEmail: "mika@example.test",
        hue: 330,
        signing: { format: "none", signCommits: false },
      },
      { syncGlobalGitConfig: false },
    );
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.id;
    const scope = { kind: "profile" as const, profileId: id };
    const active = await window.eda.identity.setActive(id);
    if (!active.ok) throw new Error(active.error.message);
    const theme = await window.eda.settings.set("theme", scope, {
      mode: "dark",
      light: "eda-light",
      dark: "eda-dark",
    });
    if (!theme.ok) throw new Error(theme.error.message);
    const savedBackground = await window.eda.settings.set("background", scope, {
      image: background,
      strength: 16,
      blur: 2,
    });
    if (!savedBackground.ok) throw new Error(savedBackground.error.message);
    return id;
  }, image);
  assert.ok(profileId);

  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset["appearance"] === "dark");
  await page.evaluate(() => window.dispatchEvent(new Event("eda:start-tour")));

  const frame = page.frameLocator('iframe[title="Interactive Eda tutorial"]');
  await frame.getByRole("heading", { name: "Your way around Eda" }).waitFor();
  await frame.getByRole("button", { name: "Next", exact: true }).click();
  await frame.getByRole("heading", { name: "Three ways to get started", exact: true }).waitFor();
  await frame.getByRole("button", { name: "Next", exact: true }).click();
  await frame.getByRole("heading", { name: "Open Hello Eda", exact: true }).waitFor();
  await frame.getByRole("button", { name: "Open Hello Eda", exact: true }).click();
  await frame.getByRole("heading", { name: "Meet your workspace", exact: true }).waitFor();
  await frame.locator('[data-testid="commit-graph"]').waitFor();
  await frame.locator("body").evaluate((body) => {
    const style = document.createElement("style");
    style.textContent = ".ui-spotlight-motion, .ui-coachmark-motion { display: none !important; }";
    body.append(style);
  });

  const workspace = frame.locator("#demo-workspace");
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe[title="Interactive Eda tutorial"]',
    );
    return (
      document.documentElement.dataset["appearance"] === "dark" &&
      frame?.contentDocument?.documentElement.dataset["appearance"] === "dark"
    );
  });
  await waitForPaint(page);
  await workspace.screenshot({
    path: resolve(output, "eda-preview-dark.png"),
    animations: "disabled",
  });
  console.log("Wrote screenshots/eda-preview-dark.png");

  assert.deepEqual(errors, [], "The screenshot run produced renderer errors.");
} finally {
  await app?.close();
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
