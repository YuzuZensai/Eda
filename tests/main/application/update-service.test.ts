import { afterEach, expect, it, vi } from "vitest";
import {
  UpdateService,
  UPDATE_CHECK_INTERVAL,
  UPDATE_STARTUP_DELAY,
  newerRelease,
  updateError,
  type UpdateDriver,
  type UpdateOptions,
} from "@main/application/update-service";
import { releaseFromManifest } from "@main/application/update-manifest";
import type { UpdateProgress } from "@shared/updates";
import type { VelopackAsset } from "velopack";

const release = {
  version: "0.0.2",
  name: "Eda 0.0.2-012345abcdef",
  notes: "Changes",
  releasedAt: null,
};

function fixture(overrides: Partial<UpdateOptions> = {}) {
  let progress: ((value: UpdateProgress) => void) | undefined;
  const driver: UpdateDriver = {
    check: vi.fn(async () => ({ available: true, release })),
    download: vi.fn(async (listener) => {
      progress = listener;
    }),
    discardDownload: vi.fn(),
    install: vi.fn(async () => {}),
  };
  const rollback = vi.fn();
  const options: UpdateOptions = {
    capability: "automatic",
    reason: null,
    platform: "win",
    arch: "x64",
    currentVersion: "0.0.1",
    automaticChecks: () => true,
    includePrereleases: () => true,
    createDriver: vi.fn(() => driver),
    prepareInstall: vi.fn(async () => rollback),
    ...overrides,
  };
  const service = new UpdateService(options);
  return {
    service,
    driver,
    options,
    rollback,
    progress: (value: UpdateProgress) => progress?.(value),
  };
}

afterEach(() => vi.useRealTimers());

it("checks managed releases on schedule, preserves ownership, and rejects all in-app replacements", async () => {
  vi.useFakeTimers();
  let enabled = true;
  let preview = false;
  const checkRelease = vi.fn(async () => ({ available: true, release }));
  const { service, driver, options } = fixture({
    capability: "managed",
    reason: "Managed by Homebrew.",
    automaticChecks: () => enabled,
    includePrereleases: () => preview,
    checkRelease,
  });

  service.start();
  await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY);
  expect(service.snapshot()).toMatchObject({
    phase: "available",
    reason: "Managed by Homebrew.",
    release,
  });
  expect(checkRelease).toHaveBeenLastCalledWith(expect.stringContaining("/stable/"));
  expect(() => service.download()).toThrow("Managed by Homebrew.");
  await expect(service.install()).rejects.toThrow("Managed by Homebrew.");
  expect(options.createDriver).not.toHaveBeenCalled();
  expect(driver.download).not.toHaveBeenCalled();
  expect(driver.install).not.toHaveBeenCalled();
  expect(options.prepareInstall).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
  expect(checkRelease).toHaveBeenCalledTimes(2);
  preview = true;
  service.refreshSchedule();
  expect(service.snapshot()).toMatchObject({ phase: "idle", reason: "Managed by Homebrew." });
  await service.check();
  expect(checkRelease).toHaveBeenLastCalledWith(expect.stringContaining("/preview/"));

  enabled = false;
  service.refreshSchedule();
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
  expect(checkRelease).toHaveBeenCalledTimes(3);
  checkRelease.mockRejectedValueOnce(new Error("network failure"));
  await service.check();
  expect(service.snapshot()).toMatchObject({ phase: "error", reason: "Managed by Homebrew." });
  await service.check();
  expect(service.snapshot().phase).toBe("available");
  service.stop();
});

it("deduplicates checks and requires separate verified download and installation actions", async () => {
  const { service, driver, options } = fixture();
  const revisions: number[] = [];
  service.onChange((value) => revisions.push(value.revision));
  expect(() => service.download()).toThrow(/before downloading/);
  await expect(service.install()).rejects.toThrow(/before installing/);

  const check = service.check();
  expect(service.check()).toBe(check);
  await check;
  expect(driver.check).toHaveBeenCalledTimes(1);
  expect(service.snapshot().phase).toBe("available");
  expect(driver.download).not.toHaveBeenCalled();
  expect(options.createDriver).toHaveBeenCalledWith(
    "https://eda.kirameki.cafe/api/updates/v1/preview/win/x64/",
  );

  await service.download();
  expect(service.snapshot().phase).toBe("ready");
  expect(driver.install).not.toHaveBeenCalled();
  await service.install();
  expect(options.prepareInstall).toHaveBeenCalledOnce();
  expect(driver.install).toHaveBeenCalledOnce();
  expect(service.snapshot().phase).toBe("installing");
  await expect(service.install()).rejects.toThrow();
  expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
});

it("discards download results, rejects unverified installers, and preserves a retryable release", async () => {
  const { service, driver, progress } = fixture();
  await service.check();
  let fail!: (error: Error) => void;
  vi.mocked(driver.download).mockImplementationOnce((listener) => {
    listener({ percent: 25, transferred: 25, total: 100, bytesPerSecond: 1 });
    return new Promise((_, reject) => {
      fail = reject;
    });
  });
  vi.mocked(driver.discardDownload).mockImplementation(() => fail(new Error("Cancelled")));
  const downloading = service.download();
  await vi.waitFor(() => expect(service.snapshot().progress?.percent).toBe(25));
  expect(service.download()).toBe(downloading);
  await service.discardDownload();
  expect(service.snapshot()).toMatchObject({ phase: "available", error: null, progress: null });

  vi.mocked(driver.download).mockRejectedValueOnce(new Error("sha256 checksum mismatch"));
  await service.download();
  expect(service.snapshot().error).toMatch(/could not be verified/);
  expect(service.snapshot().phase).toBe("available");
  await expect(service.install()).rejects.toThrow();
  expect(driver.install).not.toHaveBeenCalled();
  progress({ percent: 90, transferred: 90, total: 100, bytesPerSecond: 1 });
  expect(service.snapshot().progress).toBeNull();

  const count = vi.mocked(driver.download).mock.calls.length;
  service.download();
  await service.discardDownload();
  expect(driver.download).toHaveBeenCalledTimes(count);
});

it("retries absent feeds and synchronous setup failures without claiming up-to-date", async () => {
  const { service, driver, options } = fixture();
  vi.mocked(options.createDriver).mockImplementationOnce(() => {
    throw new Error("network failed");
  });
  await service.check();
  expect(service.snapshot().phase).toBe("error");
  vi.mocked(driver.check).mockRejectedValueOnce(
    new Error("404 ERR_UPDATER_LATEST_VERSION_NOT_FOUND"),
  );
  await service.check();
  expect(service.snapshot().error).toMatch(/update feed or package could not be found/);
  await service.check();
  expect(service.snapshot().phase).toBe("available");
});

it("switches audiences without restarting and discards offers and verified downloads from the previous audience", async () => {
  let includePrereleases = true;
  const { service, driver, options } = fixture({ includePrereleases: () => includePrereleases });

  await service.check();
  await service.download();
  expect(service.snapshot().phase).toBe("ready");

  includePrereleases = false;
  service.refreshSchedule();

  expect(driver.discardDownload).toHaveBeenCalledOnce();
  expect(service.snapshot()).toMatchObject({
    phase: "idle",
    feedUrl: "https://eda.kirameki.cafe/api/updates/v1/stable/win/x64/",
    release: null,
    error: null,
    checkedAt: null,
  });

  await expect(service.install()).rejects.toThrow(/before installing/);
  await service.check();

  expect(options.createDriver).toHaveBeenLastCalledWith(
    "https://eda.kirameki.cafe/api/updates/v1/stable/win/x64/",
  );

  includePrereleases = true;
  service.refreshSchedule();
  expect(service.snapshot().release).toBeNull();

  await service.check();

  expect(options.createDriver).toHaveBeenLastCalledWith(
    "https://eda.kirameki.cafe/api/updates/v1/preview/win/x64/",
  );
});

it("defers an audience switch until an in-flight check finishes and returns the new state", async () => {
  let includePrereleases = true;
  const { service, driver } = fixture({ includePrereleases: () => includePrereleases });

  let finish!: (value: { available: boolean; release: typeof release }) => void;
  vi.mocked(driver.check).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );

  const pending = service.check();
  await vi.waitFor(() => expect(driver.check).toHaveBeenCalledOnce());

  includePrereleases = false;
  service.refreshSchedule();
  expect(service.snapshot().phase).toBe("checking");

  finish({ available: true, release });

  expect(await pending).toMatchObject({ phase: "idle", release: null });
  expect(service.snapshot().feedUrl).toContain("/stable/");
});

it("treats DNS failures as connectivity errors rather than an undeployed service", () => {
  expect(updateError(new Error("getaddrinfo ENOTFOUND eda.kirameki.cafe"), "check")).toMatch(
    /Could not reach the update service/,
  );
});

it("compares numeric stable releases, refuses same-version rebuilds and discovers later offers", async () => {
  expect(newerRelease("0.0.10", "0.0.9")).toBe(true);
  expect(newerRelease("0.0.1", "0.0.1")).toBe(false);
  expect(newerRelease("0.0.1", "0.1.0")).toBe(false);
  expect(() => newerRelease("0.0.1-abcdef-dirty", "0.0.1")).toThrow();
  const { service, driver } = fixture();
  vi.mocked(driver.check).mockResolvedValueOnce({
    available: true,
    release: { ...release, version: "0.0.1" },
  });
  await service.check();
  expect(service.snapshot().phase).toBe("current");
  await service.check();
  vi.mocked(driver.check).mockResolvedValueOnce({
    available: true,
    release: { ...release, version: "0.0.3" },
  });
  await service.check();
  expect(service.snapshot().release?.version).toBe("0.0.3");
});

it("does not check or replace development and manual installations", async () => {
  for (const capability of ["development", "manual"] as const) {
    const { service, options } = fixture({ capability });
    vi.useFakeTimers();
    service.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL * 2);
    expect(options.createDriver).not.toHaveBeenCalled();
    expect(() => service.check()).toThrow();
    service.stop();
    vi.useRealTimers();
  }
});

it("checks after three seconds, repeats every six hours, and honors the automatic check setting", async () => {
  vi.useFakeTimers();
  let enabled = true;
  const { service, driver } = fixture({ automaticChecks: () => enabled });
  vi.mocked(driver.check).mockResolvedValue({ available: false, release });
  service.start();
  await vi.advanceTimersByTimeAsync(2_999);
  expect(driver.check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(driver.check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
  expect(driver.check).toHaveBeenCalledTimes(2);
  enabled = false;
  service.refreshSchedule();
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
  expect(driver.check).toHaveBeenCalledTimes(2);
  service.stop();
});

it("recovers from shutdown refusal and asynchronous native installation failures", async () => {
  const { service, driver, options, rollback } = fixture();
  await service.check();
  await service.download();
  vi.mocked(options.prepareInstall).mockRejectedValueOnce(new Error("Busy"));
  await service.install();
  expect(service.snapshot().phase).toBe("ready");
  expect(driver.install).not.toHaveBeenCalled();
  vi.mocked(driver.install).mockRejectedValueOnce(new Error("signature verification failed"));
  await service.install();
  expect(service.snapshot()).toMatchObject({
    phase: "ready",
    error: expect.stringContaining("verified"),
  });
  expect(rollback).toHaveBeenCalledOnce();
});

it("maps Velopack full packages and uses markdown notes as plain text", () => {
  const info: VelopackAsset = {
    PackageId: "Eda",
    Version: "0.0.2",
    Type: "Full",
    FileName: "Eda-0.0.2-win-x64-stable-full.nupkg",
    SHA1: "a".repeat(40),
    SHA256: "b".repeat(64),
    Size: 100,
    NotesMarkdown: "<script>These notes are rendered as text.</script>",
    NotesHtml: "<script>ignored</script>",
  };
  expect(releaseFromManifest(info)).toEqual({
    version: "0.0.2",
    name: "Eda 0.0.2",
    notes: info.NotesMarkdown,
    releasedAt: null,
  });
  for (const change of [
    { PackageId: "Other" },
    { Type: "Delta" },
    { Version: "0.0.2-beta" },
    { Version: ["0.0.2"] },
    { NotesMarkdown: {} },
  ])
    expect(() => releaseFromManifest({ ...info, ...change })).toThrow();
});

function homebrewFixture() {
  const homebrew = {
    check: vi.fn(async (_version: string): Promise<string | null> => null),
    install: vi.fn(async (_version: string) => {}),
    restart: vi.fn(),
  };
  const checkRelease = vi.fn(async () => ({ available: true, release }));
  return {
    ...fixture({ capability: "homebrew", homebrew, checkRelease }),
    homebrew,
    checkRelease,
  };
}

it("withholds Homebrew installation until the announced release is available in the cask", async () => {
  const { service, homebrew, driver, options } = homebrewFixture();
  homebrew.check.mockResolvedValueOnce("The cask is not available yet.");

  await service.check();
  expect(service.snapshot()).toMatchObject({
    phase: "current",
    release: null,
    reason: "The cask is not available yet.",
  });
  await expect(service.install()).rejects.toThrow();
  expect(options.prepareInstall).not.toHaveBeenCalled();
  expect(homebrew.install).not.toHaveBeenCalled();

  await service.check();
  expect(service.snapshot()).toMatchObject({ phase: "available", release, reason: null });
  expect(homebrew.check).toHaveBeenLastCalledWith(release.version);
  expect(() => service.download()).toThrow();
  await service.install();
  expect(homebrew.install).toHaveBeenCalledExactlyOnceWith(release.version);
  expect(homebrew.restart).toHaveBeenCalledOnce();
  expect(driver.install).not.toHaveBeenCalled();
  expect(options.createDriver).not.toHaveBeenCalled();
});

it("keeps Homebrew failures blocked until another successful check, restores app operations and allows retry", async () => {
  const { service, homebrew, rollback } = homebrewFixture();
  await service.check();
  let fail!: (error: Error) => void;
  homebrew.install.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const pending = service.install();
  await vi.waitFor(() => expect(homebrew.install).toHaveBeenCalledOnce());
  expect(service.blocksQuit).toBe(true);
  await expect(service.install()).rejects.toThrow();
  fail(new Error("Upgrade failed"));
  await pending;

  expect(service.blocksQuit).toBe(false);
  expect(service.snapshot()).toMatchObject({
    phase: "idle",
    release: null,
    error: expect.any(String),
  });
  expect(rollback).toHaveBeenCalledOnce();
  expect(homebrew.restart).not.toHaveBeenCalled();
  await expect(service.install()).rejects.toThrow();
  await service.check();
  homebrew.restart.mockImplementationOnce(() => expect(service.blocksQuit).toBe(false));
  await service.install();
  expect(homebrew.restart).toHaveBeenCalledOnce();
});

it("never offers a Homebrew update after a failed cask check or when the release is not newer", async () => {
  const { service, homebrew, checkRelease } = homebrewFixture();
  homebrew.check.mockRejectedValueOnce(new Error("Homebrew unavailable"));
  await service.check();
  expect(service.snapshot()).toMatchObject({ phase: "error", release: null });
  await expect(service.install()).rejects.toThrow();
  checkRelease.mockResolvedValueOnce({
    available: true,
    release: { ...release, version: "0.0.1" },
  });
  await service.check();
  expect(service.snapshot().phase).toBe("current");
  expect(homebrew.check).toHaveBeenCalledOnce();
});

it("restores app operations and reports an asynchronous Homebrew restart failure", async () => {
  const { service, homebrew, rollback } = homebrewFixture();
  await service.check();
  homebrew.restart.mockRejectedValueOnce(new Error("fixture restart failure"));
  await service.install();
  expect(homebrew.install).toHaveBeenCalledExactlyOnceWith(release.version);
  expect(rollback).toHaveBeenCalledOnce();
  expect(service.blocksQuit).toBe(false);
  expect(service.snapshot()).toMatchObject({
    phase: "idle",
    release: null,
    error: expect.any(String),
  });
});
