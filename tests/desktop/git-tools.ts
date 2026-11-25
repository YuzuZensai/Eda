import { lfsLockServer } from "../helpers/lfs-lock-server.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, glob, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { prepareGit } from "../../scripts/prepare-git.ts";
import { expect } from "playwright/test";
import type { Locator, Page } from "playwright";
import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { chooseSelect } from "./select-control.ts";
import { finishOnboarding } from "./helpers/onboarding.ts";
import { trustFixture } from "./helpers/trust.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "eda-git-tools-")));
const repository = join(root, "git-tools-fixture");
const env = fixtureEnvironment(root);
const linked = join(root, "linked");
const child = join(root, "child");
const remote = join(root, "server.git");
const bundle = await prepareGit();
const lfs = await glob("**/git-lfs{,.exe}", { cwd: bundle }).next();
assert.ok(!lfs.done, "The bundled Git LFS executable is required by the fixture checkout hooks.");
const gitEnv = {
  ...env,
  PATH: [env["PATH"] ?? env["Path"], join(bundle, dirname(lfs.value))].join(delimiter),
};

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    env: gitEnv,
    encoding: "utf8",
    stdio: "pipe",
  }).trimEnd();
const git = (...args: string[]) => run(repository, ...args);
const button = (container: Page | Locator, name: string) =>
  container.getByRole("button", { name, exact: true });
const summary = (container: Locator, title: string) =>
  container.locator("summary").filter({ hasText: new RegExp("^" + title + "$") });
const app = await electron.launch({
  args: ["dist/main/index.js", "--user-data-dir=" + join(root, "data")],
  env,
});
const pickOpenFile = (filePath: string) =>
  app.evaluate(({ dialog }, path) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [path] };
    };
  }, filePath);
const pickSaveFile = (filePath: string) =>
  app.evaluate(({ dialog }, path) => {
    const original = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => {
      dialog.showSaveDialog = original;
      return { canceled: false, filePath: path };
    };
  }, filePath);
try {
  await writeFile(
    join(root, "gitconfig"),
    "[user]\nname = Fixture\nemail = fixture@example.test\n[init]\ndefaultBranch = main\n",
  );
  for (const path of [repository, child, remote]) await mkdir(path);
  run(remote, "init", "--bare");
  run(child, "init");
  await writeFile(join(child, "child.txt"), "child\n");
  run(child, "add", ".");
  run(child, "commit", "-m", "Child fixture");
  git("init");
  for (const path of ["included", "omitted"]) {
    await mkdir(join(repository, path));
    await writeFile(join(repository, path, "readme.txt"), path + "\n");
  }
  await writeFile(join(repository, "history.txt"), "original\n");
  git("add", ".");
  git("commit", "-m", "Tools fixture base");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(repository, "history.txt"), "latest\n");
  git("commit", "-am", "Update historical file");
  git("remote", "add", "origin", remote);
  git("push", "-u", "origin", "main");

  await trustFixture(app, root);
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(15000);
  await button(page, "Get started").click();
  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Work");
  await page.getByRole("textbox", { name: /^Git author name/ }).fill("Eda");
  await page.getByRole("textbox", { name: /^Git email/ }).fill("fixture@example.test");
  await button(page, "Continue").click();
  await finishOnboarding(page);
  const approveCheckout = async (path: string) => {
    const member = await page.evaluate((directory) => window.eda.repository.open(directory), path);
    assert.ok(member.ok, JSON.stringify(member));
    const trust = await page.evaluate(
      (id) => window.eda.repository.reviewTrust(id),
      member.value.id,
    );
    assert.ok(trust.ok, JSON.stringify(trust));
  };
  await approveCheckout(repository);
  await button(page, "Open git-tools-fixture").click();

  const overview = page.getByLabel("Repository overview", { exact: true });
  const tools = page.getByRole("dialog", { name: "Worktrees", exact: true });
  const openTools = () => button(overview, "Worktrees").click();
  await openTools();
  await summary(tools, "Create worktree").click();
  await tools.getByLabel("New worktree directory (absolute path)").fill(linked);
  await tools.getByLabel("Local branch", { exact: true }).fill("desktop-linked");
  await tools.getByLabel("Create a new branch", { exact: true }).check();
  await button(tools, "Create worktree").click();
  const entry = tools
    .getByRole("listitem")
    .filter({ has: tools.page().getByText(linked, { exact: true }) });
  await button(entry, "Lock").click();
  await expect.poll(() => git("worktree", "list", "--porcelain")).toContain("locked");
  await button(entry, "Unlock").click();
  await expect.poll(() => git("worktree", "list", "--porcelain")).not.toContain("locked");
  console.log("Created, locked and unlocked a linked checkout.");

  await summary(tools, "Sparse checkout").click();
  await tools.getByLabel("Directories to include (one per line)").fill("included");
  await button(tools, "Apply directory selection").click();
  await expect.poll(() => existsSync(join(repository, "omitted/readme.txt"))).toBe(false);
  await button(tools, "Reapply existing selection").click();
  await button(tools, "Disable sparse checkout").click();
  await expect.poll(() => existsSync(join(repository, "omitted/readme.txt"))).toBe(true);

  await summary(tools, "Gitflow").click();
  await button(tools, "Initialize Gitflow").click();
  await tools.getByLabel("Topic or version name").fill("desktop");
  await button(tools, "Start branch").click();
  await expect.poll(() => git("branch", "--show-current")).toBe("feature/desktop");
  await writeFile(join(repository, "feature.txt"), "feature\n");
  git("add", "feature.txt");
  git("commit", "-m", "Finish through the desktop");
  await summary(tools, "Review publishing branch").click();
  await button(tools, "Review publishing branch").click();
  await button(tools, "Publish branch").click();
  await expect
    .poll(() => run(remote, "branch", "--list", "feature/desktop"))
    .toContain("feature/desktop");
  await tools.getByLabel("Keep topic branch after merging").uncheck();
  await button(tools, "Preview finish").click();
  await expect(
    tools.getByText("Delete merged branch feature/desktop", { exact: true }),
  ).toBeVisible();
  await button(tools, "Finish reviewed merges").click();
  await expect.poll(() => git("branch", "--list", "feature/desktop")).toBe("");
  await expect(
    tools
      .getByRole("listitem")
      .filter({ hasText: "Main worktree" })
      .getByText("develop", { exact: true }),
  ).toBeVisible();
  assert.equal(git("show", "develop:feature.txt"), "feature");
  console.log("Changed sparse checkout and published and finished a Gitflow feature.");

  await summary(tools, "Git LFS").click();
  await button(tools, "Initialize Git LFS in this repository").click();
  await tools.getByLabel("Tracking pattern").fill("*.fixture");
  await button(tools, "Track pattern and stage .gitattributes").click();
  await expect.poll(() => git("diff", "--cached", "--", ".gitattributes")).toContain("filter=lfs");
  await button(tools, "Untrack pattern and stage .gitattributes").click();
  await expect
    .poll(() => git("diff", "--cached", "--", ".gitattributes"))
    .not.toContain("filter=lfs");
  await button(tools, "Preview local objects to prune").click();
  await expect(button(tools, "Confirm deletion of eligible local LFS objects")).toBeVisible();
  const locks = await lfsLockServer("history.txt");
  try {
    git("config", "--local", "lfs.url", locks.url);
    await tools.getByLabel("Repository-relative file to lock or unlock").fill("history.txt");
    await button(tools, "Lock file").click();
    await expect.poll(() => locks.isLocked()).toBe(true);
    await button(tools, "List remote locks").click();
    await expect(tools.locator("pre[role=status]")).toContainText("history.txt");
    await button(tools, "Unlock my file").click();
    await expect.poll(() => locks.isLocked()).toBe(false);
  } finally {
    git("config", "--local", "--unset", "lfs.url");
    await locks.close();
  }
  await summary(tools, "Submodules").click();
  await summary(tools, "Manage submodules").click();
  await tools.getByLabel("Submodule path in this repository").fill("dependency");
  await tools.getByLabel("Git repository URL or absolute local repository path").fill(child);
  await button(tools, "Add submodule and stage parent gitlink").click();
  await expect.poll(() => git("ls-files", "--stage", "dependency")).toContain("160000");
  await tools.getByLabel("Update initialized submodules on Eda branch checkout").click();
  await expect
    .poll(() => git("config", "--local", "--list"))
    .toContain("eda.updatesubmodules=true");
  git("commit", "-m", "Record parent gitlink");
  await approveCheckout(join(repository, "dependency"));
  await tools.getByLabel("Include nested submodules").check();
  for (const name of [
    "Initialize selected submodule",
    "Sync configured URL from .gitmodules",
    "Update selected submodule",
  ]) {
    await button(tools, name).click();
    await expect(button(tools, name)).toBeEnabled();
    await expect(
      tools.getByText(
        "Updated submodule configuration or checkout. Review the parent staging area.",
        { exact: true },
      ),
    ).toBeVisible();
  }
  await button(tools, "Remove selected submodule and stage parent changes").click();
  await tools.getByRole("button", { name: /^Confirm.*dependency/ }).click();
  await expect.poll(() => git("ls-files", "--stage", "dependency")).toBe("");
  await approveCheckout(linked);
  await button(entry, "Remove worktree and delete merged branch").click();
  const removal = page.getByRole("dialog", { name: "Confirm removal", exact: true });
  await expect(removal).toContainText("desktop-linked");
  await button(removal, "Remove worktree and delete merged branch").click();
  await expect(tools.getByText(/^Saved recovery reference refs\/eda\/recovery\//)).toBeVisible();
  await expect(removal).toBeHidden();
  assert.equal(existsSync(linked), false);
  assert.equal(git("branch", "--list", "desktop-linked"), "");
  assert.ok(
    git("for-each-ref", "--format=%(objectname)", "refs/eda/recovery").includes(
      git("rev-parse", "main"),
    ),
  );
  console.log("Staged LFS tracking changes and added a real submodule.");
  await page.keyboard.press("Escape");

  const drawer = page.getByRole("region", { name: "Workspace drawer" });
  const terminalTab = drawer.getByRole("tab", { name: "Embedded terminal" });
  const activityTab = drawer.getByRole("tab", { name: "Activity" });
  const terminal = drawer.getByRole("tabpanel", { name: "Embedded terminal" });
  const activity = drawer.getByRole("tabpanel", { name: "Activity" });
  const drawerToggle = button(drawer, "Workspace drawer");
  await expect(drawerToggle).toHaveAttribute("aria-expanded", "false");
  await terminalTab.click();
  await expect(drawerToggle).toHaveAttribute("aria-expanded", "true");
  await expect(terminalTab).toHaveAttribute("aria-selected", "true");
  await expect(activity).toBeHidden();
  const sessions = terminal.getByRole("tablist", { name: "Sessions" });
  const surface = terminal.getByRole("textbox", { name: "Shell input and output" });
  await expect(sessions.getByRole("tab")).toHaveCount(1);
  await expect(surface).toBeFocused();

  const terminalBackground = terminal.locator(".terminal-sessions");
  const sessionSidebar = terminal.getByRole("complementary");
  const transparent = "rgba(0, 0, 0, 0)";
  await expect(terminalBackground).not.toHaveCSS("background-color", transparent);
  await expect(sessionSidebar).not.toHaveCSS("background-color", transparent);
  const wallpaper = await readFile(new URL("../fixtures/backgrounds/sakura.jpg", import.meta.url));
  const backgroundSaved = await page.evaluate(
    (image) =>
      window.eda.settings.set(
        "background",
        { kind: "application" },
        { image, strength: 20, blur: 4 },
      ),
    `data:image/jpeg;base64,${wallpaper.toString("base64")}`,
  );
  assert.ok(backgroundSaved.ok, JSON.stringify(backgroundSaved));
  await expect(surface).toHaveCSS("background-color", transparent);
  await expect(terminalBackground).toHaveCSS("background-color", transparent);
  await expect(sessionSidebar).toHaveCSS("background-color", transparent);

  const backgroundReset = await page.evaluate(() =>
    window.eda.settings.reset("background", { kind: "application" }),
  );
  assert.ok(backgroundReset.ok, JSON.stringify(backgroundReset));
  await expect(terminalBackground).not.toHaveCSS("background-color", transparent);
  await expect(sessionSidebar).not.toHaveCSS("background-color", transparent);

  const proofCommand = "echo desktop-terminal > terminal-proof.txt";
  await page.keyboard.type(proofCommand);
  await page.keyboard.press("Enter");
  const proofPath = join(repository, "terminal-proof.txt");
  await expect
    .poll(async () => (existsSync(proofPath) ? (await readFile(proofPath, "utf8")).trim() : null))
    .toBe("desktop-terminal");
  const completion = terminal.getByRole("textbox", { name: "Git completion" });
  const search = terminal.getByRole("textbox", { name: "Find in scrollback" });
  await expect(completion).toBeHidden();
  await expect(search).toBeHidden();
  await button(terminal, "Git completion").click();
  await expect(completion).toBeFocused();
  await completion.fill("git sta");
  await button(terminal, "git status").click();
  await expect(completion).toBeHidden();
  await expect(surface).toBeFocused();
  await expect(surface).toContainText("git status");

  const statusFile = join(".git", "terminal-status.txt");
  await page.keyboard.type(` --porcelain=v1 --branch -- terminal-proof.txt > ${statusFile} 2>&1`);
  await page.keyboard.press("Enter");
  const statusPath = join(repository, statusFile);
  await expect
    .poll(
      async () =>
        existsSync(statusPath)
          ? (await readFile(statusPath, "utf8")).trimEnd().split(/\r?\n/)
          : null,
      { message: "The completed Git command should report the fixture status", timeout: 15_000 },
    )
    .toEqual(["## develop", "?? terminal-proof.txt"]);

  await page.keyboard.type(`${process.platform === "win32" ? "type" : "cat"} ${statusFile}`);
  await page.keyboard.press("Enter");
  await expect(surface).toContainText("## develop");
  await button(terminal, "Find in scrollback").click();
  await expect(search).toBeFocused();
  await search.fill("desktop-terminal");
  await expect(surface).toContainText(proofCommand);
  await search.press("Escape");
  await expect(search).toBeHidden();
  await expect(surface).toBeFocused();
  await button(page, "Settings").click();
  await button(
    page.getByRole("navigation", { name: "Settings sections" }),
    "Embedded terminal",
  ).click();
  await expect(terminalTab).toBeHidden();
  await expect(activityTab).toBeVisible();
  const terminalSettings = page.getByRole("region", { name: "Embedded terminal" });
  await terminalSettings.getByLabel("Font size").fill("15");
  await chooseSelect(terminalSettings.getByLabel("Cursor shape"), "bar");
  await button(terminalSettings, "Save").click();
  await expect(button(terminalSettings, "Save")).toBeEnabled();
  await button(page, "Back to workspace").click();
  await expect(surface).toHaveCSS("font-size", "15px");
  await button(terminal, "New shell").click();
  const selectedShell = sessions.getByRole("tab", { selected: true });
  await expect(selectedShell).toHaveText(/^2 · /);
  await expect(sessions).toHaveAttribute("aria-orientation", "vertical");
  const sessionBounds = await sessions.boundingBox();
  const shellBounds = await surface.boundingBox();
  assert.ok(sessionBounds && shellBounds && sessionBounds.x >= shellBounds.x + shellBounds.width);
  await selectedShell.press("ArrowUp");
  await expect(selectedShell).toHaveText(/^1 · /);
  await expect(selectedShell).toBeFocused();
  await selectedShell.press("ArrowDown");
  await expect(selectedShell).toHaveText(/^2 · /);
  await terminalTab.press("ArrowLeft");
  await expect(activityTab).toBeFocused();
  await expect(activityTab).toHaveAttribute("aria-selected", "true");
  await expect(activity).toBeVisible();
  await expect(terminal).toBeHidden();
  await activityTab.press("End");
  await expect(terminalTab).toBeFocused();
  await expect(selectedShell).toHaveText(/^2 · /);
  await drawerToggle.click();
  await expect(drawerToggle).toHaveAttribute("aria-expanded", "false");
  await expect(surface).toBeHidden();
  await drawerToggle.click();
  await expect(sessions.getByRole("tab")).toHaveCount(2);
  await expect(selectedShell).toHaveText(/^2 · /);
  await button(terminal, "Move shell earlier").click();
  await expect(selectedShell).toHaveText(/^1 · /);
  await drawerToggle.click();
  await button(page, "Open a repository").click();
  await button(page, "Local collections").click();
  const collections = page.getByRole("dialog", { name: "Local collections" });
  await button(collections, "New collection").click();
  await collections.getByLabel("Collection name").fill("Desktop checkouts");
  await collections.getByLabel("git-tools-fixture", { exact: true }).check();
  await button(collections, "Save collection").click();
  await button(collections, "Open tabs").click();
  await expect(
    collections.getByRole("listitem").filter({ hasText: "git-tools-fixture · Done" }),
  ).toBeVisible();
  const manifestPath = join(root, "collection.json");
  git("remote", "set-url", "origin", "https://example.test/fixture/repo.git");
  await pickSaveFile(manifestPath);
  await button(collections, "Export manifest").click();
  await expect.poll(() => existsSync(manifestPath)).toBe(true);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(manifest.members, [
    { name: "git-tools-fixture", remote: "https://example.test/fixture/repo.git" },
  ]);
  git("remote", "set-url", "origin", remote);
  await pickOpenFile(manifestPath);
  await button(collections, "Import manifest").click();
  await expect(collections.getByRole("combobox")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "git-tools-fixture", exact: true }).click();
  await terminalTab.click();
  await expect(sessions.getByRole("tab")).toHaveCount(2);
  await expect(selectedShell).toHaveText(/^1 · /);
  const keptShellId = await selectedShell.getAttribute("id");
  assert.ok(keptShellId);
  await button(sessions, "Close shell 2").click();
  await expect(sessions.getByRole("tab")).toHaveCount(1);
  await expect(selectedShell).toHaveAttribute("id", keptShellId);
  await button(sessions, "Close shell 1").click();
  await expect(surface).toHaveCount(0);
  await expect(button(terminal, "New shell")).toBeEnabled();
  await expect(
    terminal.getByText("Start a shell in this repository to run commands."),
  ).toBeVisible();
  await drawerToggle.click();
  await expect(terminal).toBeHidden();
  await terminalTab.click();
  await expect(sessions.getByRole("tab")).toHaveCount(1);
  await expect(surface).toBeFocused();
  await button(sessions, "Close shell 1").click();
  await expect(button(terminal, "New shell")).toBeEnabled();
  await drawerToggle.click();

  await button(page, "Working file").click();
  const file = page.getByRole("dialog", { name: "Working file", exact: true });
  await file.getByLabel("Path in the current worktree").fill("created-in-eda.txt");
  await button(file, "Create empty file").click();
  await expect.poll(() => existsSync(join(repository, "created-in-eda.txt"))).toBe(true);
  await button(file, "Move file to trash").click();
  await expect(button(file, "Confirm moving created-in-eda.txt to trash")).toBeVisible();
  assert.ok(existsSync(join(repository, "created-in-eda.txt")));
  await button(file, "Confirm moving created-in-eda.txt to trash").click();
  await expect.poll(() => existsSync(join(repository, "created-in-eda.txt"))).toBe(false);
  await button(file, "Close dialog").click();

  await page
    .getByTestId("commit-graph")
    .getByRole("button", { name: /Tools fixture base/ })
    .click();
  await page.getByTestId("commit-graph").press("Shift+F10");
  await page.getByRole("menuitem", { name: "Browse all files", exact: true }).click();
  const tree = page.getByRole("region", { name: "Commit snapshot", exact: true });
  await expect(tree.getByRole("checkbox")).toHaveCount(0);
  await button(tree, "Select files").click();
  await tree.getByRole("checkbox", { name: "Select history.txt for restore" }).check();
  await button(tree, "included").click();
  await tree.getByRole("checkbox", { name: "Select included/readme.txt for restore" }).check();
  await button(tree, "Restore 2 files…").click();
  const selectionReview = page.getByRole("dialog", { name: "Restore files from this commit" });
  await expect(selectionReview.getByText("included/readme.txt", { exact: true })).toBeVisible();
  await expect(selectionReview.getByText("history.txt", { exact: true })).toBeVisible();
  await button(selectionReview, "Cancel").click();
  await button(tree, "git-tools-fixture").click();
  await button(tree, "Cancel").click();
  await button(tree, "history.txt").click();
  await button(tree, "Restore files from this commit").click();
  const restore = page.getByRole("dialog", { name: "Restore files from this commit" });
  await chooseSelect(restore.getByRole("combobox"), "index");
  await button(restore, "Replace selected files in the chosen destination").click();
  await expect.poll(() => git("show", ":history.txt")).toBe(git("show", base + ":history.txt"));
  assert.equal((await readFile(join(repository, "history.txt"), "utf8")).trim(), "latest");
  await button(tree, "Back to history").click();
  git("add", "--all");
  git("commit", "-m", "Prepare mailbox workspace");
  const start = git("rev-parse", "HEAD");
  git("switch", "-c", "mailbox-source");
  await writeFile(join(repository, "mailbox.txt"), "mailbox content\n");
  git("add", "mailbox.txt");
  git("commit", "--author", "Mail Author <author@example.test>", "-m", "Mailbox desktop fixture");
  const tip = git("rev-parse", "HEAD");
  git("switch", "develop");
  await button(page, "Settings").click();
  await button(page.getByRole("navigation", { name: "Settings sections" }), "Git").click();
  const preview = page.getByLabel("Enable mailbox patch series (preview)");
  await preview.click();
  await expect(preview).toBeChecked();
  await button(page, "Back to workspace").click();
  const mailboxButton = button(page, "Mailbox patch series (preview)");
  await button(page, "Working tree").click();
  await mailboxButton.click();
  const mailbox = page.getByRole("dialog", { name: "Mailbox patch series (preview)" });
  const filePath = join(root, "series.mbox");
  await pickSaveFile(filePath);
  await mailbox.getByLabel("Last commit (full ID)").fill(tip);
  await mailbox.getByLabel("After commit (full ID, optional for a single commit)").fill(start);
  await button(mailbox, "Export commit series").click();
  await expect(mailbox).toContainText("Saved the mailbox.");
  assert.match(await readFile(filePath, "utf8"), /Mailbox desktop fixture/);
  await pickOpenFile(filePath);
  await button(mailbox, "Apply mailbox as commits").click();
  await expect
    .poll(() => git("log", "-1", "--format=%an|%ae|%s"))
    .toBe("Mail Author|author@example.test|Mailbox desktop fixture");
  await expect(mailbox).toContainText("Updated mailbox series.");
  await page.keyboard.press("Escape");

  const hook = join(repository, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 1\n");
  await chmod(hook, 0o755);
  await writeFile(join(repository, "hooks.txt"), "one-off hook bypass\n");
  await button(page, "Stage hooks.txt").click();
  await page
    .getByRole("textbox", { name: "Commit title", exact: true })
    .fill("One-off hook bypass");
  await page.getByText("Commit options", { exact: true }).click();
  await button(page, "Commit once without pre-commit and commit-msg hooks").click();
  await expect.poll(() => git("log", "-1", "--format=%s")).toBe("One-off hook bypass");

  run(remote, "config", "uploadpack.allowFilter", "true");
  await button(page, "Open a repository").click();
  await button(page, "Clone repository").click();
  const clone = page.getByRole("dialog", { name: "Clone repository", exact: true });
  await clone.getByLabel("Repository URL", { exact: true }).fill(remote);
  await clone.getByLabel("Clone parent folder").fill(root);
  await clone.getByLabel("Clone folder name").fill("partial-checkout");
  await summary(clone, "Sparse checkout").click();
  await clone.getByLabel("Start with a sparse checkout").check();
  await clone.getByLabel("Request a blobless clone").check();
  await clone.getByLabel("Directories to include (one per line)").fill("included");
  await button(clone, "Clone repository").click();
  await expect(clone).toBeHidden({ timeout: 30000 });
  const partial = join(root, "partial-checkout");
  assert.equal(run(partial, "config", "--get", "remote.origin.partialclonefilter"), "blob:none");
  assert.ok(existsSync(join(partial, "included", "readme.txt")));
  assert.equal(existsSync(join(partial, "omitted", "readme.txt")), false);
  console.log(
    "Exported and applied a mailbox with original authorship, committed with one-time hook bypass and cloned a sparse, blobless repository.",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Desktop Git tools passed, including PTY input, retained sessions, local collections, working-file creation and index-only historical restore.",
  );
} catch (failure) {
  console.error(
    await (
      await app.firstWindow()
    )
      .locator("body")
      .innerText({ timeout: 2000 })
      .catch(() => "Renderer unavailable"),
  );
  throw failure;
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
