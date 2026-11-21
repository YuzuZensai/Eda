import { describe, expect, it, vi } from "vitest";
import {
  SHELL_COMMANDS,
  commandReason,
  dispatchCommand,
  searchCommands,
  configuredCommands,
  shortcutCommand,
  shortcutLabel,
  type CommandContext,
  type ShellCommandId,
} from "@renderer/commands/shell-commands";

const ready: CommandContext = {
  profileId: "work",
  repositoryId: "repo-a",
  generation: 3,
  loading: false,
  transitioning: false,
  workspace: true,
  available: true,
  reading: false,
  writing: false,
  tabs: ["repo-a", "repo-b"],
  canReopen: false,
};

const command = (id: ShellCommandId) => SHELL_COMMANDS.find((entry) => entry.id === id)!;
const key = (value: string, overrides: Partial<Parameters<typeof shortcutCommand>[0]> = {}) => ({
  key: value,
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  repeat: false,
  ...overrides,
});

describe("shell commands", () => {
  it("gates local actions on selected commits, staged state and configured tools", () => {
    expect(
      commandReason(command("repository.stageAll"), {
        ...ready,
        unstagedCount: 1,
        writeUnavailable: "Read-only fixture",
      }),
    ).toBe("Read-only fixture");
    expect(commandReason(command("repository.editor"), ready)).toContain("editor executable");
    expect(
      commandReason(command("repository.editor"), { ...ready, editorConfigured: true }),
    ).toBeNull();
    expect(commandReason(command("repository.stageAll"), ready)).toContain("no working changes");
    expect(
      commandReason(command("repository.stageAll"), { ...ready, unstagedCount: 2 }),
    ).toBeNull();
    expect(
      commandReason(command("repository.unstageAll"), { ...ready, stagedCount: 1 }),
    ).toBeNull();
    expect(commandReason(command("repository.createTag"), ready)).toContain("first commit");
    expect(
      commandReason(command("repository.createTag"), { ...ready, commitOid: "a".repeat(40) }),
    ).toBeNull();
  });

  it("offers direct stash and pop commands and gates stashing on changes and write access", () => {
    expect(commandReason(command("repository.stash"), ready)).toContain("no changes");
    expect(commandReason(command("repository.stash"), { ...ready, stagedCount: 1 })).toBeNull();
    expect(commandReason(command("repository.stash"), { ...ready, unstagedCount: 1 })).toBeNull();
    expect(commandReason(command("repository.popStash"), ready)).toBeNull();
    for (const id of ["repository.stash", "repository.popStash"] as const)
      expect(commandReason(command(id), { ...ready, writeUnavailable: "Read only" })).toBe(
        "Read only",
      );
    expect(searchCommands("stash").map((entry) => entry.id)).toEqual([
      "repository.stash",
      "repository.popStash",
    ]);
  });

  it("uses unique IDs and unambiguous shortcuts", () => {
    expect(new Set(SHELL_COMMANDS.map((entry) => entry.id)).size).toBe(SHELL_COMMANDS.length);
    const keys = SHELL_COMMANDS.flatMap((entry) =>
      entry.shortcut ? [JSON.stringify(entry.shortcut)] : [],
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("explains missing, unavailable and busy repositories while navigation remains available", () => {
    expect(
      commandReason(command("repository.refresh"), { ...ready, repositoryId: null }),
    ).toContain("Select a repository");
    expect(commandReason(command("repository.refresh"), { ...ready, available: false })).toContain(
      "Locate",
    );
    expect(commandReason(command("repository.refresh"), { ...ready, writing: true })).toContain(
      "operation",
    );
    expect(commandReason(command("repository.refresh"), { ...ready, reading: true })).toContain(
      "loading",
    );
    expect(commandReason(command("repository.refresh"), { ...ready, workspace: false })).toContain(
      "workspace",
    );
    expect(commandReason(command("profiles.manage"), { ...ready, repositoryId: null })).toBeNull();
  });

  it("keeps tab positions and closed history scoped to the supplied profile", () => {
    expect(commandReason(command("tab.2"), ready)).toBeNull();
    expect(commandReason(command("tab.3"), ready)).toContain("no repository tab");
    expect(commandReason(command("tab.9"), ready)).toBeNull();
    expect(commandReason(command("tabs.reopen"), ready)).toContain("this profile");
    expect(commandReason(command("tabs.reopen"), { ...ready, canReopen: true })).toBeNull();
  });

  it.each(["loading", "transitioning"] as const)("blocks dispatch while %s", (state) => {
    const execute = vi.fn();
    expect(dispatchCommand("profiles.create", { ...ready, [state]: true }, execute)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { profileId: "home" },
    { repositoryId: "repo-b" },
    { generation: 4 },
    { workspace: false },
  ])("rejects stale palette context %o", (changed) => {
    const execute = vi.fn();
    expect(dispatchCommand("tabs.close", { ...ready, ...changed }, execute, ready)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rechecks availability when a displayed command is invoked", () => {
    const execute = vi.fn();
    expect(dispatchCommand("repository.refresh", { ...ready, writing: true }, execute, ready)).toBe(
      false,
    );
    expect(dispatchCommand("repository.refresh", ready, execute, ready)).toBe(true);
    expect(execute).toHaveBeenCalledExactlyOnceWith("repository.refresh", ready);
  });

  it("searches action names and keywords without losing disabled actions", () => {
    expect(searchCommands("  identity manage ").map((entry) => entry.id)).toEqual([
      "profiles.manage",
    ]);
    expect(searchCommands("reload disk").map((entry) => entry.id)).toEqual(["repository.refresh"]);
    expect(searchCommands("unfindable")).toEqual([]);
  });

  it("uses Command on macOS and Control on Windows/Linux", () => {
    expect(shortcutCommand(key("P", { shiftKey: true }), "windows")?.id).toBe("commands.open");
    expect(shortcutCommand(key("p"), "linux")?.id).toBe("repositories.browse");
    expect(shortcutCommand(key("p"), "mac")).toBeUndefined();
    expect(shortcutCommand(key("p", { ctrlKey: false, metaKey: true }), "mac")?.id).toBe(
      "repositories.browse",
    );
    expect(shortcutLabel({ key: "p", shift: true }, "mac")).toBe("Cmd+Shift+P");
  });

  it("matches reassigned shortcuts and removes the previous binding", () => {
    const commands = configuredCommands({ "commands.open": "shift+k", "repositories.browse": "" });
    expect(shortcutCommand(key("K", { shiftKey: true }), "linux", commands)?.id).toBe(
      "commands.open",
    );
    expect(shortcutCommand(key("p", { shiftKey: true }), "linux", commands)).toBeUndefined();
    expect(shortcutCommand(key("p"), "linux", commands)).toBeUndefined();
  });

  it("does not bind native editing shortcuts, composition, repeats or extra modifiers", () => {
    for (const value of ["z", "y", "x", "c", "v", "a"])
      expect(shortcutCommand(key(value), "windows")).toBeUndefined();

    for (const extra of [
      { altKey: true },
      { isComposing: true },
      { repeat: true },
      { metaKey: true },
    ])
      expect(shortcutCommand(key("w", extra), "windows")).toBeUndefined();
  });
});
