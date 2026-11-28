import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { trustFixture } from "./helpers/trust.ts";
import { finishOnboarding } from "./helpers/onboarding.ts";
import type { OperationState } from "../../src/shared/operations.ts";
import assert from "node:assert/strict";
import { type ElectronApplication, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "eda-local-workflow-"));
const repository = join(root, "local-workflow");

await mkdir(repository);

const config = join(root, "gitconfig");

await writeFile(
  config,
  "[user]\nname = Eda\nemail = fixture@eda.invalid\n[commit]\ngpgsign = false\n",
);

const env = fixtureEnvironment(root);

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], { env, encoding: "utf8", stdio: "pipe" });

git("init", "-b", "main");

const original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";

await writeFile(join(repository, "file.txt"), original);
git("add", ".");
git("commit", "-m", "Initial", "-m", "Reusable fixture body");

const template = join(root, "commit-template.txt");

await writeFile(template, "Template summary\n\nTemplate body\n");
git("config", "commit.template", template);
await writeFile(
  join(repository, "file.txt"),
  original.replace("line 1\n", "first change\n").replace("line 25\n", "second change\n"),
);

let app: ElectronApplication | undefined;
const errors: string[] = [];

async function waitForOperation(page: Page, kind: string, state: OperationState) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const records = await page.evaluate(async () => {
      const result = await window.eda.operations.list();
      if (!result.ok)
        throw new Error("Expected a successful IPC result: " + JSON.stringify(result));
      return result.value;
    });

    if (records?.some((record) => record.kind === kind && record.state === state)) return;

    await page.waitForTimeout(100);
  }

  throw new Error(`Timed out waiting for ${kind}: ${state}`);
}

try {
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });

  await trustFixture(app, root);
  const page = await app.firstWindow();

  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Work");
  await page.getByRole("textbox", { name: /^Git author name/ }).fill("Eda");
  await page.getByRole("textbox", { name: /^Git email/ }).fill("work@eda.invalid");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await finishOnboarding(page);
  await page.getByRole("button", { name: /Active profile: Work/ }).waitFor();
  const opened = await page.evaluate((path) => window.eda.repository.open(path), repository);

  assert.ok(opened.ok, JSON.stringify(opened));

  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+p`);

  const picker = page.getByRole("dialog", { name: "Open a repository", exact: true });

  await picker.getByRole("button", { name: /^local-workflow / }).press("Enter");
  await picker.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "local-workflow", exact: true }).waitFor();
  await page.getByRole("button", { name: "Unstaged file.txt, status M", exact: true }).click();
  await page.getByRole("button", { name: "Stage hunk 1", exact: true }).click();
  await waitForOperation(page, "Apply selected changes", "succeeded");
  assert.equal(
    await page.getByRole("dialog", { name: "Stage selected changes", exact: true }).count(),
    0,
  );
  assert.match(git("diff", "--cached"), /first change/);
  assert.doesNotMatch(git("diff", "--cached"), /second change/);

  await page.getByRole("button", { name: "Back to history", exact: true }).click();

  const draft = page.getByRole("textbox", { name: "Commit title" });

  await page.getByText("Commit options", { exact: true }).click();
  await page.getByRole("button", { name: "Reuse commit message" }).click();
  const history = page.getByRole("dialog", { name: "Reuse commit message" });
  await history.getByRole("button", { name: /Initial/ }).click();
  assert.equal(await draft.inputValue(), "Initial");
  assert.equal(
    (await page.getByRole("textbox", { name: "Commit description" }).inputValue()).trim(),
    "Reusable fixture body",
  );
  await draft.fill("A".repeat(110));
  await page.getByText(/Title is 110 characters/).waitFor();
  assert.equal(await draft.getAttribute("spellcheck"), "true");
  await draft.fill("");
  await page.getByRole("textbox", { name: "Commit description" }).fill("");
  await page.getByRole("button", { name: "Insert Git template", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector<HTMLTextAreaElement>('[aria-label="Commit description"]')
      ?.value.includes("Template body"),
  );
  const graphDraft = page.getByRole("textbox", { name: "Working tree title", exact: true });
  await graphDraft.fill("Commit first hunk");
  assert.equal(await draft.inputValue(), "Commit first hunk");
  await page.getByRole("textbox", { name: "Commit description" }).fill("");
  await page.getByRole("checkbox", { name: "Add Signed-off-by trailer" }).check();
  await page.getByRole("button", { name: "Add co-author..." }).click();
  await page.getByRole("textbox", { name: "Co-author name" }).fill("Eda");
  await page.getByRole("textbox", { name: "Co-author email" }).fill("second@eda.invalid");
  await page.getByRole("button", { name: "Insert trailer", exact: true }).click();
  await page.getByRole("button", { name: "Commit", exact: true }).click();
  await waitForOperation(page, "Commit", "succeeded");
  assert.match(git("show", "HEAD:file.txt"), /first change/);
  assert.doesNotMatch(git("show", "HEAD:file.txt"), /second change/);
  assert.match(git("diff"), /second change/);
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>('[aria-label="Working tree title"]')?.value === "",
  );
  assert.match(git("log", "-1", "--format=%B"), /Signed-off-by: Eda <work@eda.invalid>/);
  assert.match(git("log", "-1", "--format=%B"), /Co-authored-by: Eda <second@eda.invalid>/);

  const committed = git("rev-parse", "HEAD").trim();
  const commitParent = git("rev-parse", "HEAD^").trim();
  const stagedContent = git("show", ":file.txt");
  const workingContent = await readFile(join(repository, "file.txt"), "utf8");
  const reverseAction = async (label: string, direction: "Undo" | "Redo") => {
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+p`);
    await page
      .getByRole("combobox", { name: "Search commands" })
      .fill("Undo and redo local actions");
    await page.getByRole("option", { name: /Undo and redo local actions/ }).click();

    const dialog = page.getByRole("dialog", { name: "Undo and redo local actions", exact: true });

    await dialog.getByRole("button", { name: `${direction} ${label}`, exact: true }).click();

    if (direction === "Redo" && label.startsWith("Amend commit:"))
      await dialog.getByRole("note").filter({ hasText: "force-with-lease" }).waitFor();

    await dialog.getByRole("checkbox", { name: "I reviewed this reversal", exact: true }).check();
    await dialog.getByRole("button", { name: `Apply ${direction}`, exact: true }).click();
    await dialog
      .getByRole("status")
      .filter({ hasText: `${direction} ${label} completed.` })
      .waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  };

  await reverseAction("Commit: Commit first hunk", "Undo");
  assert.equal(git("rev-parse", "HEAD").trim(), commitParent);
  assert.equal(git("show", ":file.txt"), stagedContent);
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), workingContent);

  await reverseAction("Commit: Commit first hunk", "Redo");
  assert.equal(git("rev-parse", "HEAD").trim(), committed);

  git("update-ref", "refs/remotes/origin/published", committed);
  await page.getByRole("checkbox", { name: "Amend the previous commit", exact: true }).check();
  await draft.fill("Amended first hunk");
  await page.getByRole("button", { name: "Amend commit", exact: true }).click();
  await waitForOperation(page, "Amend commit", "succeeded");
  await page
    .getByRole("status")
    .filter({ hasText: "Amendment completed and replaced published history" })
    .waitFor();

  const amended = git("rev-parse", "HEAD").trim();

  assert.notEqual(amended, committed);

  await reverseAction("Amend commit: Amended first hunk", "Undo");
  assert.equal(git("rev-parse", "HEAD").trim(), committed);

  await reverseAction("Amend commit: Amended first hunk", "Redo");
  assert.equal(git("rev-parse", "HEAD").trim(), amended);
  assert.equal(git("show", ":file.txt"), stagedContent);
  assert.equal(await readFile(join(repository, "file.txt"), "utf8"), workingContent);

  await page.getByRole("checkbox", { name: "Amend the previous commit", exact: true }).uncheck();
  await page.getByText("Commit options", { exact: true }).click();

  const hooks = join(root, "hooks");

  await mkdir(hooks);
  git("config", "core.hooksPath", hooks);
  await writeFile(
    join(hooks, "pre-commit"),
    '#!/bin/sh\necho "token=private-test-secret" >&2\nexit 1\n',
    { mode: 0o755 },
  );

  const trust = await page.evaluate((id) => window.eda.repository.reviewTrust(id), opened.value.id);

  assert.ok(trust.ok, JSON.stringify(trust));

  await page.getByRole("button", { name: "Stage file.txt", exact: true }).click();
  await draft.fill("Keep failed draft");
  await page.getByRole("button", { name: "Commit", exact: true }).click();
  await waitForOperation(page, "Commit", "failed");
  await page
    .getByRole("dialog", { name: "Could not complete the action", exact: true })
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  assert.equal(await draft.inputValue(), "Keep failed draft");

  const records = await page.evaluate(async () => {
    const result = await window.eda.operations.list();
    if (!result.ok) throw new Error("Expected a successful IPC result: " + JSON.stringify(result));
    return result.value;
  });

  assert.doesNotMatch(JSON.stringify(records), /private-test-secret/);
  assert.match(JSON.stringify(records), /redacted/);

  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByText("failed", { exact: true }).first().click();
  await page.getByText(/token=\[redacted\]/).waitFor();

  const beforeCancel = git("rev-parse", "HEAD");
  const indexBeforeCancel = git("ls-files", "--stage", "-z");

  await writeFile(
    join(hooks, "pre-commit"),
    `#!/bin/sh\necho "Waiting in fixture hook" >&2\n"${process.execPath.replaceAll("\\", "/")}" -e 'setTimeout(() => {}, 60000)'\n`,
    { mode: 0o755 },
  );
  await page.getByRole("button", { name: "Workspace drawer", exact: true }).click();
  await page.getByRole("button", { name: "Commit", exact: true }).click();
  await waitForOperation(page, "Commit", "running");
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByText("running", { exact: true }).first().click();
  await page.getByText(/Waiting in fixture hook/).waitFor();
  await page.getByRole("button", { name: "Cancel operation", exact: true }).click();
  await waitForOperation(page, "Commit", "interrupted");
  await page
    .getByRole("dialog", { name: "Could not complete the action", exact: true })
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  assert.equal(git("rev-parse", "HEAD"), beforeCancel);
  assert.equal(git("ls-files", "--stage", "-z"), indexBeforeCancel);
  assert.equal(await draft.inputValue(), "Keep failed draft");

  await mkdir("screenshots", { recursive: true });
  await page.getByRole("button", { name: "Workspace drawer", exact: true }).click();
  await page.getByRole("button", { name: "Unstage file.txt", exact: true }).click();
  await writeFile(join(repository, "scratch.log"), "keep scratch bytes\0\r\n");
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+r`);
  await page.getByRole("button", { name: "Stage scratch.log", exact: true }).waitFor();

  await page.getByRole("button", { name: "Stage file.txt", exact: true }).waitFor();
  assert.equal(await page.getByText("Untracked", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Stage all", exact: true }).count(), 1);
  await page.getByLabel("2 unstaged files", { exact: true }).waitFor();

  const beforeDiscardIndex = git("ls-files", "--stage", "-z");
  const beforeDiscardFile = await readFile(join(repository, "file.txt"));

  await page.getByRole("button", { name: "Stage all", exact: true }).click();
  await page.getByRole("button", { name: "Unstage scratch.log", exact: true }).waitFor();
  await page.getByRole("button", { name: "Unstage file.txt", exact: true }).waitFor();
  assert.equal(git("diff"), "");
  assert.deepEqual(git("diff", "--cached", "--name-only").trim().split("\n"), [
    "file.txt",
    "scratch.log",
  ]);

  await page.getByRole("button", { name: "Unstage all", exact: true }).click();
  await page.getByRole("button", { name: "Stage scratch.log", exact: true }).waitFor();
  await page.getByRole("button", { name: "Stage file.txt", exact: true }).waitFor();
  assert.equal(git("ls-files", "--stage", "-z"), beforeDiscardIndex);

  await page.getByRole("button", { name: "Discard all files", exact: true }).click();

  const discard = page.getByRole("dialog", { name: "Discard working changes" });

  await discard.getByRole("checkbox").check();
  await discard.getByRole("button", { name: "Discard selected files", exact: true }).click();
  await discard.waitFor({ state: "hidden" });
  assert.equal(git("ls-files", "--stage", "-z"), beforeDiscardIndex);
  assert.equal(git("diff"), "");
  await assert.rejects(readFile(join(repository, "scratch.log")));

  await page.getByRole("button", { name: "Recovery", exact: true }).click();
  await page.getByRole("button", { name: "Restore 2 files", exact: true }).click();
  await page.getByRole("dialog", { name: "Recover local files" }).waitFor({ state: "hidden" });
  assert.deepEqual(await readFile(join(repository, "file.txt")), beforeDiscardFile);
  assert.equal(await readFile(join(repository, "scratch.log"), "utf8"), "keep scratch bytes\0\r\n");

  await page.getByRole("button", { name: /^Unstaged file.txt, status/ }).click();
  await page.getByRole("button", { name: "Discard hunk 1", exact: true }).click();

  const partialDiscard = page.getByRole("dialog", { name: "Discard working changes" });

  await partialDiscard.locator("pre").filter({ hasText: "second change" }).waitFor();
  await partialDiscard.getByRole("checkbox").check();
  await partialDiscard.getByRole("button", { name: "Discard selected files", exact: true }).click();
  await partialDiscard.waitFor({ state: "hidden" });
  assert.equal(git("diff", "--", "file.txt"), "");
  assert.equal(git("ls-files", "--stage", "-z"), beforeDiscardIndex);

  await page.getByRole("button", { name: "Recovery", exact: true }).click();
  await page.getByRole("button", { name: "Restore 1 files", exact: true }).click();
  await page.getByRole("dialog", { name: "Recover local files" }).waitFor({ state: "hidden" });
  assert.deepEqual(await readFile(join(repository, "file.txt")), beforeDiscardFile);
  assert.equal(git("ls-files", "--stage", "-z"), beforeDiscardIndex);

  await page.getByText("scratch.log", { exact: true }).first().click();
  await page.getByRole("button", { name: "Ignore...", exact: true }).click();

  const ignore = page.getByRole("dialog", { name: "Ignore rules", exact: true });

  await ignore.locator("pre").filter({ hasText: "/scratch.log" }).waitFor();
  await ignore.getByRole("button", { name: "Add ignore rule", exact: true }).click();
  await ignore.waitFor({ state: "hidden" });
  assert.match(git("check-ignore", "scratch.log"), /scratch.log/);
  assert.equal(await readFile(join(repository, "scratch.log"), "utf8"), "keep scratch bytes\0\r\n");

  await page.screenshot({ path: resolve("screenshots/local-workflow.png") });
  await page.getByRole("button", { name: "Back to history", exact: true }).click();
  git("config", "--unset", "core.hooksPath");
  const graph = page.getByTestId("commit-graph");
  const subject = git("log", "-1", "--format=%s").trim();
  const headRow = graph.getByRole("button").filter({ hasText: subject }).first();
  await headRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Create worktree here..." }).click();
  const worktrees = page.getByRole("dialog", { name: "Worktrees" });
  assert.equal(
    await worktrees.getByLabel("Start new branch at").inputValue(),
    git("rev-parse", "HEAD").trim(),
  );
  await page.keyboard.press("Escape");

  await headRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit commit message" }).click();
  const edit = page.getByRole("dialog", { name: "Edit commit message" });
  const message = edit.getByRole("textbox", { name: "Commit title" });
  await message.waitFor();
  assert.equal(await edit.getByRole("button", { name: "Review current state" }).count(), 0);
  assert.equal((await message.inputValue()).split("\n")[0], subject);
  await message.fill("Reword from history");
  await edit.getByRole("textbox", { name: "Commit description" }).fill("Keep the complete body");
  await edit.getByRole("button", { name: "Save message" }).click();
  await edit.waitFor({ state: "hidden" });
  await graph.getByRole("button", { name: /Reword from history/ }).waitFor();
  assert.equal(
    git("log", "-1", "--format=%B").trimEnd(),
    "Reword from history\n\nKeep the complete body",
  );
  assert.equal(git("ls-files", "--stage", "-z"), beforeDiscardIndex);

  assert.equal(errors.length, 0, errors.join("\n"));

  console.log(
    "Local workflow passed: combined tracked/untracked staging, hunk staging and commit, commit/amend Undo/Redo, templates/sign-off/co-authors, hook failure and running-hook cancellation, preserved index/drafts, redacted activity diagnostics, whole-file and partial discard/recovery, and ignore rules.",
  );
} catch (error) {
  if (errors.length) console.error(errors);

  if (app) {
    await mkdir("screenshots", { recursive: true });
    await app
      .windows()[0]
      ?.screenshot({ path: resolve("screenshots/local-workflow-failure.png") })
      .catch(() => {});
  }

  throw error;
} finally {
  if (app) {
    const timeout = setTimeout(() => app?.process().kill(), 5000);
    await app.close().catch(() => app?.process().kill());
    clearTimeout(timeout);
  }

  assert.ok(resolve(root).startsWith(resolve(tmpdir(), "eda-local-workflow-")));

  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
