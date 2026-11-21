import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import type * as FileSystem from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryWatcher } from "@main/repo/lifecycle/repository-watcher";

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof FileSystem>()),
  watch: vi.fn(),
}));

const nativeWatch = (await vi.importActual<typeof FileSystem>("node:fs")).watch;
const handles: (EventEmitter & { close: ReturnType<typeof vi.fn> })[] = [];
const subscriptions: RepositoryWatcher[] = [];
const create = (onChange: (id: string, warning?: string) => void) => {
  const subscription = new RepositoryWatcher(onChange, 20);
  subscriptions.push(subscription);
  return subscription;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(watch).mockImplementation(() => {
    const handle = Object.assign(new EventEmitter(), { close: vi.fn() });
    handles.push(handle);
    return handle as unknown as FSWatcher;
  });
});

afterEach(() => {
  for (const subscription of subscriptions) subscription.closeAll();
  subscriptions.length = handles.length = 0;
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("coalesces named and unnamed changes while filtering Git internal churn", () => {
  const change = vi.fn();

  create(change).watch("repo", "/repo");

  const handle = handles[0]!;

  for (const path of [".git/objects/ab/cd", ".git/index.lock", ".git/COMMIT_EDITMSG"])
    handle.emit("change", "change", path);

  vi.advanceTimersByTime(100);
  expect(change).not.toHaveBeenCalled();

  for (const path of [null, undefined, Buffer.from(".git/HEAD"), "src/file.ts"])
    handle.emit("change", "change", path);

  vi.advanceTimersByTime(20);
  expect(change).toHaveBeenCalledExactlyOnceWith("repo");
});

it("ignores events from replaced watches and cancels pending work on close", () => {
  const change = vi.fn();
  const subscription = create(change);

  subscription.watch("repo", "/old");
  handles[0]!.emit("change", "change", null);
  subscription.watch("repo", "/new");
  expect(handles[0]!.close).toHaveBeenCalledOnce();

  handles[0]!.emit("error", new Error("late watcher failure"));
  handles[0]!.emit("change", "change", "old.txt");
  vi.advanceTimersByTime(5000);
  expect(change).not.toHaveBeenCalled();

  handles[1]!.emit("change", "change", "new.txt");
  subscription.closeAll();
  vi.advanceTimersByTime(5000);
  expect(change).not.toHaveBeenCalled();
  expect(handles[1]!.close).toHaveBeenCalledOnce();
});

it.each(["creation", "runtime"] as const)(
  "falls back to scoped polling after a %s failure and stops on unwatch",
  (failure) => {
    const change = vi.fn();
    const subscription = create(change);

    if (failure === "creation")
      vi.mocked(watch).mockImplementationOnce(() => {
        throw new Error("unavailable");
      });

    subscription.watch("repo", "/repo");

    if (failure === "runtime") handles[0]!.emit("error", new Error("overflow"));

    expect(change).toHaveBeenCalledWith("repo", expect.stringContaining("refreshes"));

    change.mockClear();
    vi.advanceTimersByTime(5000);
    expect(change).toHaveBeenCalledExactlyOnceWith("repo");

    subscription.unwatch("repo");
    change.mockClear();
    vi.advanceTimersByTime(10000);
    expect(change).not.toHaveBeenCalled();
  },
);

it("delivers real filesystem changes to the owning repository", async () => {
  vi.useRealTimers();
  vi.mocked(watch).mockImplementation(nativeWatch);

  const root = await mkdtemp(join(tmpdir(), "eda-watch-"));
  const change = vi.fn();
  const subscription = create(change);

  try {
    subscription.watch("repo", root);
    await writeFile(join(root, "file.txt"), "changed");
    await vi.waitFor(() => expect(change).toHaveBeenCalledWith("repo"));
    expect(change.mock.calls.every(([id, warning]) => id === "repo" && warning === undefined)).toBe(
      true,
    );
  } finally {
    subscription.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

it("refreshes a linked worktree after external changes to its index and shared refs", async () => {
  vi.useRealTimers();
  vi.mocked(watch).mockImplementation(nativeWatch);
  const root = await mkdtemp(join(tmpdir(), "eda-linked-watch-"));
  const work = join(root, "work");
  const gitDir = join(root, "common", "worktrees", "work");
  const commonDir = join(root, "common");
  const change = vi.fn();
  const subscription = create(change);
  try {
    await mkdir(work);
    await mkdir(gitDir, { recursive: true });
    await mkdir(join(commonDir, "refs", "heads"), { recursive: true });
    subscription.watch("linked", work, { gitDir, commonDir });
    await writeFile(join(gitDir, "index"), "index");
    await vi.waitFor(() => expect(change).toHaveBeenCalledWith("linked"));
    change.mockClear();
    await writeFile(join(commonDir, "refs", "heads", "topic"), "tip");
    await vi.waitFor(() => expect(change).toHaveBeenCalledWith("linked"));
  } finally {
    subscription.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
