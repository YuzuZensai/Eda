import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { trustFixture } from "./helpers/trust.ts";
import { finishOnboarding } from "./helpers/onboarding.ts";
import { assertSmoothResize, sampleResize } from "../helpers/motion.ts";
import assert from "node:assert/strict";
import { expect } from "playwright/test";
import { type ElectronApplication, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tinyPng, pngVersion } from "../fixtures/images.ts";

const workspacePrefix = join(await realpath(tmpdir()), "eda-workspace-gate-");
const root = await mkdtemp(workspacePrefix);
const repository = join(root, "workspace-repo");
const config = join(root, "gitconfig");

await mkdir(repository);

await writeFile(
  config,
  "[user]\nname = Fixture\nemail = fixture@example.com\n[commit]\ngpgsign = false\n",
);

const env = {
  ...fixtureEnvironment(root),
  HOME: root,
  USERPROFILE: root,
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], { env, encoding: "utf8", stdio: "pipe" }).trim();

git("init", "-b", "main");
await writeFile(join(repository, "file.txt"), "initial\n");
await writeFile(join(repository, "preview.png"), pngVersion("original"));
git("add", ".");
git("commit", "-m", "Create repository");

for (let index = 0; index < 40; index++)
  git("commit", "--allow-empty", "-m", `History fixture ${index}`);

git("checkout", "-b", "feature/clear-branch-navigation");
await writeFile(join(repository, "feature.txt"), "feature\n");
git("add", ".");
git("commit", "-m", "Make branch navigation visible");

const feature = git("rev-parse", "HEAD");

git("tag", "-a", "v1.0", "-m", "Annotated release");
const linked = join(root, "linked directory");
git("worktree", "add", "--detach", linked, feature);
git("worktree", "lock", "--reason", "offline drive", linked);
git("update-ref", "refs/remotes/origin/feature/clear-branch-navigation", feature);
git("checkout", "main");
await writeFile(join(repository, "main.txt"), "main\n");

await writeFile(
  join(repository, "large.txt"),
  Array.from({ length: 3_000 }, (_, i) => `preview line ${i}`).join("\n"),
);

for (let index = 0; index < 8; index++) {
  await writeFile(
    join(repository, `a-budget-${index}.txt`),
    Array.from({ length: 1_800 }, (_, line) => `budget ${index} line ${line}`).join("\n"),
  );
}

await writeFile(
  join(repository, "zz-small.txt"),
  Array.from({ length: 38 }, (_, line) => `selected file line ${line}`).join("\n"),
);

await writeFile(join(repository, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
await writeFile(join(repository, "image file.bin"), Buffer.from([0, 1, 2, 255, 0]));
await writeFile(join(repository, "preview.png"), pngVersion("committed"));
git("add", ".");
git("commit", "-m", "Keep working changes beside the commit editor");
git("update-ref", "refs/remotes/origin/main", "HEAD~1");
git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
git("config", "remote.origin.url", repository);
git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
git("branch", "--set-upstream-to=origin/main", "main");
await writeFile(join(repository, "file.txt"), "staged change\n");
git("add", "file.txt");
await writeFile(
  join(repository, "main.txt"),
  "working change " + "on this line ".repeat(70) + "\n",
);
await writeFile(join(repository, "preview.png"), pngVersion("index"));
git("add", "preview.png");
await writeFile(join(repository, "preview.png"), pngVersion("working"));
await writeFile(join(repository, "added.png"), tinyPng);
await copyFile(resolve("tests/fixtures/backgrounds/sakura.jpg"), join(repository, "photo.jpg"));

const before = {
  head: git("rev-parse", "HEAD"),
  status: git("status", "--porcelain=v1"),
  index: git("write-tree"),
};

let app: ElectronApplication | undefined;
const errors: string[] = [];

const launch = async () => {
  app = await electron.launch({ args: ["dist/main/index.js", `--user-data-dir=${root}`], env });
  await trustFixture(app, root);
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
};

try {
  let page = await launch();

  assert.ok(app);

  if (process.platform === "darwin") {
    assert.equal(await page.locator(".window-controls").count(), 0);
    assert.ok(
      await page.locator(".window-titlebar").evaluate((element) => {
        return parseFloat(getComputedStyle(element).paddingLeft) >= 70;
      }),
      "The macOS title bar reserves space for native traffic lights.",
    );

    let previousCaptionSize = 0;

    for (const zoom of [75, 100, 200]) {
      const changed = await page.evaluate(
        (zoom) => window.eda.settings.set("uiZoom", { kind: "application" }, zoom),
        zoom,
      );
      assert.equal(changed.ok, true);
      await page.waitForFunction(
        (zoom) =>
          Number(document.documentElement.style.getPropertyValue("--window-zoom")) === zoom / 100,
        zoom,
      );

      const position: Electron.Point | null = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getWindowButtonPosition(),
      );
      const titlebar = await page.locator(".window-titlebar").boundingBox();
      assert.ok(position && titlebar);
      assert.ok(
        Math.abs((titlebar.height * zoom) / 100 - 44) <= 1,
        `The macOS title bar stays 44 screen pixels high at ${zoom}% zoom.`,
      );
      assert.ok(
        Math.abs(position.y + 7 - (titlebar.height * zoom) / 200) <= 1,
        `Native traffic lights stay vertically centered at ${zoom}% zoom.`,
      );
      const captionSize = await page
        .locator(".window-titlebar > span")
        .first()
        .evaluate(
          (element, zoom) => (parseFloat(getComputedStyle(element).fontSize) * zoom) / 100,
          zoom,
        );
      assert.ok(captionSize > previousCaptionSize, "Title bar text follows interface zoom.");
      previousCaptionSize = captionSize;
      assert.ok(
        await page.locator(".window-titlebar").evaluate((element) => {
          return parseFloat(getComputedStyle(element).paddingRight) >= 20;
        }),
        "The right edge of the macOS title bar has comfortable padding.",
      );
    }

    await page.evaluate(() => window.eda.settings.reset("uiZoom", { kind: "application" }));
  } else {
    await page.getByRole("button", { name: "Maximize window", exact: true }).click();
    await page.getByRole("button", { name: "Restore window", exact: true }).waitFor();

    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized()),
      true,
    );

    await page.getByRole("button", { name: "Restore window", exact: true }).click();
    await page.getByRole("button", { name: "Maximize window", exact: true }).waitFor();
    await page.getByRole("button", { name: "Minimize window", exact: true }).click();

    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()),
      true,
    );

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.restore());
  }
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Work");
  await page.getByRole("textbox", { name: /^Git author name/ }).fill("Eda");
  await page.getByRole("textbox", { name: /^Git email/ }).fill("work@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await finishOnboarding(page);
  await page.getByRole("button", { name: /Active profile: Work/ }).waitFor();

  assert.equal(
    (await page.evaluate((path) => window.eda.repository.open(path), repository)).ok,
    true,
  );

  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+p`);
  await page.getByRole("button", { name: /^workspace-repo / }).click();
  await page.getByRole("button", { name: "Inspect branch main", exact: true }).waitFor();

  if (process.platform === "darwin") {
    let previousAvatarSize = 0;

    for (const zoom of [75, 100, 200]) {
      await page.evaluate(
        (zoom) => window.eda.settings.set("uiZoom", { kind: "application" }, zoom),
        zoom,
      );
      await page.waitForFunction(
        (zoom) =>
          Number(document.documentElement.style.getPropertyValue("--window-zoom")) === zoom / 100,
        zoom,
      );
      const outside = await page.locator(".window-titlebar").evaluate((header) => {
        const bar = header.getBoundingClientRect();
        return Array.from(header.querySelectorAll("button"))
          .filter((button) => {
            const bounds = button.getBoundingClientRect();
            return (
              bounds.height > 0 && (bounds.top < bar.top - 0.5 || bounds.bottom > bar.bottom + 0.5)
            );
          })
          .map((button) => button.getAttribute("aria-label") ?? button.textContent);
      });
      assert.deepEqual(
        outside,
        [],
        `Title bar controls fit inside the fixed bar at ${zoom}% zoom.`,
      );
      const avatar = await page.locator(".window-titlebar .profile-avatar").boundingBox();
      assert.ok(avatar && (avatar.height * zoom) / 100 > previousAvatarSize);
      previousAvatarSize = (avatar.height * zoom) / 100;
    }

    await page.evaluate(() => window.eda.settings.reset("uiZoom", { kind: "application" }));
  }

  assert.equal(
    await page.getByRole("button", { name: /^Inspect branch origin\/HEAD$/ }).count(),
    0,
  );

  const overview = page.getByLabel("Repository overview", { exact: true });

  await overview.getByRole("button", { name: "Worktrees" }).click();
  const worktrees = page.getByRole("dialog", { name: "Worktrees" });
  await expect(worktrees.getByText(linked, { exact: true })).toBeVisible();
  await expect(worktrees.getByText("Locked offline drive", { exact: true })).toBeVisible();
  await expect(
    worktrees.getByText("Detached HEAD " + feature.slice(0, 8), { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  assert.doesNotMatch(await overview.innerText(), /Tracking origin\/main/);

  assert.equal(
    await overview.getByTitle("Commits ahead of the locally known upstream").innerText(),
    "1",
  );

  const graph = page.getByTestId("commit-graph");
  const featureBranch = "feature/clear-branch-navigation";
  const graphNode = (subject: RegExp) =>
    graph.getByRole("button", { name: subject }).locator(":scope > svg > circle:last-child");
  const graphColor = (subject: RegExp) =>
    graphNode(subject).evaluate((node) => getComputedStyle(node).color);
  const mainColor = await graphColor(/Keep working changes beside the commit editor/);
  const featureColor = await graphColor(/Make branch navigation visible/);
  assert.notEqual(mainColor, featureColor, "Divergent branch tips use different graph colors");
  const mainNode = graphNode(/Keep working changes beside the commit editor/);
  const featureNode = graphNode(/Make branch navigation visible/);
  const alternateAccent = await page.addStyleTag({
    content: ":root { --identity-hue: 110 !important; --identity-chroma: 0.03 !important; }",
  });
  await expect(mainNode).not.toHaveCSS("color", mainColor);
  await expect(featureNode).toHaveCSS("color", featureColor);
  await alternateAccent.evaluate((element) => element.parentNode?.removeChild(element));

  const featureEdge = featureNode.locator("..").locator(":scope > path").last();
  await expect(mainNode).toHaveCSS("stroke", mainColor);
  await expect(featureNode).not.toHaveCSS("stroke", featureColor);
  await expect(featureNode).toHaveCSS("opacity", "1");
  await expect(featureNode).toHaveCSS("fill-opacity", "1");
  await expect(featureEdge).not.toHaveCSS("stroke", featureColor);
  await expect(featureEdge).toHaveCSS("opacity", "1");
  await expect(featureEdge).toHaveCSS("stroke-opacity", "1");

  const references = page.getByRole("complementary", { name: "Repository references" });
  const branchRow = (name: string) =>
    references.getByRole("button", { name: `Inspect branch ${name}`, exact: true });
  const branchMarker = (name: string) => branchRow(name).locator("svg");
  await expect(references.getByRole("button", { name: /^Inspect branch / })).toHaveText([
    "main",
    featureBranch,
    "origin/main",
    `origin/${featureBranch}`,
  ]);
  await expect(branchMarker("main")).toHaveCSS("color", mainColor);
  await expect(branchMarker(featureBranch)).toHaveCSS("color", featureColor);
  await expect(branchMarker(`origin/${featureBranch}`)).toHaveCSS("color", featureColor);
  await expect(branchMarker("main")).toHaveCSS("opacity", "1");
  await expect(branchMarker(featureBranch)).toHaveCSS("opacity", "0.7");
  await branchRow(featureBranch).hover();
  await expect(branchMarker(featureBranch)).toHaveCSS("opacity", "1");
  await expect(featureNode).toHaveCSS("stroke", featureColor);
  await expect(featureEdge).toHaveCSS("stroke", featureColor);
  await overview.hover();
  await expect(branchMarker(featureBranch)).toHaveCSS("opacity", "0.7");
  await expect(featureNode).not.toHaveCSS("stroke", featureColor);
  await branchRow(featureBranch).focus();
  await expect(branchMarker(featureBranch)).toHaveCSS("opacity", "1");

  await overview.getByRole("button", { name: "On branch main. Switch or create a branch" }).click();
  const branchSwitcher = page.getByRole("dialog", { name: "Branches", exact: true });
  await branchSwitcher.getByText("Tracking origin/main").waitFor();
  await expect(
    branchSwitcher.getByRole("button", { name: /^(main|feature\/clear-branch-navigation)$/ }),
  ).toHaveText(["main", featureBranch]);
  const switcherMarker = branchSwitcher
    .getByRole("button", { name: featureBranch, exact: true })
    .locator("svg");
  await expect(switcherMarker).toHaveCSS("color", featureColor);
  await expect(switcherMarker).toHaveCSS("opacity", "0.7");
  await branchSwitcher
    .getByRole("textbox", { name: "Find or create a branch", exact: true })
    .press("ArrowDown");
  await expect(switcherMarker).toHaveCSS("opacity", "1");
  await page.keyboard.press("Escape");

  await graph.getByRole("button", { name: "All branches...", exact: true }).click();
  await page.getByRole("menuitem", { name: "Filter and pin references...", exact: true }).click();
  const graphFilter = page.getByRole("dialog", { name: "Graph visibility", exact: true });
  const remoteRef = `refs/remotes/origin/${featureBranch}`;
  await expect(graphFilter.getByRole("checkbox", { name: /^Hide refs\// }).first()).toHaveAttribute(
    "aria-label",
    "Hide refs/heads/main",
  );
  const filterMarker = graphFilter
    .getByTitle(remoteRef, { exact: true })
    .locator("..")
    .locator(":scope > span > svg");
  await expect(filterMarker).toHaveCSS("color", featureColor);
  await expect(filterMarker).toHaveCSS("opacity", "0.7");
  await graphFilter.getByRole("checkbox", { name: `Solo ${remoteRef}`, exact: true }).check();
  const applyGraphView = graphFilter.getByRole("button", { name: "Apply graph view", exact: true });
  await applyGraphView.hover();
  await applyGraphView.focus();
  await expect(filterMarker).toHaveCSS("opacity", "1");
  await applyGraphView.click();
  await expect(branchMarker("main")).toHaveCount(0);
  await expect(branchMarker(`origin/${featureBranch}`)).toHaveCSS(
    "color",
    await graphColor(/Make branch navigation visible/),
  );

  await graph.getByRole("button", { name: "Filtered graph...", exact: true }).click();
  await page.getByRole("menuitem", { name: "Use global default (Branches and tags)" }).click();
  await expect(branchMarker("main")).toHaveCSS("color", mainColor);

  await page.getByRole("button", { name: "Staged file.txt, status M", exact: true }).waitFor();
  await page.getByRole("button", { name: "Unstaged main.txt, status M", exact: true }).waitFor();

  const initialGraph = await graph.boundingBox();

  const mainHeight = await graph.evaluate(
    (element) => element.closest(".panel-split")!.getBoundingClientRect().height,
  );

  assert.ok(
    initialGraph && Math.abs(initialGraph.height - mainHeight) <= 1,
    "History fills the main area",
  );

  await graph.getByRole("button", { name: "Contributors", exact: true }).click();
  const contributors = page.getByRole("dialog", { name: "Contributors", exact: true });
  await expect(contributors.getByText("1 contributor", { exact: true })).toBeVisible();
  await expect(contributors.getByText("fixture@example.com", { exact: true })).toBeVisible();
  await expect(contributors.getByText("43 commits", { exact: true })).toBeVisible();
  assert.equal(
    await contributors
      .getByRole("region", { name: "Contributors", exact: true })
      .evaluate((element) => element.scrollHeight <= element.clientHeight),
    true,
    "A short contributor list fits without a scrollbar",
  );
  const contributorSort = contributors.getByRole("combobox", { name: "Sort contributors by" });
  await expect(contributorSort).toHaveText("Commits");
  await contributorSort.click();
  await page.getByRole("option", { name: "Name", exact: true }).click();
  await expect(contributorSort).toHaveText("Name");
  await contributors.getByRole("button", { name: "Sort descending", exact: true }).click();
  await expect(
    contributors.getByRole("button", { name: "Sort ascending", exact: true }),
  ).toBeVisible();
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: resolve("screenshots/contributors.png") });
  await contributors.getByRole("searchbox", { name: "Search name or email" }).fill("missing");
  await expect(contributors.getByText("No matching contributors", { exact: true })).toBeVisible();
  await contributors.getByRole("searchbox", { name: "Search name or email" }).fill("FIXTURE");
  await expect(contributors.getByText("fixture@example.com", { exact: true })).toBeVisible();
  await contributors.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("textbox", { name: "Commit title" }).fill("Preserve this draft");
  assert.equal(await page.getByRole("heading", { name: "Diff viewer", exact: true }).count(), 0);

  const commitFiles = page.getByRole("region", { name: "Commit file changes", exact: true });

  await page.getByRole("button", { name: "Inspect tag v1.0", exact: true }).click();
  await commitFiles.getByTitle(feature, { exact: true }).waitFor();

  const filter = page.getByLabel("Filter branches and tags", { exact: true });

  await filter.fill("clear-branch");
  assert.equal(await page.getByRole("button", { name: /^Inspect branch / }).count(), 2);

  await filter.fill("");
  await branchRow(featureBranch).click();
  await filter.hover();
  await filter.focus();
  await expect(branchRow(featureBranch)).toHaveAttribute("aria-pressed", "true");
  await expect(branchMarker(featureBranch)).toHaveCSS("opacity", "1");
  await expect(featureNode).toHaveCSS("stroke", featureColor);
  await page.getByRole("button", { name: "Inspect branch main", exact: true }).click();

  await commitFiles.waitFor();
  assert.equal(await graph.isVisible(), true, "Selecting a commit keeps history visible");
  assert.equal(await page.getByRole("textbox", { name: "Commit title" }).count(), 0);

  await graph
    .getByRole("button", { name: /Make branch navigation visible/ })
    .click({ button: "right" });
  const inspectRange = page.getByRole("menuitem", { name: "Inspect range from selected commit" });
  await expect(inspectRange.locator('svg[aria-hidden="true"]')).toBeVisible();
  await inspectRange.click();
  const range = page.getByRole("dialog", { name: /^Inspect \d+ commits$/ });
  await expect(range.getByText("Make branch navigation visible", { exact: false })).toBeVisible();
  await expect(
    range.getByText("Keep working changes beside the commit editor", { exact: false }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await graph
    .getByRole("button", { name: /Make branch navigation visible/ })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Compare with selected commit", exact: true }).click();

  const comparison = page.getByRole("region", { name: "Compare revisions", exact: true });
  const comparedMain = comparison.getByRole("button", {
    name: "View comparison for main.txt",
    exact: true,
  });
  const comparedFeature = comparison.getByRole("button", {
    name: "View comparison for feature.txt",
    exact: true,
  });
  await expect(comparison.getByLabel("From revision", { exact: true })).toHaveValue(before.head);
  await expect(comparison.getByLabel("To revision", { exact: true })).toHaveValue(feature);
  await comparedMain.click();
  await expect(comparison.locator("[data-diff-text]").filter({ hasText: /^main$/ })).toBeVisible();
  await expect(comparedFeature).toBeVisible();

  await comparison.getByRole("button", { name: "From merge base", exact: true }).click();
  await expect(
    comparison.getByRole("heading", { name: "1 changed file", exact: true }),
  ).toBeVisible();
  await expect(comparedMain).toHaveCount(0);
  await expect(comparedFeature).toBeVisible();
  await expect(
    comparison.locator("[data-diff-text]").filter({ hasText: /^feature$/ }),
  ).toBeVisible();

  await comparison.getByRole("button", { name: "Back to history", exact: true }).click();
  await expect(
    graph.getByRole("button", { name: /Keep working changes beside the commit editor/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(commitFiles.getByTitle(before.head, { exact: true })).toBeVisible();

  await expect(commitFiles.getByRole("button", { name: "Browse all files" })).toHaveCount(0);
  await expect(commitFiles.getByRole("button", { name: "Export commit patch" })).toHaveCount(0);
  await graph
    .getByRole("button", { name: /Make branch navigation visible/ })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Browse all files", exact: true }).click();
  const browser = page.getByRole("region", { name: "Commit snapshot", exact: true });
  await expect(browser.getByTitle(feature, { exact: true })).toBeVisible();
  await browser.getByRole("button", { name: "file.txt", exact: true }).click();
  await expect(browser.getByRole("region", { name: "file.txt", exact: true })).toHaveText(
    "initial",
  );
  await browser.getByRole("button", { name: "Line blame" }).click();
  await expect(browser.getByText("initial", { exact: true })).toBeVisible();
  await browser.getByRole("button", { name: "Back to history" }).click();
  await graph.getByRole("button", { name: "Search commit history" }).click();
  const search = page.getByRole("dialog", { name: "Search commit history" });
  await search.getByRole("textbox", { name: "Commit message" }).fill("History fixture 3");
  await search.getByRole("button", { name: "Search", exact: true }).click();
  await search.getByText("History fixture 3", { exact: true }).click();
  await expect(
    graph
      .getByRole("button", { name: /History fixture 3,|History fixture 3 ·|History fixture 3\./ })
      .first(),
  ).toHaveAttribute("aria-pressed", "true");
  await graph.getByRole("button", { name: "Back in selection history" }).click();
  await expect(
    graph.getByRole("button", { name: /Keep working changes beside the commit editor/ }),
  ).toHaveAttribute("aria-pressed", "true");

  const detailsToggle = commitFiles.getByRole("button", { name: "Commit details", exact: true });
  const detailsId = await detailsToggle.getAttribute("aria-controls");
  assert.ok(detailsId);

  const details = commitFiles.locator(`[id="${detailsId}"]`);
  assertSmoothResize(await sampleResize(details, () => detailsToggle.click()));
  assert.equal(await details.getAttribute("aria-hidden"), "false");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedDetails = await sampleResize(details, () => detailsToggle.click());

  assert.ok(
    new Set(reducedDetails.map(Math.round)).size <= 2,
    "Reduced motion should collapse commit details immediately.",
  );

  assert.equal(await details.getAttribute("aria-hidden"), "true");
  assert.equal(await details.getAttribute("inert"), "");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const graphList = graph.locator("[data-virtual-list]");

  await graphList.evaluate((element) => {
    element.scrollTop = 120;
  });

  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="commit-graph"] [data-virtual-list]')?.scrollTop === 120,
  );

  await overview.getByRole("button", { name: "Refresh repository", exact: true }).click();
  await overview.getByRole("status").filter({ hasText: "Refresh repository: completed" }).waitFor();
  assert.equal(
    await graphList.evaluate((element) => element.scrollTop),
    120,
    "Refreshing history preserves graph scroll",
  );

  await page
    .getByRole("button", { name: "View commit diff for image file.bin", exact: true })
    .click();

  await page.getByText("Binary file changed: no text preview.", { exact: true }).waitFor();
  await page.getByRole("region", { name: "Binary file details" }).getByText("5 bytes").waitFor();
  assert.equal(await graph.isVisible(), false, "Selecting a file replaces history with its diff");

  await page.getByRole("button", { name: "Back to history", exact: true }).click();
  assert.equal(await graph.isVisible(), true);

  assert.equal(
    await graphList.evaluate((element) => element.scrollTop),
    120,
    "Returning from a file retains graph scroll",
  );

  await page.getByRole("button", { name: "View commit diff for preview.png", exact: true }).click();

  await verifyImages(page, [
    ["Parent", "original"],
    ["Commit", "committed"],
  ]);

  const imageVersions = page.getByRole("group", { name: "Image versions", exact: true });
  await imageVersions.getByRole("button", { name: "Commit", exact: true }).click();
  assert.equal(await page.getByRole("img", { name: /^Parent image:/ }).count(), 0);
  await page.getByRole("button", { name: "Actual size", exact: true }).click();
  await page.getByRole("button", { name: "Fit image", exact: true }).click();
  await imageVersions.getByRole("button", { name: "Compare", exact: true }).click();
  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: resolve("screenshots/image-preview-commit.png") });

  await page
    .getByRole("button", { name: "View commit diff for zz-small.txt", exact: true })
    .click();

  await page.getByText("selected file line 0", { exact: true }).waitFor();
  await page.getByText("selected file line 37", { exact: true }).waitFor();

  const selectedLine = await page
    .getByText("selected file line 0", { exact: true })
    .elementHandle();
  assert.ok(selectedLine);
  const commitFileFilter = commitFiles.getByLabel("Filter commit files", { exact: true });
  await commitFileFilter.fill("zz-small");
  const graphScrollBeforeRefresh = await graphList.evaluate((element) => element.scrollTop);
  await overview.getByRole("button", { name: "Refresh repository", exact: true }).click();
  await overview.getByRole("status").filter({ hasText: "Refresh repository: completed" }).waitFor();

  assert.equal(
    await selectedLine.evaluate((element) => element.isConnected),
    true,
    "Refreshing keeps the selected diff mounted",
  );
  assert.equal(await commitFileFilter.inputValue(), "zz-small", "Refresh preserves file filters");
  assert.equal(
    await graphList.evaluate((element) => element.scrollTop),
    graphScrollBeforeRefresh,
    "Refresh preserves graph scroll",
  );
  await commitFileFilter.fill("");

  assert.equal(
    await page
      .getByText(
        "Preview truncated to keep the viewer responsive. Some lines or text are omitted.",
        { exact: true },
      )
      .count(),
    0,
    "A small selected file has its own preview budget",
  );

  await page
    .getByRole("button", { name: "View commit diff for pnpm-lock.yaml", exact: true })
    .click();

  await page.getByRole("button", { name: "Expand diff for pnpm-lock.yaml", exact: true }).waitFor();
  await page.getByRole("button", { name: "View commit diff for large.txt", exact: true }).click();

  const largeDiff = page.getByRole("button", { name: "Expand diff for large.txt", exact: true });
  await largeDiff.waitFor();

  const diffBounds = await page
    .getByRole("button", { name: "Back to history", exact: true })
    .evaluate((element) => element.closest("section")!.getBoundingClientRect().toJSON());

  assert.ok(diffBounds.height >= initialGraph.height, "Diff fills the history area");

  assert.equal(
    await page.getByRole("button", { name: "Expand diff for pnpm-lock.yaml", exact: true }).count(),
    0,
    "Only the selected file is displayed",
  );

  assert.equal(
    await page.getByRole("button", { name: /Expand diff for image file.bin/ }).count(),
    0,
  );

  assert.equal(await page.getByText("preview line 0", { exact: true }).count(), 0);

  await mkdir("screenshots", { recursive: true });
  await page.screenshot({ path: resolve("screenshots/diff-collapsed.png") });

  const findInDiff = page.getByRole("searchbox", { name: "Find in diff" });
  await findInDiff.fill("PREVIEW LINE 1500");
  await page.getByRole("button", { name: "Next match" }).click();
  const match = page
    .locator("[data-diff-text]")
    .filter({ has: page.locator("mark[data-active-search-match]") });
  await expect(match).toHaveText("preview line 1500");
  await findInDiff.fill("");
  await page.getByLabel("Unified diff", { exact: true }).evaluate((list) => {
    list.scrollTop = 0;
  });

  await page
    .getByText("Preview truncated to keep the viewer responsive. Some lines or text are omitted.", {
      exact: true,
    })
    .waitFor();

  await page.getByText("preview line 0", { exact: true }).waitFor();

  const diffList = page
    .locator("[data-virtual-list]")
    .filter({ has: page.locator("[data-diff-text]") });

  await diffList.evaluate((element) => {
    element.scrollTop = 440;
  });

  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll("[data-virtual-list]")).some(
      (element) => element.scrollTop === 440,
    ),
  );

  const scrollBeforeFocus = await diffList.evaluate((element) => element.scrollTop);

  await page.getByRole("button", { name: "Maximize diff viewer", exact: true }).click();
  await page.getByRole("button", { name: "Restore diff viewer", exact: true }).click();
  assert.equal(await diffList.evaluate((element) => element.scrollTop), scrollBeforeFocus);

  await diffList.evaluate((element) => {
    element.scrollTop = 0;
  });

  await verifyCopy(page);
  await page.getByRole("button", { name: "Side by side", exact: true }).click();
  await page.locator("[data-virtual-list] .grid-cols-2").first().waitFor();
  await verifyCopy(page);
  await page.getByRole("button", { name: "Collapse diff for large.txt", exact: true }).waitFor();

  assert.equal(
    await page.getByRole("button", { name: "Collapse diff for large.txt", exact: true }).count(),
    1,
  );

  await page.getByRole("button", { name: "Collapse diff for large.txt", exact: true }).click();
  await largeDiff.waitFor();
  assert.equal(await page.getByText("preview line 0", { exact: true }).count(), 0);

  await page.getByRole("button", { name: "Unified", exact: true }).click();
  await commitFiles.getByRole("button", { name: "View changes", exact: true }).click();
  await page.getByRole("button", { name: "Staged preview.png, status M", exact: true }).click();

  await verifyImages(page, [
    ["HEAD", "committed"],
    ["Index", "index"],
  ]);

  await page.getByRole("button", { name: "Unstaged preview.png, status M", exact: true }).click();

  await verifyImages(page, [
    ["Index", "index"],
    ["Working tree", "working"],
  ]);

  await page.getByRole("button", { name: "Untracked added.png, status ?", exact: true }).click();
  const added = page.getByRole("img", { name: "Working tree image: added.png", exact: true });
  await added.waitFor();

  await page.waitForFunction(
    () =>
      document.querySelector<HTMLImageElement>('img[alt="Working tree image: added.png"]')
        ?.naturalWidth === 1,
  );

  assert.equal(
    await added.getAttribute("src"),
    `data:image/png;base64,${tinyPng.toString("base64")}`,
  );

  await page
    .getByRole("group", { name: "Image versions", exact: true })
    .getByRole("button", { name: "Index", exact: true })
    .click();

  await page.getByText("File not present", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Untracked photo.jpg, status ?", exact: true }).click();
  const photo = page.getByRole("img", { name: "Working tree image: photo.jpg", exact: true });
  await photo.waitFor();

  await page.waitForFunction(
    () =>
      (document.querySelector<HTMLImageElement>('img[alt="Working tree image: photo.jpg"]')
        ?.naturalWidth ?? 0) > 1,
  );

  assert.match((await photo.getAttribute("src")) ?? "", /^data:image\/jpeg;base64,/);
  await page.screenshot({ path: resolve("screenshots/image-preview-working.png") });
  const stableDiff = await page
    .getByRole("button", { name: "Unstaged main.txt, status M", exact: true })
    .evaluate(async (button) => {
      const panel = document.querySelector('[data-tour="diff"]')!;
      const header = panel.querySelector("header")!;
      const photo = panel.querySelector<HTMLImageElement>(
        'img[alt="Working tree image: photo.jpg"]',
      )!;
      const started = performance.now();
      (button as HTMLButtonElement).click();

      while (performance.now() - started < 5000) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!header.isConnected || !header.checkVisibility({ checkOpacity: true })) return false;
        const text = panel.querySelector("[data-virtual-list]");
        if (text?.textContent?.includes("working change") && text.checkVisibility()) {
          return header.querySelector("h3")?.textContent === "main.txt";
        }
        if (
          !photo.checkVisibility() ||
          !photo.naturalWidth ||
          !header.textContent?.includes("photo.jpg")
        )
          return false;
      }
      return false;
    });
  assert.ok(
    stableDiff,
    "Every frame keeps the previous preview or shows the newly selected file with its header",
  );

  await page.getByTitle("Working tree: main.txt", { exact: true }).waitFor();

  assert.equal(
    await page.getByRole("textbox", { name: "Commit title" }).inputValue(),
    "Preserve this draft",
  );

  const patchPath = join(root, "working.patch");
  await app.evaluate(({ dialog }, filePath) => {
    const previous = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => {
      dialog.showSaveDialog = previous;
      return { canceled: false, filePath };
    };
  }, patchPath);
  await page.getByRole("button", { name: "Export file patch" }).click();
  await expect.poll(() => readFile(patchPath, "utf8").catch(() => "")).toContain("working change");
  git("apply", "--check", "--reverse", patchPath);
  const wrap = page.getByRole("checkbox", { name: "Wrap long lines" });
  await wrap.check();
  const longLine = page
    .locator("[data-row-index] [data-diff-text]")
    .filter({ hasText: "working change" });
  await expect.poll(async () => (await longLine.boundingBox())?.height ?? 0).toBeGreaterThan(24);
  await wrap.uncheck();
  const whitespace = page.getByRole("checkbox", { name: "Ignore whitespace" });
  await whitespace.check();
  await expect(
    page.getByText("Choose Hunks and show whitespace to stage individual changes."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Stage hunk 1", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stage file", exact: true })).toBeVisible();
  await whitespace.uncheck();
  await expect(page.getByRole("button", { name: "Stage hunk 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stage file", exact: true }).click();
  await page.getByRole("button", { name: "Staged main.txt, status M", exact: true }).click();
  assert.equal(
    git("show", ":main.txt"),
    (await readFile(join(repository, "main.txt"), "utf8")).trim(),
  );
  await page.getByRole("button", { name: "Unstage file", exact: true }).click();
  await page.getByRole("button", { name: "Unstaged main.txt, status M", exact: true }).click();
  assert.equal(git("show", ":main.txt"), git("show", "HEAD:main.txt"));

  const divider = page.getByRole("separator", { name: "Resize the working tree panel" });
  const oldSize = Number(await divider.getAttribute("aria-valuenow"));

  await divider.focus();

  await page.keyboard.press(
    (await divider.getAttribute("aria-orientation")) === "vertical" ? "ArrowRight" : "ArrowDown",
  );

  assert.ok(Number(await divider.getAttribute("aria-valuenow")) > oldSize);

  await expect(page.getByRole("button", { name: "Show branches and tags" })).toBeVisible();
  const referencesDivider = () =>
    page.getByRole("separator", { name: "Resize the references sidebar", exact: true });
  const referenceWidth = () =>
    page.getByRole("complementary", { name: "Repository references" }).evaluate((element) => {
      return element.getBoundingClientRect().width;
    });

  await expect(referencesDivider()).toHaveCount(0);
  await page.getByRole("button", { name: "Back to history", exact: true }).click();

  const branchName = page
    .getByRole("button", { name: "Inspect branch origin/feature/clear-branch-navigation" })
    .getByText("origin/feature/clear-branch-navigation", { exact: true });
  const branchNameFits = () =>
    branchName.evaluate((element) => element.scrollWidth <= element.clientWidth);

  assert.equal(await branchNameFits(), false, "The long remote branch starts truncated");
  const originalWidth = await referenceWidth();
  const handle = await referencesDivider().boundingBox();
  assert.ok(handle);
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 220, y, { steps: 8 });
  await expect.poll(branchNameFits).toBe(true);
  const draggedWidth = await referenceWidth();
  assert.ok(draggedWidth > originalWidth);
  await page.mouse.up();

  await referencesDivider().press("ArrowRight");
  const savedWidth = await referenceWidth();
  assert.ok(savedWidth > draggedWidth, "The keyboard can also widen the references sidebar");

  await page.locator("summary").filter({ hasText: "Remote branches" }).click();
  await page.getByRole("button", { name: "Hide branches and tags", exact: true }).click();
  await page.getByRole("button", { name: "Show branches and tags", exact: true }).waitFor();
  await expect(referencesDivider()).toHaveCount(0);

  if (process.platform === "darwin") {
    const closed = page.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await closed;
    await app.close();
  } else {
    const closed = app.waitForEvent("close");
    await page.getByRole("button", { name: "Close window", exact: true }).click();
    await closed;
  }
  page = await launch();
  await page.getByRole("button", { name: "Show branches and tags", exact: true }).waitFor();

  assert.equal(
    await page.getByRole("textbox", { name: "Commit title" }).inputValue(),
    "Preserve this draft",
  );

  await page.getByTitle("Working tree: main.txt", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Back to history", exact: true }).click();
  await page.getByRole("button", { name: "Show branches and tags", exact: true }).click();

  await page.waitForFunction(
    () =>
      document.querySelector('.reference-sidebar[data-collapsed="false"]') !== null &&
      document.documentElement.dataset["navigationMotion"] === undefined,
  );

  await expect.poll(async () => Math.abs((await referenceWidth()) - savedWidth)).toBeLessThan(1);

  assert.equal(
    await page
      .locator("summary")
      .filter({ hasText: "Remote branches" })
      .evaluate((element) => String(element.closest("details")?.open)),
    "false",
  );

  await page.locator("summary").filter({ hasText: "Remote branches" }).click();

  await page.getByRole("button", { name: "Unstaged main.txt, status M", exact: true }).click();

  for (const width of [1440, 940]) {
    await page.setViewportSize({ width, height: 850 });

    if (width === 940) {
      await page.waitForFunction(() => {
        const sidebar = document.querySelector('.reference-sidebar[data-collapsed="true"]');
        return sidebar !== null && sidebar.getBoundingClientRect().width <= 48;
      });
    }

    const references = await page
      .getByRole("complementary", { name: "Repository references" })
      .boundingBox();

    const history = await page
      .getByRole("button", { name: "Back to history", exact: true })
      .evaluate((element) => element.closest("section")!.getBoundingClientRect().toJSON());

    const draft = await page.getByRole("textbox", { name: "Commit title" }).boundingBox();

    assert.ok(references && history && draft);
    assert.ok(references.x + references.width <= history.x + 1);
    assert.ok(history.x + history.width <= draft.x + 1);
    assert.ok(draft.x + draft.width <= width);

    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );

    await mkdir("screenshots", { recursive: true });
    await page.screenshot({ path: resolve(`screenshots/workspace-${width}.png`) });

    if (width === 940) {
      await page.getByRole("button", { name: "Show branches and tags", exact: true }).click();

      const drawer = page.getByRole("dialog", { name: "Branches and tags", exact: true });
      const drawerReferences = drawer.getByRole("complementary", { name: "Repository references" });

      await drawerReferences.waitFor();

      assert.ok(
        (await drawerReferences.boundingBox())!.width > (await drawer.boundingBox())!.width / 2,
        "Expanded references should use the drawer width on small windows",
      );

      await drawer
        .getByRole("button", { name: "Inspect tag v1.0", exact: true })
        .click({ button: "right" });

      await page.getByRole("menu", { name: "Tag actions", exact: true }).waitFor();
      await page.keyboard.press("Escape");

      await page
        .getByRole("menu", { name: "Tag actions", exact: true })
        .waitFor({ state: "hidden" });

      assert.equal(await drawer.isVisible(), true);

      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Maximize diff viewer", exact: true }).click();
      await page.getByRole("button", { name: "Commit draft...", exact: true }).click();

      const commitDrawer = page.getByRole("dialog", { name: "Commit draft", exact: true });

      assert.equal(
        await commitDrawer.getByRole("textbox", { name: "Commit title" }).inputValue(),
        "Preserve this draft",
      );

      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Restore diff viewer", exact: true }).click();
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  const openWorktrees = page.getByRole("button", { name: "Worktrees", exact: true });
  const linkedDialog = page.getByRole("dialog", { name: "Worktrees", exact: true });
  const terminalReady = join(root, "terminal-ready");
  const terminalContinue = join(root, "terminal-continue");
  const terminalResult = join(root, "terminal-result");
  if (process.platform !== "win32") {
    const program = join(root, "terminal-fixture.cjs");
    await writeFile(
      program,
      [
        "#!" + process.execPath,
        'const fs = require("node:fs");',
        "fs.writeFileSync(" + JSON.stringify(terminalReady) + ",process.cwd());",
        "const interval = setInterval(() => {",
        " if (fs.existsSync(" + JSON.stringify(terminalContinue) + ")) {",
        "  fs.writeFileSync(" +
          JSON.stringify(terminalResult) +
          ",process.cwd()); clearInterval(interval);",
        " }",
        "}, 50);",
        "setTimeout(() => clearInterval(interval),15000).unref();",
      ].join("\n"),
      { mode: 0o700 },
    );
    const configured = await page.evaluate(
      (path) => window.eda.settings.set("terminalExecutable", { kind: "application" }, path),
      program,
    );
    assert.ok(configured.ok, JSON.stringify(configured));
  }
  await writeFile(join(linked, "separate-worktree.txt"), "local change");
  await openWorktrees.click();
  if (process.platform !== "win32") {
    await linkedDialog
      .getByRole("listitem")
      .filter({ has: page.getByText(linked, { exact: true }) })
      .getByRole("button", { name: "External terminal" })
      .click();
    await expect.poll(() => readFile(terminalReady, "utf8").catch(() => "")).toBe(linked);
  }
  await linkedDialog
    .getByRole("listitem")
    .filter({ has: page.getByText(linked, { exact: true }) })
    .getByRole("button", { name: "Open in another tab" })
    .click();
  await expect(page.getByRole("heading", { name: "linked directory", exact: true })).toBeVisible();
  const linkedDraft = page.getByRole("textbox", { name: "Commit title", exact: true });
  await expect(linkedDraft).toHaveValue("");
  if (process.platform !== "win32") {
    await writeFile(terminalContinue, "continue");
    await expect.poll(() => readFile(terminalResult, "utf8").catch(() => "")).toBe(linked);
  }
  await linkedDraft.fill("Draft in linked worktree");
  await openWorktrees.click();
  await linkedDialog
    .getByRole("listitem")
    .filter({ has: page.getByText(repository, { exact: true }) })
    .getByRole("button", { name: "Open in this tab" })
    .click();
  await expect(page.getByRole("heading", { name: "workspace-repo", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Commit title", exact: true })).toHaveValue(
    "Preserve this draft",
  );
  await page.getByRole("button", { name: "Back to history", exact: true }).click();
  await page
    .getByRole("list", { name: "Linked worktree changes" })
    .getByRole("button", { name: /Changed files \(1\)/ })
    .click();
  await expect(linkedDraft).toHaveValue("Draft in linked worktree");

  assert.equal(git("symbolic-ref", "--short", "HEAD"), "main");

  assert.deepEqual(
    {
      head: git("rev-parse", "HEAD"),
      status: git("status", "--porcelain=v1"),
      index: git("write-tree"),
    },
    before,
  );

  assert.equal(errors.length, 0, errors.join("\n"));

  console.log(
    "Workspace gate passed: inspection without Git mutations, status and references, bounded large/generated/binary diffs, clean clipboard text in both diff modes, focus scroll restoration, keyboard dividers, nested drawers, saved drafts/layout and wide/compact bounds.",
  );
} catch (error) {
  if (app) {
    await mkdir("screenshots", { recursive: true });

    await app
      .windows()[0]
      ?.screenshot({ path: resolve("screenshots/workspace-gate-failure.png") })
      .catch(() => {});
  }

  throw error;
} finally {
  if (app) await app.close().catch(() => app?.process().kill());
  assert.ok(root.startsWith(workspacePrefix));
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

async function verifyCopy(page: Page) {
  assert.ok(app);

  const line = page.locator("[data-diff-text]").filter({ hasText: "preview line 0" }).first();

  await line.waitFor();

  const expected = await line.textContent();

  assert.ok(expected);

  await line.evaluate((element) => {
    const row = element.parentElement;
    const range = document.createRange();

    if (!row) throw new Error("Expected a diff row");

    range.selectNodeContents(row);

    const selection = window.getSelection();

    if (!selection) throw new Error("Selection is unavailable");

    selection.removeAllRanges();
    selection.addRange(range);
  });

  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+c`);

  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());

  assert.equal(copied.trim(), expected.trim(), "Diff copying must exclude line-number gutters");

  await page.evaluate(() => window.getSelection()?.removeAllRanges());
}

async function verifyImages(page: Page, versions: [string, string][]) {
  for (const [label, tag] of versions) {
    const image = page.getByRole("img", { name: `${label} image: preview.png`, exact: true });
    await image.waitFor();

    await page.waitForFunction(
      (alt) =>
        Array.from(document.images).some(
          (image) => image.alt === alt && image.complete && image.naturalWidth === 1,
        ),
      `${label} image: preview.png`,
    );

    assert.equal(
      await image.getAttribute("src"),
      `data:image/png;base64,${pngVersion(tag).toString("base64")}`,
    );
  }
}
