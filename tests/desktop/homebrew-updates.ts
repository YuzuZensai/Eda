import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build, Platform, Arch } from "electron-builder";
import { chromium, type Browser, type ElectronApplication } from "playwright";
import { expect } from "playwright/test";
import configuration from "../../electron-builder.config.ts";
import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";

if (process.platform !== "darwin") throw new Error("The Homebrew desktop suite requires macOS.");

const execute = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), "eda-homebrew-updates-")));
const project = resolve(".");
const brewRoot = join(root, "brew");
const prefix = join(root, "prefix");
const appdir = join(root, "Applications");
const data = join(root, "data");
const tap = join(root, "tap");
const core = join(root, "core");
const brew = join(prefix, "bin", "brew");
const token = "yuzuzensai/tap/eda";
const originalVersion = "0.0.1";
const updatedVersion = "0.0.2";
const productName = "Eda Dev Update Test";
const environment = { ...fixtureEnvironment(root), SHELL: "/bin/sh" };

let app: ElectronApplication | undefined;
let relaunched: Browser | undefined;
let relaunchedPid: number | undefined;

async function run(executable: string, args: string[], env: NodeJS.ProcessEnv = environment) {
  try {
    return (
      await execute(executable, args, { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    ).stdout.trim();
  } catch (error) {
    if (error instanceof Error && "stderr" in error) console.error(error.stderr);

    throw error;
  }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function commit(directory: string, message: string) {
  await run("git", ["-C", directory, "add", "."]);

  await run("git", [
    "-C",
    directory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=test@eda.invalid",
    "commit",
    "-qm",
    message,
  ]);
}

async function cask(version: string, archive: string) {
  const checksum = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");

  await writeFile(
    join(tap, "Casks", "eda.rb"),
    `cask "eda" do
  version "${version}"
  sha256 "${checksum}"
  url "${pathToFileURL(archive).href}"
  name "Eda local update fixture"
  desc "Disposable Homebrew update test"
  homepage "https://eda.kirameki.cafe/"
  app "Eda.app"

  postflight_steps do
    run "/usr/bin/xattr",
        args: ["-dr", "com.apple.quarantine", "{{appdir}}/Eda.app"],
        must_succeed: true
  end
end
`,
  );

  await commit(tap, version);
}

async function packageVersion(version: string, port: number) {
  const staging = join(root, `source-${version}`);
  const output = join(root, `package-${version}`);

  await mkdir(staging);
  await cp(join(project, "dist"), join(staging, "dist"), { recursive: true });
  await symlink(join(project, "node_modules"), join(staging, "node_modules"));

  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));

  await writeFile(
    join(staging, "package.json"),
    JSON.stringify({
      ...manifest,
      name: "eda-dev-update-test",
      productName,
      version,
      main: "dist/main/homebrew-fixture.mjs",
    }),
  );

  await writeFile(
    join(staging, "dist/main/homebrew-fixture.mjs"),
    `import { app, session, safeStorage } from "electron";
import { appendFileSync, writeFileSync, readFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const spawn = childProcess.spawn;

childProcess.spawn = (executable, args, options) => {
  if (executable.endsWith("/bin/brew")) {
    appendFileSync(
      ${JSON.stringify(join(root, "brew-process.log"))},
      JSON.stringify({ executable, args }) + "\\n",
    );

    if (executable !== ${JSON.stringify(brew)})
      throw new Error("Refusing to run Homebrew outside the fixture prefix");
  }

  const child = executable === "/usr/bin/security"
    ? spawn("/usr/bin/true", [], options)
    : spawn(executable, args, options);

  if (executable.endsWith("/bin/brew")) {
    child.stderr.on("data", (chunk) =>
      appendFileSync(${JSON.stringify(join(root, "brew-process.log"))}, chunk),
    );
  }

  return child;
};

syncBuiltinESMExports();

app.commandLine.appendSwitch("remote-debugging-port", ${JSON.stringify(String(port))});
safeStorage.isEncryptionAvailable = () => false;
safeStorage.isAsyncEncryptionAvailable = async () => false;

app.whenReady().then(() => {
  session.defaultSession.protocol.handle("https", (request) => {
    const url = new URL(request.url);

    return url.hostname === "eda.kirameki.cafe" && url.pathname.startsWith("/api/updates/")
      ? new Response(
          readFileSync(${JSON.stringify(join(root, "feed.json"))}),
          { headers: { "Content-Type": "application/json" } },
        )
      : new Response("Network disabled in local update fixture", { status: 503 });
  });
});

app.on("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", () => {
    writeFileSync(
      ${JSON.stringify(join(root, `started-${version}.json`))},
      JSON.stringify({
        pid: process.pid,
        version: app.getVersion(),
        data: app.getPath("userData"),
      }),
    );
  });
});

await import("./index.js");
`,
  );

  console.log(`Packaging local Homebrew fixture ${version}…`);

  await build({
    projectDir: staging,
    targets: Platform.MAC.createTarget("dir", process.arch === "arm64" ? Arch.arm64 : Arch.x64),
    config: {
      ...configuration,
      files: ["dist/**/*", "package.json"],
      mac: { ...configuration.mac },
      appId: "cafe.kirameki.eda.homebrew-fixture",
      productName,
      protocols: [],
      electronDist: join(project, "node_modules/electron/dist"),
      electronFuses: { ...configuration.electronFuses, enableNodeCliInspectArguments: true },
      directories: { output },
      extraResources: [{ from: join(project, `vendor/git/mac-${process.arch}`), to: "git" }],
    },
    publish: "never",
  });

  const packageDirectory = join(output, process.arch === "arm64" ? "mac-arm64" : "mac");
  const bundle = join(packageDirectory, "Eda.app");
  const archive = join(root, `Eda-${version}.zip`);

  await rename(join(packageDirectory, `${productName}.app`), bundle);
  await run("codesign", ["--force", "--deep", "--sign", "-", bundle]);
  await run("codesign", ["--verify", "--deep", "--strict", bundle]);
  await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", bundle, archive]);

  return archive;
}

try {
  const repository = await run("brew", ["--repository"], process.env);

  await run("git", ["clone", "--shared", "--quiet", repository, brewRoot]);
  await symlink(
    join(repository, "Library/Homebrew/vendor/portable-ruby"),
    join(brewRoot, "Library/Homebrew/vendor/portable-ruby"),
  );

  await mkdir(join(prefix, "bin"), { recursive: true });
  await mkdir(join(brewRoot, "Caskroom"));
  await symlink(join(brewRoot, "Caskroom"), join(prefix, "Caskroom"));
  await mkdir(appdir);
  await mkdir(data);

  await mkdir(join(tap, "Casks"), { recursive: true });
  await run("git", ["init", "-q", "-b", "main", tap]);

  await run("git", ["init", "-q", "-b", "main", core]);
  await writeFile(join(core, "README.md"), "Empty core tap for the local Eda cask test.\n");
  await commit(core, "Initialize local core fixture");

  await run("git", [
    "clone",
    "--quiet",
    core,
    join(brewRoot, "Library/Taps/homebrew/homebrew-core"),
  ]);

  await writeFile(
    brew,
    `#!/bin/sh
export HOMEBREW_BREW_GIT_REMOTE=${quote(repository)}
export HOMEBREW_CORE_GIT_REMOTE=${quote(core)}

export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_FROM_API=1
export HOMEBREW_NO_ANALYTICS=1
export HOMEBREW_NO_ENV_HINTS=1
export HOMEBREW_UPDATE_TEST=1

export HOMEBREW_CACHE=${quote(join(root, "cache"))}
export HOMEBREW_LOGS=${quote(join(root, "logs"))}
export HOMEBREW_CASK_OPTS=${quote(`--appdir=${appdir} --no-quarantine`)}

exec ${quote(join(brewRoot, "bin/brew"))} "$@"
`,
    { mode: 0o755 },
  );

  await writeFile(join(root, "gitconfig"), "[user]\nname = Fixture\nemail = test@eda.invalid\n");
  assert.equal(await realpath(await run(brew, ["--prefix"])), brewRoot);

  await writeFile(
    join(root, "feed.json"),
    JSON.stringify({ Assets: [{ PackageId: "Eda", Type: "Full", Version: updatedVersion }] }),
  );

  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => server.close(() => done()));

  const originalArchive = await packageVersion(originalVersion, port);
  const updatedArchive = await packageVersion(updatedVersion, port);

  await cask(originalVersion, originalArchive);
  await run(brew, ["tap", "yuzuzensai/tap", tap]);
  await run(brew, ["install", "--cask", "--require-sha", token]);

  await cask(updatedVersion, updatedArchive);
  await run(brew, ["update"]);

  console.log("Launching the installed fixture and checking the real Homebrew update…");

  app = await electron.launch({
    executablePath: join(appdir, `Eda.app/Contents/MacOS/${productName}`),
    timeout: 30_000,
    args: [`--user-data-dir=${data}`],
    env: { ...environment, HOMEBREW_CASKROOM: join(prefix, "Caskroom") },
  });

  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.getByRole("button", { name: "Get started", exact: true }).waitFor();

  const saved = await page.evaluate(async () => {
    const created = await window.eda.identity.create(
      {
        name: "Homebrew fixture",
        gitName: "Fixture",
        gitEmail: "test@eda.invalid",
        hue: 45,
        signing: { format: "none", signCommits: false },
      },
      { syncGlobalGitConfig: true },
    );

    if (!created.ok) throw new Error(created.error.message);

    const active = await window.eda.identity.setActive(created.value.id);

    if (!active.ok) throw new Error(active.error.message);

    return created.value;
  });

  await page.reload();
  await writeFile(join(root, "gitconfig"), "[user]\nname = Outside\nemail = outside@eda.invalid\n");

  await page
    .getByRole("complementary", { name: "Global Git configuration warning", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "About", exact: true }).click();

  const offered = await page.evaluate(() => window.eda.updates.check());

  assert.ok(
    offered.ok && offered.value.phase === "available",
    JSON.stringify(offered) + "\n" + (await readFile(join(root, "brew-process.log"), "utf8")),
  );

  await page.getByRole("button", { name: "Update with Homebrew", exact: true }).waitFor();

  const closed = app.waitForEvent("close", { timeout: 120_000 });
  await page.getByRole("button", { name: "Update with Homebrew", exact: true }).click();

  await expect(
    page.getByRole("complementary", { name: "Global Git configuration warning", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Review global Git settings", exact: true }),
  ).toHaveCount(0);

  await closed;

  await expect
    .poll(
      async () => readFile(join(root, `started-${updatedVersion}.json`), "utf8").catch(() => ""),
      { timeout: 30_000 },
    )
    .not.toBe("");

  const started = JSON.parse(await readFile(join(root, `started-${updatedVersion}.json`), "utf8"));
  assert.ok(Number.isSafeInteger(started.pid) && started.pid > 0);
  relaunchedPid = started.pid;

  assert.equal(started.version, updatedVersion);
  assert.equal(started.data, data);

  relaunched = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const restored = relaunched.contexts()[0]!.pages()[0]!;
  await restored.getByRole("button", { name: "Settings", exact: true }).waitFor();

  const active = await restored.evaluate(() => window.eda.identity.getActive());

  assert.ok(active.ok && active.value?.id === saved.id);
  await expect(restored.getByRole("button", { name: "Get started", exact: true })).toHaveCount(0);

  const info = JSON.parse(await run(brew, ["info", "--json=v2", "--cask", token]));
  assert.equal(info.casks[0].installed, updatedVersion);

  console.log(
    "Local Homebrew update passed: real cask replacement, automatic relaunch, preserved profile and data path, and no misleading Git warning.",
  );
} finally {
  await relaunched?.close();

  if (relaunchedPid) {
    try {
      process.kill(relaunchedPid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }

  await app?.close().catch(() => app?.process().kill());
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
