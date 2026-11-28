import { firstRepository, electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { trustFixture } from "./helpers/trust.ts";
import { finishOnboarding } from "./helpers/onboarding.ts";
import { expect } from "playwright/test";
import { chooseSelect } from "./select-control.ts";
import assert from "node:assert/strict";
import { type ElectronApplication } from "playwright";
import ssh2 from "ssh2";
import { existsSync } from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { Connection, Server } from "ssh2";

const root = await mkdtemp(join(tmpdir(), "eda-ssh-remotes-"));
const source = join(root, "source");
const remote = join(root, "remote.git");
const key = join(root, "client-key");
const fixturePassphrase = "eda-disposable-key-fixture";
const wrongKey = join(root, "wrong-key");
const hostKey = join(root, "host-key");
const gpgHome = join(root, "gnupg");
const env = {
  ...fixtureEnvironment(root),
  PATH: process.env["PATH"] ?? "",
  NODE_OPTIONS: "--no-warnings=ExperimentalWarning",
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: "pipe" }).trim();
const clients = new Set<Connection>();
const children = new Set<ChildProcess>();
const gpg =
  process.env["EDA_GPG"] ??
  (existsSync("C:/Program Files/Git/usr/bin/gpg.exe")
    ? "C:/Program Files/Git/usr/bin/gpg.exe"
    : "gpg");
const gpgconf =
  process.env["EDA_GPGCONF"] ??
  (existsSync("C:/Program Files/Git/usr/bin/gpgconf.exe")
    ? "C:/Program Files/Git/usr/bin/gpgconf.exe"
    : "gpgconf");

if (process.platform === "win32" && gpg.replaceAll("\\", "/").includes("/usr/bin/"))
  env.GNUPGHOME = gpgHome
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

let server: Server | undefined;
let app: ElectronApplication | undefined;

try {
  await mkdir(source);
  await mkdir(join(root, ".ssh"));
  await writeFile(
    env.GIT_CONFIG_GLOBAL,
    "[user]\nname = Eda\nemail = test@eda.invalid\n[commit]\ngpgsign = false\n",
  );

  for (const path of [key, wrongKey, hostKey])
    execFileSync(
      "ssh-keygen",
      ["-t", "ed25519", "-f", path, "-N", path === key ? fixturePassphrase : "", "-C", "Eda", "-q"],
      {
        env,
        stdio: "pipe",
      },
    );

  git(source, "init", "-b", "main");
  await writeFile(join(source, "initial.txt"), "initial\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "Initial history");
  git(source, "init", "--bare", "-b", "main", remote);
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "origin", "main");

  const allowedKey = ssh2.utils.parseKey(await readFile(`${key}.pub`));

  assert.ok(!(allowedKey instanceof Error));

  server = new ssh2.Server({ hostKeys: [await readFile(hostKey)] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (
        ctx.username !== "eda" ||
        ctx.method !== "publickey" ||
        !ctx.key.data.equals(allowedKey.getPublicSSH()) ||
        (ctx.signature &&
          (!ctx.blob || allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true))
      )
        return ctx.reject();

      ctx.accept();
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();

        session.on("exec", (accept, reject, info) => {
          const match = /^git-(upload|receive)-pack '\/remote.git'$/.exec(info.command);

          if (!match) return reject();

          const channel = accept();
          const child = spawn("git", [`${match[1]}-pack`, remote], {
            env,
            windowsHide: true,
            stdio: "pipe",
          });

          children.add(child);
          child.stdin.on("error", () => {});
          channel.on("error", () => {});
          channel.pipe(child.stdin);
          child.stdout.pipe(channel, { end: false });
          child.stderr.pipe(channel.stderr, { end: false });
          child.on("error", (error) => {
            channel.stderr.write(error.message);
            channel.exit(1);
            channel.end();
          });
          child.on("close", (code) => {
            children.delete(child);
            channel.exit(code ?? 1);
            channel.end();
          });
          channel.on("close", () => {
            if (child.exitCode === null) child.kill();
          });
        });
      }),
    );
  });
  await new Promise<void>((done, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", done);
  });

  const address = server.address();

  assert.ok(address && typeof address !== "string");

  const port = address.port;
  const knownHosts = join(root, ".ssh", "known_hosts");

  await writeFile(knownHosts, `[127.0.0.1]:${port} ${await readFile(`${hostKey}.pub`, "utf8")}`);

  if (process.platform !== "win32") {
    // On Unix, OpenSSH gets ~ from passwd rather than HOME.
    const os = process.platform === "darwin" ? "mac" : "linux";
    const sshExecutable = resolve("vendor/git", `${os}-${process.arch}`, "openssh/bin/ssh");
    assert.ok(existsSync(sshExecutable), "Prepare the bundled OpenSSH client before this gate.");

    const bin = join(root, "bin");

    await mkdir(bin);

    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

    await writeFile(
      join(bin, "ssh"),
      `#!/bin/sh\nexec ${quote(sshExecutable)} -F /dev/null -o ${quote(`UserKnownHostsFile=${knownHosts}`)} -o GlobalKnownHostsFile=/dev/null "$@"\n`,
      { mode: 0o700 },
    );
    env["PATH"] = `${bin}${delimiter}${env["PATH"] ?? ""}`;
  }

  const url = `ssh://eda@127.0.0.1:${port}/remote.git`;

  app = await electron.launch({
    args: ["dist/main/index.js", `--user-data-dir=${join(root, "user-data")}`],
    env,
  });

  if (process.platform !== "win32") {
    const setupPage = await app.firstWindow();
    await setupPage.waitForFunction(() => Boolean(window.eda));
    await app.evaluate(({ dialog }) => {
      const previous = dialog.showMessageBox;
      dialog.showMessageBox = async () => {
        dialog.showMessageBox = previous;
        return { response: 1, checkboxChecked: false };
      };
    });
    const configured = await setupPage.evaluate(
      (path) => window.eda.settings.set("sshExecutable", { kind: "application" }, path),
      join(root, "bin", "ssh"),
    );
    assert.ok(configured.ok, JSON.stringify(configured));
    await app.close();
    app = await electron.launch({
      args: ["dist/main/index.js", `--user-data-dir=${join(root, "user-data")}`],
      env,
    });
  }
  await trustFixture(app, root);
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Eda");
  await page.getByRole("textbox", { name: /^Git author name/ }).fill("Eda");
  await page.getByRole("textbox", { name: /^Git email/ }).fill("test@eda.invalid");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await finishOnboarding(page);
  await page.getByRole("button", { name: "Clone repository", exact: true }).waitFor();

  let profile;
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    const active = await page.evaluate(() => window.eda.identity.getActive());
    assert.ok(active.ok, JSON.stringify(active));
    profile = active.value;
    if (profile) break;
    await new Promise((done) => setTimeout(done, 50));
  }

  assert.ok(profile, "First profile activation must finish");

  const configured = await page.evaluate(
    ({ id, key }) =>
      window.eda.identity.update(id, {
        sshKeyPath: key,
        signing: { format: "ssh", keyRef: key, signCommits: false },
      }),
    { id: profile.id, key },
  );

  assert.equal(configured.ok, true, JSON.stringify(configured));
  const unlocked = await page.evaluate(
    ({ id, passphrase }) =>
      window.eda.credentials.unlockActiveKey(
        { remember: false, lifetimeSeconds: 600 },
        passphrase,
        id,
      ),
    { id: profile.id, passphrase: fixturePassphrase },
  );
  assert.ok(
    unlocked.ok && unlocked.value.available && unlocked.value.keys.length === 1,
    JSON.stringify(unlocked),
  );

  await page.getByRole("button", { name: "Clone repository", exact: true }).click();

  const clone = page.getByRole("dialog", { name: "Clone repository", exact: true });

  await clone.getByLabel("Repository URL", { exact: true }).fill(url);
  await clone.getByLabel("Clone parent folder").fill(root);
  await clone.getByLabel("Clone folder name").fill("client repo");
  await clone.getByRole("button", { name: "Clone repository", exact: true }).click();
  await clone.waitFor({ state: "hidden", timeout: 30000 });

  const repository = await firstRepository(page);

  assert.ok(repository);
  assert.equal(git(repository.path, "log", "-1", "--format=%s"), "Initial history");

  git(source, "branch", "remote-topic");
  git(source, "push", "origin", "remote-topic");

  const fetch = () =>
    page.evaluate(
      (id) =>
        window.eda.remotes.fetch({ repositoryId: id, remote: "origin", prune: true, tags: true }),
      repository.id,
    );

  assert.equal((await fetch()).ok, true);
  assert.equal(
    git(repository.path, "rev-parse", "origin/remote-topic"),
    git(source, "rev-parse", "remote-topic"),
  );

  const created = await page.evaluate(
    (id) =>
      window.eda.repository.createBranch({ repositoryId: id, name: "feature/ssh", checkout: true }),
    repository.id,
  );

  assert.equal(created.ok, true);

  await page.getByRole("button", { name: /On branch feature\/ssh/ }).waitFor();
  await page.getByRole("button", { name: "Push", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /new branch/ })
    .waitFor();
  assert.equal(git(remote, "rev-parse", "feature/ssh"), git(repository.path, "rev-parse", "HEAD"));

  const allowed = join(root, "allowed-signers");

  await writeFile(allowed, `test@eda.invalid ${await readFile(`${key}.pub`, "utf8")}`);
  git(repository.path, "config", "gpg.ssh.allowedSignersFile", allowed);

  const modifier = process.platform === "darwin" ? "Meta" : "Control";

  await page.keyboard.press(`${modifier}+Shift+p`);
  await page
    .getByRole("combobox", { name: "Search commands" })
    .fill("Create tag at selection or HEAD");
  await page.keyboard.press("Enter");
  await page.getByRole("textbox", { name: "Tag name", exact: true }).fill("signed-release");
  await page.getByRole("textbox", { name: "Annotated tag message" }).fill("Signed release");
  await page.getByLabel("Sign with this profile’s SSH/GPG key").check();
  await page.getByRole("button", { name: "Create tag", exact: true }).click();
  await page
    .getByRole("button", { name: "Inspect tag signed-release", exact: true })
    .click({ button: "right" });

  await page.getByRole("menuitem", { name: "Verify tag signature...", exact: true }).click();
  const tag = page.getByRole("dialog", { name: "Verify tag", exact: true });

  await tag.getByText("Valid signature · trusted signer", { exact: true }).waitFor();
  await page.keyboard.press("Escape");

  const signedPush = await page.evaluate(async (id) => {
    const preview = await window.eda.remotes.preparePush({
      repositoryId: id,
      remote: "origin",
      branch: "signed-release",
      destination: "signed-release",
      refKind: "tag",
      mode: "normal",
      setUpstream: false,
    });

    return preview.ok ? window.eda.remotes.push(id, preview.value.token) : preview;
  }, repository.id);

  assert.equal(signedPush.ok, true, JSON.stringify(signedPush));
  assert.equal(
    git(remote, "rev-parse", "refs/tags/signed-release"),
    git(repository.path, "rev-parse", "refs/tags/signed-release"),
  );

  const deletedTag = await page.evaluate(async (id) => {
    const preview = await window.eda.remotes.preparePush({
      repositoryId: id,
      remote: "origin",
      branch: "signed-release",
      destination: "signed-release",
      refKind: "tag",
      mode: "delete",
      setUpstream: false,
    });

    return preview.ok ? window.eda.remotes.push(id, preview.value.token) : preview;
  }, repository.id);

  assert.equal(deletedTag.ok, true);
  assert.equal(git(remote, "tag", "--list", "signed-release"), "");
  assert.equal(git(repository.path, "tag", "--list", "signed-release"), "signed-release");

  await mkdir(gpgHome);
  execFileSync(
    gpg,
    [
      "--batch",
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      "",
      "--quick-generate-key",
      "Eda <test@eda.invalid>",
      "ed25519",
      "sign",
      "0",
    ],
    { env, stdio: "pipe" },
  );

  const publicKeys = execFileSync(gpg, ["--batch", "--with-colons", "--list-secret-keys"], {
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  const fingerprint = publicKeys
    .split("\n")
    .find((line) => line.startsWith("fpr:"))
    ?.split(":")[9];

  assert.ok(fingerprint);

  git(repository.path, "config", "gpg.program", gpg);
  git(repository.path, "config", "--global", "gpg.program", gpg);

  const trust = await page.evaluate((id) => window.eda.repository.reviewTrust(id), repository.id);

  assert.ok(trust.ok, JSON.stringify(trust));

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Credentials & signing", exact: true })
    .click();

  const signing = page.getByRole("group", { name: "Commit signing", exact: true });

  await chooseSelect(signing.getByLabel("Format", { exact: true }), "gpg");

  const picker = signing.getByRole("radiogroup", { name: "GPG signing key", exact: true });

  const exactSigner = `${fingerprint}!`;
  await picker.getByRole("radio", { name: /Primary key · exact selection/ }).check();
  assert.match((await picker.textContent()) ?? "", /test@eda.invalid/);
  await expect(signing).toHaveAttribute("aria-busy", "false");

  await expect
    .poll(
      () =>
        page.evaluate(async (expected) => {
          const result = await window.eda.identity.getActive();
          return (
            result.ok &&
            result.value?.signing.format === "gpg" &&
            result.value.signing.keyRef === expected
          );
        }, exactSigner),
      { timeout: 30_000 },
    )
    .toBe(true);

  const gpgProfile = await page.evaluate(() => window.eda.identity.getActive());

  assert.ok(gpgProfile.ok && gpgProfile.value, JSON.stringify(gpgProfile));
  assert.equal(gpgProfile.value.signing.keyRef, exactSigner);
  assert.equal(gpgProfile.value.signing.format, "gpg");

  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const gpgTag = await page.evaluate(
    (id) =>
      window.eda.repository.createTag({
        repositoryId: id,
        name: "gpg-release",
        message: "GPG release",
        sign: true,
      }),
    repository.id,
  );

  assert.equal(gpgTag.ok, true, JSON.stringify(gpgTag));

  const gpgVerification = await page.evaluate(
    (id) => window.eda.repository.verifyTag({ repositoryId: id, name: "gpg-release" }),
    repository.id,
  );

  assert.ok(gpgVerification.ok, JSON.stringify(gpgVerification));
  assert.equal(gpgVerification.value?.status, "verified", JSON.stringify(gpgVerification));

  const rejected = await page.evaluate(
    ({ id, key }) => window.eda.identity.update(id, { sshKeyPath: key }),
    { id: profile.id, key: wrongKey },
  );

  assert.equal(rejected.ok, true);
  assert.equal((await fetch()).ok, false, "A different key must not authenticate");

  await page.evaluate(({ id, key }) => window.eda.identity.update(id, { sshKeyPath: key }), {
    id: profile.id,
    key,
  });
  await writeFile(knownHosts, `[127.0.0.1]:${port} ${await readFile(`${wrongKey}.pub`, "utf8")}`);

  const changedHost = await fetch();

  assert.equal(changedHost.ok, false);
  assert.match(changedHost.error.suggestedAction ?? changedHost.error.message, /host key changed/i);
  assert.equal(errors.length, 0, errors.join("\n"));

  console.log(
    "SSH remotes gate passed: private clone/fetch/publish, profile key rejection, changed-host refusal, and SSH/GPG signed tag creation/verification and signed-tag transfer/deletion. All keys were generated in a disposable directory.",
  );
} catch (error) {
  if (app) {
    console.error(
      await app.windows()[0]?.evaluate(async () => {
        const result = await window.eda.operations.list();
        if (!result.ok)
          throw new Error("Expected a successful IPC result: " + JSON.stringify(result));
        return result.value;
      }),
    );
    await mkdir("screenshots", { recursive: true });
    await app
      .windows()[0]
      ?.screenshot({ path: resolve("screenshots/ssh-remotes-failure.png") })
      .catch(() => {});
  }

  throw error;
} finally {
  if (app) await app.close().catch(() => app?.process().kill());

  for (const child of children) child.kill();

  for (const client of clients) client.end();

  if (server) await new Promise<void>((done) => server!.close(() => done()));

  if (existsSync(gpgHome)) {
    try {
      execFileSync(gpgconf, ["--kill", "gpg-agent"], { env, stdio: "pipe" });
    } catch {}
  }

  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
