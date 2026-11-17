import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { trustFixture } from "./helpers/trust.ts";
import { finishOnboarding } from "./helpers/onboarding.ts";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { expect, type ElectronApplication } from "playwright/test";

const root = await mkdtemp(join(tmpdir(), "eda-signing-keys-"));
const repository = join(root, "signed-repository");
const signingHome = join(root, "signer");
const verificationHome = join(root, "verifier");
for (const path of [repository, signingHome, verificationHome]) await mkdir(path, { mode: 0o700 });
const config = join(root, "gitconfig");
await writeFile(
  config,
  "[user]\nname = Signer\nemail = signer@example.test\n[commit]\ngpgsign = false\n",
);
const env = {
  ...fixtureEnvironment(root),
  HOME: root,
  USERPROFILE: root,
  GNUPGHOME: verificationHome,
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const gpg = (...args: string[]) =>
  execFileSync("gpg", ["--homedir", signingHome, "--batch", ...args], {
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], {
    env: { ...env, GNUPGHOME: signingHome, GIT_COMMITTER_EMAIL: `noreply@${"github.com"}` },
    encoding: "utf8",
    stdio: "pipe",
  });
let app: ElectronApplication | undefined;
try {
  gpg(
    "--pinentry-mode",
    "loopback",
    "--passphrase",
    "",
    "--quick-generate-key",
    `GitHub <noreply@${"github.com"}>`,
    "ed25519",
    "sign",
    "0",
  );
  const fingerprint = gpg("--with-colons", "--list-keys")
    .split("\n")
    .find((line) => line.startsWith("fpr:"))!
    .split(":")[9]!;
  const armor = gpg("--armor", "--export", fingerprint);
  git("init", "-b", "main");
  await writeFile(join(repository, "file.txt"), "signed content\n");
  git("add", ".");
  git(
    "-c",
    "gpg.format=openpgp",
    "-c",
    `user.signingkey=${fingerprint}`,
    "commit",
    "-S",
    "-m",
    "Signed fixture",
  );
  const oid = git("rev-parse", "HEAD").trim();
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });
  await app.evaluate(({ net }, armor) => {
    const original = net.fetch.bind(net);
    net.fetch = (input, init) =>
      String(input) === "https://github.com/web-flow.gpg"
        ? Promise.resolve(new Response(armor))
        : original(input, init);
  }, armor);
  await trustFixture(app, root);
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Work");
  await page.getByRole("textbox", { name: /^Git author name/ }).fill("Signer");
  await page.getByRole("textbox", { name: /^Git email/ }).fill("signer@example.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await finishOnboarding(page);
  await page.getByRole("button", { name: /Active profile: Work/ }).waitFor();
  const opened = await page.evaluate((path) => window.eda.repository.open(path), repository);
  assert.ok(opened.ok, JSON.stringify(opened));
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+p`);
  const picker = page.getByRole("dialog", { name: "Open a repository", exact: true });
  await picker.getByRole("button", { name: /^signed-repository / }).press("Enter");
  await picker.waitFor({ state: "hidden" });
  await page.locator('[data-tour="history-commit"]').filter({ hasText: "Signed fixture" }).click();
  await page.getByRole("button", { name: "Commit details", exact: true }).click();
  await page.getByText("GitHub web signing", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Review signer…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Signer trust", exact: true });
  await expect(dialog.getByText("Signed by GitHub", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("GitHub signed this commit. This does not verify the author’s identity."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Trust key", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "Signer email", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const result = await page.evaluate(
    async ({ id, oid }) => window.eda.repository.commitSignature(id, oid),
    { id: opened.value.id, oid },
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.validity, "valid");
  assert.equal(result.value.keySource, "https://github.com/web-flow.gpg");
  assert.equal(result.value.signerTrust, "unknown");
  assert.equal(result.value.trustScope, undefined);
  assert.equal(result.value.fingerprint, fingerprint);
  assert.equal(result.value.committerEmail, `noreply@${"github.com"}`);
  const untouched = execFileSync(
    "gpg",
    ["--homedir", verificationHome, "--batch", "--with-colons", "--list-keys"],
    { env, encoding: "utf8", stdio: "pipe" },
  );
  assert.ok(!untouched.includes(fingerprint), "Discovery must not import into the global keyring");
  console.log(
    "Automatic GitHub provenance, absence of personal trust controls, and keyring isolation passed.",
  );
} finally {
  await app?.close();
  try {
    execFileSync("gpgconf", ["--homedir", signingHome, "--kill", "gpg-agent"], { stdio: "ignore" });
  } catch {
    /* The fixture agent may have exited already. */
  }
  await rm(root, { recursive: true, force: true });
}
