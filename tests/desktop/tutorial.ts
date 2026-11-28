import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const root = await mkdtemp(join(tmpdir(), "eda-tour-"));
const errors: string[] = [];
const app = await electron.launch({
  args: ["dist/main/index.js", "--no-sandbox", `--user-data-dir=${root}`],
  env: fixtureEnvironment(root),
});
const page = await app.firstWindow();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE", m.text());
});
try {
  await page.waitForFunction(() => !!window.eda);
  const result = await page.evaluate(() =>
    window.eda.identity.create(
      {
        name: "Tour test",
        gitName: "Explorer",
        gitEmail: "explorer@example.test",
        hue: 190,
        signing: { format: "none", signCommits: false },
      },
      { syncGlobalGitConfig: false },
    ),
  );
  assert.equal(result.ok, true);
  await page.evaluate((id) => window.eda.identity.setActive(id), result.value.id);
  const backgroundImage = await app.evaluate(
    ({ nativeImage }) =>
      "data:image/jpeg;base64," +
      nativeImage
        .createFromBitmap(Buffer.alloc(16, 180), { width: 2, height: 2 })
        .toJPEG(80)
        .toString("base64"),
  );
  const saved = await page.evaluate(
    ({ profileId, image }) =>
      window.eda.settings.set(
        "background",
        { kind: "profile", profileId },
        { image, strength: 75, blur: 0 },
      ),
    { profileId: result.value.id, image: backgroundImage },
  );
  assert.equal(saved.ok, true);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset["customBackground"] === "true");
  const expectedBackground = await page.evaluate(
    () => getComputedStyle(document.body, "::before").backgroundImage,
  );
  await page.getByRole("button", { name: "Take a tour", exact: true }).click();
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "Your way around Eda" }).waitFor({ timeout: 10000 });
  const presentation = await frame.locator("body").evaluate((element) => ({
    image: getComputedStyle(element, "::before").backgroundImage,
    strength: document.documentElement.style.getPropertyValue("--background-strength"),
    canvas: getComputedStyle(document.querySelector(".app-canvas")!).backgroundColor,
    profile: document.querySelector('[data-tour="profile"]')?.textContent,
  }));
  assert.equal(presentation.image, expectedBackground);
  assert.equal(presentation.strength, "0.75");
  assert.equal(presentation.canvas, "rgba(0, 0, 0, 0)");
  assert.ok(presentation.profile?.includes("Explorer"));
  assert.ok(!presentation.profile?.includes("Tour test"));
  await frame.getByRole("tab", { name: "Activity", exact: true }).waitFor();
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--background-strength", "0.55"),
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector("iframe")
        ?.contentDocument?.documentElement.style.getPropertyValue("--background-strength") ===
      "0.55",
  );

  assert.equal(await frame.getByRole("button", { name: "Back", exact: true }).isDisabled(), true);
  const outline = await frame.locator(".ui-spotlight-motion.border-accent").elementHandle();
  assert.ok(outline);
  const duration = await outline.evaluate(
    (element) => getComputedStyle(element).transitionDuration,
  );
  assert.ok(parseFloat(duration) > 0.1);

  await frame.getByRole("button", { name: "Next", exact: true }).click();
  await frame.getByRole("heading", { name: "Three ways to get started", exact: true }).waitFor();
  assert.equal(await outline.evaluate((element) => element.isConnected), true);
  const reducedDuration = await frame.locator("html").evaluate((element) => {
    const previous = element.getAttribute("data-reduced-motion");
    element.setAttribute("data-reduced-motion", "true");
    const duration = getComputedStyle(
      document.querySelector(".ui-spotlight-motion")!,
    ).transitionDuration;
    if (previous === null) element.removeAttribute("data-reduced-motion");
    else element.setAttribute("data-reduced-motion", previous);
    return duration;
  });
  assert.ok(parseFloat(reducedDuration) < 0.001);

  await frame.getByRole("button", { name: "Back", exact: true }).click();
  const next = () => frame.getByRole("button", { name: "Next", exact: true }).click();
  const heading = (name: string) => frame.getByRole("heading", { name, exact: true }).waitFor();
  await next();
  await next();
  assert.equal(await frame.getByRole("button", { name: "Next", exact: true }).count(), 0);
  await frame.getByRole("button", { name: "Open Hello Eda", exact: true }).click();
  await frame
    .getByRole("heading", { name: "Meet your workspace", exact: true })
    .waitFor({ timeout: 1000 });
  await next();
  await heading("Choose what goes into a commit");
  await frame.getByRole("button", { name: "Stage all", exact: true }).click();
  await heading("Describe your change");
  await frame.getByRole("button", { name: "Back", exact: true }).click();
  await heading("Choose what goes into a commit");
  await frame.getByRole("checkbox", { name: "Select unstaged README.md", exact: true }).check();
  assert.equal(
    await frame.getByRole("button", { name: "Stage 1 selected files", exact: true }).isEnabled(),
    true,
  );
  await heading("Choose what goes into a commit");
  await frame.getByRole("button", { name: "Stage 1 selected files", exact: true }).click();
  await heading("Describe your change");
  assert.equal(
    await frame.getByRole("checkbox", { name: "Select staged README.md", exact: true }).count(),
    1,
  );
  assert.equal(
    await frame
      .getByRole("checkbox", { name: "Select unstaged src/greeting.ts", exact: true })
      .count(),
    1,
  );
  await next();
  await heading("Look inside a commit");
  assert.equal(await frame.getByRole("dialog").count(), 0);
  await frame.getByText("Add a friendly greeting", { exact: true }).click();
  await heading("Pick a changed file");
  await frame.getByText("README.md", { exact: true }).click();
  await heading("Read the change");
  await frame.getByRole("button", { name: "Side by side", exact: true }).click();
  await frame
    .getByRole("button", { name: "Side by side", exact: true })
    .getAttribute("aria-pressed")
    .then((pressed) => assert.equal(pressed, "true"));
  const diffAppearance = await frame.locator("body").evaluate((element) => ({
    image: getComputedStyle(element, "::before").backgroundImage,
    strength: document.documentElement.style.getPropertyValue("--background-strength"),
  }));
  assert.equal(diffAppearance.image, expectedBackground);
  assert.equal(diffAppearance.strength, "0.75");
  await frame.getByRole("button", { name: "Unified", exact: true }).click();
  assert.equal(
    await frame.getByRole("button", { name: "Unified", exact: true }).getAttribute("aria-pressed"),
    "true",
  );

  await frame.getByRole("button", { name: "Back", exact: true }).click();
  await heading("Pick a changed file");
  await frame.getByText("README.md", { exact: true }).click();
  await heading("Read the change");
  await frame.getByRole("button", { name: "Finish tour", exact: true }).click();
  await page.getByRole("heading", { name: "Repositories", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.eda.repository.list()), {
    ok: true,
    value: [],
  });
  await page.getByRole("button", { name: "Take a tour", exact: true }).click();
  await frame.getByRole("heading", { name: "Your way around Eda" }).waitFor();
  await frame.getByRole("button", { name: "Skip tour", exact: true }).click();
  await page.locator("iframe").waitFor({ state: "detached" });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search settings", exact: true }).fill("tutorial");
  await page.getByRole("button", { name: "About", exact: true }).click();
  const replay = page.getByRole("button", { name: "Take the tour again", exact: true });
  await replay.click();
  await frame.getByRole("heading", { name: "Your way around Eda" }).waitFor();
  await frame.getByRole("button", { name: "Next", exact: true }).click();
  await frame.getByRole("heading", { name: "Three ways to get started", exact: true }).waitFor();
  await frame.getByRole("button", { name: "Skip tour", exact: true }).click();
  await page.locator("iframe").waitFor({ state: "detached" });
  assert.equal(await replay.evaluate((button) => button === document.activeElement), true);

  await replay.click();
  await frame.getByRole("heading", { name: "Your way around Eda" }).waitFor();
  await frame.locator("body").press("Escape");
  await page.locator("iframe").waitFor({ state: "detached" });
  await replay.waitFor();
  assert.deepEqual(await page.evaluate(() => window.eda.repository.list()), {
    ok: true,
    value: [],
  });
  assert.deepEqual(errors, []);
  console.log("Tutorial desktop checks passed.");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
