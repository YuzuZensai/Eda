import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { SettingsRepository } from "@main/persistence/settings-repository";
import { repositories, settingOverrides } from "@main/persistence/schema";
import type { Database } from "@main/persistence/types";

const nordPreference = { mode: "dark", light: "nord-light", dark: "nord" } as const;
const lavenderPreference = {
  mode: "dark",
  light: "lavender-light",
  dark: "lavender-dark",
} as const;
const lightPreference = { mode: "light", light: "eda-light", dark: "eda-dark" } as const;

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) if (db.raw.isOpen) db.close();
});

function setup() {
  const db = openInMemoryDatabase();

  databases.push(db);

  const profiles = new IdentityRepository(db);
  const work = profiles.create({
    name: "Work",
    gitName: "Eda",
    gitEmail: "work@example.com",
    hue: 210,
    signing: { format: "none", signCommits: false },
    rules: [],
  });

  const home = profiles.create({
    name: "Home",
    gitName: "Eda",
    gitEmail: "home@example.com",
    hue: 210,
    signing: { format: "none", signCommits: false },
    rules: [],
  });

  db.insert(repositories)
    .values({ id: "repo", identityId: work.id, path: "/work/repo", name: "repo", createdAt: "now" })
    .run();

  return { db, work, home, profiles, store: new SettingsRepository(db) };
}

describe("preference scopes", () => {
  it("persists visible history columns globally across profiles and repositories", () => {
    const { db, store, work, home } = setup();
    const scope = { kind: "application" } as const;
    expect(store.resolve("historyVisibleColumns").value).toEqual(["author", "date", "sha"]);
    store.set("historyVisibleColumns", scope, ["date", "sha"]);
    const reloaded = new SettingsRepository(db);
    for (const profile of [work, home])
      expect(reloaded.resolve("historyVisibleColumns", { profileId: profile.id }).value).toEqual([
        "date",
        "sha",
      ]);
    expect(
      reloaded.resolve("historyVisibleColumns", { profileId: work.id, repositoryId: "repo" }).value,
    ).toEqual(["date", "sha"]);
    expect(() =>
      store.set(
        "historyVisibleColumns",
        { kind: "repository", profileId: work.id, repositoryId: "repo" },
        ["sha"],
      ),
    ).toThrow();
    store.set("historyVisibleColumns", scope, []);
    expect(new SettingsRepository(db).resolve("historyVisibleColumns").value).toEqual([]);
    store.reset("historyVisibleColumns", scope);
    expect(store.resolve("historyVisibleColumns").value).toEqual(["author", "date", "sha"]);
  });

  it("isolates profile column overrides and returns to the latest global visibility on reset", () => {
    const { db, store, work, home } = setup();
    const global = { kind: "application" } as const;
    const profile = { kind: "profile", profileId: work.id } as const;
    const context = { profileId: work.id, repositoryId: "repo" };
    store.set("historyVisibleColumns", global, ["date", "sha"]);
    store.set("historyVisibleColumns", profile, ["author"]);

    const reloaded = new SettingsRepository(db);
    expect(reloaded.resolve("historyVisibleColumns", context)).toMatchObject({
      value: ["author"],
      source: profile,
    });
    expect(reloaded.resolve("historyVisibleColumns", { profileId: home.id }).value).toEqual([
      "date",
      "sha",
    ]);
    store.set("historyVisibleColumns", global, ["sha"]);
    expect(reloaded.resolve("historyVisibleColumns", context).value).toEqual(["author"]);
    store.set("historyVisibleColumns", profile, []);
    expect(reloaded.resolve("historyVisibleColumns", context).value).toEqual([]);
    store.reset("historyVisibleColumns", profile);
    expect(reloaded.resolve("historyVisibleColumns", context)).toMatchObject({
      value: ["sha"],
      source: global,
    });
    expect(reloaded.resolve("historyVisibleColumns").value).toEqual(["sha"]);
  });

  it("hides internal history refs by default and persists the opt-in globally", () => {
    const { db, store, work, home } = setup();
    const scope = { kind: "application" } as const;
    expect(store.resolve("showInternalRefs").value).toBe(false);
    store.set("showInternalRefs", scope, true);
    const reloaded = new SettingsRepository(db);
    for (const profile of [work, home])
      expect(reloaded.resolve("showInternalRefs", { profileId: profile.id }).value).toBe(true);
    expect(() =>
      store.set("showInternalRefs", { kind: "profile", profileId: work.id }, false),
    ).toThrow();
    expect(() => store.set("showInternalRefs", scope, "true")).toThrow();
    store.reset("showInternalRefs", scope);
    expect(store.resolve("showInternalRefs").value).toBe(false);
  });

  it("persists the global vigilant mode default while preserving independent profile overrides", () => {
    const { db, store, work, home } = setup();
    const global = { kind: "application" } as const;
    const profile = { kind: "profile", profileId: work.id } as const;
    const context = { profileId: work.id, repositoryId: "repo" };

    expect(store.resolve("vigilantMode").value).toBe(false);
    store.set("vigilantMode", profile, true);

    const reloaded = new SettingsRepository(db);
    expect(reloaded.resolve("vigilantMode", context)).toMatchObject({
      value: true,
      source: profile,
    });
    expect(reloaded.resolve("vigilantMode", { profileId: home.id }).value).toBe(false);

    store.set("vigilantMode", global, true);
    store.set("vigilantMode", profile, false);
    expect(reloaded.resolve("vigilantMode", context)).toMatchObject({
      value: false,
      source: profile,
    });
    expect(reloaded.resolve("vigilantMode", { profileId: home.id })).toMatchObject({
      value: true,
      source: global,
    });
    expect(() => store.set("vigilantMode", global, "true")).toThrow();
    expect(() => store.set("vigilantMode", profile, "true")).toThrow();
    expect(() => store.set("vigilantMode", { kind: "repository", ...context }, true)).toThrow();

    store.reset("vigilantMode", profile);
    expect(reloaded.resolve("vigilantMode", context)).toMatchObject({
      value: true,
      source: global,
    });
    store.reset("vigilantMode", global);
    expect(reloaded.resolve("vigilantMode", context).value).toBe(false);
  });

  it("keeps developer settings disabled by default and persists the application opt-in", () => {
    const { db, store, work, home } = setup();
    const scope = { kind: "application" } as const;
    expect(store.resolve("developerSettingsEnabled").value).toBe(false);
    store.set("developerSettingsEnabled", scope, true);
    const reloaded = new SettingsRepository(db);
    for (const profile of [work, home])
      expect(reloaded.resolve("developerSettingsEnabled", { profileId: profile.id }).value).toBe(
        true,
      );
    expect(() => store.set("developerSettingsEnabled", scope, "true")).toThrow();
    expect(() =>
      store.set("developerSettingsEnabled", { kind: "profile", profileId: work.id }, true),
    ).toThrow();
    store.reset("developerSettingsEnabled", scope);
    expect(store.resolve("developerSettingsEnabled").value).toBe(false);
  });
  it("includes pre-release updates by default and persists the application opt-out", () => {
    const { db, store, work } = setup();
    const scope = { kind: "application" } as const;
    expect(store.resolve("includePrereleaseUpdates").value).toBe(true);
    store.set("includePrereleaseUpdates", scope, false);
    expect(new SettingsRepository(db).resolve("includePrereleaseUpdates").value).toBe(false);
    expect(() => store.set("includePrereleaseUpdates", scope, "false")).toThrow();
    expect(() =>
      store.set("includePrereleaseUpdates", { kind: "profile", profileId: work.id }, true),
    ).toThrow();
    store.reset("includePrereleaseUpdates", scope);
    expect(store.resolve("includePrereleaseUpdates").value).toBe(true);
  });
  it("requires explicit, valid repository commit overrides and isolates them by owner", () => {
    const { store, work, home } = setup();
    const context = { profileId: work.id, repositoryId: "repo" };
    const scope = { kind: "repository", ...context } as const;
    const identity = { name: "Repository Author", email: "repo@example.com" };
    expect(store.resolve("repositoryCommitIdentity", context).value).toBeNull();
    expect(() =>
      store.set("repositoryCommitIdentity", { kind: "application" }, identity),
    ).toThrow();
    expect(() =>
      store.set("repositoryCommitIdentity", { kind: "profile", profileId: work.id }, identity),
    ).toThrow();
    expect(() =>
      store.set("repositoryCommitIdentity", { ...scope, profileId: home.id }, identity),
    ).toThrow();
    for (const invalid of [
      { ...identity, name: "A <B>" },
      { ...identity, name: "A\nB" },
      { ...identity, email: "bad-email" },
    ])
      expect(() => store.set("repositoryCommitIdentity", scope, invalid)).toThrow();
    store.set("repositoryCommitIdentity", scope, identity);
    expect(store.resolve("repositoryCommitIdentity", context).value).toEqual(identity);
    expect(store.resolve("repositoryCommitIdentity", { profileId: home.id }).value).toBeNull();
    store.reset("repositoryCommitIdentity", scope);
    expect(store.resolve("repositoryCommitIdentity", context).value).toBeNull();
  });
  it("defaults to the built-in SSH agent and keeps its selection global", () => {
    const { store, work, home } = setup();
    expect(store.resolve("sshAgent").value).toBe("builtin");
    store.set("sshAgent", { kind: "application" }, "system");
    for (const profile of [work, home])
      expect(store.resolve("sshAgent", { profileId: profile.id }).value).toBe("system");
    expect(() =>
      store.set("sshAgent", { kind: "profile", profileId: work.id }, "builtin"),
    ).toThrow();
    expect(() => store.set("sshAgent", { kind: "application" }, "auto")).toThrow();
    store.reset("sshAgent", { kind: "application" });
    expect(store.resolve("sshAgent").value).toBe("builtin");
  });
  it("inherits the background fetch default and restores it after an explicit Off override", () => {
    const { store, work } = setup();
    const context = { profileId: work.id, repositoryId: "repo" };
    const scope = { kind: "repository", ...context } as const;
    expect(store.resolve("backgroundFetchMinutes", context)).toMatchObject({
      value: 5,
      source: { kind: "built-in" },
      hasOverride: false,
    });
    store.set("backgroundFetchMinutes", { kind: "application" }, 5);
    expect(store.resolve("backgroundFetchMinutes", context)).toMatchObject({
      value: 5,
      source: { kind: "application" },
    });
    store.set("backgroundFetchMinutes", scope, 0);
    store.set("backgroundFetchMinutes", { kind: "application" }, 10);
    expect(store.resolve("backgroundFetchMinutes", context)).toMatchObject({
      value: 0,
      source: scope,
    });
    store.reset("backgroundFetchMinutes", scope);
    expect(store.resolve("backgroundFetchMinutes", context)).toMatchObject({
      value: 10,
      source: { kind: "application" },
    });
    store.set("fetchPrune", scope, true);
    store.set("fetchTags", scope, true);
    expect(store.resolve("fetchPrune", context).value).toBe(true);
    expect(store.resolve("fetchTags", context).value).toBe(true);
    expect(store.resolve("fetchPrune", { profileId: work.id }).value).toBe(true);
  });

  it("prunes deleted remote branches by default and preserves a repository opt-out", () => {
    const { db, store, work } = setup();
    const context = { profileId: work.id, repositoryId: "repo" };
    const scope = { kind: "repository", ...context } as const;

    expect(store.resolve("fetchPrune", context).value).toBe(true);
    store.set("fetchPrune", scope, false);
    expect(new SettingsRepository(db).resolve("fetchPrune", context).value).toBe(false);
    store.reset("fetchPrune", scope);
    expect(store.resolve("fetchPrune", context).value).toBe(true);
  });

  it("defaults to bundled Git and shares engine selection across profiles", () => {
    const { store, work, home } = setup();

    expect(store.resolve("gitEngine").value).toBe("bundled");

    store.set("gitEngine", { kind: "application" }, "system");

    for (const profile of [work, home])
      expect(store.resolve("gitEngine", { profileId: profile.id }).value).toBe("system");

    expect(() =>
      store.set("gitEngine", { kind: "profile", profileId: work.id }, "bundled"),
    ).toThrow(/cannot be changed/);
    expect(() => store.set("gitEngine", { kind: "application" }, "/arbitrary/git")).toThrow(
      /Invalid value/,
    );

    store.reset("gitEngine", { kind: "application" });
    expect(store.resolve("gitEngine").value).toBe("bundled");
  });

  it("inherits application defaults without copying rows to profiles", () => {
    const { db, store, work, home } = setup();

    store.set("theme", { kind: "application" }, nordPreference);

    for (const profile of [work, home])
      expect(store.resolve("theme", { profileId: profile.id })).toMatchObject({
        value: nordPreference,
        source: { kind: "application" },
        hasOverride: false,
      });

    expect(db.select().from(settingOverrides).all()).toEqual([]);
  });

  it("isolates profile overrides and resets to the current inherited value", () => {
    const { store, work, home } = setup();
    const scope = { kind: "profile", profileId: work.id } as const;

    store.set("theme", scope, lavenderPreference);
    store.set("theme", { kind: "application" }, nordPreference);
    expect(store.resolve("theme", { profileId: work.id })).toMatchObject({
      value: lavenderPreference,
      hasOverride: true,
    });
    expect(store.resolve("theme", { profileId: home.id }).value).toEqual(nordPreference);

    store.reset("theme", scope);
    expect(store.resolve("theme", { profileId: work.id })).toMatchObject({
      value: nordPreference,
      source: { kind: "application" },
      hasOverride: false,
    });

    store.reset("theme", { kind: "application" });
    expect(store.resolve("theme").source.kind).toBe("built-in");
  });

  it("inherits presentation settings and isolates independent profile overrides", () => {
    const { store, work, home } = setup();
    const scope = { kind: "profile", profileId: work.id } as const;

    store.set("uiZoom", { kind: "application" }, 125);
    store.set("reducedMotion", { kind: "application" }, true);
    store.set("accentHue", { kind: "application" }, 190);
    store.set("uiZoom", scope, 150);
    store.set("reducedMotion", scope, false);
    store.set("accentHue", scope, 330);
    expect(store.resolve("accentHue", { profileId: work.id }).value).toBe(330);
    expect(store.resolve("accentHue", { profileId: home.id }).value).toBe(190);

    store.reset("accentHue", scope);
    expect(store.resolve("accentHue", { profileId: work.id }).value).toBe(190);

    store.set("accentHue", { kind: "application" }, "#bd6b9a");
    store.set("accentHue", scope, "#728fa9");
    expect(store.resolve("accentHue", { profileId: work.id }).value).toBe("#728fa9");
    expect(store.resolve("accentHue", { profileId: home.id }).value).toBe("#bd6b9a");

    for (const invalid of ["#bad", "#zzzzzz", "red", "url(https://example.com)"])
      expect(() => store.set("accentHue", scope, invalid)).toThrow(/Invalid value/);

    store.reset("accentHue", scope);
    expect(store.resolve("accentHue", { profileId: work.id }).value).toBe("#bd6b9a");
    expect(store.resolve("uiZoom", { profileId: work.id }).value).toBe(150);
    expect(store.resolve("uiZoom", { profileId: home.id }).value).toBe(125);
    expect(store.resolve("reducedMotion", { profileId: work.id }).value).toBe(false);
    expect(store.resolve("reducedMotion", { profileId: home.id }).value).toBe(true);

    store.reset("uiZoom", scope);
    expect(store.resolve("uiZoom", { profileId: work.id }).value).toBe(125);
    expect(store.resolve("reducedMotion", { profileId: work.id }).value).toBe(false);

    store.reset("reducedMotion", scope);
    expect(store.resolve("reducedMotion", { profileId: work.id }).value).toBe(true);
    expect(() => store.set("gitEngine", scope, "system")).toThrow(/cannot be changed/);
    expect(() => store.reset("gitEngine", scope)).toThrow(/cannot be changed/);
  });

  it("inherits application tools and keeps explicit disabled choices isolated to a profile", () => {
    const { store, work, home } = setup();
    const global = { kind: "application" } as const;
    const profile = { kind: "profile", profileId: work.id } as const;
    const tool = {
      executable: "/tools/merge",
      args: ["{base}", "{current}", "{incoming}", "{result}"],
    };

    store.set("editorExecutable", global, "/tools/editor");
    store.set("mergeTool", global, tool);
    expect(store.resolve("editorExecutable", { profileId: work.id }).value).toBe("/tools/editor");
    expect(store.resolve("mergeTool", { profileId: work.id }).value).toEqual(tool);

    store.set("editorExecutable", profile, "");
    store.set("mergeTool", profile, { ...tool, executable: "" });
    expect(store.resolve("editorExecutable", { profileId: work.id }).value).toBe("");
    expect(store.resolve("mergeTool", { profileId: work.id }).value.executable).toBe("");
    expect(store.resolve("editorExecutable", { profileId: home.id }).value).toBe("/tools/editor");
    expect(store.resolve("mergeTool", { profileId: home.id }).value).toEqual(tool);

    store.reset("editorExecutable", profile);
    store.reset("mergeTool", profile);
    expect(store.resolve("editorExecutable", { profileId: work.id }).value).toBe("/tools/editor");
    expect(store.resolve("mergeTool", { profileId: work.id }).value).toEqual(tool);
  });

  it("resolves repository overrides above profile and application defaults", () => {
    const { store, work, home } = setup();

    store.set("diffMode", { kind: "profile", profileId: work.id }, "split");
    store.set(
      "diffMode",
      { kind: "repository", profileId: work.id, repositoryId: "repo" },
      "unified",
    );
    expect(store.resolve("diffMode", { profileId: work.id, repositoryId: "repo" })).toMatchObject({
      value: "unified",
      source: { kind: "repository" },
    });
    expect(store.resolve("diffMode", { profileId: work.id }).value).toBe("split");
    expect(() => store.resolve("diffMode", { profileId: home.id, repositoryId: "repo" })).toThrow(
      /owner/,
    );
    expect(() => store.resolve("diffMode", { repositoryId: "repo" })).toThrow(/require a profile/);
  });

  it("rejects invalid values without disturbing valid data", () => {
    const { store } = setup();

    for (const value of [null, "true", 1])
      expect(() => store.set("syncGlobalGitConfig", { kind: "application" }, value)).toThrow(
        /Invalid value/,
      );

    for (const value of [0, 300, NaN, 100.5])
      expect(() => store.set("uiZoom", { kind: "application" }, value)).toThrow();

    expect(store.resolve("syncGlobalGitConfig").value).toBe(true);
  });

  it("preserves corrupt data and inherits a valid ancestor", () => {
    const { db, store, work } = setup();
    store.set("theme", { kind: "application" }, nordPreference);
    store.set("theme", { kind: "profile", profileId: work.id }, lavenderPreference);
    db.raw.exec("PRAGMA ignore_check_constraints = ON");
    db.update(settingOverrides).set({ value: "{invalid" }).run();
    db.raw.exec("PRAGMA ignore_check_constraints = OFF");
    expect(store.resolve("theme", { profileId: work.id }).value).toEqual(nordPreference);
    expect(db.select().from(settingOverrides).get()?.value).toBe("{invalid");
  });

  it("cascades owned overrides without deleting another profile or global defaults", () => {
    const { db, store, work, home, profiles } = setup();

    store.set("theme", { kind: "profile", profileId: work.id }, nordPreference);
    store.set("theme", { kind: "profile", profileId: home.id }, lavenderPreference);
    store.set("theme", { kind: "application" }, lightPreference);
    profiles.delete(work.id);
    expect(db.select().from(settingOverrides).all()).toHaveLength(1);
    expect(store.resolve("theme", { profileId: home.id }).value).toEqual(lavenderPreference);
    expect(store.resolve("theme").value).toEqual(lightPreference);
    expect(() =>
      store.set("theme", { kind: "profile", profileId: work.id }, nordPreference),
    ).toThrow(/owner/);
  });
});

it("saves paired appearance preferences with profile inheritance", () => {
  const { store, work, home } = setup();

  expect(store.resolve("theme", { profileId: work.id })).toMatchObject({
    value: { mode: "system", light: "eda-light", dark: "eda-dark" },
    source: { kind: "built-in" },
  });

  const global = { kind: "application" } as const;
  const profile = { kind: "profile", profileId: work.id } as const;

  store.set("theme", global, nordPreference);
  expect(store.resolve("theme", { profileId: work.id }).value).toEqual({
    mode: "dark",
    light: "nord-light",
    dark: "nord",
  });

  expect(() => store.set("theme", global, "nord")).toThrow(/Invalid value/);
  expect(() => store.set("theme", global, { ...nordPreference, dark: "dracula" })).toThrow(
    /Invalid value/,
  );

  const pair = { mode: "system", light: "eda-light", dark: "lavender-dark" } as const;

  store.set("theme", global, pair);
  expect(store.resolve("theme", { profileId: work.id }).value).toEqual(pair);

  store.set("theme", profile, { ...pair, mode: "light", dark: "nord" });
  expect(store.resolve("theme", { profileId: home.id }).value).toEqual(pair);
  expect(store.resolve("theme", { profileId: work.id }).value).toEqual({
    ...pair,
    mode: "light",
    dark: "nord",
  });
  expect(() => store.set("theme", profile, { ...pair, light: "nord" })).toThrow(/Invalid value/);
  expect(() => store.set("theme", profile, { ...pair, dark: "eda-light" })).toThrow(
    /Invalid value/,
  );

  store.reset("theme", profile);
  expect(store.resolve("theme", { profileId: work.id }).value).toEqual(pair);
});

it("inherits commit guidance independently and validates profile prefix overrides", () => {
  const { store, work, home } = setup();
  const global = { kind: "application" } as const;
  const profile = { kind: "profile", profileId: work.id } as const;

  store.set("conventionalCommitsEnabled", global, true);
  store.set("commitPrefixes", global, ["feat", "fix"]);
  store.set("conventionalCommitsEnabled", profile, false);
  store.set("commitPrefixes", profile, ["ship", "repair"]);
  expect(store.resolve("conventionalCommitsEnabled", { profileId: work.id }).value).toBe(false);
  expect(store.resolve("conventionalCommitsEnabled", { profileId: home.id }).value).toBe(true);
  expect(store.resolve("commitPrefixes", { profileId: home.id }).value).toEqual(["feat", "fix"]);

  for (const value of [[], ["fix", "fix"], ["fix:\n"], [null], ["bad scope"]])
    expect(() => store.set("commitPrefixes", profile, value)).toThrow(/Invalid value/);

  expect(store.resolve("commitPrefixes", { profileId: work.id }).value).toEqual(["ship", "repair"]);

  store.set("commitPrefixes", profile, ["✨ feat", "🐛 fix"]);
  expect(store.resolve("commitPrefixes", { profileId: work.id }).value).toEqual([
    "✨ feat",
    "🐛 fix",
  ]);

  store.reset("commitPrefixes", profile);
  expect(store.resolve("commitPrefixes", { profileId: work.id }).value).toEqual(["feat", "fix"]);
  expect(store.resolve("conventionalCommitsEnabled", { profileId: work.id }).value).toBe(false);

  store.reset("conventionalCommitsEnabled", profile);
  expect(store.resolve("conventionalCommitsEnabled", { profileId: work.id }).value).toBe(true);
  expect(() =>
    store.set("commitPrefixes", { kind: "repository", profileId: work.id, repositoryId: "repo" }, [
      "fix",
    ]),
  ).toThrow(/cannot be changed/);
});
