import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { trustFixture } from "./helpers/trust.ts";
import { type Page, type Locator } from "playwright";
import { expect } from "playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const MAX_MOUNTED_ROWS = 80;
const userData = await mkdtemp(join(tmpdir(), "eda-large-gate-"));
const generatedRepository = await createSyntheticRepository();
const repository = generatedRepository;
const commitCount = Number(
  execFileSync("git", ["-C", repository, "rev-list", "--count", "--all"], {
    env: fixtureEnvironment(userData),
    encoding: "utf8",
  }).trim(),
);

if (commitCount < PAGE_SIZE * 4) {
  throw new Error(
    `The gate needs at least ${PAGE_SIZE * 4} commits; ${repository} has ${commitCount}.`,
  );
}

const gitConfigGlobal = join(userData, "gitconfig");

await writeFile(gitConfigGlobal, "");

const app = await electron.launch({
  args: [
    "dist/main/index.js",
    "--no-sandbox",
    "--force-color-profile=srgb",
    `--user-data-dir=${userData}`,
  ],
  env: {
    ...fixtureEnvironment(userData),
    HOME: userData,
    USERPROFILE: userData,
    GIT_CONFIG_GLOBAL: gitConfigGlobal,
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    NODE_OPTIONS: "--no-warnings=ExperimentalWarning",
  },
});

try {
  await trustFixture(app, repository);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("avatar:commit-get");
    ipcMain.handle("avatar:commit-get", () => ({
      ok: true,
      value: {
        dataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQ3RkHAAITAS23Eb1qAAAAAElFTkSuQmCC",
        expiresAt: Date.now() + 60 * 60_000,
      },
    }));
  });
  const page = await app.firstWindow();

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900),
  );
  await page.waitForLoadState("domcontentloaded");

  const openedRepository = await page.evaluate(async (path) => {
    const created = await window.eda.identity.create({
      name: "Large repository gate",
      gitName: "Eda",
      gitEmail: "gate@eda.invalid",
      hue: 210,
      signing: { format: "none", signCommits: false },
    });

    if (!created.ok) throw new Error(created.error.message);

    const activated = await window.eda.identity.setActive(created.value.id);

    if (!activated.ok) throw new Error(activated.error.message);

    const opened = await window.eda.repository.open(path);

    if (!opened.ok) throw new Error(opened.error.message);

    return opened.value;
  }, repository);

  await page.reload();
  await page.getByRole("button", { name: `Open ${openedRepository.name}`, exact: true }).click();

  const list = page.locator('[data-testid="commit-graph"] [data-virtual-list="true"]');

  await list.waitFor({ state: "visible" });
  await page
    .getByRole("button", { name: "Inspect branch fixture/branch-00000", exact: true })
    .waitFor();
  assert.ok((await page.getByRole("button", { name: /^Inspect branch / }).count()) <= 200);

  const coldStart = performance.now();
  await page.evaluate(async (profileId) => {
    const result = await window.eda.settings.set(
      "vigilantMode",
      { kind: "profile", profileId },
      true,
    );
    if (!result.ok) throw new Error(result.error.message);
  }, openedRepository.identityId);
  await waitForSignatures(list);
  const coldVerificationMs = Math.round(performance.now() - coldStart);

  const warmStart = performance.now();
  await page.reload();
  await list.waitFor({ state: "visible" });
  await waitForSignatures(list);
  const warmReopenMs = Math.round(performance.now() - warmStart);
  assertBounds(await readMetrics(list));

  const initialHeap = await heapSize(page);
  const targetOffset = Math.min(commitCount - PAGE_SIZE * MAX_PAGES, 1_000);
  const rowHeight = await list
    .locator('[data-tour="history-commit"]')
    .first()
    .evaluate((row) => row.getBoundingClientRect().height);
  await assertCachedRowDetailsDuringScroll(list, rowHeight);

  const prefetchInset = 24 * rowHeight;
  let offset = 0;

  for (let attempts = 0; attempts < 30 && offset < targetOffset; attempts += 1) {
    const previous = await readMetrics(list, "end", prefetchInset);
    await page.waitForFunction(
      ({ previous }) => {
        const list = document.querySelector(
          '[data-testid="commit-graph"] [data-virtual-list="true"]',
        );

        return (
          list &&
          (Number(list.getAttribute("data-item-offset")) !== previous.offset ||
            Number(list.getAttribute("data-retained-count")) !== previous.retained)
        );
      },
      { previous },
      { timeout: 15000 },
    );

    const metrics = await readMetrics(list);

    offset = metrics.offset;
    assertBounds(metrics);
    assertScrollAnchor(previous, metrics, rowHeight);
  }

  if (offset < targetOffset)
    throw new Error(`History stopped at offset ${offset}; expected at least ${targetOffset}.`);

  const forwardOffset = offset;

  const previous = await readMetrics(list, "start", prefetchInset);
  await page.waitForFunction(
    (forwardOffset) =>
      Number(
        document
          .querySelector('[data-testid="commit-graph"] [data-virtual-list="true"]')
          ?.getAttribute("data-item-offset"),
      ) < forwardOffset,
    forwardOffset,
    { timeout: 15000 },
  );

  const backward = await readMetrics(list);

  assertBounds(backward);
  assertScrollAnchor(previous, backward, rowHeight);

  if (backward.offset >= forwardOffset)
    throw new Error("Scrolling backward did not refetch an evicted history page.");

  const heapGrowth = (await heapSize(page)) - initialHeap;

  if (heapGrowth > 128 * 1024 * 1024)
    throw new Error(`Renderer heap grew by ${Math.round(heapGrowth / 1024 / 1024)} MiB.`);

  await list.evaluate((element) => {
    const bottom = element.getBoundingClientRect().bottom;
    const rows = element.querySelectorAll<HTMLElement>('[data-tour="history-commit"]');
    Array.from(rows)
      .findLast((row) => row.getBoundingClientRect().bottom <= bottom)!
      .focus();
  });
  for (let step = 0; step < 3; step++) await page.keyboard.press("Tab");
  await expect(list.locator('[data-tour="history-commit"]:focus')).toBeInViewport({ ratio: 1 });

  await assertThumbDragCoverage(page, list, rowHeight);
  await assertWheelScrollCoverage(page, list, rowHeight);
  await waitForSignatures(list);

  console.log(
    `Large-repository gate passed with vigilant mode (${commitCount} commits): traversed to commit ${forwardOffset}, retained <= ${PAGE_SIZE * MAX_PAGES}, mounted <= ${MAX_MOUNTED_ROWS}, heap delta ${Math.round(heapGrowth / 1024 / 1024)} MiB, initial signatures ${coldVerificationMs} ms, warm app reload ${warmReopenMs} ms.`,
  );
} catch (error) {
  console.error("Large-repository assertion failed:", error);
  throw error;
} finally {
  await app.close();
  assert.ok(resolve(userData).startsWith(resolve(tmpdir(), "eda-large-gate-")));

  await rm(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

  if (generatedRepository) {
    assert.ok(resolve(generatedRepository).startsWith(resolve(tmpdir(), "eda-history-")));

    await rm(generatedRepository, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
}

async function createSyntheticRepository() {
  const path = await mkdtemp(join(tmpdir(), "eda-history-"));

  const env = fixtureEnvironment(path);
  execFileSync("git", ["init", "-q", "-b", "main", path], { env });

  const records = [];

  for (let index = 1; index <= 100_000; index += 1) {
    const message = `Gate commit ${index}\n`;
    records.push(
      `commit refs/heads/main\nmark :${index}\ncommitter Eda <gate@eda.invalid> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}${index > 1 ? `from :${index - 1}\n` : ""}\n`,
    );
  }

  execFileSync("git", ["-C", path, "fast-import", "--quiet"], {
    env,
    input: records.join(""),
    maxBuffer: 1024 * 1024,
  });

  const tips = execFileSync("git", ["-C", path, "rev-list", "--max-count=10000", "HEAD"], {
    env,
    encoding: "utf8",
  })
    .trim()
    .split("\n");

  await writeFile(
    join(path, ".git", "packed-refs"),
    "# pack-refs with: peeled fully-peeled sorted\n" +
      tips
        .map((oid, index) => `${oid} refs/heads/fixture/branch-${String(index).padStart(5, "0")}\n`)
        .join(""),
  );

  return path;
}

async function assertCachedRowDetailsDuringScroll(list: Locator, rowHeight: number) {
  const avatar = list.locator('[data-tour="history-commit"] .profile-avatar img').first();
  await avatar.waitFor({ state: "visible" });
  const result = await list.evaluate(async (element, rowHeight) => {
    const commitRow = '[data-tour="history-commit"]';
    const first = element.querySelector(commitRow);
    const firstTitle = first?.getAttribute("title");
    let flashes = 0;
    const observer = new MutationObserver((records) => {
      for (const { addedNodes } of records) {
        for (const node of addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          for (const avatar of node.querySelectorAll(".profile-avatar")) {
            if (avatar.matches(".ui-skeleton") || !avatar.querySelector("img")) flashes++;
          }
        }
      }
    });
    observer.observe(element, { childList: true, subtree: true });

    const scroll = async (top: number, firstRowMounted: boolean) => {
      element.scrollTop = top;
      for (let frame = 0; frame < 120; frame++) {
        await new Promise(requestAnimationFrame);
        const firstVisible = element.querySelector(commitRow)?.getAttribute("title");
        if ((firstVisible === firstTitle) === firstRowMounted) return;
      }
      throw new Error("Scrolling should unmount and remount the first commit");
    };

    try {
      await scroll(32 * rowHeight, false);
      await scroll(0, true);
      return {
        flashes,
        signature: element.querySelector(`${commitRow} [role="img"]`)?.getAttribute("aria-label"),
      };
    } finally {
      observer.disconnect();
    }
  }, rowHeight);
  assert.equal(result.flashes, 0, "Scrolling should display cached author avatars immediately");
  assert.equal(result.signature, "Unsigned", "Returning rows should show their cached signature");
}

async function assertThumbDragCoverage(page: Page, list: Locator, rowHeight: number) {
  const marker = await page.addStyleTag({
    content: `
      [data-tour="history-commit"] { position: relative }
      [data-tour="history-commit"]::after {
        content: ""; position: absolute; inset: 0 auto 0 12px; width: 5px;
        background: lime; pointer-events: none;
      }`,
  });
  const track = await list.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const height = element.clientHeight;
    const thumb = (height * height) / element.scrollHeight;
    return {
      x: rect.right - (rect.width - element.clientWidth) / 2,
      grab: rect.top + (height * element.scrollTop) / element.scrollHeight + thumb / 2,
      low: rect.top + height * 0.72,
      high: rect.top + height * 0.28,
      strip: {
        x: Math.round(rect.left + 14),
        y: Math.ceil(rect.top) + 1,
        width: 1,
        height: height - 2,
      },
    };
  });
  const paintedGap = () =>
    app.evaluate(async ({ BrowserWindow }, strip) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const image = await contents.capturePage(strip);
      if (image.isEmpty()) throw new Error("The history viewport capture was empty");
      const { width, height } = image.getSize();
      const pixels = image.toBitmap();
      let gap = 0;
      let longest = 0;
      for (let i = 0; i < pixels.length; i += 4 * width) {
        const green = pixels[i + 1]!;
        gap = green - Math.max(pixels[i]!, pixels[i + 2]!) > 100 ? 0 : gap + 1;
        longest = Math.max(longest, gap);
      }
      return (longest * strip.height) / height;
    }, track.strip);
  const coverage = await list.evaluateHandle((element) => {
    let previous = element.scrollTop;
    let down = 0;
    let up = 0;
    let gap = 0;
    const sample = () => {
      const rows = element.querySelectorAll('[data-tour="history-commit"]');
      const viewport = element.getBoundingClientRect();
      const first = rows[0]?.getBoundingClientRect();
      const last = rows[rows.length - 1]?.getBoundingClientRect();
      gap = Math.max(
        gap,
        first && last
          ? Math.min(
              viewport.height,
              Math.max(first.top - viewport.top, viewport.bottom - last.bottom),
            )
          : viewport.height,
      );
      down = Math.max(down, element.scrollTop - previous);
      up = Math.max(up, previous - element.scrollTop);
      previous = element.scrollTop;
    };
    element.addEventListener("scroll", sample, true);
    return {
      stats: () => ({ down, up, gap }),
      stop: () => element.removeEventListener("scroll", sample, true),
    };
  });
  const session = await page.context().newCDPSession(page);
  try {
    await expect
      .poll(paintedGap, { message: "History rows should paint the marker before dragging" })
      .toBeLessThan(5);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 8 });
    await page.mouse.move(track.x, track.grab);
    await page.mouse.down();
    let maxGap = 0;
    for (let pass = 0; pass < 6; pass++) {
      for (const y of [track.low, track.high]) {
        const [, gap] = await Promise.all([page.mouse.move(track.x, y), paintedGap()]);
        maxGap = Math.max(maxGap, gap);
      }
    }
    maxGap = Math.max(maxGap, await paintedGap());
    const { down, up, gap } = await coverage.evaluate((coverage) => coverage.stats());
    assert.ok(
      Math.min(down, up) > MAX_MOUNTED_ROWS * rowHeight,
      "The thumb must jump beyond the mounted rows in both directions",
    );
    assert.ok(gap <= 1, `Dragging the scrollbar uncovered ${gap}px before the rows updated`);
    assert.ok(maxGap < rowHeight, `The scrollbar drag painted a ${maxGap}px gap`);
  } finally {
    await page.mouse.up();
    await coverage.evaluate((coverage) => coverage.stop());
    await coverage.dispose();
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await session.detach();
    await marker.evaluate((element) => element.parentNode?.removeChild(element));
  }
  await expect
    .poll(() =>
      list.evaluate(
        (element, { commitCount, rowHeight }) => {
          const viewport = element.getBoundingClientRect();
          const middle = Math.floor(viewport.height / 2);
          const index =
            Number(element.getAttribute("data-item-offset")) +
            Math.floor((element.scrollTop + middle) / rowHeight);
          const row = document
            .elementFromPoint(viewport.left + 20, viewport.top + middle)
            ?.closest('[data-tour="history-commit"]');
          return (
            row?.getAttribute("title")?.split("\n")[0] === `Gate commit ${commitCount - index}`
          );
        },
        { commitCount, rowHeight },
      ),
    )
    .toBe(true);
}

async function assertWheelScrollCoverage(page: Page, list: Locator, rowHeight: number) {
  await list.hover();
  const session = await page.context().newCDPSession(page);
  const monitor = await list.evaluateHandle((element, rowHeight) => {
    const scrollPosition = () =>
      element.scrollTop + Number(element.getAttribute("data-item-offset")) * rowHeight;
    let frame = 0;
    let forward = 0;
    let backward = 0;
    let animatedSignatures = 0;
    let previous = scrollPosition();
    let maxGap = 0;
    const sample = () => {
      const position = scrollPosition();
      if (position !== previous) {
        const rows = element.querySelectorAll('[data-tour="history-commit"]');
        const viewport = element.getBoundingClientRect();
        const first = rows[0]?.getBoundingClientRect();
        const last = rows[rows.length - 1]?.getBoundingClientRect();
        const gap =
          first && last
            ? Math.max(first.top - viewport.top, viewport.bottom - last.bottom)
            : viewport.height;
        if (element.querySelector('[role="img"] .animate-spin-fast')) animatedSignatures++;
        maxGap = Math.max(maxGap, gap);
        if (position > previous) forward++;
        else backward++;
        previous = position;
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return {
      stats: () => ({ forward, backward, maxGap, animatedSignatures }),
      stop: () => cancelAnimationFrame(frame),
    };
  }, rowHeight);
  try {
    await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    for (const direction of ["forward", "backward"] as const) {
      const movedFrames = () => monitor.evaluate((monitor, dir) => monitor.stats()[dir], direction);
      const baseline = await movedFrames();

      // Wheel events at the edge of a retained page can arrive before the next page loads.
      await expect
        .poll(
          async () => {
            await page.mouse.wheel(0, direction === "forward" ? 780 : -780);
            return (await movedFrames()) - baseline;
          },
          {
            message: `Wheel input should move the viewport ${direction}`,
            intervals: [32],
            timeout: 15000,
          },
        )
        .toBeGreaterThanOrEqual(15);
    }
    const result = await monitor.evaluate((monitor) => monitor.stats());
    assert.ok(
      result.maxGap <= 1,
      `Wheel scrolling showed blank areas up to ${result.maxGap}px high`,
    );
    assert.equal(result.animatedSignatures, 0, "Wheel scrolling should not spin signature icons");
  } finally {
    await monitor.evaluate((monitor) => monitor.stop());
    await monitor.dispose();
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await session.detach();
  }
}

async function readMetrics(locator: Locator, edge?: "start" | "end", inset = 0) {
  return locator.evaluate(
    (element, { edge, inset }) => {
      if (edge === "start") element.scrollTop = inset;
      else if (edge === "end")
        element.scrollTop = element.scrollHeight - element.clientHeight - inset;
      const viewport = element.getBoundingClientRect();
      const rows = Array.from(element.querySelectorAll('[data-tour="history-commit"]'));
      return {
        mounted: rows.length,
        retained: Number(element.getAttribute("data-retained-count")),
        offset: Number(element.getAttribute("data-item-offset")),
        scrollTop: element.scrollTop,
        hasVisibleCommit: rows.some((row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.top < viewport.bottom && bounds.bottom > viewport.top;
        }),
      };
    },
    { edge, inset },
  );
}

function assertScrollAnchor(
  before: Awaited<ReturnType<typeof readMetrics>>,
  after: Awaited<ReturnType<typeof readMetrics>>,
  rowHeight: number,
) {
  assert.ok(after.hasVisibleCommit, "The viewport should still show commits after loading a page");
  const shift = after.scrollTop - before.scrollTop + (after.offset - before.offset) * rowHeight;
  assert.ok(Math.abs(shift) <= 1, `Loading a history page moved the visible commits by ${shift}px`);
}

async function waitForSignatures(list: Locator) {
  const rows = list.locator('[data-tour="history-commit"]');
  await expect
    .poll(
      () =>
        rows.evaluateAll((rows) => {
          const labels = rows.map((row) =>
            row.querySelector('[role="img"]')?.getAttribute("aria-label"),
          );
          return [...new Set(labels)];
        }),
      {
        message: "All mounted history rows should show their unsigned status",
        intervals: [32],
        timeout: 15000,
      },
    )
    .toEqual(["Unsigned"]);
}

function assertBounds(metrics: Awaited<ReturnType<typeof readMetrics>>) {
  if (metrics.mounted > MAX_MOUNTED_ROWS)
    throw new Error(`Mounted row bound failed: ${metrics.mounted}.`);
  if (metrics.retained > PAGE_SIZE * MAX_PAGES)
    throw new Error(`Retained commit bound failed: ${metrics.retained}.`);
}

async function heapSize(page: Page) {
  const session = await page.context().newCDPSession(page);

  try {
    const { usedSize } = await session.send("Runtime.getHeapUsage");
    assert.ok(usedSize > 0, "Heap measurement must be available");
    return usedSize;
  } finally {
    await session.detach();
  }
}
