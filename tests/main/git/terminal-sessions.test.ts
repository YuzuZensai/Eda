import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { it, expect } from "vitest";
import { TerminalSessions } from "@main/git/terminal-sessions";
import { defaultTerminalOptions } from "@shared/repository/terminal";
import { createTempRepo } from "../../helpers/temp-repo";

it("runs real shells in each worktree, retains output across tab switches, resizes, searches and isolates owners", async () => {
  const repo = await createTempRepo();
  const sessions = new TerminalSessions();
  const owner = { windowId: 2, profileId: "work", repositoryId: "repo", cwd: repo.path };
  try {
    const id = await sessions.start(owner, defaultTerminalOptions, () => true);
    const other = await sessions.start(owner, defaultTerminalOptions, () => true);
    sessions.resize(owner, id, 76, 12);
    const command =
      process.platform === "win32"
        ? "echo hello> terminal-fixture.txt & echo terminal-ready"
        : "test -t 0 && printf hello > terminal-fixture.txt && echo terminal-ready";
    sessions.input(owner, id, command + "\r", false);
    await expect
      .poll(() => readFile(join(repo.path, "terminal-fixture.txt"), "utf8").catch(() => ""))
      .toMatch(/hello/);
    expect(sessions.busyAt(repo.path)).toBe(true);
    const remove = vi.fn(async () => undefined);
    await expect(sessions.whileWorktreeIdle(repo.path, remove)).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
    sessions.move(owner, id, 1);
    expect(sessions.list(owner).map((s) => s.id)).toEqual([other, id]);
    await expect
      .poll(() => sessions.frame(owner, id, null, "terminal-ready", -1)?.lines.join("\n"))
      .toContain("terminal-ready");
    expect(sessions.frame(owner, id, null, "", -1)?.lines).toHaveLength(12);
    const otherOwner = { ...owner, profileId: "home" };
    expect(sessions.list(otherOwner)).toEqual([]);
    expect(() => sessions.input(otherOwner, id, "exit\r", false)).toThrow();
    sessions.input(owner, id, "exit 0\r", false);
    await expect.poll(() => sessions.list(owner).find((tab) => tab.id === id)?.exit).toBe(0);
    sessions.close(owner, id);
    expect(sessions.list(owner)).toHaveLength(1);
    sessions.close(owner, other);
    await sessions.whileWorktreeIdle(repo.path, async () => {
      await expect(sessions.start(owner, defaultTerminalOptions, () => true)).rejects.toThrow();
    });
  } finally {
    sessions.dispose();
    await repo.cleanup();
  }
});

it("cancels pending shells only for the disposed window or forgotten repository", async () => {
  const repo = await createTempRepo();
  const sessions = new TerminalSessions();
  const owner = { windowId: 1, profileId: "work", repositoryId: "repo", cwd: repo.path };
  const otherWindow = { ...owner, windowId: 2 };
  const otherRepo = { ...otherWindow, repositoryId: "other" };

  try {
    const closed = sessions.start(owner, defaultTerminalOptions, () => true);
    const forgotten = sessions.start(otherRepo, defaultTerminalOptions, () => true);
    const retained = sessions.start(otherWindow, defaultTerminalOptions, () => true);
    sessions.dispose(owner.windowId);
    sessions.forget(otherRepo.profileId, otherRepo.repositoryId);

    await Promise.all([
      expect(closed).rejects.toThrow(),
      expect(forgotten).rejects.toThrow(),
      expect(retained).resolves.toEqual(expect.any(String)),
    ]);
    expect(sessions.list(owner)).toHaveLength(0);
    expect(sessions.list(otherRepo)).toHaveLength(0);
    expect(sessions.list(otherWindow)).toHaveLength(1);
  } finally {
    sessions.dispose();
    await repo.cleanup();
  }
});
