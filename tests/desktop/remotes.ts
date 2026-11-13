import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { trustFixture } from "./helpers/trust.ts";
import { finishOnboarding } from "./helpers/onboarding.ts";
import { chooseSelect } from "./select-control.ts";
import assert from "node:assert/strict";
import { type ElectronApplication } from "playwright";
import { expect } from "playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "eda-remotes-gate-"));
const config = join(root, "gitconfig");
const source = join(root, "source");
const remote = join(root, "remote.git");
const certificate = join(root, "certificate.pem");
const privateKey = join(root, "key.pem");
const opensslConfig = join(root, "openssl.cnf");
const env = {
  ...fixtureEnvironment(root),
  HOME: root,
  USERPROFILE: root,
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_SSL_CAINFO: certificate,
  NODE_OPTIONS: "--no-warnings=ExperimentalWarning",
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: "pipe" }).trim();
const token = "eda-fixture-access-only";
const authorization = `Basic ${Buffer.from(`fixture:${token}`).toString("base64")}`;
const serverGit =
  process.env["EDA_SERVER_GIT"] ??
  (existsSync("C:/Program Files/Git/cmd/git.exe") ? "C:/Program Files/Git/cmd/git.exe" : "git");
let app: ElectronApplication | undefined;
let server: ReturnType<typeof createServer> | undefined;
let hold = false;
let heldRequests = 0;
let releaseHeldRequest: () => void;
const requestHeld = new Promise<void>((resolve) => {
  releaseHeldRequest = resolve;
});
const children = new Set<ChildProcess>();
const errors: string[] = [];

try {
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
      privateKey,
      "-out",
      certificate,
      "-days",
      "2",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-config",
      opensslConfig,
    ],
    { stdio: "pipe", windowsHide: true },
  );
  await writeFile(
    config,
    `[user]\nname = Fixture\nemail = fixture@example.com\n[commit]\ngpgsign = false\n[http]\nsslBackend = openssl\nsslCAInfo = ${certificate.replaceAll("\\", "/")}\n`,
  );
  await mkdir(source);
  await mkdir(remote);
  git(remote, "init", "--bare", "-b", "main");
  git(remote, "config", "http.receivepack", "true");
  git(source, "init", "-b", "main");
  await writeFile(join(source, "file.txt"), "initial\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "Initial history");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "origin", "main");
  server = createServer(
    { key: await readFile(privateKey), cert: await readFile(certificate) },
    (request, response) => {
      if (hold) {
        heldRequests++;
        releaseHeldRequest();
        request.resume();
        return;
      }

      if (request.headers.authorization !== authorization) {
        request.resume();
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Eda fixture"' });
        response.end("Authentication required");
        return;
      }

      const url = new URL(request.url ?? "/", "https://127.0.0.1");
      const child = spawn(serverGit, ["http-backend"], {
        env: {
          ...env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          CONTENT_LENGTH: request.headers["content-length"] ?? "",
          REMOTE_USER: "fixture",
          HTTP_GIT_PROTOCOL: request.headers["git-protocol"]?.toString() ?? "",
        },
        windowsHide: true,
      });

      children.add(child);
      request.pipe(child.stdin);
      child.stdin.on("error", () => {});

      const chunks: Buffer[] = [];

      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stderr.on("data", () => {});
      child.on("error", () => {
        response.writeHead(500);
        response.end();
      });
      child.on("close", () => {
        children.delete(child);

        const output = Buffer.concat(chunks);
        const boundary = output.indexOf("\r\n\r\n");

        if (boundary < 0) {
          response.writeHead(500);
          response.end();
          return;
        }

        const headers: Record<string, string> = {};
        let status = 200;

        for (const line of output.subarray(0, boundary).toString().split("\r\n")) {
          const split = line.indexOf(":");
          if (split < 0) continue;
          const key = line.slice(0, split).toLowerCase();
          const value = line.slice(split + 1).trim();
          if (key === "status") status = Number(value.split(" ")[0]);
          else headers[key] = value;
        }

        response.writeHead(status, headers);
        response.end(output.subarray(boundary + 4));
      });
    },
  );
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));

  const address = server.address();

  assert.ok(address && typeof address !== "string");

  const url = `https://127.0.0.1:${address.port}/remote.git`;

  app = await electron.launch({
    args: ["dist/main/index.js", `--user-data-dir=${join(root, "user-data")}`],
    env,
  });

  await trustFixture(app, root);
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });

  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Work");
  await page.getByRole("textbox", { name: /^Git author name/ }).fill("Fixture");
  await page.getByRole("textbox", { name: /^Git email/ }).fill("fixture@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await finishOnboarding(page);
  await page.getByRole("button", { name: "Clone repository", exact: true }).click();

  const clone = page.getByRole("dialog", { name: "Clone repository", exact: true });

  await clone.getByLabel("Repository URL", { exact: true }).fill(url);
  await clone.getByLabel("Clone parent folder").fill(root);
  await clone.getByLabel("Clone folder name").fill("cloned repo");
  await clone.getByText("HTTPS authentication", { exact: true }).click();
  await clone.getByLabel("HTTPS username").fill("fixture");
  await clone.getByLabel("HTTPS token").fill(token);
  await clone.getByRole("button", { name: "Clone repository", exact: true }).click();
  await clone.waitFor({ state: "hidden", timeout: 30000 });

  const cloneRecords = await page.evaluate(() => window.eda.operations.list());

  assert.ok(cloneRecords.ok, JSON.stringify(cloneRecords));
  assert.equal(
    cloneRecords.value?.find((record) => record.kind === "Clone repository")?.state,
    "succeeded",
    JSON.stringify(cloneRecords),
  );

  const clientPath = join(root, "cloned repo");

  assert.equal(git(clientPath, "log", "-1", "--format=%s"), "Initial history");
  assert.equal(git(clientPath, "remote", "get-url", "origin"), url);
  assert.doesNotMatch(
    await readFile(join(clientPath, ".git/config"), "utf8"),
    /Authorization|eda-fixture-access-only/,
  );

  const repository = await page.evaluate(async () => {
    const result = await window.eda.repository.list();
    if (!result.ok) throw new Error("Expected a successful IPC result: " + JSON.stringify(result));
    return result.value[0];
  });

  assert.ok(repository);

  await page.getByRole("button", { name: "Fetch options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage remotes...", exact: true }).click();
  const remoteSettings = page.locator("#settings-repository-remotes");
  await remoteSettings.getByLabel("Remote name").fill("backup");
  await remoteSettings.getByLabel("Remote URL").fill(remote);
  await remoteSettings.getByRole("button", { name: "Save remote", exact: true }).click();
  await remoteSettings.getByText("backup", { exact: true }).waitFor();
  assert.equal(resolve(git(clientPath, "remote", "get-url", "backup")), resolve(remote));
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const httpsAuthentication = page.getByRole("dialog", {
    name: "HTTPS authentication",
    exact: true,
  });
  await page.getByRole("button", { name: "Fetch", exact: true }).click();
  await httpsAuthentication.getByLabel("HTTPS username").fill("fixture");
  await httpsAuthentication.getByLabel("HTTPS token").fill("wrong-token");
  await httpsAuthentication.getByRole("button", { name: "Retry fetch", exact: true }).click();
  await httpsAuthentication.getByLabel("HTTPS token").fill(token);
  await httpsAuthentication.getByLabel("HTTPS username").fill("fixture");
  git(source, "branch", "topic");
  git(source, "push", "origin", "topic");
  await httpsAuthentication.getByRole("button", { name: "Retry fetch", exact: true }).click();
  await httpsAuthentication.waitFor({ state: "hidden" });
  await page
    .getByRole("status")
    .filter({ hasText: /Fetched origin/ })
    .first()
    .waitFor();
  assert.equal(await page.getByRole("dialog", { name: "Remotes", exact: true }).count(), 0);
  assert.equal(
    git(clientPath, "rev-parse", "refs/remotes/origin/topic"),
    git(source, "rev-parse", "topic"),
  );
  await page.getByRole("button", { name: "Remotes", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Remotes", exact: true })).toHaveCount(0);
  await expect(remoteSettings.getByRole("heading", { name: "Branch tracking" })).toBeVisible();

  await chooseSelect(
    remoteSettings.getByLabel("Upstream", { exact: true }),
    "refs/remotes/origin/topic",
  );
  await remoteSettings.getByRole("button", { name: "Set upstream", exact: true }).click();
  await remoteSettings.getByText(/origin\/topic up to date/).waitFor();
  assert.equal(git(clientPath, "config", "branch.main.merge"), "refs/heads/topic");

  await chooseSelect(
    remoteSettings.getByLabel("Upstream", { exact: true }),
    "refs/remotes/origin/main",
  );
  await remoteSettings.getByRole("button", { name: "Set upstream", exact: true }).click();
  await remoteSettings.getByText(/origin\/main up to date/).waitFor();
  assert.equal(git(clientPath, "config", "branch.main.merge"), "refs/heads/main");

  git(clientPath, "tag", "-a", "release", "-m", "release notes");
  git(clientPath, "tag", "unpublished");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Command palette", exact: true }).click();
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  await palette.getByRole("combobox", { name: "Search commands" }).fill("Manage branch tracking");
  await page.keyboard.press("Enter");
  await expect(remoteSettings.getByRole("heading", { name: "Branch tracking" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Remotes", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Fetch", exact: true }).click();
  await httpsAuthentication.getByLabel("HTTPS username").fill("fixture");
  await httpsAuthentication.getByLabel("HTTPS token").fill(token);
  await httpsAuthentication.getByRole("button", { name: "Retry fetch", exact: true }).click();
  await httpsAuthentication.waitFor({ state: "hidden" });
  await page
    .getByRole("status")
    .filter({ hasText: /Fetched origin/ })
    .first()
    .waitFor();
  git(remote, "tag", "server-only", "refs/heads/main");
  git(clientPath, "branch", "release");
  await page
    .getByRole("button", { name: "Inspect tag release", exact: true })
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Verify tag signature...", exact: true }).locator("svg"),
  ).toHaveCount(1);
  await page.screenshot({ path: join(tmpdir(), "eda-tag-menu.png") });
  await page.getByRole("menuitem", { name: "Push tag", exact: true }).click();
  await httpsAuthentication.getByLabel("Username", { exact: true }).fill("fixture");
  await httpsAuthentication.getByLabel("Access token", { exact: true }).fill(token);
  await httpsAuthentication.getByRole("button", { name: "Retry push", exact: true }).click();
  await httpsAuthentication.waitFor({ state: "hidden" });
  await expect.poll(() => git(remote, "tag", "--list", "release")).toBe("release");
  assert.equal(
    git(remote, "rev-parse", "refs/tags/release"),
    git(clientPath, "rev-parse", "refs/tags/release"),
  );

  const tagsSection = page
    .locator("details")
    .filter({ has: page.locator("summary").getByText("Tags", { exact: true }) });
  await expect(tagsSection).toHaveCount(1);
  await expect(page.getByText("Local tags", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Remote tags", { exact: true })).toHaveCount(0);
  const remoteOnlyTag = tagsSection.getByRole("button", {
    name: "Inspect tag server-only",
    exact: true,
  });
  await remoteOnlyTag.waitFor();
  await expect(
    tagsSection.getByRole("button", { name: "Inspect tag release", exact: true }),
  ).toHaveCount(1);
  await expect(remoteOnlyTag).toHaveText("backup/server-only");
  await expect(remoteOnlyTag).toHaveAttribute("title", /Remote tag: backup/);
  await expect(remoteOnlyTag.locator("svg")).toHaveCount(0);
  await expect(
    tagsSection.getByRole("button", { name: "Inspect tag release", exact: true }),
  ).toHaveText("release");
  await expect(page.getByRole("button", { name: "Inspect branch main", exact: true })).toHaveText(
    "main",
  );
  await expect(
    page.getByRole("button", { name: "Inspect branch origin/main", exact: true }),
  ).toHaveText("origin/main");
  assert.equal(git(clientPath, "tag", "--list", "server-only"), "");
  await page.screenshot({ path: join(tmpdir(), "eda-tag-references.png") });
  await page
    .locator('[data-tour="references"]')
    .screenshot({ path: join(tmpdir(), "eda-reference-locations.png") });
  await remoteOnlyTag.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Verify tag signature...", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Inspect tag unpublished", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete tag...", exact: true }).click();
  const localTagDelete = page.getByRole("dialog", { name: "Delete tag", exact: true });
  await chooseSelect(localTagDelete.getByLabel("Remote", { exact: true }), "backup");
  await expect(localTagDelete.getByRole("radio", { name: "Remote only", exact: true })).toHaveCount(
    0,
  );
  await expect(
    localTagDelete.getByRole("radio", { name: "Local and remote", exact: true }),
  ).toHaveCount(0);
  await expect(localTagDelete.getByText("Remote: backup/unpublished", { exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({ path: join(tmpdir(), "eda-tag-delete-local-only.png") });
  await localTagDelete.getByRole("button", { name: "Delete locally", exact: true }).click();
  await localTagDelete.waitFor({ state: "hidden" });
  assert.equal(git(clientPath, "tag", "--list", "unpublished"), "");

  await page
    .getByRole("button", { name: "Inspect tag release", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete tag...", exact: true }).click();
  const deleteTagDialog = page.getByRole("dialog", { name: "Delete tag", exact: true });
  await chooseSelect(deleteTagDialog.getByLabel("Remote", { exact: true }), "backup");
  await expect(deleteTagDialog).not.toHaveAttribute("aria-modal", "true");
  await expect(deleteTagDialog).toHaveClass(/ui-popover-in/);
  await expect(deleteTagDialog.getByText("Check remote tags", { exact: true })).toHaveCount(0);
  await expect(deleteTagDialog.locator('input[type="password"]')).toHaveCount(0);
  await deleteTagDialog.getByRole("radio", { name: "Local and remote", exact: true }).check();
  await page.screenshot({ path: join(tmpdir(), "eda-tag-delete-compact.png") });
  await chooseSelect(deleteTagDialog.getByLabel("Remote", { exact: true }), "origin");
  await deleteTagDialog.getByLabel("HTTPS username").fill("fixture");
  await deleteTagDialog.getByLabel("Access token").fill(token);
  await deleteTagDialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    deleteTagDialog.getByRole("radio", { name: "Local and remote", exact: true }),
  ).toBeEnabled();
  await deleteTagDialog.getByRole("radio", { name: "Local and remote", exact: true }).check();
  await page.screenshot({ path: join(tmpdir(), "eda-tag-delete.png") });
  await deleteTagDialog
    .getByRole("button", { name: "Delete local and remote", exact: true })
    .click();
  await deleteTagDialog.waitFor({ state: "hidden" });
  assert.equal(git(remote, "tag", "--list", "release"), "");
  assert.equal(git(clientPath, "tag", "--list", "release"), "");
  assert.notEqual(git(clientPath, "branch", "--list", "release"), "");
  assert.notEqual(git(remote, "tag", "--list", "server-only"), "");

  await writeFile(join(clientPath, "commit-and-push.txt"), "committed locally first\n");

  const staged = await page.evaluate(
    (id) => window.eda.repository.stage({ repositoryId: id }),
    repository.id,
  );

  assert.equal(staged.ok, true);

  await page
    .getByRole("textbox", { name: "Commit title", exact: true })
    .fill("Commit and push acceptance");
  await page.getByRole("button", { name: "Commit and Push", exact: true }).click();
  await httpsAuthentication.waitFor();

  const committedHead = git(clientPath, "rev-parse", "HEAD");

  assert.equal(git(clientPath, "log", "-1", "--format=%s"), "Commit and push acceptance");

  git(remote, "config", "receive.denyNonFastForwards", "true");
  git(clientPath, "branch", "--set-upstream-to=origin/main", "main");
  await writeFile(join(source, "concurrent.txt"), "concurrent remote change\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "concurrent update");
  git(source, "push", "origin", "main");
  await httpsAuthentication.getByLabel("Username", { exact: true }).fill("fixture");
  await httpsAuthentication.getByLabel("Access token", { exact: true }).fill(token);
  await httpsAuthentication.getByRole("button", { name: "Retry push", exact: true }).click();
  const forcePush = page.getByRole("dialog", { name: "Force push?", exact: true });
  await forcePush.getByRole("button", { name: "Force with lease", exact: true }).click();
  const pushFailure = page.getByRole("dialog", { name: "Push failed", exact: true });
  await pushFailure
    .getByRole("alert")
    .filter({ hasText: /rejected/ })
    .waitFor();
  assert.equal(git(clientPath, "rev-parse", "HEAD"), committedHead);
  assert.equal(git(clientPath, "status", "--porcelain"), "");
  await pushFailure.getByRole("button", { name: "Close", exact: true }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "Commit title", exact: true }).inputValue(),
    "",
  );

  const tlsResult = await page.evaluate(
    async ({ id, url, token }) => {
      await window.eda.remotes.change(id, {
        kind: "url",
        name: "origin",
        url: url.replace("127.0.0.1", "localhost"),
        push: false,
      });

      const result = await window.eda.remotes.fetch({
        repositoryId: id,
        remote: "origin",
        prune: false,
        tags: false,
        credentials: { username: "fixture", password: token },
      });

      await window.eda.remotes.change(id, { kind: "url", name: "origin", url, push: false });

      return result;
    },
    { id: repository.id, url, token },
  );

  assert.equal(tlsResult.ok, false);
  assert.equal(tlsResult.error.kind, "network-failed");
  assert.match(tlsResult.error.message, /TLS certificate/);

  hold = true;
  await page.getByRole("button", { name: "Fetch", exact: true }).click();

  let requestTimeout;

  try {
    await Promise.race([
      requestHeld,
      new Promise((_, reject) => {
        requestTimeout = setTimeout(
          () => reject(new Error("Fetch never reached the remote")),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(requestTimeout);
  }

  await page.getByRole("button", { name: /^Activity/ }).click();
  const runningFetch = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /running.*Fetch remotes/ }) });
  await runningFetch.locator("summary").click();
  await runningFetch.getByRole("button", { name: "Cancel operation", exact: true }).click();
  await page
    .getByRole("button", { name: "Fetch", exact: true })
    .filter({ has: page.locator(".ui-action-visible .lucide-x") })
    .click();
  await page
    .getByRole("dialog", { name: "Could not complete the action", exact: true })
    .getByRole("alert")
    .filter({ hasText: /cancelled/ })
    .waitFor();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.getByRole("button", { name: /^Activity/ }).click();
  hold = false;

  const records = await page.evaluate(() => window.eda.operations.list());

  assert.equal(records.ok, true);
  assert.ok(records.value.some((record) => record.state === "interrupted"));
  assert.doesNotMatch(JSON.stringify(records), /eda-fixture-access-only|wrong-token/);

  const before = git(clientPath, "rev-parse", "HEAD");

  assert.equal(await realpath(repository.path), await realpath(clientPath));
  assert.equal(before, committedHead);

  git(clientPath, "branch", "--set-upstream-to=origin/main", "main");
  await page.getByRole("button", { name: "Pull strategies", exact: true }).click();
  await page.getByRole("menuitem", { name: "Fast-forward only", exact: true }).click();
  await httpsAuthentication.getByLabel("HTTPS username").fill("fixture");
  await httpsAuthentication.getByLabel("HTTPS token").fill(token);
  await httpsAuthentication.getByRole("button", { name: "Retry pull", exact: true }).click();
  await page
    .getByRole("button", { name: "Pull", exact: true })
    .filter({ has: page.locator(".ui-action-visible .lucide-x") })
    .click();
  await page
    .getByRole("dialog", { name: "Could not complete the action", exact: true })
    .getByRole("alert")
    .filter({ hasText: /diverged/ })
    .waitFor();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  assert.equal(git(clientPath, "rev-parse", "HEAD"), committedHead);

  await page.getByRole("button", { name: "Pull strategies", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rebase local commits", exact: true }).click();
  await httpsAuthentication.getByLabel("HTTPS username").fill("fixture");
  await httpsAuthentication.getByLabel("HTTPS token").fill(token);
  await httpsAuthentication.getByRole("button", { name: "Retry pull", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Pull completed." }).waitFor();
  assert.equal(git(clientPath, "rev-parse", "HEAD^"), git(source, "rev-parse", "HEAD"));
  assert.equal(git(clientPath, "status", "--porcelain"), "");

  await writeFile(join(clientPath, "second-commit.txt"), "push from the same panel\n");
  const secondStage = await page.evaluate(
    (id) => window.eda.repository.stage({ repositoryId: id }),
    repository.id,
  );
  assert.ok(secondStage.ok);
  await page.getByRole("textbox", { name: "Commit title", exact: true }).fill("Second push");
  await page.getByRole("button", { name: "Commit and Push", exact: true }).click();
  await httpsAuthentication.getByLabel("Username", { exact: true }).fill("fixture");
  await httpsAuthentication.getByLabel("Access token", { exact: true }).fill(token);
  await httpsAuthentication.getByRole("button", { name: "Retry push", exact: true }).click();
  assert.equal(git(clientPath, "log", "-1", "--format=%s"), "Second push");
  await expect
    .poll(() => git(remote, "rev-parse", "main"))
    .toBe(git(clientPath, "rev-parse", "HEAD"));

  git(source, "branch", "scheduled-only");
  git(source, "push", "origin", "scheduled-only");
  git(clientPath, "remote", "add", "scheduled", remote);

  const beforeScheduled = git(clientPath, "rev-parse", "HEAD");

  await writeFile(join(clientPath, "scheduled-local.txt"), "preserve unsaved work\n");
  await page.getByRole("button", { name: "Fetch options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Fetch settings...", exact: true }).click();
  const fetchSettings = page.locator("#settings-repository-fetch");
  await chooseSelect(
    fetchSettings.getByRole("combobox", { name: "Background fetch interval" }),
    "1",
  );

  const fetchDeadline = Date.now() + 45_000;

  for (;;) {
    const state = await page.evaluate(
      (id) => window.eda.backgroundFetch.inspect(id),
      repository.id,
    );

    if (
      state.ok &&
      state.value.remotes.some(
        (remote) => remote.name === "scheduled" && remote.history?.lastSuccess,
      )
    )
      break;

    if (Date.now() > fetchDeadline)
      throw new Error(`Scheduled fetch did not complete: ${JSON.stringify(state)}`);

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(
    git(clientPath, "rev-parse", "refs/remotes/scheduled/scheduled-only"),
    git(source, "rev-parse", "scheduled-only"),
  );
  assert.equal(git(clientPath, "rev-parse", "HEAD"), beforeScheduled);
  assert.equal(
    await readFile(join(clientPath, "scheduled-local.txt"), "utf8"),
    "preserve unsaved work\n",
  );

  await chooseSelect(
    fetchSettings.getByRole("combobox", { name: "Background fetch interval" }),
    "0",
  );
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const state = await window.eda.backgroundFetch.inspect(id);
          return state.ok && state.value.intervalMinutes === 0;
        }, repository.id),
      { timeout: 30_000 },
    )
    .toBe(true);
  await app.close();
  app = await electron.launch({
    args: ["dist/main/index.js", `--user-data-dir=${join(root, "user-data")}`],
    env,
  });

  const resumedPage = await app.firstWindow();

  resumedPage.setDefaultTimeout(20_000);
  resumedPage.on("pageerror", (error) => errors.push(error.message));
  await resumedPage.getByRole("button", { name: "Settings", exact: true }).waitFor();

  const savedFetch = await resumedPage.evaluate(
    async (id) => window.eda.backgroundFetch.inspect(id),
    repository.id,
  );

  assert.equal(savedFetch.ok, true);
  assert.equal(savedFetch.value.intervalMinutes, 0);
  assert.ok(
    savedFetch.value.remotes.find((remote) => remote.name === "scheduled")?.history?.lastSuccess,
  );
  assert.equal(errors.length, 0, errors.join("\n"));

  console.log(
    `Remotes gate passed: private HTTPS clone/fetch/push, credential rejection/redaction, tracking, tags/deletion, rejected-push recovery, reviewed pull, scheduled fetch preserving local work, timestamp persistence after restart and cancellation (${heldRequests} held requests).`,
  );
} catch (error) {
  if (app) {
    console.error(
      await app.windows()[0]?.evaluate(async () => {
        const result = await window.eda.operations.list();

        if (!result.ok)
          throw new Error("Expected a successful IPC result: " + JSON.stringify(result));

        return result.value.map((record) => ({
          kind: record.kind,
          state: record.state,
          message: record.message,
          output: record.output,
        }));
      }),
    );
    await mkdir("screenshots", { recursive: true });
    await app
      .windows()[0]
      ?.screenshot({ path: resolve("screenshots/remotes-gate-failure.png") })
      .catch(() => {});
  }

  throw error;
} finally {
  if (app) await app.close().catch(() => app?.process().kill());

  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }

  for (const child of children) child.kill();

  assert.ok(resolve(root).startsWith(resolve(tmpdir(), "eda-remotes-gate-")));

  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
