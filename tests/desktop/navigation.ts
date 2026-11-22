import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { trustFixture } from "./helpers/trust.ts";
import { finishOnboarding } from "./helpers/onboarding.ts";
import assert from "node:assert/strict";
import { type ElectronApplication } from "playwright";
import { expect } from "playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCompositorMotion } from "../helpers/motion.ts";

type Probe = {
  motion?: string | undefined;
  ready?: number;
  finished?: number;
  duration?: number;
  paneOpacity?: string;
  paneAnimation?: string;
  error?: string;
};

type EntryProbe = { motion: string; duration: number; finished: boolean };

declare global {
  interface Window {
    __navigationProbes: Probe[];
    __navigationWatchChanges: number;
    __navigationEntries: EntryProbe[];
  }
}

const root = await mkdtemp(join(tmpdir(), "eda-navigation-gate-"));
const config = join(root, "gitconfig");
const fixtureEnv = fixtureEnvironment(root);

await writeFile(config, "[user]\nname = Fixture\nemail = fixture@example.com\n");

let app: ElectronApplication | undefined;

try {
  app = await electron.launch({
    args: ["dist/main/index.js", "--no-sandbox", `--user-data-dir=${root}`],
    env: {
      ...fixtureEnvironment(root),
      HOME: root,
      USERPROFILE: root,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      ...(process.env["EDA_DEV_SERVER_URL"]
        ? { VITE_DEV_SERVER_URL: process.env["EDA_DEV_SERVER_URL"] }
        : {}),
    },
  });

  await trustFixture(app, root);
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(20000);
  await page.getByRole("button", { name: "Get started", exact: true }).waitFor();
  await assertCompositorMotion(page);
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await page.getByRole("textbox", { name: /^Profile name/ }).fill("Navigation fixture");
  await page.getByRole("textbox", { name: /^Git author name/ }).fill("Fixture");
  await page.getByRole("textbox", { name: /^Git email/ }).fill("fixture@example.com");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await finishOnboarding(page);
  await page.getByRole("button", { name: /Active profile: Navigation fixture/ }).waitFor();
  await page.evaluate(() => {
    window.__navigationEntries = [];
    document.addEventListener("animationstart", (event) => {
      const target = event.target;

      if (!(target instanceof HTMLElement) || event.animationName !== "ui-navigation-in") return;

      const motion = target.dataset["navigationFallback"];

      if (!motion) return;

      const probe = {
        motion,
        duration: parseFloat(getComputedStyle(target).animationDuration) * 1000,
        finished: false,
      };

      window.__navigationEntries.push(probe);
      void Promise.allSettled(target.getAnimations().map((animation) => animation.finished)).then(
        () => {
          probe.finished = true;
        },
      );
    });
  });

  const entrySettled = async (index: number, motion: string) => {
    await page.waitForFunction((index) => window.__navigationEntries[index]?.finished, index);

    const entries = await page.evaluate((index) => window.__navigationEntries.slice(index), index);

    assert.equal(entries.length, 1, "One view change should animate once.");
    assert.equal(entries[0]?.motion, motion);
    assert.ok(entries[0].duration > 100);
  };
  const expectEntry = async (action: () => Promise<unknown>, motion: string) => {
    const before = await page.evaluate(() => window.__navigationEntries.length);

    await action();
    await entrySettled(before, motion);
  };

  const repositoryPath = join(root, "navigation-repository");

  await mkdir(repositoryPath);
  execFileSync("git", ["init", "-b", "main", repositoryPath], { env: fixtureEnv, stdio: "pipe" });
  await writeFile(join(repositoryPath, "file.txt"), "initial\n");
  execFileSync("git", ["-C", repositoryPath, "add", "."], { env: fixtureEnv, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-C",
      repositoryPath,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Navigation fixture",
    ],
    { env: fixtureEnv, stdio: "pipe" },
  );
  execFileSync(
    "git",
    [
      "-C",
      repositoryPath,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "tag",
      "--no-sign",
      "-a",
      "-m",
      "Navigation release annotation",
      "navigation-release",
    ],
    { env: fixtureEnv, stdio: "pipe" },
  );
  await writeFile(join(repositoryPath, "file.txt"), "working change\n");

  const repositoryId = await page.evaluate(async (path) => {
    const opened = await window.eda.repository.open(path);
    if (!opened.ok) throw new Error(opened.error.message);
    return opened.value.id;
  }, repositoryPath);

  await expectEntry(
    () => page.getByRole("button", { name: "Open navigation-repository", exact: true }).click(),
    "section",
  );
  await page.getByRole("searchbox", { name: "Filter changed files", exact: true }).waitFor();
  await expectEntry(
    () => page.getByRole("button", { name: "Unstaged file.txt, status M", exact: true }).click(),
    "forward",
  );
  await expectEntry(
    () => page.getByRole("button", { name: "Back to history", exact: true }).click(),
    "back",
  );
  await expectEntry(
    () => page.getByRole("button", { name: "Inspect branch main", exact: true }).click(),
    "section",
  );
  const workingChanges = page.getByRole("button", {
    name: "View working changes: 1 file change in working tree",
    exact: true,
  });
  const workingBounds = await page.locator('[data-tour="history-working-tree"]').boundingBox();
  const headBounds = await page.locator('[data-tour="history-commit"]').first().boundingBox();
  assert.ok(workingBounds && headBounds);
  assert.equal(workingBounds.height, headBounds.height);
  assert.equal(workingBounds.y + workingBounds.height, headBounds.y);
  await expectEntry(() => workingChanges.click(), "section");
  await expect(workingChanges).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("searchbox", { name: "Filter changed files", exact: true }).waitFor();
  await expectEntry(
    () => page.getByRole("button", { name: "Close navigation-repository", exact: true }).click(),
    "section",
  );
  await expectEntry(
    () => page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+t`),
    "section",
  );

  const backgroundBytes = await readFile(
    new URL("../fixtures/backgrounds/sakura.jpg", import.meta.url),
  );
  const backgroundImage = `data:image/jpeg;base64,${backgroundBytes.toString("base64")}`;

  await page.evaluate(async (image) => {
    const decoded = new Image();

    decoded.src = image;
    await decoded.decode();

    const result = await window.eda.settings.set(
      "background",
      { kind: "application" },
      {
        image,
        strength: 20,
        blur: 4,
      },
    );

    if (!result.ok) throw new Error(result.error.message);
  }, backgroundImage);
  await page.waitForFunction(() => document.documentElement.dataset["customBackground"] === "true");
  await page.evaluate((id) => {
    window.__navigationWatchChanges = 0;
    window.eda.events.onRepositoryChanged((changed) => {
      if (changed === id) window.__navigationWatchChanges++;
    });
  }, repositoryId);
  await page.evaluate(() => {
    window.__navigationProbes = [];

    const original = document.startViewTransition.bind(document);

    document.startViewTransition = (update) => {
      const probe: Probe = { motion: document.documentElement.dataset["navigationMotion"] };

      window.__navigationProbes.push(probe);

      const transition = original(update);

      void transition.ready
        .then(() => {
          probe.ready = performance.now();
          probe.duration =
            parseFloat(
              getComputedStyle(
                document.documentElement,
                probe.motion === "layout"
                  ? "::view-transition-group(layout-pane-0)"
                  : "::view-transition-new(navigation-content)",
              ).animationDuration,
            ) * 1000;
          if (probe.motion === "layout") {
            probe.paneOpacity = getComputedStyle(
              document.documentElement,
              "::view-transition-new(layout-pane-0)",
            ).opacity;
            probe.paneAnimation = getComputedStyle(
              document.documentElement,
              "::view-transition-group(layout-pane-0)",
            ).animationName;
          }
        })
        .catch((error: unknown) => {
          probe.error = String(error);
        });
      void transition.finished.then(() => {
        probe.finished = performance.now();
      });

      return transition;
    };
  });

  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const settled = async (motion: string) =>
    page.waitForFunction((expected) => {
      const probe = window.__navigationProbes.at(-1);
      return probe?.motion === expected && probe.finished !== undefined;
    }, motion);

  const draft = page.getByRole("textbox", { name: "Commit title", exact: true });

  const graphDraft = page.getByRole("textbox", { name: "Working tree title", exact: true });
  const editorBounds = await graphDraft.boundingBox();
  const rowBounds = await page.locator('[data-tour="history-working-tree"]').boundingBox();
  assert.ok(editorBounds && rowBounds);
  assert.ok(editorBounds.width <= 320, "Graph title stays compact on wide layouts");
  assert.ok(editorBounds.x + editorBounds.width <= rowBounds.x + rowBounds.width);
  assert.ok(editorBounds.y >= rowBounds.y);
  assert.ok(editorBounds.y + editorBounds.height <= rowBounds.y + rowBounds.height);
  await graphDraft.fill("Draft from the graph");
  await expect(draft).toHaveValue("Draft from the graph");
  await draft.fill("Keep this draft through layout changes");
  await expect(graphDraft).toHaveValue("Keep this draft through layout changes");

  for (const name of [
    "Maximize working tree",
    "Restore working tree",
    "Collapse working tree",
    "Expand Working tree",
    "Hide branches and tags",
    "Show branches and tags",
  ]) {
    const before = await page.evaluate(() => window.__navigationProbes.length);

    await page.getByRole("button", { name, exact: true }).click();
    await page.waitForFunction((index) => window.__navigationProbes.length > index, before);
    await settled("layout");
  }

  for (const expanded of [true, false]) {
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    assert.equal(
      await page
        .getByRole("button", { name: "Activity", exact: true })
        .getAttribute("aria-expanded"),
      String(expanded),
    );
    await page.locator(".activity-content").evaluate(async (element) => {
      await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
    });
  }

  assert.equal(await draft.inputValue(), "Keep this draft through layout changes");
  await expect(graphDraft).toHaveValue("Keep this draft through layout changes");

  await page.emulateMedia({ reducedMotion: "reduce" });

  const beforeReduced = await page.evaluate(() => window.__navigationProbes.length);
  const entriesBeforeReduced = await page.evaluate(() => window.__navigationEntries.length);

  await page.getByRole("button", { name: "Collapse working tree", exact: true }).click();
  await page.getByRole("button", { name: "Expand Working tree", exact: true }).click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__navigationProbes.length), beforeReduced);
  await page.getByRole("button", { name: "Unstaged file.txt, status M", exact: true }).click();
  await page.getByRole("button", { name: "Back to history", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__navigationEntries.length), entriesBeforeReduced);
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await settings.click();
  await settled("forward");
  await page.evaluate(() => {
    window.__navigationWatchChanges = 0;
  });
  await writeFile(join(repositoryPath, "changed-in-settings.txt"), "external change\n");
  await page.waitForFunction(() => window.__navigationWatchChanges > 0);
  await settings.click();
  await settled("back");
  await page.evaluate(async () => {
    const profile = await window.eda.identity.getActive();

    if (!profile.ok || !profile.value) throw new Error("Missing fixture profile");

    for (const [scope, value] of [
      [{ kind: "profile", profileId: profile.value.id }, 100],
      [{ kind: "application" }, 110],
    ] as const) {
      const result = await window.eda.settings.set("uiZoom", scope, value);
      if (!result.ok) throw new Error(result.error.message);
    }
  });

  const width = await page.evaluate(() => innerWidth);

  await settings.click();
  await settled("forward");
  await page.getByRole("button", { name: "Global settings: Appearance", exact: true }).click();
  await settled("section");
  await page.waitForFunction((previous) => innerWidth < previous, width);
  await settings.click();
  await settled("back");
  await page.waitForFunction((previous) => innerWidth === previous, width);

  const probes = await page.evaluate(() => window.__navigationProbes);
  const layouts = probes.filter((probe) => probe.motion === "layout");
  const section = probes.find((probe) => probe.motion === "section");

  assert.equal(layouts.length, 6);
  assert.ok(section?.duration);
  for (const layout of layouts) {
    assert.equal(layout.duration, section.duration, "Pane resizing reuses the shared motion pace.");
    assert.equal(layout.paneOpacity, "1", "Pane resizing keeps content solid.");
    assert.ok(layout.paneAnimation && layout.paneAnimation !== "none", "Pane bounds must animate.");
  }

  for (const probe of probes) {
    assert.equal(probe.error, undefined, `Capture failed: ${probe.error}`);
    assert.ok(probe.ready !== undefined && probe.finished !== undefined && probe.duration);
    assert.ok(
      probe.finished - probe.ready >= probe.duration * 0.8,
      `${probe.motion} was cut short: ${probe.finished - probe.ready}ms of ${probe.duration}ms`,
    );
  }

  // Use raw clicks: Locator.click waits for hit testing and hides this bug.
  const bounds = await settings.boundingBox();

  assert.ok(bounds);

  const initialCount = probes.length;

  for (const [offset, motion] of ["forward", "back", "forward", "back"].entries()) {
    if (offset > 0) {
      assert.equal(
        await page.evaluate(() => window.__navigationProbes.at(-1)?.finished),
        undefined,
        "The test must interrupt a running animation",
      );
    }

    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.waitForFunction(
      ({ index, expected }) => {
        const probe = window.__navigationProbes[index];
        return probe?.motion === expected && probe.ready !== undefined;
      },
      { index: initialCount + offset, expected: motion },
    );
  }

  await settled("back");
  assert.equal(await settings.getAttribute("aria-current"), null);
  assert.equal(
    await page.getByRole("searchbox", { name: "Filter changed files" }).isVisible(),
    true,
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await settings.click();
  await page.locator('button[aria-controls="settings-global"]').click();

  const vigilantMode = page.getByRole("checkbox", { name: "Vigilant mode", exact: true });
  await vigilantMode.waitFor();
  assert.equal(await vigilantMode.isChecked(), false);
  await vigilantMode.click();
  await expect(vigilantMode).toBeChecked();
  await settings.click();

  const graph = page.getByTestId("commit-graph");
  const unsigned = graph.getByRole("img", { name: "Unsigned", exact: true });
  await unsigned.waitFor({ state: "visible" });
  assert.ok(await unsigned.boundingBox(), "The SHA signing icon must fit the visible column.");
  const tag = page.getByRole("button", { name: "Inspect tag navigation-release", exact: true });
  const tagSignature = tag.getByRole("img", { name: "Unsigned", exact: true });
  await expect(tagSignature).toBeVisible();
  await expect(tag).toHaveAccessibleDescription("Unsigned");

  await page.setViewportSize({ width: 700, height: 900 });
  await expect(graph.locator('[data-tour="history-commit"] [role="img"]')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await unsigned.waitFor({ state: "visible" });

  await settings.click();
  await vigilantMode.waitFor();
  await expect(vigilantMode).toBeChecked();
  await page.locator('button[aria-controls="settings-preferences"]').click();
  const profileVigilantMode = page.getByRole("combobox", { name: "Vigilant mode", exact: true });
  await expect(profileVigilantMode).toHaveText("Follow global");
  await profileVigilantMode.click();
  await page.getByRole("option", { name: "Off", exact: true }).click();
  await expect(profileVigilantMode).toHaveText("Off");
  await settings.click();
  await unsigned.waitFor({ state: "detached" });
  await expect(tagSignature).toHaveCount(0);

  await settings.click();
  await profileVigilantMode.click();
  await page.getByRole("option", { name: "Follow global", exact: true }).click();
  await expect(profileVigilantMode).toHaveText("Follow global");
  await settings.click();
  await unsigned.waitFor({ state: "visible" });

  await settings.click();
  await page.locator('button[aria-controls="settings-global"]').click();
  await vigilantMode.click();
  await expect(vigilantMode).not.toBeChecked();
  await settings.click();
  await unsigned.waitFor({ state: "detached" });

  const database = new DatabaseSync(join(root, "eda.db"));
  try {
    const saved = database
      .prepare("SELECT value FROM commit_signatures WHERE repository_id = ?")
      .all(repositoryId);
    assert.equal(saved.length, 1, "Disabling vigilant mode must keep the saved verification.");
  } finally {
    database.close();
  }

  await settings.click();
  await page.getByRole("button", { name: "About", exact: true }).click();
  await page.getByRole("checkbox", { name: "Enable developer settings", exact: true }).check();

  const sidebar = page.getByRole("navigation", { name: "Settings sections", exact: true });
  const panels = await sidebar
    .locator("button[aria-controls]")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-controls")!));

  for (const width of [1440, 700]) {
    await page.setViewportSize({ width, height: 900 });

    for (const id of panels) {
      await sidebar.locator(`button[aria-controls="${id}"]`).click();
      await page.locator(`#${id}`).waitFor();

      if (id === "settings-debug") await page.locator(".component-gallery").waitFor();

      const widths = await page.locator(`#${id}`).evaluate((panel) => {
        const header = panel.querySelector("header")!.getBoundingClientRect();
        const selectors = [":scope > div > :first-child"];

        if (panel.id === "settings-global-git") selectors.push(":scope > div > div > :last-child");

        if (panel.id === "settings-repository-sync")
          selectors.push(":scope > div > div > section > div");

        return [...panel.querySelectorAll(selectors.join(","))].map((content) => {
          const bounds = content.getBoundingClientRect();

          return { left: bounds.left - header.left, right: bounds.right - header.right };
        });
      });

      assert.ok(widths.length > 0, `${id} must render content at ${width}px.`);

      for (const bounds of widths) {
        assert.ok(
          Math.abs(bounds.left) < 1 && Math.abs(bounds.right) < 1,
          `${id} must fill the shared settings content width at ${width}px: ${JSON.stringify(bounds)}`,
        );
      }
    }
  }

  console.log(
    "Shared navigation passed: repository close/reopen, history/diff and commit/working-tree changes, pane resizing, Activity disclosure, retained drafts, reduced motion, pointer interruption, watching, scale restoration and shared settings widths on wide and narrow windows.",
  );
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
