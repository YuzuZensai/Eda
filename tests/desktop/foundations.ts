import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { trustFixture } from "./helpers/trust.ts";
import { finishOnboarding } from "./helpers/onboarding.ts";
import { chooseSelect } from "./select-control.ts";
import type { ProfileSession } from "../../src/shared/identity/profile-session.ts";
import assert from "node:assert/strict";
import { type ElectronApplication, type Page } from "playwright";
import { expect } from "playwright/test";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "eda-foundations-"));
const repository = join(root, "foundations");
const initial = join(root, "created");

await mkdir(repository);
await mkdir(initial);

const config = join(root, "gitconfig");

await writeFile(
  config,
  "[user]\nname = Eda\nemail = test@eda.invalid\n[commit]\ngpgsign = false\n",
);

const env = {
  ...fixtureEnvironment(root),
  HOME: root,
  USERPROFILE: root,
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  EDA_TEST_SENSITIVE: "must-not-inherit",
};

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], { env, encoding: "utf8", stdio: "pipe" });

git("init", "-b", "main");
await writeFile(join(repository, "file.txt"), "initial\n");
git("add", ".");
git("commit", "-m", "Initial");

const head = git("rev-parse", "HEAD").trim();

git("tag", "-a", "v1", "-m", "Release annotation");
git("branch", "feature/work");

let app: ElectronApplication | undefined;
const errors: string[] = [];
const modifier = process.platform === "darwin" ? "Meta" : "Control";

async function foundationWindow(running: ElectronApplication): Promise<Page> {
  await running.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  await trustFixture(running, root);
  const page = await running.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));

  return page;
}

async function savedSession(predicate: (session: ProfileSession) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const db = new DatabaseSync(join(root, "eda.db"), { readOnly: true });
    let session: ProfileSession | null;

    try {
      const row = db.prepare("SELECT value FROM profile_sessions LIMIT 1").get();
      session =
        row && typeof row["value"] === "string"
          ? (JSON.parse(row["value"]) as ProfileSession)
          : null;
    } finally {
      db.close();
    }

    if (session && predicate(session)) {
      assert.ok(session.selectedRepositoryId);
      return { ...session, selectedRepositoryId: session.selectedRepositoryId };
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("The expected repository view was not persisted.");
}

try {
  app = await electron.launch({
    args: ["dist/main/index.js", `--user-data-dir=${root}`, join(repository, "file.txt")],
    env,
  });

  const page = await foundationWindow(app);

  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Work");
  await page.getByRole("textbox", { name: /^Git author name/ }).fill("Eda");
  await page.getByRole("textbox", { name: /^Git email/ }).fill("work@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await finishOnboarding(page);
  await page.getByRole("button", { name: "Inspect branch feature/work", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Inspect tag v1", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Verify tag signature...", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Verify tag" })
    .getByText("Release annotation", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Columns...", exact: true }).click();

  const columns = page.getByRole("dialog", { name: "History columns" });

  await columns.getByRole("checkbox", { name: "author", exact: true }).uncheck();
  await columns.getByRole("button", { name: "Move sha column left" }).click();
  await columns.getByRole("slider", { name: "sha column width" }).focus();
  await page.keyboard.press("ArrowRight");
  await columns.getByRole("button", { name: "Done", exact: true }).click();
  await expect(columns).toHaveCount(0);

  const saved = await savedSession(
    (session) => session.views[session.selectedRepositoryId ?? ""]?.graphColumns?.[1]?.id === "sha",
  );
  const repositoryId = saved.selectedRepositoryId;
  const mergeToolScript = join(root, "merge-tool.cjs");

  await writeFile(
    mergeToolScript,
    "const fs = require('node:fs'); const [base,current,incoming,result] = process.argv.slice(2); fs.writeFileSync(result, fs.readFileSync(incoming));",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("navigation", { name: "Settings sections", exact: true });
  await settings.getByRole("button", { name: "Global settings: Application", exact: true }).click();
  await page
    .locator("#settings-application")
    .getByText("Advanced options", { exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Merge tool executable", exact: true })
    .fill(process.execPath);
  await page
    .getByRole("textbox", { name: "Merge tool arguments", exact: true })
    .fill([mergeToolScript, "{base}", "{current}", "{incoming}", "{result}"].join("\n"));
  await page.getByRole("button", { name: "Save merge tool", exact: true }).click();
  await page.getByText("Merge tool saved.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await expect(settings).toHaveCount(0);

  const savedColumns = saved.views[repositoryId]?.graphColumns;

  assert.ok(savedColumns?.[0] && savedColumns[1]);
  assert.equal(savedColumns[0].visible, false);
  assert.equal(savedColumns[1].id, "sha");

  const command = async (name: string) => {
    await page.keyboard.press(`${modifier}+Shift+p`);
    await page.getByRole("combobox", { name: "Search commands" }).fill(name);
    await page
      .getByRole("option")
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
    await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "hidden" });
  };

  await command("Use compact layout");
  await page.getByRole("button", { name: "Local branches: 2", exact: true }).waitFor();
  await command("Restore default layout");
  await page.getByRole("button", { name: "Inspect branch main", exact: true }).waitFor();
  await command("Graph visibility and pinning");

  const visibility = page.getByRole("dialog", { name: "Graph visibility" });

  await visibility
    .getByRole("checkbox", { name: "Solo refs/heads/feature/work", exact: true })
    .check();
  await visibility.getByRole("radio", { name: "Pin refs/heads/feature/work", exact: true }).check();
  await visibility.getByRole("button", { name: "Apply graph view", exact: true }).click();
  await page.getByRole("button", { name: "Filtered graph...", exact: true }).waitFor();

  const filtered = await savedSession(
    (session) => session.views[repositoryId]?.graphFilter?.pinnedOid === head,
  );
  const savedFilter = filtered.views[repositoryId]?.graphFilter;

  assert.ok(savedFilter);
  assert.deepEqual(savedFilter.refs, ["refs/heads/feature/work"]);
  assert.equal(savedFilter.pinnedOid, head);

  await command("Graph visibility and pinning");
  await visibility.getByRole("button", { name: "Show all", exact: true }).click();
  await visibility.getByRole("button", { name: "Apply graph view", exact: true }).click();
  await page
    .getByRole("button", { name: "Inspect branch feature/work", exact: true })
    .click({ button: "right" });

  await page.getByRole("menuitem", { name: "Rename branch...", exact: true }).click();
  const branch = page.getByRole("dialog", { name: "Rename branch", exact: true });

  await branch.getByRole("textbox", { name: "Rename branch to" }).fill("feature/renamed");
  await branch.getByRole("button", { name: "Rename branch", exact: true }).click();
  await page.getByRole("button", { name: "Inspect branch feature/renamed", exact: true }).waitFor();
  await branch.waitFor({ state: "hidden" });
  await command("Create branch at selection or HEAD");
  await page.getByRole("textbox", { name: "Branch name", exact: true }).fill("feature/new");
  await page.getByRole("textbox", { name: "Branch name", exact: true }).press("Enter");
  await page.getByRole("button", { name: /On branch feature\/new/ }).waitFor();
  assert.equal(git("branch", "--show-current").trim(), "feature/new");

  git("commit", "--allow-empty", "-m", "Unmerged fixture commit");
  await page.getByRole("button", { name: "Inspect branch main", exact: true }).dblclick();
  await page.getByRole("button", { name: /On branch main/ }).waitFor();
  assert.equal(git("branch", "--show-current").trim(), "main");
  await command("Create tag at selection or HEAD");
  await page.getByRole("textbox", { name: "Tag name", exact: true }).fill("release/new");
  await page
    .getByRole("textbox", { name: "Annotated tag message" })
    .fill("Created in desktop gate");
  await page.getByRole("textbox", { name: "Tag name", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Inspect tag release/new", exact: true }).waitFor();
  assert.equal(git("cat-file", "-t", "release/new").trim(), "tag");

  await page
    .getByRole("button", { name: "Inspect tag release/new", exact: true })
    .click({ button: "right" });

  await page.getByRole("menuitem", { name: "Verify tag signature...", exact: true }).click();
  const tag = page.getByRole("dialog", { name: "Verify tag" });

  await tag.getByText("Created in desktop gate", { exact: true }).waitFor();
  await tag.getByRole("button", { name: "Close", exact: true }).click();
  await tag.waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Inspect tag release/new", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Check out tag (detached HEAD)", exact: true }).click();
  await page.getByRole("menu", { name: "Tag actions", exact: true }).waitFor({ state: "hidden" });
  await page.getByText(/^Detached HEAD /).waitFor();
  assert.equal(git("branch", "--show-current").trim(), "");

  await page
    .getByRole("button", { name: "Inspect branch main", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Check out branch", exact: true }).click();
  await page
    .getByRole("menu", { name: "Branch actions", exact: true })
    .waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /On branch main/ }).waitFor();
  await command("Manage local references");

  const manage = page.getByRole("dialog", { name: "Manage local references" });

  await manage.getByRole("checkbox", { name: "feature/new", exact: true }).check();
  await manage.getByRole("checkbox", { name: "feature/renamed", exact: true }).check();
  await manage.getByRole("checkbox", { name: "release/new", exact: true }).check();
  await manage
    .getByRole("checkbox", { name: "Delete these local references", exact: true })
    .check();
  await manage.getByRole("button", { name: "Delete 3 selected references", exact: true }).click();
  await manage.getByText(/branch:feature\/new:.*not fully merged/).waitFor();
  await manage.getByText("branch:feature/renamed: Deleted locally", { exact: true }).waitFor();
  await manage.getByText("tag:release/new: Deleted locally", { exact: true }).waitFor();
  assert.equal(git("branch", "--list", "feature/*").trim(), "feature/new");

  await manage.getByRole("button", { name: "Close", exact: true }).click();
  await page.keyboard.press(`${modifier}+w`);
  await page.getByRole("button", { name: "Rename foundations", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Repository display name", exact: true })
    .fill("Favourite project");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await page.getByRole("button", { name: "Favourite Favourite project", exact: true }).click();
  await page.getByRole("button", { name: "Unfavourite Favourite project", exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "Filter repositories" }).fill("Favourite");
  await page.getByRole("button", { name: "Open Favourite project", exact: true }).waitFor();
  await writeFile(join(repository, "package.json"), JSON.stringify({ main: "editor-fixture.cjs" }));
  await writeFile(
    join(repository, "editor-fixture.cjs"),
    `require('node:fs').writeFileSync('editor-result.json', JSON.stringify({ path: process.argv[1], leaked: !!process.env["EDA_TEST_SENSITIVE"] }));`,
  );
  assert.equal(
    (
      await page.evaluate(
        (path) => window.eda.settings.set("editorExecutable", { kind: "application" }, path),
        process.execPath,
      )
    ).ok,
    true,
  );

  await page.getByRole("button", { name: "Open Favourite project in editor", exact: true }).click();

  let editor: { path: string; leaked: boolean } | undefined;

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      editor = JSON.parse(await readFile(join(repository, "editor-result.json"), "utf8"));
      break;
    } catch {
      await page.waitForTimeout(50);
    }
  }

  assert.ok(editor, "The external editor must report its repository path");
  assert.equal(await realpath(editor.path), await realpath(repository));
  assert.equal(editor.leaked, false);

  await page.getByRole("button", { name: "Create repository", exact: true }).click();

  const create = page.getByRole("dialog", { name: "Create a repository" });

  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, initial);
  await create.getByRole("button", { name: "Browse...", exact: true }).click();
  await create.getByRole("textbox", { name: "Initial branch", exact: true }).fill("trunk");
  await chooseSelect(create.getByRole("combobox", { name: "Ignore template" }), "node");
  await chooseSelect(create.getByRole("combobox", { name: "License file" }), "MIT");
  await create.getByRole("button", { name: "Create repository", exact: true }).click();
  await page.getByRole("button", { name: /On branch trunk/ }).waitFor();
  assert.match(await readFile(join(initial, ".gitignore"), "utf8"), /node_modules/);
  assert.match(await readFile(join(initial, "LICENSE"), "utf8"), /MIT License/);
  assert.match(await readFile(join(initial, "README.md"), "utf8"), /created/);

  const link = `eda://open?path=${encodeURIComponent(repository)}&commit=${head}`;

  await app.evaluate(
    ({ app }, { link, cwd }) => app.emit("second-instance", {}, ["electron", "main.js", link], cwd),
    { link, cwd: root },
  );
  await page
    .getByRole("region", { name: "Commit file changes", exact: true })
    .getByTitle(head, { exact: true })
    .waitFor();
  assert.equal(git("rev-parse", "HEAD").trim(), head);

  const cdp = await page.context().newCDPSession(page);
  const drag = { items: [], files: [join(initial, "README.md")], dragOperationsMask: 1 };

  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x: 400, y: 150, data: drag });
  await cdp.send("Input.dispatchDragEvent", { type: "drop", x: 400, y: 150, data: drag });
  await page.getByRole("button", { name: /On branch trunk/ }).waitFor();
  await cdp.detach();
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: resolve("screenshots/foundations.png") });
  git("add", "--all");
  git("commit", "-m", "Preserve editor fixture files");
  git("checkout", "-b", "workflow-topic");
  await writeFile(join(repository, "file.txt"), "topic conflict\n");
  git("add", "file.txt");
  git("commit", "-m", "topic conflict");
  git("checkout", "main");
  await writeFile(join(repository, "file.txt"), "main conflict\n");
  git("add", "file.txt");
  git("commit", "-m", "main conflict");
  await app.evaluate(
    ({ app }, { link, cwd }) => app.emit("second-instance", {}, ["electron", "main.js", link], cwd),
    { link: `eda://open?path=${encodeURIComponent(repository)}`, cwd: root },
  );
  await page
    .getByRole("button", { name: "Inspect branch workflow-topic", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menu", { name: "Branch actions" })
    .getByRole("menuitem", { name: "Merge into current branch...", exact: true })
    .click();

  const mergeReview = page.getByRole("dialog", { name: "Merge into current branch", exact: true });

  await mergeReview
    .getByText("Git predicts conflicts. You can start the merge and resolve them in Eda.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await mergeReview.getByLabel("Merge prediction").getByRole("listitem").innerText(),
    "file.txt",
  );
  assert.equal(git("ls-files", "--unmerged"), "");
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "main conflict\n");

  await mergeReview.getByRole("button", { name: "Start merge", exact: true }).click();
  await mergeReview.waitFor({ state: "hidden" });
  await page.getByText("merge in progress", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Resolve 1 conflicts", exact: true }).click();

  const conflict = page.getByRole("dialog", { name: "Resolve conflicts", exact: true });
  const conflictIndex = git("ls-files", "--stage");
  const conflictWorking = await readFile(join(repository, "file.txt"), "utf8");

  await conflict.getByRole("button", { name: "Open external merge tool...", exact: true }).click();
  await conflict.getByRole("status").filter({ hasText: "External tool finished" }).waitFor();
  assert.equal(git("ls-files", "--stage"), conflictIndex);
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), conflictWorking);
  assert.equal(
    await conflict.getByRole("textbox", { name: "Resolved output" }).inputValue(),
    "topic conflict\n",
  );

  await conflict.getByRole("button", { name: "Save output", exact: true }).click();
  await conflict.getByRole("status").filter({ hasText: "Saved file.txt" }).waitFor();
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "topic conflict\n");
  assert.notEqual(git("ls-files", "--unmerged"), "");

  await conflict.getByRole("button", { name: "Save and mark resolved", exact: true }).click();
  await conflict.getByRole("status").filter({ hasText: "Resolved file.txt" }).waitFor();
  assert.equal(git("show", ":file.txt"), "topic conflict\n");

  await conflict.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Refresh repository", exact: true }).click();
  await page.getByText("merge in progress", { exact: true }).waitFor();
  await app.close();
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });

  const restored = await foundationWindow(app);

  await restored.getByText("merge in progress", { exact: true }).waitFor();
  assert.equal(git("ls-files", "--unmerged"), "");

  const mergeParents = [git("rev-parse", "HEAD").trim(), git("rev-parse", "MERGE_HEAD").trim()];

  await restored.getByRole("button", { name: "Continue merge", exact: true }).click();

  const completion = restored.getByRole("dialog", { name: "Complete merge", exact: true });

  await completion
    .getByRole("textbox", { name: "Merge message", exact: true })
    .fill("Merge resolved in Eda");
  await completion.getByRole("button", { name: "Complete merge", exact: true }).click();
  await completion.waitFor({ state: "hidden" });
  await restored.getByText("merge in progress", { exact: true }).waitFor({ state: "hidden" });
  assert.deepEqual(
    git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").slice(1),
    mergeParents,
  );
  assert.equal(git("show", "HEAD:file.txt"), "topic conflict\n");
  assert.equal(git("status", "--porcelain"), "");

  git("checkout", "-b", "abort-topic");
  await writeFile(join(repository, "file.txt"), "abort incoming\n");
  git("add", "file.txt");
  git("commit", "-m", "abort incoming");
  git("checkout", "main");
  await writeFile(join(repository, "file.txt"), "abort current\n");
  git("add", "file.txt");
  git("commit", "-m", "abort current");

  const beforeAbort = git("rev-parse", "HEAD").trim();

  assert.throws(() => git("merge", "abort-topic", "--no-edit"));

  await writeFile(join(repository, "file.txt"), "keep this resolution\n");
  await app.close();
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });

  const abortPage = await foundationWindow(app);

  await abortPage.getByRole("button", { name: "Abort merge...", exact: true }).click();

  const abortDialog = abortPage.getByRole("dialog", { name: "Abort merge", exact: true });

  await abortDialog
    .getByRole("checkbox", { name: "Abort this merge and preserve recovery copies" })
    .check();
  await abortDialog.getByRole("button", { name: "Abort merge", exact: true }).click();
  await abortDialog.waitFor({ state: "hidden" });
  await abortPage.getByText("merge in progress", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(git("rev-parse", "HEAD").trim(), beforeAbort);
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "abort current\n");

  await abortPage.keyboard.press(`${modifier}+Shift+p`);
  await abortPage.getByRole("combobox", { name: "Search commands" }).fill("Recover local files");
  await abortPage.keyboard.press("Enter");

  const recovery = abortPage.getByRole("dialog", { name: "Recover local files" });

  await recovery
    .getByRole("button", { name: "Save index stage 2 copy of file.txt...", exact: true })
    .waitFor();
  await recovery.getByRole("button", { name: "Restore 1 files", exact: true }).click();
  await recovery.waitFor({ state: "hidden" });
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "keep this resolution\n");
  assert.equal(git("show", ":file.txt"), "abort current\n");

  git("add", "file.txt");
  git("commit", "-m", "Recovered abort fixture");

  const squashParent = git("rev-parse", "HEAD").trim();

  await abortPage
    .getByRole("button", { name: "Inspect branch abort-topic", exact: true })
    .click({ button: "right" });
  await abortPage
    .getByRole("menu", { name: "Branch actions" })
    .getByRole("menuitem", { name: "Merge into current branch...", exact: true })
    .click();

  const squashReview = abortPage.getByRole("dialog", {
    name: "Merge into current branch",
    exact: true,
  });

  await chooseSelect(squashReview.getByRole("combobox", { name: "Merge policy" }), "squash");
  await squashReview.getByRole("button", { name: "Start merge", exact: true }).click();
  await squashReview.waitFor({ state: "hidden" });
  await abortPage.getByText("squash in progress", { exact: true }).waitFor();
  assert.throws(() => git("rev-parse", "--verify", "MERGE_HEAD"));

  await abortPage.getByRole("button", { name: "Resolve 1 conflicts", exact: true }).click();

  const squashConflict = abortPage.getByRole("dialog", { name: "Resolve conflicts", exact: true });

  await squashConflict.getByRole("button", { name: "Use squashed source", exact: true }).click();
  await squashConflict.getByRole("button", { name: "Save and mark resolved", exact: true }).click();
  await squashConflict.getByRole("status").filter({ hasText: "Resolved file.txt" }).waitFor();
  await squashConflict.getByRole("button", { name: "Close", exact: true }).click();
  await app.close();
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });

  const squashPage = await foundationWindow(app);

  await squashPage.getByText("squash in progress", { exact: true }).waitFor();
  await squashPage.getByRole("button", { name: "Continue merge", exact: true }).click();

  const squashCompletion = squashPage.getByRole("dialog", { name: "Complete merge", exact: true });

  await squashCompletion.getByText(/Squash commit parent:/).waitFor();
  await squashCompletion
    .getByRole("textbox", { name: "Merge message" })
    .fill("Squash completed in Eda");
  await squashCompletion.getByRole("button", { name: "Complete merge", exact: true }).click();
  await squashCompletion.waitFor({ state: "hidden" });
  await squashPage.getByText("squash in progress", { exact: true }).waitFor({ state: "hidden" });
  assert.deepEqual(git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").slice(1), [
    squashParent,
  ]);
  assert.equal(git("status", "--porcelain"), "");

  await writeFile(join(repository, "file.txt"), "desktop_staged_stash\n");
  git("add", "file.txt");
  await writeFile(join(repository, "file.txt"), "desktop_working_stash\n");
  await writeFile(join(repository, "stash-untracked.txt"), "desktop_untracked_stash\n");
  await writeFile(join(repository, "scope-unrelated.txt"), "keep unrelated staged work\n");
  git("add", "scope-unrelated.txt");
  await squashPage.keyboard.press(`${modifier}+Shift+p`);
  await squashPage.getByRole("combobox", { name: "Search commands" }).fill("Manage stashes");
  await squashPage.keyboard.press("Enter");

  const stashes = squashPage.getByRole("dialog", { name: "Stashes", exact: true });

  await stashes.getByRole("textbox", { name: "Stash name" }).fill("Desktop unfinished work");
  await chooseSelect(stashes.getByRole("combobox", { name: "Stash contents" }), "untracked");
  await chooseSelect(stashes.getByRole("combobox", { name: "Stash scope" }), "selected");
  await stashes.getByRole("checkbox", { name: "Stash file.txt", exact: true }).check();
  await stashes.getByRole("checkbox", { name: "Stash stash-untracked.txt", exact: true }).check();
  await stashes.getByRole("button", { name: "Create stash", exact: true }).click();
  await chooseSelect(stashes.getByRole("combobox", { name: "Saved stash" }), "stash@{0}");
  await stashes.getByText("desktop_working_stash", { exact: true }).waitFor();
  await chooseSelect(stashes.getByRole("combobox", { name: "Stash diff" }), "staged");
  await stashes.getByText("desktop_staged_stash", { exact: true }).waitFor();

  const beforeFileRestore = git("show", ":file.txt");

  await chooseSelect(stashes.getByRole("combobox", { name: "Stash file to restore" }), "file.txt");
  await stashes.getByRole("button", { name: "Restore file...", exact: true }).click();

  const fileRestore = squashPage.getByRole("dialog", { name: "Restore stash file", exact: true });

  await fileRestore.getByRole("button", { name: "Restore working file", exact: true }).click();
  await fileRestore.waitFor({ state: "hidden" });
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "desktop_staged_stash\n");
  assert.equal(git("show", ":file.txt"), beforeFileRestore);

  await stashes.getByRole("button", { name: "Close", exact: true }).click();
  await squashPage.keyboard.press(`${modifier}+Shift+p`);
  await squashPage.getByRole("combobox", { name: "Search commands" }).fill("Recover local files");
  await squashPage.keyboard.press("Enter");

  const fileRecovery = squashPage.getByRole("dialog", { name: "Recover local files" });
  const restoredFileRecord = fileRecovery
    .locator("div")
    .filter({ has: squashPage.getByText(/Stash file restore/) })
    .filter({ has: squashPage.getByRole("button", { name: "Restore 1 files", exact: true }) })
    .last();

  await restoredFileRecord.getByRole("button", { name: "Restore 1 files", exact: true }).click();
  await fileRecovery.waitFor({ state: "hidden" });
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), beforeFileRestore);
  assert.equal(git("show", ":file.txt"), beforeFileRestore);

  await squashPage.keyboard.press(`${modifier}+Shift+p`);
  await squashPage.getByRole("combobox", { name: "Search commands" }).fill("Manage stashes");
  await squashPage.getByRole("option", { name: "Manage stashes Repository", exact: true }).click();
  await chooseSelect(stashes.getByRole("combobox", { name: "Saved stash" }), "stash@{0}");
  await chooseSelect(stashes.getByRole("combobox", { name: "Stash diff" }), "untracked");
  await stashes.getByText("desktop_untracked_stash", { exact: true }).waitFor();
  assert.equal(git("show", ":scope-unrelated.txt"), "keep unrelated staged work\n");
  assert.equal(git("diff", "--name-only", "stash@{0}^1", "stash@{0}"), "file.txt\n");

  git("commit", "-m", "Retain unrelated staged work");
  assert.equal(git("status", "--porcelain"), "");
  assert.match(git("stash", "list"), /Desktop unfinished work/);

  git("checkout", "-b", "stash-destination");
  await writeFile(join(repository, "file.txt"), "desktop_stash_destination\n");
  git("add", "file.txt");
  git("commit", "-m", "Stash destination change");

  const stashHead = git("rev-parse", "HEAD");

  await stashes.getByRole("button", { name: "Pop stash", exact: true }).click();
  await stashes.getByRole("status").filter({ hasText: "Application needs attention" }).waitFor();
  assert.match(git("stash", "list"), /Desktop unfinished work/);

  await stashes.getByRole("button", { name: "Close", exact: true }).click();
  await app.close();
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });

  const stashPage = await foundationWindow(app);

  await stashPage.getByText("stash in progress", { exact: true }).waitFor();
  await stashPage.getByRole("button", { name: "Resolve 1 conflicts", exact: true }).click();

  const stashConflict = stashPage.getByRole("dialog", { name: "Resolve conflicts", exact: true });

  await stashConflict.getByRole("button", { name: "Use stashed changes", exact: true }).click();
  await stashConflict.getByRole("button", { name: "Save and mark resolved", exact: true }).click();
  await stashConflict.getByRole("status").filter({ hasText: "Resolved file.txt" }).waitFor();
  await stashConflict.getByRole("button", { name: "Close", exact: true }).click();
  await stashPage.getByRole("button", { name: "Finish stash application", exact: true }).click();
  await stashPage.getByText("stash in progress", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(git("rev-parse", "HEAD"), stashHead);
  assert.equal(git("show", ":file.txt"), "desktop_working_stash\n");
  assert.equal(
    await readFile(join(repository, "stash-untracked.txt"), "utf8"),
    "desktop_untracked_stash\n",
  );

  await stashPage.keyboard.press(`${modifier}+Shift+p`);
  await stashPage.getByRole("combobox", { name: "Search commands" }).fill("Manage stashes");
  await stashPage.keyboard.press("Enter");

  const retainedStashes = stashPage.getByRole("dialog", { name: "Stashes", exact: true });

  await chooseSelect(retainedStashes.getByRole("combobox", { name: "Saved stash" }), "stash@{0}");
  await retainedStashes
    .getByRole("checkbox", { name: "Remove this stash from Git’s stash list" })
    .check();
  await retainedStashes.getByRole("button", { name: "Drop selected stash", exact: true }).click();
  await retainedStashes
    .getByRole("button", { name: "Drop selected stash", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(git("stash", "list"), "");
  assert.equal(git("show", ":file.txt"), "desktop_working_stash\n");

  await retainedStashes.getByRole("button", { name: "Close", exact: true }).click();
  git("add", "--all");
  git("commit", "-m", "Preserve resolved stash");
  git("checkout", "-b", "rebase-base");
  await writeFile(join(repository, "file.txt"), "desktop_rebase_base\n");
  git("add", "file.txt");
  git("commit", "-m", "Rebase base");

  const rebaseBase = git("rev-parse", "HEAD").trim();

  git("checkout", "stash-destination");
  await writeFile(join(repository, "file.txt"), "desktop_rebase_topic\n");
  git("add", "file.txt");
  git("commit", "-m", "Rebase topic");

  const rebaseTopic = git("rev-parse", "HEAD").trim();

  git("update-ref", "refs/remotes/origin/published-topic", rebaseTopic);

  const planIds = [];

  for (const name of ["a", "b", "c"]) {
    await writeFile(join(repository, `plan-${name}.txt`), `${name}\n`);
    git("add", `plan-${name}.txt`);
    git("commit", "-m", `Plan ${name}`);
    planIds.push(git("rev-parse", "HEAD").trim().slice(0, 8));
  }

  await writeFile(join(repository, "plan-fix.txt"), "fixed\n");
  git("add", "plan-fix.txt");
  git("commit", "-m", "fixup! Plan b");

  const fixupId = git("rev-parse", "HEAD").trim().slice(0, 8);

  await writeFile(join(repository, "plan-edit.txt"), "before edit\n");
  git("add", "plan-edit.txt");
  git("commit", "-m", "Plan edit");

  const editId = git("rev-parse", "HEAD").trim().slice(0, 8);

  const refreshBeforeRebase = stashPage.getByRole("button", {
    name: "Refresh repository",
    exact: true,
  });

  await refreshBeforeRebase.click();
  await expect(refreshBeforeRebase).toBeEnabled();
  await expect(
    stashPage.getByRole("button", { name: "Inspect branch stash-destination", exact: true }),
  ).toHaveAttribute("title", `stash-destination\nCurrent branch, Inspect ${editId}`);

  await stashPage
    .getByRole("button", { name: "Inspect branch rebase-base", exact: true })
    .click({ button: "right" });
  await stashPage
    .getByRole("menu", { name: "Branch actions" })
    .getByRole("menuitem", { name: "Rebase current branch onto this...", exact: true })
    .click();

  const rebaseReview = stashPage.getByRole("dialog", {
    name: "Rebase current branch",
    exact: true,
  });

  await rebaseReview.getByRole("note").filter({ hasText: "includes 1 commits" }).waitFor();
  await rebaseReview.getByRole("checkbox", { name: "Edit commit order and messages" }).check();
  await rebaseReview.getByRole("button", { name: "Reset and autosquash", exact: true }).click();
  assert.equal(
    await rebaseReview.getByRole("combobox", { name: `Action for ${fixupId}` }).innerText(),
    "Fixup",
  );

  await chooseSelect(rebaseReview.getByRole("combobox", { name: `Action for ${editId}` }), "edit");
  await chooseSelect(
    rebaseReview.getByRole("combobox", { name: `Action for ${rebaseTopic.slice(0, 8)}` }),
    "reword",
  );
  await rebaseReview
    .getByRole("textbox", { name: `Message for ${rebaseTopic.slice(0, 8)}` })
    .fill("Reviewed topic after restart");
  await rebaseReview.getByRole("button", { name: `Move ${planIds[1]} up`, exact: true }).click();
  await chooseSelect(
    rebaseReview.getByRole("combobox", { name: `Action for ${planIds[0]}` }),
    "squash",
  );
  await rebaseReview
    .getByRole("textbox", { name: `Message for ${planIds[0]}` })
    .fill("Combined plan b and a");
  await chooseSelect(
    rebaseReview.getByRole("combobox", { name: `Action for ${planIds[2]}` }),
    "drop",
  );
  await rebaseReview.getByRole("checkbox", { name: "I reviewed this rebase action" }).check();
  await rebaseReview.getByRole("button", { name: "Rebase current branch", exact: true }).click();
  await rebaseReview.waitFor({ state: "hidden" });
  await stashPage.getByText(/rebase in progress/).waitFor();
  await app.close();
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });

  let rebasePage = await foundationWindow(app);

  await rebasePage.getByText(/rebase in progress/).waitFor();
  await rebasePage.getByRole("button", { name: "Resolve 1 conflicts", exact: true }).click();

  const rebaseConflict = rebasePage.getByRole("dialog", { name: "Resolve conflicts", exact: true });

  await rebaseConflict.getByText(/ours does not mean your original branch/).waitFor();
  await rebaseConflict.getByRole("button", { name: "Use replayed commit", exact: true }).click();
  await rebaseConflict.getByRole("button", { name: "Save and mark resolved", exact: true }).click();
  await rebaseConflict.getByRole("status").filter({ hasText: "Resolved file.txt" }).waitFor();
  await rebaseConflict.getByRole("button", { name: "Close", exact: true }).click();
  await rebasePage.getByRole("button", { name: "Continue rebase...", exact: true }).click();

  const rebaseContinue = rebasePage.getByRole("dialog", { name: "Continue rebase", exact: true });

  await rebaseContinue.getByRole("checkbox", { name: "I reviewed this rebase action" }).check();
  await rebaseContinue.getByRole("button", { name: "Continue rebase", exact: true }).click();
  await rebaseContinue.waitFor({ state: "hidden" });
  await rebasePage.getByRole("button", { name: "Amend paused commit...", exact: true }).waitFor();
  await app.close();
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });
  rebasePage = await foundationWindow(app);
  await rebasePage.getByRole("button", { name: "Amend paused commit...", exact: true }).waitFor();
  await writeFile(join(repository, "plan-edit.txt"), "after edit\n");
  git("add", "plan-edit.txt");
  await rebasePage.getByRole("button", { name: "Refresh repository", exact: true }).click();
  await rebasePage.getByRole("button", { name: "Amend paused commit...", exact: true }).click();

  const amendReview = rebasePage.getByRole("dialog", { name: "Amend paused commit", exact: true });

  await amendReview
    .getByRole("textbox", { name: "Paused commit message" })
    .fill("Reviewed edit after restart");
  await amendReview.getByRole("checkbox", { name: "I reviewed this rebase action" }).check();
  await amendReview.getByRole("button", { name: "Amend paused commit", exact: true }).click();
  await amendReview.waitFor({ state: "hidden" });
  assert.equal(git("show", "HEAD:plan-edit.txt"), "after edit\n");

  await rebasePage.getByRole("button", { name: "Continue rebase...", exact: true }).click();

  const finishEdit = rebasePage.getByRole("dialog", { name: "Continue rebase", exact: true });

  await finishEdit.getByRole("checkbox", { name: "I reviewed this rebase action" }).check();
  await finishEdit.getByRole("button", { name: "Continue rebase", exact: true }).click();
  await finishEdit.getByRole("status").filter({ hasText: "Rebase completed" }).waitFor();
  assert.match(await finishEdit.getByRole("status").innerText(), /force-with-lease/);
  assert.equal(git("rev-parse", "refs/remotes/origin/published-topic").trim(), rebaseTopic);

  await finishEdit.getByRole("button", { name: "Close", exact: true }).click();
  await finishEdit.waitFor({ state: "hidden" });
  await rebasePage.getByText(/rebase in progress/).waitFor({ state: "hidden" });
  assert.equal(git("rev-parse", "HEAD~3").trim(), rebaseBase);
  assert.equal(git("show", "-s", "--format=%s", "HEAD~2").trim(), "Reviewed topic after restart");
  assert.equal(git("show", "-s", "--format=%s", "HEAD^").trim(), "Combined plan b and a");
  assert.equal(git("show", "-s", "--format=%s", "HEAD").trim(), "Reviewed edit after restart");
  assert.equal(await readFile(join(repository, "plan-fix.txt"), "utf8"), "fixed\n");
  assert.equal(await readFile(join(repository, "plan-a.txt"), "utf8"), "a\n");
  assert.equal(await readFile(join(repository, "plan-b.txt"), "utf8"), "b\n");
  assert.equal(git("ls-files", "--", "plan-c.txt"), "");
  assert.equal(git("symbolic-ref", "--short", "HEAD").trim(), "stash-destination");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "desktop_rebase_topic\n");

  const stashBranchBase = git("rev-parse", "HEAD").trim();

  await writeFile(join(repository, "file.txt"), "branch_staged_version\n");
  git("add", "file.txt");
  await writeFile(join(repository, "file.txt"), "branch_working_version\n");
  await rebasePage.keyboard.press(`${modifier}+Shift+p`);
  await rebasePage.getByRole("combobox", { name: "Search commands" }).fill("Manage stashes");
  await rebasePage.getByRole("option", { name: "Manage stashes Repository", exact: true }).click();

  const branchStashes = rebasePage.getByRole("dialog", { name: "Stashes", exact: true });

  await branchStashes.getByRole("textbox", { name: "Stash name" }).fill("Branch recovery");
  await branchStashes.getByRole("button", { name: "Create stash", exact: true }).click();
  await chooseSelect(branchStashes.getByRole("combobox", { name: "Saved stash" }), "stash@{0}");
  await branchStashes.getByText("branch_working_version", { exact: true }).waitFor();
  await writeFile(join(repository, "file.txt"), "original_branch_advanced\n");
  git("add", "file.txt");
  git("commit", "-m", "Advance original branch");
  await branchStashes.getByRole("button", { name: "Create branch...", exact: true }).click();

  const stashBranchDialog = rebasePage.getByRole("dialog", {
    name: "Create branch from stash",
    exact: true,
  });

  await stashBranchDialog
    .getByRole("textbox", { name: "Stash branch name" })
    .fill("stash-recovered");
  await stashBranchDialog.getByRole("button", { name: "Review branch", exact: true }).click();
  await stashBranchDialog.getByRole("button", { name: "Create and restore", exact: true }).click();
  await stashBranchDialog.waitFor({ state: "hidden" });
  await branchStashes
    .getByRole("status")
    .filter({ hasText: "Created stash-recovered and restored" })
    .waitFor();
  assert.equal(git("branch", "--show-current").trim(), "stash-recovered");
  assert.equal(git("rev-parse", "HEAD").trim(), stashBranchBase);
  assert.equal(git("show", ":file.txt"), "branch_staged_version\n");
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "branch_working_version\n");
  assert.match(git("stash", "list"), /Branch recovery/);

  const stashStructure = git("show", "-s", "--format=%T %P", "stash@{0}");

  await branchStashes.getByRole("button", { name: "Rename...", exact: true }).click();

  const renameStash = rebasePage.getByRole("dialog", { name: "Rename stash", exact: true });

  await renameStash.getByRole("textbox", { name: "New stash description" }).fill("Recovered work");
  await renameStash.getByRole("button", { name: "Rename stash", exact: true }).click();
  await renameStash.waitFor({ state: "hidden" });
  await branchStashes.getByRole("status").filter({ hasText: "Renamed stash and moved" }).waitFor();
  assert.equal(git("stash", "list", "--format=%gs"), "Recovered work\n");
  assert.equal(git("show", "-s", "--format=%T %P", "stash@{0}"), stashStructure);
  assert.equal(git("show", ":file.txt"), "branch_staged_version\n");
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "branch_working_version\n");

  await branchStashes.getByRole("button", { name: "Close", exact: true }).click();
  await rebasePage.getByTestId("commit-graph").press("Home");
  await rebasePage.getByRole("button", { name: /^stash@\{0\}: Recovered work\./ }).waitFor();
  await rebasePage.keyboard.press(`${modifier}+Shift+p`);
  await rebasePage
    .getByRole("combobox", { name: "Search commands" })
    .fill("Graph visibility and pinning");
  await rebasePage.getByRole("option", { name: /Graph visibility and pinning/ }).click();

  const stashVisibility = rebasePage.getByRole("dialog", { name: "Graph visibility" });

  await stashVisibility.getByRole("checkbox", { name: "Show stashes", exact: true }).uncheck();
  await stashVisibility.getByRole("button", { name: "Apply graph view", exact: true }).click();
  await rebasePage
    .getByRole("button", { name: /^stash@\{0\}: Recovered work\./ })
    .waitFor({ state: "hidden" });
  await savedSession((session) =>
    Object.values(session.views).some((view) => view.graphFilter?.showStashes === false),
  );
  await app.close();
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });

  const stashGraphPage = await foundationWindow(app);

  await stashGraphPage.getByRole("button", { name: /On branch stash-recovered/ }).waitFor();
  assert.equal(
    await stashGraphPage.getByRole("button", { name: /^stash@\{0\}: Recovered work\./ }).count(),
    0,
  );

  await stashGraphPage.keyboard.press(`${modifier}+Shift+p`);
  await stashGraphPage
    .getByRole("combobox", { name: "Search commands" })
    .fill("Graph visibility and pinning");
  await stashGraphPage.getByRole("option", { name: /Graph visibility and pinning/ }).click();

  const restoredVisibility = stashGraphPage.getByRole("dialog", { name: "Graph visibility" });

  assert.equal(
    await restoredVisibility
      .getByRole("checkbox", { name: "Show stashes", exact: true })
      .isChecked(),
    false,
  );

  await restoredVisibility.getByRole("checkbox", { name: "Show stashes", exact: true }).check();
  await restoredVisibility.getByRole("button", { name: "Apply graph view", exact: true }).click();
  await stashGraphPage.getByTestId("commit-graph").press("Home");
  await stashGraphPage.getByRole("button", { name: /^stash@\{0\}: Recovered work\./ }).waitFor();
  assert.equal(git("stash", "list", "--format=%gs"), "Recovered work\n");
  assert.equal(git("show", ":file.txt"), "branch_staged_version\n");
  assert.equal(errors.length, 0, errors.join("\n"));

  git("add", "--all");
  git("commit", "-m", "Preserve restored work");

  const largeBase = Buffer.alloc(4 * 1024 * 1024 + 32);

  await writeFile(join(repository, "large.bin"), largeBase);
  git("add", "large.bin");
  git("commit", "-m", "Large binary base");
  git("checkout", "-b", "large-conflict-source");

  const largeIncoming = Buffer.from(largeBase);

  largeIncoming[1] = 2;
  await writeFile(join(repository, "large.bin"), largeIncoming);
  git("add", "large.bin");
  git("commit", "-m", "Large incoming content");
  git("checkout", "stash-recovered");

  const largeCurrent = Buffer.from(largeBase);

  largeCurrent[1] = 1;
  await writeFile(join(repository, "large.bin"), largeCurrent);
  git("add", "large.bin");
  git("commit", "-m", "Large current content");
  assert.throws(
    () => git("merge", "large-conflict-source", "--no-edit"),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 1,
  );

  await stashGraphPage.getByRole("button", { name: "Refresh repository", exact: true }).click();
  await stashGraphPage.getByRole("button", { name: "Resolve 1 conflicts", exact: true }).click();

  const largeConflict = stashGraphPage.getByRole("dialog", {
    name: "Resolve conflicts",
    exact: true,
  });

  await largeConflict.getByText(/This content cannot be edited in the text preview/).waitFor();
  await chooseSelect(
    largeConflict.getByRole("combobox", { name: "Resolution choice", exact: true }),
    "incoming",
  );
  await largeConflict.getByRole("button", { name: "Save and mark resolved", exact: true }).click();
  await largeConflict.getByRole("status").filter({ hasText: "Resolved large.bin" }).waitFor();
  assert.equal(git("ls-files", "--unmerged"), "");
  assert.equal(git("rev-parse", ":large.bin"), git("rev-parse", "large-conflict-source:large.bin"));
  assert.ok((await readFile(join(repository, "large.bin"))).equals(largeIncoming));

  await largeConflict.getByRole("button", { name: "Close", exact: true }).click();
  git("commit", "-m", "Resolve large binary merge");

  const replayBase = git("rev-parse", "HEAD").trim();

  git("checkout", "-b", "replay-source");
  await writeFile(join(repository, "file.txt"), "replay incoming\n");
  git("add", "file.txt");
  git("commit", "-m", "Replay first");

  const replayFirst = git("rev-parse", "HEAD").trim();

  await writeFile(join(repository, "replay-second.txt"), "second\n");
  git("add", "replay-second.txt");
  git("commit", "-m", "Replay second");

  const replaySecond = git("rev-parse", "HEAD").trim();

  git("checkout", "stash-recovered");
  await writeFile(join(repository, "file.txt"), "replay destination\n");
  git("add", "file.txt");
  git("commit", "-m", "Replay destination");

  const replayDestination = git("rev-parse", "HEAD").trim();

  await stashGraphPage.getByRole("button", { name: "Refresh repository", exact: true }).click();
  await stashGraphPage.getByTestId("commit-graph").press("Home");
  await stashGraphPage
    .getByRole("button", { name: new RegExp(`^Replay first\\. ${replayFirst.slice(0, 8)}\\.`) })
    .click({ button: "right" });
  await stashGraphPage.getByRole("menuitem", { name: "Cherry-pick...", exact: true }).click();

  const pickReview = stashGraphPage.getByRole("dialog", {
    name: "Cherry-pick commits",
    exact: true,
  });

  await chooseSelect(
    pickReview.getByRole("combobox", { name: "Add commit from loaded history" }),
    replaySecond,
  );
  await pickReview.getByRole("button", { name: "Review current state", exact: true }).click();
  await pickReview.getByRole("checkbox", { name: "I reviewed this cherry-pick action" }).check();
  await pickReview.getByRole("button", { name: "Cherry-pick commits", exact: true }).click();
  await pickReview.waitFor({ state: "hidden" });
  await stashGraphPage.getByText(/cherry-pick in progress/).waitFor();
  await app.close();
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });

  const replayPage = await foundationWindow(app);

  await replayPage.getByRole("button", { name: "Resolve 1 conflicts", exact: true }).click();

  const pickConflict = replayPage.getByRole("dialog", { name: "Resolve conflicts", exact: true });

  await chooseSelect(
    pickConflict.getByRole("combobox", { name: "Resolution choice", exact: true }),
    "incoming",
  );
  await pickConflict.getByRole("button", { name: "Save and mark resolved", exact: true }).click();
  await pickConflict.getByRole("status").filter({ hasText: "Resolved file.txt" }).waitFor();
  await pickConflict.getByRole("button", { name: "Close", exact: true }).click();
  await replayPage.getByRole("button", { name: "Continue cherry-pick...", exact: true }).click();

  const pickContinue = replayPage.getByRole("dialog", {
    name: "Continue cherry-pick",
    exact: true,
  });

  await pickContinue.getByRole("checkbox", { name: "I reviewed this cherry-pick action" }).check();
  await pickContinue.getByRole("button", { name: "Continue cherry-pick", exact: true }).click();
  await pickContinue.waitFor({ state: "hidden" });
  await replayPage.getByText(/cherry-pick in progress/).waitFor({ state: "hidden" });
  assert.equal(git("rev-parse", "HEAD~2").trim(), replayDestination);
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "replay incoming\n");

  const pickedFirst = git("rev-parse", "HEAD^").trim();
  const pickedSecond = git("rev-parse", "HEAD").trim();

  await replayPage.getByTestId("commit-graph").press("Home");
  await replayPage
    .getByRole("button", { name: new RegExp(`^Replay second\\. ${pickedSecond.slice(0, 8)}\\.`) })
    .click({ button: "right" });
  await replayPage.getByRole("menuitem", { name: "Revert...", exact: true }).click();

  const revertReview = replayPage.getByRole("dialog", { name: "Revert commits", exact: true });

  await chooseSelect(
    revertReview.getByRole("combobox", { name: "Add commit from loaded history" }),
    pickedFirst,
  );
  await revertReview.getByRole("button", { name: "Review current state", exact: true }).click();
  await revertReview.getByRole("checkbox", { name: "I reviewed this revert action" }).check();
  await revertReview.getByRole("button", { name: "Revert commits", exact: true }).click();
  await revertReview.waitFor({ state: "hidden" });
  assert.equal(git("rev-parse", "HEAD^{tree}"), git("rev-parse", `${replayDestination}^{tree}`));
  assert.equal(git("status", "--porcelain"), "");

  await replayPage.getByTestId("commit-graph").press("Home");
  await replayPage
    .getByRole("button", {
      name: new RegExp(`^Resolve large binary merge\\. ${replayBase.slice(0, 8)}\\.`),
    })
    .click({ button: "right" });
  await replayPage.getByRole("menuitem", { name: "Revert...", exact: true }).click();

  const mergeRevert = replayPage.getByRole("dialog", { name: "Revert commits", exact: true });

  await chooseSelect(mergeRevert.getByRole("combobox", { name: "Mainline parent" }), "1");
  await mergeRevert.getByRole("button", { name: "Review current state", exact: true }).click();
  await mergeRevert.getByRole("checkbox", { name: "I reviewed this revert action" }).check();
  await mergeRevert.getByRole("button", { name: "Revert commits", exact: true }).click();
  await mergeRevert.waitFor({ state: "hidden" });
  assert.ok((await readFile(join(repository, "large.bin"))).equals(largeCurrent));
  assert.equal(git("status", "--porcelain"), "");

  const resetBase = git("rev-parse", "HEAD").trim();
  const resetSubject = git("log", "-1", "--format=%s").trim();

  await writeFile(join(repository, "file.txt"), "reset committed\n");
  git("add", "file.txt");
  git("commit", "-m", "Reset source");

  const resetSource = git("rev-parse", "HEAD").trim();

  git("update-ref", "refs/remotes/origin/reset-source", resetSource);
  await writeFile(join(repository, "file.txt"), "reset staged\n");
  git("add", "file.txt");
  await writeFile(join(repository, "file.txt"), "reset working\n");

  const baseContent = git("show", `${resetBase}:file.txt`);

  for (const mode of ["soft", "mixed", "hard"]) {
    await replayPage.getByRole("button", { name: "Refresh repository", exact: true }).click();
    await replayPage.getByTestId("commit-graph").press("Home");
    await replayPage
      .getByRole("button", { name: `${resetSubject}. ${resetBase.slice(0, 8)}.`, exact: false })
      .click({ button: "right" });
    await replayPage
      .getByRole("menuitem", { name: "Reset current branch here...", exact: true })
      .click();

    const resetDialog = replayPage.getByRole("dialog", { name: "Reset to commit", exact: true });

    await chooseSelect(resetDialog.getByRole("combobox", { name: "Reset mode" }), mode);

    if (mode === "soft")
      await resetDialog.getByRole("note").filter({ hasText: "This reset removes 1" }).waitFor();

    await resetDialog
      .getByRole("checkbox", {
        name:
          mode === "hard"
            ? "I reviewed the files that will be overwritten or removed"
            : "I reviewed this reset",
        exact: true,
      })
      .check();
    await resetDialog.getByRole("button", { name: `Reset ${mode}`, exact: true }).click();
    await resetDialog.getByRole("status").filter({ hasText: "Reset completed." }).waitFor();

    if (mode === "soft") {
      await resetDialog.getByRole("note").filter({ hasText: "Nothing was pushed" }).waitFor();
      assert.equal(git("rev-parse", "refs/remotes/origin/reset-source").trim(), resetSource);
    }

    assert.equal(git("rev-parse", "HEAD").trim(), resetBase);
    assert.equal(git("show", ":file.txt"), mode === "soft" ? "reset staged\n" : baseContent);
    assert.equal(
      await readFile(join(repository, "file.txt"), "utf8"),
      mode === "hard" ? baseContent : "reset working\n",
    );

    await resetDialog.getByRole("button", { name: "Close", exact: true }).click();
  }

  const reverseReset = async (page: Page, direction: "Undo" | "Redo") => {
    await page.keyboard.press(`${modifier}+Shift+p`);
    await page
      .getByRole("combobox", { name: "Search commands" })
      .fill("Undo and redo local actions");
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Undo and redo local actions", exact: true });

    await dialog.getByRole("button", { name: new RegExp(`^${direction} hard reset to `) }).click();
    await dialog.getByRole("checkbox", { name: "I reviewed this reversal", exact: true }).check();
    await dialog.getByRole("button", { name: `Apply ${direction}`, exact: true }).click();
    await dialog
      .getByRole("status")
      .filter({ hasText: new RegExp(`^${direction} hard reset to .* completed\\.`) })
      .waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  };

  await reverseReset(replayPage, "Undo");
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "reset working\n");
  assert.equal(git("show", ":file.txt"), baseContent);

  await app.close();

  const reversalDb = new DatabaseSync(join(root, "eda.db"));
  const pendingUndo = reversalDb
    .prepare(
      "SELECT id FROM workflow_journal WHERE json_extract(record, '$.mode') = 'reset' AND json_extract(record, '$.refChange.mode') = 'hard' AND json_extract(record, '$.refChange.reversal.state') = 'undone' ORDER BY updated_at DESC LIMIT 1",
    )
    .get();

  assert.ok(pendingUndo);
  assert.equal(typeof pendingUndo["id"], "string");

  reversalDb
    .prepare(
      "UPDATE workflow_journal SET record = json_set(record, '$.refChange.reversal.state', 'undoing', '$.refChange.reversal.expectedFingerprint', json_extract(record, '$.refChange.afterFingerprint')) WHERE id = ?",
    )
    .run(pendingUndo["id"]!);
  reversalDb.close();
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });

  let resetPage = await foundationWindow(app);

  await resetPage.getByRole("button", { name: "Refresh repository", exact: true }).waitFor();

  const reconciliationReflog = git("reflog", "--format=%H %gs");

  await resetPage.keyboard.press(`${modifier}+Shift+p`);
  await resetPage
    .getByRole("combobox", { name: "Search commands" })
    .fill("Undo and redo local actions");
  await resetPage.getByRole("option", { name: /Undo and redo local actions/ }).click();

  const reconcileDialog = resetPage.getByRole("dialog", {
    name: "Undo and redo local actions",
    exact: true,
  });

  await reconcileDialog.getByRole("button", { name: /^Reconcile Undo hard reset to / }).click();
  await reconcileDialog
    .getByRole("status")
    .filter({ hasText: "Recovery record reconciled" })
    .waitFor();
  assert.equal(git("reflog", "--format=%H %gs"), reconciliationReflog);
  assert.equal(git("show", ":file.txt"), baseContent);
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "reset working\n");

  await reconcileDialog.getByRole("button", { name: "Close", exact: true }).click();
  await reverseReset(resetPage, "Redo");
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), baseContent);
  assert.equal(git("show", ":file.txt"), baseContent);

  await resetPage.keyboard.press(`${modifier}+Shift+p`);
  await resetPage.getByRole("combobox", { name: "Search commands" }).fill("Recover local files");
  await resetPage.keyboard.press("Enter");

  const resetRecovery = resetPage.getByRole("dialog", { name: "Recover local files" });
  const resetRecord = resetRecovery
    .locator("div")
    .filter({ has: resetPage.getByText(/Reset recovery/) })
    .filter({ has: resetPage.getByRole("button", { name: "Restore 1 files", exact: true }) })
    .last();

  await resetRecord.getByRole("button", { name: "Restore 1 files", exact: true }).click();
  await resetRecovery.waitFor({ state: "hidden" });
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "reset working\n");
  assert.equal(git("show", ":file.txt"), baseContent);

  await resetPage.keyboard.press(`${modifier}+Shift+p`);
  await resetPage
    .getByRole("combobox", { name: "Search commands" })
    .fill("Reflog and history recovery");
  await resetPage.keyboard.press("Enter");

  const historyRecovery = resetPage.getByRole("dialog", {
    name: "Reflog and history recovery",
    exact: true,
  });

  await historyRecovery
    .getByRole("button", { name: "Shared-history actions", exact: true })
    .click();
  await historyRecovery.getByRole("note").filter({ hasText: "force-with-lease" }).waitFor();
  await historyRecovery
    .getByRole("button", { name: `Inspect ${resetSource} Reset soft`, exact: true })
    .waitFor();
  await historyRecovery.getByRole("button", { name: /^Inspect .* Rebase$/ }).waitFor();
  await historyRecovery.getByRole("button", { name: "Saved recovery refs", exact: true }).click();
  await historyRecovery.getByRole("textbox", { name: "Filter recovery entries" }).fill(resetSource);
  await historyRecovery
    .getByRole("button", { name: new RegExp(`^Inspect ${resetSource} `) })
    .first()
    .click();
  await historyRecovery.getByRole("heading", { name: "Reset source", exact: true }).waitFor();
  await historyRecovery
    .getByRole("textbox", { name: "Recovered branch name" })
    .fill("recovered-reset-source");
  await historyRecovery
    .getByRole("checkbox", { name: "Create this branch at the inspected commit", exact: true })
    .check();
  await historyRecovery.getByRole("button", { name: "Restore as branch", exact: true }).click();
  await historyRecovery
    .getByRole("status")
    .filter({ hasText: "Restored refs/heads/recovered-reset-source" })
    .waitFor();
  assert.equal(git("rev-parse", "recovered-reset-source").trim(), resetSource);
  assert.equal(git("rev-parse", "HEAD").trim(), resetBase);
  assert.equal(git("show", ":file.txt"), baseContent);
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "reset working\n");

  await historyRecovery.getByRole("button", { name: "Close", exact: true }).click();

  const mixedResumeSetup = await resetPage.evaluate(
    async ({ id, source }) => {
      const review = await window.eda.reset.prepare(id, source, "mixed");
      if (!review.ok) return review;
      return window.eda.reset.execute(id, review.value.token);
    },
    { id: repositoryId, source: resetSource },
  );

  assert.equal(mixedResumeSetup.ok, true);

  await app.close();

  const mixedDb = new DatabaseSync(join(root, "eda.db"));
  const pendingMixed = mixedDb
    .prepare(
      "SELECT id FROM workflow_journal WHERE json_extract(record, '$.mode') = 'reset' AND json_extract(record, '$.refChange.mode') = 'mixed' AND json_extract(record, '$.refChange.target') = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(resetSource);

  assert.ok(pendingMixed);
  assert.equal(typeof pendingMixed["id"], "string");

  mixedDb
    .prepare(
      "UPDATE workflow_journal SET record = json_set(record, '$.refChange.reversal.state', 'undoing') WHERE id = ?",
    )
    .run(pendingMixed["id"]!);
  mixedDb.close();
  git("update-ref", "HEAD", resetBase, resetSource);

  const mixedResumeReflog = git("reflog", "--format=%H %gs");

  assert.equal(git("show", ":file.txt"), "reset committed\n");

  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });
  resetPage = await foundationWindow(app);
  await resetPage.getByRole("button", { name: "Refresh repository", exact: true }).waitFor();
  await resetPage.keyboard.press(`${modifier}+Shift+p`);
  await resetPage
    .getByRole("combobox", { name: "Search commands" })
    .fill("Undo and redo local actions");
  await resetPage.getByRole("option", { name: /Undo and redo local actions/ }).click();

  const resumeIndexDialog = resetPage.getByRole("dialog", {
    name: "Undo and redo local actions",
    exact: true,
  });

  await resumeIndexDialog
    .getByRole("button", { name: /^Resume index for Undo mixed reset to / })
    .click();
  await resumeIndexDialog
    .getByRole("status")
    .filter({ hasText: "Index restoration completed" })
    .waitFor();
  assert.equal(git("reflog", "--format=%H %gs"), mixedResumeReflog);
  assert.equal(git("show", ":file.txt"), baseContent);
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "reset working\n");

  await resumeIndexDialog.getByRole("button", { name: "Close", exact: true }).click();

  const hardResumeSetup = await resetPage.evaluate(
    async ({ id, source }) => {
      const review = await window.eda.reset.prepare(id, source, "hard");

      if (!review.ok) throw new Error(review.error.message);

      const reset = await window.eda.reset.execute(id, review.value.token);

      if (!reset.ok) throw new Error(reset.error.message);

      const actions = await window.eda.historyRecovery.reversals(id);

      if (!actions.ok) throw new Error(actions.error.message);

      const action = actions.value.find((item) => item.mode === "hard" && item.available);

      if (!action) throw new Error("Missing hard-reset reversal");

      const undo = await window.eda.historyRecovery.reverse(
        id,
        action.id,
        "undo",
        action.publishedCommits,
      );

      if (!undo.ok) throw new Error(undo.error.message);

      return action.id;
    },
    { id: repositoryId, source: resetSource },
  );

  await app.close();

  const hardResumeDb = new DatabaseSync(join(root, "eda.db"));

  hardResumeDb
    .prepare(
      "UPDATE workflow_journal SET record = json_set(record, '$.refChange.reversal.state', 'redoing') WHERE id = ?",
    )
    .run(hardResumeSetup);
  hardResumeDb.close();
  git("update-ref", "HEAD", resetSource, resetBase);

  const hardResumeReflog = git("reflog", "--format=%H %gs");

  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });
  resetPage = await foundationWindow(app);
  await resetPage.getByRole("button", { name: "Refresh repository", exact: true }).waitFor();
  await resetPage.keyboard.press(`${modifier}+Shift+p`);
  await resetPage
    .getByRole("combobox", { name: "Search commands" })
    .fill("Undo and redo local actions");
  await resetPage.getByRole("option", { name: /Undo and redo local actions/ }).click();

  const hardResumeDialog = resetPage.getByRole("dialog", {
    name: "Undo and redo local actions",
    exact: true,
  });

  await hardResumeDialog
    .getByRole("button", { name: /^Resume files and index for Redo hard reset to / })
    .click();
  await hardResumeDialog
    .getByRole("status")
    .filter({ hasText: "Index and saved working-file restoration completed" })
    .waitFor();
  assert.equal(git("reflog", "--format=%H %gs"), hardResumeReflog);
  assert.equal(git("show", ":file.txt"), "reset committed\n");
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), "reset committed\n");

  await hardResumeDialog.getByRole("button", { name: "Close", exact: true }).click();

  const originalReset = await resetPage.evaluate(
    async ({ id, target }) => {
      const review = await window.eda.reset.prepare(id, target, "mixed");
      if (!review.ok) throw new Error(review.error.message);
      const result = await window.eda.reset.execute(id, review.value.token);
      if (!result.ok) throw new Error(result.error.message);
      return result.value.recoveryRef;
    },
    { id: repositoryId, target: resetBase },
  );

  const originalReflog = git("reflog", "--format=%H %gs");
  const originalIndex = git("write-tree");
  const originalWorking = await readFile(join(repository, "file.txt"), "utf8");

  await app.close();

  const originalDb = new DatabaseSync(join(root, "eda.db"));
  const changed = originalDb
    .prepare(
      "UPDATE workflow_journal SET record = json_set(json_remove(record, '$.refChange.reversal'), '$.state', 'running') WHERE json_extract(record, '$.refChange.recoveryRef') = ?",
    )
    .run(originalReset.replace(/\/head$/, ""));

  assert.equal(changed.changes, 1);

  originalDb.close();
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });
  resetPage = await foundationWindow(app);
  await resetPage.getByRole("button", { name: "Refresh repository", exact: true }).waitFor();
  await resetPage.keyboard.press(`${modifier}+Shift+p`);
  await resetPage
    .getByRole("combobox", { name: "Search commands" })
    .fill("Undo and redo local actions");
  await resetPage.getByRole("option", { name: /Undo and redo local actions/ }).click();

  const originalDialog = resetPage.getByRole("dialog", {
    name: "Undo and redo local actions",
    exact: true,
  });

  await originalDialog
    .getByRole("button", { name: "Resume interrupted mixed reset", exact: true })
    .click();
  await originalDialog.getByRole("status").filter({ hasText: "without another reset" }).waitFor();
  assert.equal(git("reflog", "--format=%H %gs"), originalReflog);
  assert.equal(git("write-tree"), originalIndex);
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), originalWorking);

  await originalDialog.getByRole("button", { name: "Close", exact: true }).click();
  git("branch", "config-recovery", "HEAD");
  git("config", "branch.config-recovery.remote", ".");
  git("config", "branch.config-recovery.merge", "refs/heads/main");

  const deleteConfigured = await resetPage.evaluate(
    (id) =>
      window.eda.repository.deleteBranch({
        repositoryId: id,
        name: "config-recovery",
        force: true,
      }),
    repositoryId,
  );

  assert.equal(deleteConfigured.ok, true, JSON.stringify(deleteConfigured));

  await resetPage.keyboard.press(`${modifier}+Shift+p`);
  await resetPage
    .getByRole("combobox", { name: "Search commands" })
    .fill("Undo and redo local actions");
  await resetPage.getByRole("option", { name: /Undo and redo local actions/ }).click();

  const configDialog = resetPage.getByRole("dialog", {
    name: "Undo and redo local actions",
    exact: true,
  });

  await configDialog
    .getByRole("button", { name: "Undo Delete branch config-recovery", exact: true })
    .click();
  await configDialog
    .getByRole("checkbox", { name: "I reviewed this reversal", exact: true })
    .check();
  await configDialog.getByRole("button", { name: "Apply Undo", exact: true }).click();
  await configDialog
    .getByRole("status")
    .filter({ hasText: "Undo Delete branch config-recovery completed" })
    .waitFor();
  assert.equal(git("config", "branch.config-recovery.remote").trim(), ".");
  assert.equal(git("config", "branch.config-recovery.merge").trim(), "refs/heads/main");
  assert.equal(git("rev-parse", "config-recovery").trim(), resetBase);

  await configDialog.getByRole("button", { name: "Close", exact: true }).click();

  const configAction = await resetPage.evaluate(async (id) => {
    const result = await window.eda.historyRecovery.reversals(id);
    if (!result.ok) throw new Error(result.error.message);
    return result.value.find((item) => item.label === "Redo Delete branch config-recovery")?.id;
  }, repositoryId);

  assert.ok(configAction);

  await app.close();

  const configDb = new DatabaseSync(join(root, "eda.db"));

  configDb
    .prepare(
      "UPDATE workflow_journal SET record = json_set(record, '$.refOperation.state', 'undoing') WHERE id = ?",
    )
    .run(configAction);
  configDb.close();
  git("config", "--remove-section", "branch.config-recovery");

  const configReflog = git("reflog", "show", "config-recovery", "--format=%H %gs");

  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });
  resetPage = await foundationWindow(app);
  await resetPage.getByRole("button", { name: "Refresh repository", exact: true }).waitFor();
  await resetPage.keyboard.press(`${modifier}+Shift+p`);
  await resetPage
    .getByRole("combobox", { name: "Search commands" })
    .fill("Undo and redo local actions");
  await resetPage.getByRole("option", { name: /Undo and redo local actions/ }).click();

  const settingsRecovery = resetPage.getByRole("dialog", {
    name: "Undo and redo local actions",
    exact: true,
  });

  await settingsRecovery
    .getByRole("button", {
      name: "Finish settings for Undo Delete branch config-recovery",
      exact: true,
    })
    .click();
  await settingsRecovery
    .getByRole("status")
    .filter({ hasText: "Branch configuration recovery completed" })
    .waitFor();
  assert.equal(git("reflog", "show", "config-recovery", "--format=%H %gs"), configReflog);
  assert.equal(git("config", "branch.config-recovery.remote").trim(), ".");
  assert.equal(git("config", "branch.config-recovery.merge").trim(), "refs/heads/main");

  git("config", "branch.renamed-config.description", "Retain existing destination settings");

  const configuredRename = await resetPage.evaluate(
    (id) =>
      window.eda.repository.renameBranch({
        repositoryId: id,
        from: "config-recovery",
        to: "renamed-config",
      }),
    repositoryId,
  );

  assert.equal(configuredRename.ok, true, JSON.stringify(configuredRename));

  await settingsRecovery.getByRole("button", { name: "Refresh actions", exact: true }).click();
  await settingsRecovery
    .getByRole("button", {
      name: "Undo Rename branch config-recovery to renamed-config",
      exact: true,
    })
    .click();
  await settingsRecovery
    .getByRole("checkbox", { name: "I reviewed this reversal", exact: true })
    .check();
  await settingsRecovery.getByRole("button", { name: "Apply Undo", exact: true }).click();
  await settingsRecovery
    .getByRole("status")
    .filter({ hasText: "Undo Rename branch config-recovery to renamed-config completed" })
    .waitFor();
  assert.equal(git("config", "branch.config-recovery.remote").trim(), ".");
  assert.equal(git("config", "branch.config-recovery.merge").trim(), "refs/heads/main");
  assert.equal(git("rev-parse", "config-recovery").trim(), resetBase);
  assert.equal(
    git("config", "branch.renamed-config.description").trim(),
    "Retain existing destination settings",
  );

  await settingsRecovery.getByRole("button", { name: "Close", exact: true }).click();

  const intentStartBranch = git("branch", "--show-current").trim();
  const intentStartHead = git("rev-parse", "HEAD").trim();
  const originalRef = await resetPage.evaluate(async (id) => {
    const created = await window.eda.repository.createBranch({
      repositoryId: id,
      name: "original-intent",
    });

    if (!created.ok) throw new Error(created.error.message);

    const actions = await window.eda.historyRecovery.reversals(id);

    if (!actions.ok) throw new Error(actions.error.message);

    return actions.value.find((item) => item.label === "Undo Create branch original-intent")?.id;
  }, repositoryId);

  assert.ok(originalRef);

  await app.close();

  const intentDb = new DatabaseSync(join(root, "eda.db"));

  intentDb
    .prepare(
      "UPDATE workflow_journal SET record = json_set(json_remove(record, '$.refOperation.afterIndexFlags'), '$.state', 'paused', '$.refOperation.afterFingerprint', '') WHERE id = ?",
    )
    .run(originalRef);
  intentDb.close();

  const intentReflog = git("reflog", "show", "original-intent", "--format=%H %gs");
  const intentIndex = git("write-tree");
  const intentWorking = await readFile(join(repository, "file.txt"), "utf8");

  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });
  resetPage = await foundationWindow(app);
  await resetPage.getByRole("button", { name: "Refresh repository", exact: true }).waitFor();
  await resetPage.keyboard.press(`${modifier}+Shift+p`);
  await resetPage
    .getByRole("combobox", { name: "Search commands" })
    .fill("Undo and redo local actions");
  await resetPage.getByRole("option", { name: /Undo and redo local actions/ }).click();

  const intentDialog = resetPage.getByRole("dialog", {
    name: "Undo and redo local actions",
    exact: true,
  });

  await intentDialog
    .getByRole("button", { name: "Reconcile Undo Create branch original-intent", exact: true })
    .click();
  await intentDialog
    .getByRole("status")
    .filter({ hasText: "Recovery record reconciled" })
    .waitFor();
  assert.equal(git("reflog", "show", "original-intent", "--format=%H %gs"), intentReflog);
  assert.equal(git("write-tree"), intentIndex);
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), intentWorking);

  await intentDialog.getByRole("button", { name: "Close", exact: true }).click();
  await app.close();

  const checkoutDb = new DatabaseSync(join(root, "eda.db"));

  checkoutDb
    .prepare(
      "UPDATE workflow_journal SET record = json_set(record, '$.state', 'paused', '$.refOperation.afterFingerprint', '', '$.refOperation.checkedOut', json('true'), '$.refOperation.afterBranch', 'original-intent') WHERE id = ?",
    )
    .run(originalRef);
  checkoutDb.close();
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });
  resetPage = await foundationWindow(app);
  await resetPage.getByRole("button", { name: "Refresh repository", exact: true }).waitFor();
  await resetPage.keyboard.press(`${modifier}+Shift+p`);
  await resetPage
    .getByRole("combobox", { name: "Search commands" })
    .fill("Undo and redo local actions");
  await resetPage.getByRole("option", { name: /Undo and redo local actions/ }).click();

  const checkoutDialog = resetPage.getByRole("dialog", {
    name: "Undo and redo local actions",
    exact: true,
  });

  await checkoutDialog
    .getByRole("button", {
      name: "Resume checkout: Undo Create branch original-intent",
      exact: true,
    })
    .click();
  await checkoutDialog
    .getByRole("status")
    .filter({ hasText: "Branch checkout completed" })
    .waitFor();
  assert.equal(git("branch", "--show-current").trim(), "original-intent");
  assert.equal(git("reflog", "show", "original-intent", "--format=%H %gs"), intentReflog);
  assert.equal(git("write-tree"), intentIndex);
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), intentWorking);

  await app.close();

  if (intentStartBranch) git("checkout", intentStartBranch);
  else git("checkout", "--detach", intentStartHead);

  git("branch", "-D", "original-intent");

  const unstartedDb = new DatabaseSync(join(root, "eda.db"));

  unstartedDb
    .prepare(
      "UPDATE workflow_journal SET record = json_set(record, '$.state', 'paused', '$.refOperation.afterFingerprint', '') WHERE id = ?",
    )
    .run(originalRef);
  unstartedDb.close();

  const unstartedReflog = git("reflog", "--format=%H %gs");

  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });
  resetPage = await foundationWindow(app);
  await resetPage.getByRole("button", { name: "Refresh repository", exact: true }).waitFor();
  await resetPage.keyboard.press(`${modifier}+Shift+p`);
  await resetPage
    .getByRole("combobox", { name: "Search commands" })
    .fill("Undo and redo local actions");
  await resetPage.getByRole("option", { name: /Undo and redo local actions/ }).click();

  const unstartedDialog = resetPage.getByRole("dialog", {
    name: "Undo and redo local actions",
    exact: true,
  });

  await unstartedDialog
    .getByRole("button", {
      name: "Dismiss unstarted action: Undo Create branch original-intent",
      exact: true,
    })
    .click();
  await unstartedDialog
    .getByRole("status")
    .filter({ hasText: "Unstarted action dismissed" })
    .waitFor();

  const remainingActions = await resetPage.evaluate(
    async (id) => window.eda.historyRecovery.reversals(id),
    repositoryId,
  );

  assert.equal(remainingActions.ok, true);
  assert.equal(
    remainingActions.value.some((item) => item.id === originalRef),
    false,
  );
  assert.equal(git("reflog", "--format=%H %gs"), unstartedReflog);
  assert.equal(git("write-tree"), intentIndex);
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), intentWorking);
  assert.equal(errors.length, 0, errors.join("\n"));

  console.log(
    "Foundation desktop gate passed: repository/navigation/layout workflows, branch/tag actions, merge/squash completion after restart, abort/recovery, stash conflict/restart/finish, branch-from-stash, stash rename/graph visibility, interactive rebase conflict/edit/restart, large binary conflict resolution, cherry-pick selection/conflict/restart, ordered/merge-mainline revert, all reset modes with recovery after restart, hard-reset Undo/restart/Redo, and inspected history recovery to a new branch.",
  );
} catch (error) {
  if (app) {
    await mkdir("screenshots", { recursive: true });
    await app
      .context()
      .tracing.stop({ path: resolve("screenshots/foundations-trace.zip") })
      .catch(() => {});
    await app
      .windows()[0]
      ?.screenshot({ path: resolve("screenshots/foundations-failure.png") })
      .catch(() => {});
  }

  throw error;
} finally {
  if (app) {
    const running = app;
    const timeout = setTimeout(() => {
      if (process.platform === "win32") {
        try {
          execFileSync("taskkill", ["/PID", String(running.process().pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {}
      } else running.process().kill("SIGKILL");
    }, 5000);

    await app.close().catch(() => app?.process().kill());
    clearTimeout(timeout);
  }

  assert.ok(resolve(root).startsWith(resolve(tmpdir(), "eda-foundations-")));

  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
