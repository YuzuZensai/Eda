import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempRepo, type TempRepo } from "../../helpers/temp-repo";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { SettingsRepository } from "@main/persistence/settings-repository";
import type { Database } from "@main/persistence/types";
import { IdentityManager } from "@main/identity/identity-manager";

const fixtures: { repo: TempRepo; db: Database }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  for (const { repo, db } of fixtures.splice(0)) {
    db.close();
    await repo.cleanup();
  }
});

async function setup(homeSync?: boolean) {
  const repo = await createTempRepo();
  const db = openInMemoryDatabase();

  fixtures.push({ repo, db });

  const profiles = new IdentityRepository(db);

  const work = profiles.create({
    name: "Work",
    gitName: "Eda Work",
    gitEmail: "work@example.com",
    hue: 210,
    signing: { format: "none", signCommits: false },
  });

  const home = profiles.create(
    {
      name: "Home",
      gitName: "Eda Home",
      gitEmail: "home@example.com",
      hue: 330,
      signing: { format: "none", signCommits: false },
    },
    homeSync === undefined ? {} : { syncGlobalGitConfig: homeSync },
  );

  const settings = new SettingsRepository(db);
  const manager = new IdentityManager(profiles, repo.git, settings);

  return { repo, profiles, settings, manager, work, home };
}

describe("profile Git synchronization", () => {
  it("repairs external global edits only on explicit apply without switching the profile", async () => {
    const { manager, work, repo } = await setup();
    await manager.setActive(work.id);
    await repo.git.writeConfig("user.email", "external@example.com", { scope: "global" });
    expect(manager.getActive()?.gitEmail).toBe(work.gitEmail);

    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(
      "external@example.com",
    );

    await manager.reapplyGlobal(work.id);
    expect(manager.getActive()?.id).toBe(work.id);
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(work.gitEmail);
  });

  it("rejects a stale apply and respects application defaults and profile sync overrides", async () => {
    const { manager, work, home, settings, repo } = await setup();
    await manager.setActive(work.id);
    await expect(manager.reapplyGlobal(home.id)).rejects.toThrow(/active profile changed/);
    settings.set("syncGlobalGitConfig", { kind: "application" }, false);
    await repo.git.writeConfig("user.email", "external@example.com", { scope: "global" });
    await expect(manager.reapplyGlobal(work.id)).rejects.toThrow(/disabled/);

    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(
      "external@example.com",
    );

    settings.set("syncGlobalGitConfig", { kind: "profile", profileId: work.id }, true);
    await manager.reapplyGlobal(work.id);
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(work.gitEmail);
    settings.set("syncGlobalGitConfig", { kind: "profile", profileId: work.id }, false);
    await expect(manager.reapplyGlobal(work.id)).rejects.toThrow(/disabled/);
  });

  it("does not apply an old profile after a queued profile switch", async () => {
    const { manager, work, home, repo } = await setup();
    await manager.setActive(work.id);
    const switching = manager.setActive(home.id);
    const applying = manager.reapplyGlobal(work.id);
    const result = await Promise.allSettled([switching, applying]);
    expect(result.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(home.gitEmail);
  });

  it("preserves machine helper, tool, proxy and certificate configuration across profile switches", async () => {
    const { manager, work, home, repo } = await setup();

    const configuration = {
      "credential.helper": "manager",
      "credential.useHttpPath": "true",
      "gpg.program": "/tools/gpg",
      "core.sshCommand": "ssh -F /tools/ssh-config",
      "http.proxy": "http://proxy.example.com:8080",
      "http.sslCAInfo": "/trust/company.pem",
    };

    for (const [key, value] of Object.entries(configuration))
      await repo.git.writeConfig(key, value, { scope: "global" });

    await manager.setActive(work.id);
    await manager.setActive(home.id);

    for (const [key, value] of Object.entries(configuration))
      expect(await repo.git.readConfig(key, { scope: "global" })).toBe(value);
  });

  it("compensates an explicit local apply failure without changing unrelated Git keys", async () => {
    const { manager, work, repo } = await setup();

    await repo.git.writeConfig("user.name", "Original", { cwd: repo.path, scope: "local" });
    await repo.git.writeConfig("core.editor", "my-editor", { cwd: repo.path, scope: "local" });

    const original = repo.git.writeConfig.bind(repo.git);

    vi.spyOn(repo.git, "writeConfig").mockImplementation(async (key, value, options) => {
      if (key === "user.email") throw new Error("config denied");
      return original(key, value, options);
    });

    await expect(manager.applyToRepository(repo.path, work)).rejects.toThrow(/denied/);

    expect(await repo.git.readConfig("user.name", { cwd: repo.path, scope: "local" })).toBe(
      "Original",
    );

    expect(await repo.git.readConfig("core.editor", { cwd: repo.path, scope: "local" })).toBe(
      "my-editor",
    );
  });

  it("defaults on and lets each profile opt out without clearing current values", async () => {
    const { repo, settings, manager, work, home } = await setup(false);

    await manager.setActive(work.id);
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(work.gitEmail);

    await manager.setActive(home.id);
    expect(manager.getActive()?.id).toBe(home.id);
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(work.gitEmail);

    settings.reset("syncGlobalGitConfig", { kind: "profile", profileId: home.id });
    await manager.setActive(home.id);
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(home.gitEmail);
  });

  it("supports application defaults while preserving explicit profile overrides", async () => {
    const { repo, settings, manager, work, home } = await setup();
    settings.set("syncGlobalGitConfig", { kind: "application" }, false);
    settings.set("syncGlobalGitConfig", { kind: "profile", profileId: work.id }, true);
    await manager.setActive(work.id);
    await manager.setActive(home.id);
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(work.gitEmail);
  });

  it("saves an active profile without replacing its ID or key assignment", async () => {
    const { profiles, manager, work, repo } = await setup();
    await manager.setActive(work.id);
    profiles.assignSshKey(work.id, "/existing/key");
    const updated = await manager.update(work.id, { name: "Renamed", gitEmail: "new@example.com" });
    expect(updated).toMatchObject({ id: work.id, name: "Renamed", sshKeyPath: "/existing/key" });
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe("new@example.com");
  });

  it("removes the previous signing key from the profile and Git when signing is disabled", async () => {
    const { profiles, manager, work, repo } = await setup();
    await manager.setActive(work.id);
    await manager.update(work.id, {
      signing: { format: "gpg", keyRef: "ABCD1234", signCommits: true },
    });

    const disabled = { format: "none", signCommits: false } as const;
    await manager.update(work.id, { signing: disabled });
    expect(profiles.findById(work.id)?.signing).toEqual(disabled);
    expect(await repo.git.readConfig("user.signingkey", { scope: "global" })).toBeUndefined();
  });

  it("does not synchronize edits to a background profile", async () => {
    const { manager, work, home, repo } = await setup();
    await manager.setActive(work.id);
    await manager.update(home.id, { gitEmail: "different@example.com" });
    expect(manager.getActive()?.id).toBe(work.id);
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(work.gitEmail);
  });

  it("retains metadata and active profile when saving fails during Git synchronization", async () => {
    const { profiles, manager, work, repo } = await setup();

    await manager.setActive(work.id);

    const original = repo.git.writeConfig.bind(repo.git);

    vi.spyOn(repo.git, "writeConfig").mockImplementation(async (key, value, options) => {
      if (key === "user.email") throw new Error("read-only config");
      return original(key, value, options);
    });

    await expect(
      manager.update(work.id, { gitName: "New name", gitEmail: "new@example.com" }),
    ).rejects.toThrow();

    expect(profiles.findById(work.id)?.gitEmail).toBe(work.gitEmail);
    expect(manager.getActive()?.id).toBe(work.id);
    expect(await repo.git.readConfig("user.name", { scope: "global" })).toBe(work.gitName);
  });

  it("preserves external edits during compensation and reports reconciliation", async () => {
    const { manager, work, home, repo } = await setup();

    await manager.setActive(work.id);

    const original = repo.git.writeConfig.bind(repo.git);

    vi.spyOn(repo.git, "writeConfig").mockImplementation(async (key, value, options) => {
      if (key === "user.email") {
        await original("user.name", "External author", { scope: "global" });
        throw new Error("another client changed config");
      }

      return original(key, value, options);
    });

    await expect(manager.setActive(home.id)).rejects.toMatchObject({
      kind: "config-write-refused",
      suggestedAction: expect.stringContaining("user.name"),
    });

    expect(await repo.git.readConfig("user.name", { scope: "global" })).toBe("External author");
    expect(manager.getActive()?.id).toBe(work.id);
  });

  it("rejects case-insensitive duplicate names before changing Git configuration", async () => {
    const { manager, work, home, repo } = await setup();
    await manager.setActive(work.id);

    await expect(manager.update(work.id, { name: home.name.toUpperCase() })).rejects.toMatchObject({
      kind: "invalid-input",
    });

    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(work.gitEmail);
  });

  it("rejects normalized duplicate names before making any Git writes", async () => {
    const { manager, work, repo, profiles } = await setup();
    await manager.setActive(work.id);
    const writes = vi.spyOn(repo.git, "writeConfig");

    await expect(
      manager.update(work.id, {
        name: "  Ｈｏｍｅ  ",
        gitName: "Changed author",
      }),
    ).rejects.toMatchObject({ kind: "invalid-input" });

    expect(writes).not.toHaveBeenCalled();
    expect(profiles.findById(work.id)?.gitName).toBe(work.gitName);
  });

  it("rolls global configuration back when saving profile metadata fails", async () => {
    const { manager, work, repo, profiles } = await setup();
    await manager.setActive(work.id);

    vi.spyOn(profiles, "update").mockImplementation(() => {
      throw new Error("database unavailable");
    });

    await expect(
      manager.update(work.id, {
        gitName: "New author",
        gitEmail: "new@example.com",
      }),
    ).rejects.toThrow("database unavailable");

    expect(await repo.git.readConfig("user.name", { scope: "global" })).toBe(work.gitName);
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(work.gitEmail);
    expect(manager.getActive()?.id).toBe(work.id);
  });

  it("preserves external local config edits when a later write fails", async () => {
    const { manager, work, repo } = await setup();
    const options = { cwd: repo.path, scope: "local" as const };
    const write = repo.git.writeConfig.bind(repo.git);
    await write("user.name", "Original", options);

    vi.spyOn(repo.git, "writeConfig").mockImplementation(async (key, value, options) => {
      if (key === "user.email") {
        await write("user.name", "External author", options);
        throw new Error("write interrupted");
      }

      return write(key, value, options);
    });

    await expect(manager.applyToRepository(repo.path, work)).rejects.toMatchObject({
      kind: "config-write-refused",
    });

    expect(await repo.git.readConfig("user.name", options)).toBe("External author");
  });
});
