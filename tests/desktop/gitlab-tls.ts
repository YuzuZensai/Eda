import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ElectronApplication } from "playwright";
import { expect } from "playwright/test";
import { finishOnboarding } from "./helpers/onboarding.ts";
import { trustFixture } from "./helpers/trust.ts";
import { IPC_CHANNELS } from "../../src/shared/ipc.ts";
import { assertSmoothResize, sampleResize } from "../helpers/motion.ts";

const root = await mkdtemp(join(tmpdir(), "eda-gitlab-tls-"));
const bootstrap = join(root, "fixture.cjs");
const config = join(root, "gitconfig");
const key = join(root, "key.pem");
const certificate = join(root, "certificate.pem");
const opensslConfig = join(root, "openssl.cnf");
const token = "fixture-gitlab-token";
const requests: string[] = [];
let app: ElectronApplication | undefined;
let server: ReturnType<typeof createServer> | undefined;

async function launch() {
  app = await electron.launch({
    args: [bootstrap, `--user-data-dir=${root}`],
    env: fixtureEnvironment(root),
  });

  return app.firstWindow();
}

try {
  await writeFile(config, "[user]\nname = Fixture\nemail = fixture@example.com\n");
  await writeFile(opensslConfig, "[req]\ndistinguished_name=dn\n[dn]\n");
  const windowsOpenSsl = "C:/Program Files/Git/usr/bin/openssl.exe";
  const openssl =
    process.env["EDA_OPENSSL"] ?? (existsSync(windowsOpenSsl) ? windowsOpenSsl : "openssl");

  execFileSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-config",
      opensslConfig,
    ],
    { stdio: "pipe", windowsHide: true },
  );

  await writeFile(
    bootstrap,
    `
const { safeStorage } = require("electron");

safeStorage.isEncryptionAvailable = () => true;
safeStorage.isAsyncEncryptionAvailable = async () => true;
safeStorage.getSelectedStorageBackend = () => "gnome_libsecret";

safeStorage.encryptString = (value) => Buffer.from(value);
safeStorage.encryptStringAsync = async (value) => Buffer.from(value);

safeStorage.decryptString = (value) => value.toString();
safeStorage.decryptStringAsync = async (value) => ({
  result: value.toString(),
  shouldReEncrypt: false,
});

import(${JSON.stringify(pathToFileURL(resolve("dist/main/index.js")).href)});
`,
  );

  server = createServer(
    { key: await readFile(key), cert: await readFile(certificate) },
    (request, response) => {
      requests.push(request.url ?? "");

      if (request.headers["private-token"] !== token) {
        response.writeHead(401).end();
        return;
      }

      response.setHeader("Content-Type", "application/json");

      response.end(
        JSON.stringify(
          request.url?.endsWith("/user")
            ? {
                id: 7,
                username: "work.user",
                name: "Self-Hosted User",
                bio: "Building on our own GitLab.",
                location: "Example City",
                avatar_url: null,
              }
            : [],
        ),
      );
    },
  );

  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `https://127.0.0.1:${address.port}/gitlab`;

  let page = await launch();
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Work");
  await page.getByRole("textbox", { name: /^Git author name/ }).fill("Fixture");
  await page.getByRole("textbox", { name: /^Git email/ }).fill("fixture@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await page
    .getByRole("group", { name: "Appearance mode", exact: true })
    .getByRole("button", { name: "Dark", exact: true })
    .click();

  await finishOnboarding(page);

  await app!.evaluate(({ ipcMain }, channels) => {
    for (const channel of [
      channels.githubStatus,
      channels.githubProfile,
      channels.gitlabStatus,
      channels.gitlabProfile,
    ])
      ipcMain.removeHandler(channel);

    ipcMain.handle(channels.githubStatus, () => ({
      ok: true,
      value: { secureStorage: true, account: { id: "1", login: "avery", state: "connected" } },
    }));

    ipcMain.handle(channels.githubProfile, () => ({
      ok: true,
      value: {
        id: "1",
        login: "avery",
        name: "Avery Lin",
        bio: "Building thoughtful tools.",
        location: "Example",
        avatarDataUrl: null,
      },
    }));

    ipcMain.handle(channels.gitlabStatus, () => ({
      ok: true,
      value: { secureStorage: true, account: { id: "2", login: "team.user", state: "connected" } },
    }));

    ipcMain.handle(channels.gitlabProfile, () => ({
      ok: true,
      value: {
        id: "2",
        name: "Team User",
        bio: "Building thoughtful projects.",
        location: "Example City",
        avatarDataUrl: null,
      },
    }));
  }, IPC_CHANNELS);

  await page.getByRole("button", { name: "Settings", exact: true }).click();

  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("button", { name: "Integrations", exact: true })
    .click();

  const card = page.getByRole("region", { name: "GitLab Self-Hosted connection", exact: true });
  await page.setViewportSize({ width: 1280, height: 850 });

  const capture = async (name: string) => {
    const prefix = process.env["EDA_INTEGRATIONS_SCREENSHOT"];
    if (!prefix) return;

    await page.evaluate(async () => {
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );

      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });

    await page.screenshot({ path: `${prefix}-${name}.png` });
  };

  await page.getByRole("button", { name: "View avery on GitHub", exact: true }).waitFor();
  await capture("overview");
  const github = page.getByRole("region", { name: "GitHub connection", exact: true });
  await expect(github.getByText("Building thoughtful tools.", { exact: true })).toBeVisible();
  await expect(github.getByText("Example", { exact: true })).toBeVisible();
  await expect(github.getByText("Connected", { exact: true })).toHaveCount(0);
  const gitlab = page.getByRole("region", { name: "GitLab connection", exact: true });
  await expect(gitlab.getByText("Team User", { exact: true })).toBeVisible();
  await expect(gitlab.getByText("Building thoughtful projects.", { exact: true })).toBeVisible();
  await expect(gitlab.getByText("Example City", { exact: true })).toBeVisible();

  assertSmoothResize(
    await sampleResize(card, () =>
      card.getByRole("button", { name: "Connect instance", exact: true }).click(),
    ),
  );

  await card.getByLabel("Instance URL", { exact: true }).fill(baseUrl);

  await expect(
    card.getByRole("checkbox", { name: "Ignore TLS errors", exact: true }),
  ).not.toBeChecked();

  await card.getByRole("button", { name: "Next", exact: true }).click();
  await card.getByLabel("Personal access token", { exact: true }).fill(token);
  await capture("setup");
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await card.getByRole("alert").waitFor();
  await expect(card.getByRole("alert")).toContainText("Could not reach the GitLab instance");
  await card.getByRole("checkbox", { name: "Ignore TLS errors", exact: true }).check();
  await card.getByLabel("Personal access token", { exact: true }).fill(token);
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await card.getByRole("button", { name: /View work.user/ }).waitFor();
  await expect(card.getByText("Self-Hosted User", { exact: true })).toBeVisible();
  await expect(card.getByText("Building on our own GitLab.", { exact: true })).toBeVisible();
  await expect(card.getByText("Example City", { exact: true })).toBeVisible();
  await expect(card.getByText(baseUrl, { exact: true })).toBeVisible();
  const instanceText = card.getByText(baseUrl, { exact: true });
  const instanceIcon = instanceText.locator("..").locator("svg");
  const [iconBounds, urlBounds] = await Promise.all([
    instanceIcon.boundingBox(),
    instanceText.boundingBox(),
  ]);
  assert.ok(iconBounds && urlBounds && iconBounds.x + iconBounds.width < urlBounds.x);

  const profileId = await page.evaluate(async () => {
    const result = await window.eda.identity.getActive();
    if (!result.ok || !result.value) throw new Error("Missing fixture profile");
    return result.value.id;
  });

  const results = await page.evaluate(
    async ({ profileId, baseUrl, token }) => ({
      status: await window.eda.gitlabSelfHosted.status(profileId),
      repositories: await window.eda.gitlabSelfHosted.repositories(profileId, baseUrl),
      other: await window.eda.gitlabSelfHosted.connect(
        profileId,
        baseUrl.replace("/gitlab", "/other"),
        token,
        false,
      ),
    }),
    { profileId, baseUrl, token },
  );

  assert.ok(results.status.ok && results.status.value.accounts[0]?.ignoreTlsErrors);
  assert.equal(results.repositories.ok, true);
  assert.equal(results.other.ok, false);

  const defaultSessionRejected = await app!.evaluate(async ({ net }, url) => {
    try {
      await net.fetch(`${url}/api/v4/user`);
      return false;
    } catch {
      return true;
    }
  }, baseUrl);

  assert.equal(defaultSessionRejected, true);

  await trustFixture(app!, root);

  const clones = await page.evaluate(
    async ({ profileId, baseUrl, parent, token }) => ({
      selected: await window.eda.remotes.clone({
        profileId,
        url: `${baseUrl}/team/repo.git`,
        parent,
        name: "selected",
      }),
      other: await window.eda.remotes.clone({
        profileId,
        url: `${baseUrl.replace("/gitlab", "/other")}/team/repo.git`,
        parent,
        name: "other",
        credentials: { username: "fixture", password: token },
      }),
    }),
    { profileId, baseUrl, parent: root, token },
  );

  assert.equal(clones.selected.ok, false);

  assert.ok(
    requests.some((path) => path.startsWith("/gitlab/team/repo.git/info/refs")),
    "Git must reach the self-signed server for the selected instance.",
  );

  assert.equal(clones.other.ok, false);
  if (!clones.other.ok) assert.match(clones.other.error.message, /TLS certificate/);
  assert.ok(!requests.some((path) => path.startsWith("/other/team/repo.git/")));

  await capture("connected");

  for (const row of [
    github,
    page.getByRole("region", { name: "GitLab connection", exact: true }),
    card,
  ]) {
    await expect
      .poll(async () => (await row.boundingBox())?.height ?? Infinity, {
        message: `${await row.getAttribute("aria-label")} should stay compact with profile details visible.`,
      })
      .toBeLessThanOrEqual(200);
  }

  await page.setViewportSize({ width: 900, height: 850 });
  await capture("narrow");
  const bounds = await card.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 900);
  await card.getByRole("button", { name: `Manage ${baseUrl} connection`, exact: true }).click();
  const menuBounds = await page.getByRole("menu").boundingBox();
  assert.ok(menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 900);
  await capture("menu");
  await page.getByRole("menuitem", { name: "Update token", exact: true }).click();

  await expect(
    card.getByRole("checkbox", { name: "Ignore TLS errors", exact: true }),
  ).toBeChecked();

  await app!.close();
  app = undefined;
  page = await launch();
  await page.getByRole("button", { name: /Active profile: Work/ }).waitFor();

  const restored = await page.evaluate(
    async (id) => window.eda.gitlabSelfHosted.status(id),
    profileId,
  );

  assert.ok(restored.ok && restored.value.accounts[0]?.ignoreTlsErrors);

  console.log(
    "GitLab TLS acceptance passed: strict default, API and Git opt-in, instance isolation, saved preference, editing and restart persistence.",
  );
} finally {
  await app?.close();

  if (server) {
    server.closeAllConnections();
    await new Promise<void>((done) => server!.close(() => done()));
  }

  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
