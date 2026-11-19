import { electron } from "../helpers/fixture-electron.ts";
import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import { trustFixture } from "./helpers/trust.ts";
import { type Page, type Locator } from "playwright";
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
  args: ["dist/main/index.js", "--no-sandbox", `--user-data-dir=${userData}`],
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
  const page = await app.firstWindow();

  await page.setViewportSize({ width: 1440, height: 900 });
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

  const initialHeap = await heapSize(page);
  const coldStart = performance.now();
  await page.evaluate(async (profileId) => {
    const result = await window.eda.settings.set(
      "vigilantMode",
      { kind: "profile", profileId },
      true,
    );
    if (!result.ok) throw new Error(result.error.message);
  }, openedRepository.identityId);
  await waitForSignatures(page);
  const coldVerificationMs = Math.round(performance.now() - coldStart);
  const targetOffset = Math.min(commitCount - PAGE_SIZE * MAX_PAGES, 1_000);
  let offset = 0;

  for (let attempts = 0; attempts < 30 && offset < targetOffset; attempts += 1) {
    const previous = await readMetrics(list);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
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
  }

  if (offset < targetOffset)
    throw new Error(`History stopped at offset ${offset}; expected at least ${targetOffset}.`);

  const forwardOffset = offset;

  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
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

  if (backward.offset >= forwardOffset)
    throw new Error("Scrolling backward did not refetch an evicted history page.");

  const heapGrowth = (await heapSize(page)) - initialHeap;

  if (heapGrowth > 128 * 1024 * 1024)
    throw new Error(`Renderer heap grew by ${Math.round(heapGrowth / 1024 / 1024)} MiB.`);

  await waitForSignatures(page);
  const warmStart = performance.now();
  await page.reload();
  await list.waitFor({ state: "visible" });
  await waitForSignatures(page);
  const warmReopenMs = Math.round(performance.now() - warmStart);
  assertBounds(await readMetrics(list));

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

async function readMetrics(locator: Locator) {
  return locator.evaluate((element) => ({
    mounted: Number(element.getAttribute("data-mounted-count")),
    retained: Number(element.getAttribute("data-retained-count")),
    offset: Number(element.getAttribute("data-item-offset")),
  }));
}

async function waitForSignatures(page: Page) {
  await page.waitForFunction(
    () => {
      const rows = [
        ...document.querySelectorAll('[data-testid="commit-graph"] [data-tour="history-commit"]'),
      ];
      return (
        rows.length > 0 &&
        rows.every(
          (row) => row.querySelector('[role="img"]')?.getAttribute("aria-label") === "Unsigned",
        )
      );
    },
    undefined,
    { timeout: 15000 },
  );
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
