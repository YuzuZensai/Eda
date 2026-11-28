import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { expect } from "playwright/test";
import { trustFixture, trustFixturePage } from "./helpers/trust.ts";
import assert from "node:assert/strict";
import { chromium, type ElectronApplication } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Result } from "../../src/shared/errors.ts";

const root = await mkdtemp(join(tmpdir(), "eda-bundled-gate-"));
const packaged = process.argv.includes("--packaged");
const env = fixtureEnvironment(root);
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === "path") delete env[key];
}

const fixtureEnv = {
  ...env,
  ...(process.platform !== "win32" && { SHELL: join(root, "login-shell") }),
  PATH:
    process.platform === "win32"
      ? join(process.env["SystemRoot"] ?? "C:/Windows", "System32")
      : "/nonexistent",
  NODE_OPTIONS: "--no-warnings=ExperimentalWarning",
};

let app: { close(): Promise<void> } | undefined;

async function launchPackaged() {
  const suffix = process.arch === "arm64" ? "-arm64" : "";
  const executable = resolve(
    process.env["EDA_PACKAGED_EXECUTABLE"] ??
      (process.platform === "win32"
        ? `release/win${suffix}-unpacked/Eda.exe`
        : process.platform === "darwin"
          ? `release/mac${suffix}/Eda.app/Contents/MacOS/Eda`
          : `release/linux${suffix}-unpacked/eda`),
  );
  const portFile = join(root, "DevToolsActivePort");
  await rm(portFile, { force: true });
  const child = spawn(
    executable,
    [
      `--user-data-dir=${root}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
    ],
    { env: fixtureEnv, stdio: ["ignore", "ignore", "inherit"] },
  );
  await once(child, "spawn");
  const exited = once(child, "exit");
  const running = {
    close: async () => {
      if (child.exitCode === null && !child.signalCode) child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
      }
    },
  };
  app = running;
  let endpoint = "";
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null || child.signalCode)
      throw new Error(
        `Packaged Eda exited before opening DevTools (${child.signalCode ?? child.exitCode})`,
      );
    const [port, path] = (await readFile(portFile, "utf8").catch(() => "")).trim().split(/\r?\n/);
    if (port && /^\d+$/.test(port) && path?.startsWith("/devtools/browser/")) {
      endpoint = `ws://127.0.0.1:${port}${path}`;
      break;
    }
    await delay(100);
  }
  assert.ok(endpoint, "The packaged app must expose its local Chromium test connection");
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  const context = browser.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 20000 }));
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => Boolean(window.eda));
  await page
    .getByRole("button", { name: "Settings", exact: true })
    .or(page.getByRole("button", { name: "Get started", exact: true }))
    .first()
    .waitFor();
  await trustFixturePage(page, [root, await realpath(root)]);
  return { running, page };
}
const launch = async () => {
  if (packaged) return launchPackaged();
  const running = await electron.launch({
    args: ["dist/main/index.js", `--user-data-dir=${root}`],
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
  await writeFile(fixtureEnv.GIT_CONFIG_GLOBAL, "");
  if (fixtureEnv.SHELL) {
    // A host login profile can put system Git back on the fixture's restricted PATH.
    await writeFile(fixtureEnv.SHELL, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', {
      mode: 0o700,
    });
  }

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
  assert.match(
    engine.path.replaceAll("\\", "/"),
    packaged ? /\/resources\/git\//i : /\/vendor\/git\//,
  );

  if (packaged) {
    assert.ok(!engine.path.includes("app.asar"));
    const resources = resolve(dirname(engine.path), "../..");
    assert.deepEqual(
      await readFile(join(resources, "licenses/provider-icons/LICENSE")),
      await readFile(new URL("../../src/renderer/assets/providers/LICENSE", import.meta.url)),
    );
  }
  const diagnostics = await page.evaluate(() => window.eda.app.gitDiagnostics());
  assert.ok(diagnostics.ok);
  assert.equal(diagnostics.value.executable, engine.path);
  assert.ok(diagnostics.value.commands.includes("worktree"));
  assert.match(diagnostics.value.build, /git version/);

  const agent = await page.evaluate(() => window.eda.ssh.getAgentStatus());
  assert.ok(agent.ok && agent.value.available, JSON.stringify(agent));
  assert.equal(agent.value.source, "builtin");
  if ("evaluate" in launched.running) {
    await (launched.running as ElectronApplication).evaluate(
      ({ dialog }, filePath) => {
        const previous = dialog.showSaveDialog;
        dialog.showSaveDialog = async () => {
          dialog.showSaveDialog = previous;
          return { canceled: false, filePath };
        };
      },
      join(root, "bundled-ed25519"),
    );
    const destination = await page.evaluate(() => window.eda.ssh.chooseKeyDestination());
    assert.ok(destination.ok && destination.value);
    const key = await page.evaluate(
      (path) => window.eda.ssh.generateKey({ path, type: "ed25519", comment: "bundled-gate" }),
      join(root, "bundled-ed25519"),
    );
    assert.ok(key.ok && key.value.fingerprint, JSON.stringify(key));
  }
  const sshKeyPath = join(root, "encrypted fixture key");
  const passphrase = "disposable encrypted key fixture";
  const keygen = resolve(
    dirname(engine.path),
    "..",
    process.platform === "win32" ? "usr/bin/ssh-keygen.exe" : "openssh/bin/ssh-keygen",
  );
  execFileSync(keygen, ["-q", "-t", "ed25519", "-f", sshKeyPath, "-N", passphrase], {
    env: fixtureEnv,
    stdio: "pipe",
  });
  const path = join(root, "repo with spaces");

  await mkdir(path);

  const repository = await page.evaluate(
    async ({ path, sshKeyPath, passphrase }) => {
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
          sshKeyPath,
          signing: { format: "ssh", keyRef: sshKeyPath, signCommits: true },
        }),
      );

      unwrap(await window.eda.settings.set("syncGlobalGitConfig", { kind: "application" }, false));
      unwrap(await window.eda.identity.setActive(profile.id));

      const unlocked = unwrap(
        await window.eda.credentials.unlockActiveKey(
          { remember: false, lifetimeSeconds: 120 },
          passphrase,
          profile.id,
        ),
      );
      if (!unlocked.available || unlocked.keys.length !== 1)
        throw new Error("Expected the fixture key in the owned agent");
      return unwrap(await window.eda.repository.init(path));
    },
    { path, sshKeyPath, passphrase },
  );

  await writeFile(join(path, "file.txt"), "no system Git needed\n");
  await mkdir(join(path, ".git/hooks"), { recursive: true });
  await writeFile(
    join(path, ".git/hooks/pre-commit"),
    "#!/bin/sh\ngit --version > hook-git-version.txt\n",
    { mode: 0o755 },
  );

  const trust = await page.evaluate((id) => window.eda.repository.reviewTrust(id), repository.id);

  assert.ok(trust.ok, JSON.stringify(trust));

  if (packaged) {
    const started = await page.evaluate((id) => window.eda.terminal.start(id), repository.id);
    assert.ok(started.ok, JSON.stringify(started));
    const session = { repo: repository.id, tab: started.value };
    try {
      const input = await page.evaluate(
        ({ repo, tab }) =>
          window.eda.terminal.input(repo, tab, "echo packaged-pty>pty-proof.txt\r", false),
        session,
      );
      assert.ok(input.ok, JSON.stringify(input));
      await expect
        .poll(() =>
          readFile(join(path, "pty-proof.txt"), "utf8")
            .then((value) => value.trim())
            .catch(() => ""),
        )
        .toBe("packaged-pty");
      const exit = await page.evaluate(
        ({ repo, tab }) => window.eda.terminal.input(repo, tab, "exit 7\r", false),
        session,
      );
      assert.ok(exit.ok, JSON.stringify(exit));
      await expect
        .poll(async () => {
          const tabs = await page.evaluate((id) => window.eda.terminal.list(id), session.repo);
          assert.ok(tabs.ok, JSON.stringify(tabs));
          return tabs.value.find((item) => item.id === session.tab)?.exit;
        })
        .toBe(7);
    } finally {
      const closed = await page.evaluate(
        ({ repo, tab }) => window.eda.terminal.close(repo, tab),
        session,
      );
      assert.ok(closed.ok, JSON.stringify(closed));
    }
  }

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
  assert.match(
    execFileSync(engine.path, ["-C", path, "cat-file", "commit", "HEAD"], {
      env: fixtureEnv,
      encoding: "utf8",
    }),
    /gpgsig -----BEGIN SSH SIGNATURE-----/,
  );
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

  if (packaged) {
    const saved = await page.evaluate(() =>
      window.eda.settings.set("hardwareAcceleration", { kind: "application" }, false),
    );
    assert.ok(saved.ok, JSON.stringify(saved));
    const graphics = await page.evaluate(() => window.eda.app.graphicsStatus());
    assert.ok(graphics.ok && graphics.value.enabledAtStartup, JSON.stringify(graphics));
  }

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

  if (packaged) {
    await expect
      .poll(async () => {
        const result = await reopened.evaluate(() => window.eda.app.graphicsStatus());
        assert.ok(result.ok, JSON.stringify(result));
        return result.value;
      })
      .toMatchObject({ enabledAtStartup: false, compositing: "software" });
  }

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
