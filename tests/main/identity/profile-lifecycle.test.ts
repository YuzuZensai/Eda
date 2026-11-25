import { ProfileRepository } from "@main/persistence/profile-repository";
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createTempRepo, type TempRepo } from "../../helpers/temp-repo";
import { openDatabase } from "@main/persistence/database";
import type { Database } from "@main/persistence/types";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { SettingsRepository } from "@main/persistence/settings-repository";
import { ProfileSessionRepository } from "@main/persistence/profile-session-repository";
import {
  profileDrafts,
  profileRecovery,
  profileSessions,
  repositories,
  settingOverrides,
} from "@main/persistence/schema";
import { IdentityManager } from "@main/identity/identity-manager";
import { ProfileService } from "@main/identity/profile-service";
import { ProfileSessions } from "@main/identity/profile-sessions";
import { emptySession, emptyView } from "@shared/identity/profile-session";
import { MemorySecrets } from "../../helpers/memory-secrets";
import { secretKeys } from "@main/secrets/secret-store";

const nordPreference = { mode: "dark", light: "nord-light", dark: "nord" } as const;

const fixtures: { repo: TempRepo; db: Database }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { repo, db } of fixtures.splice(0)) {
    if (db.raw.isOpen) db.close();
    await repo.cleanup();
  }
});

async function setup() {
  const repo = await createTempRepo();
  const dbPath = join(repo.home, "eda.db");
  const db = openDatabase(dbPath);

  fixtures.push({ repo, db });

  const identities = new IdentityRepository(db);
  const draft = (name: string) => ({
    name,
    gitName: `${name} Author`,
    gitEmail: `${name.toLowerCase()}@example.com`,
    hue: 210,
    signing: { format: "none" as const, signCommits: false },
  });

  const work = identities.create(draft("Work"));
  const home = identities.create(draft("Home"));

  for (const [id, owner] of [
    ["work-repo", work.id],
    ["home-repo", home.id],
  ] as const)
    db.insert(repositories)
      .values({ id, identityId: owner, path: repo.path, name: "Shared checkout", createdAt: "now" })
      .run();

  const settings = new SettingsRepository(db);
  const manager = new IdentityManager(identities, repo.git, settings);
  const store = new ProfileSessionRepository(db);
  const sessions = new ProfileSessions(manager, store);
  const secrets = new MemorySecrets();

  const service = new ProfileService(
    new ProfileRepository(db, identities, store),
    identities,
    manager,
    store,
    secrets,
  );

  await manager.setActive(work.id);

  return {
    repo,
    db,
    dbPath,
    identities,
    work,
    home,
    settings,
    manager,
    store,
    sessions,
    values: secrets.values,
    secrets,
    service,
  };
}

describe("durable profile sessions", () => {
  it("checks ownership when saving many tabs without a database lookup per tab", async () => {
    const { db, work, store } = await setup();
    const tabs = Array.from({ length: 100 }, (_, index) => `repo-${index}`);
    db.insert(repositories)
      .values(
        tabs.map((id) => ({ id, identityId: work.id, path: `/${id}`, name: id, createdAt: "now" })),
      )
      .run();

    const prepare = vi.spyOn(db.raw, "prepare");
    const saveTabs = (ids: string[]) =>
      store.change(work.id, "primary", { kind: "tabs", tabs: ids, selectedRepositoryId: ids[0] });
    saveTabs(tabs.slice(0, 1));
    const oneTab = prepare.mock.calls.length;
    prepare.mockClear();
    saveTabs(tabs);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(oneTab);
    expect(() => saveTabs([...tabs, "home-repo"])).toThrow(/does not belong/i);
    expect(store.read(work.id, "primary").session.tabs).toEqual(tabs);
  });

  it("requires an explicit profile choice when the saved active pointer is missing", async () => {
    const { identities, sessions, work, home, values, repo } = await setup();

    values.set(secretKeys.sshPassphrase(home.id), "home secret");

    const previous = sessions.open(1)!;

    identities.setActiveId(null);
    expect(sessions.open(1)).toBeNull();
    expect(() =>
      sessions.change(1, previous.context, { kind: "tabs", tabs: [], selectedRepositoryId: null }),
    ).toThrow(/stale/);
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(work.gitEmail);
    expect(values.get(secretKeys.sshPassphrase(home.id))).toBe("home secret");
  });

  it("separates tabs, drafts, selections and geometry for the same physical checkout", async () => {
    const { sessions, store, manager, work, home } = await setup();
    const first = sessions.open(10)!;

    sessions.change(10, first.context, {
      kind: "tabs",
      tabs: ["work-repo"],
      selectedRepositoryId: "work-repo",
    });
    sessions.change(10, first.context, {
      kind: "draft",
      repositoryId: "work-repo",
      draft: { version: 1, message: "Work only", amend: true },
    });
    sessions.change(10, first.context, {
      kind: "view",
      repositoryId: "work-repo",
      view: {
        ...emptyView(),
        selection: { kind: "commit", oid: "a".repeat(40) },
        splits: { graph: 0.7 },
        grouped: true,
      },
    });
    await manager.setActive(home.id);

    const second = sessions.open(10)!;

    expect(second.session.tabs).toEqual([]);
    expect(second.drafts).toEqual({});
    expect(() =>
      sessions.change(10, first.context, { kind: "tabs", tabs: [], selectedRepositoryId: null }),
    ).toThrow(/stale/);
    expect(() =>
      sessions.change(11, second.context, { kind: "tabs", tabs: [], selectedRepositoryId: null }),
    ).toThrow(/stale/);
    expect(() =>
      sessions.change(10, second.context, {
        kind: "draft",
        repositoryId: "work-repo",
        draft: { version: 1, message: "spoof", amend: false },
      }),
    ).toThrow(/belong/);

    await manager.setActive(work.id);
    expect(sessions.open(10)).toMatchObject({
      session: {
        tabs: ["work-repo"],
        selectedRepositoryId: "work-repo",
        views: { "work-repo": { grouped: true, splits: { graph: 0.7 } } },
      },
      drafts: { "work-repo": { message: "Work only", amend: true } },
    });
    expect(store.read(home.id, "primary").drafts).toEqual({});
  });

  it("retains drafts after closing the last tab and across a file database restart", async () => {
    const { db, dbPath, work, store, repo } = await setup();

    store.change(work.id, "primary", {
      kind: "draft",
      repositoryId: "work-repo",
      draft: { version: 1, message: "unsent\n\nbody", amend: false },
    });
    store.change(work.id, "primary", { kind: "tabs", tabs: [], selectedRepositoryId: null });
    db.close();
    await repo.git.writeConfig("user.email", "external@example.com", { scope: "global" });

    const reopened = openDatabase(dbPath);

    try {
      expect(new IdentityRepository(reopened).getActiveId()).toBe(work.id);
      expect(new ProfileSessionRepository(reopened).read(work.id, "primary")).toMatchObject({
        session: { tabs: [], selectedRepositoryId: null },
        drafts: { "work-repo": { message: "unsent\n\nbody" } },
      });
      expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(
        "external@example.com",
      );
    } finally {
      reopened.close();
    }
  });

  it("retains a sign-off-only draft across restart and removes it when sign-off is cleared", async () => {
    const { db, dbPath, work, store } = await setup();
    const draft = { version: 1, message: "", amend: false, signOff: true } as const;

    store.change(work.id, "primary", { kind: "draft", repositoryId: "work-repo", draft });
    db.close();

    const reopened = openDatabase(dbPath);

    try {
      const restored = new ProfileSessionRepository(reopened);
      expect(restored.read(work.id, "primary").drafts["work-repo"]).toEqual(draft);

      restored.change(work.id, "primary", {
        kind: "draft",
        repositoryId: "work-repo",
        draft: { ...draft, signOff: false },
      });
      expect(restored.read(work.id, "primary").drafts).toEqual({});
    } finally {
      reopened.close();
    }
  });

  it.each(["{broken", '{"version":99,"tabs":["private"]}'])(
    "preserves unreadable/newer state until an explicit recovery reset: %s",
    async (raw) => {
      const { db, work, store } = await setup();
      db.raw.exec("PRAGMA ignore_check_constraints = ON");

      db.insert(profileSessions)
        .values({ profileId: work.id, windowId: "primary", value: raw })
        .run();
      db.raw.exec("PRAGMA ignore_check_constraints = OFF");
      expect(store.read(work.id, "primary").recovery).toBeTruthy();
      expect(() =>
        store.change(work.id, "primary", { kind: "tabs", tabs: [], selectedRepositoryId: null }),
      ).toThrow(/preserved/);
      expect(db.select().from(profileSessions).get()?.value).toBe(raw);

      store.reset(work.id, "primary");
      expect(db.select().from(profileRecovery).get()?.value).toBe(raw);
      expect(store.read(work.id, "primary").recovery).toBeNull();
    },
  );

  it("preserves a damaged draft and keeps valid drafts during recovery", async () => {
    const { db, work, store } = await setup();

    db.raw.exec("PRAGMA ignore_check_constraints = ON");
    db.insert(profileDrafts)
      .values({ profileId: work.id, repositoryId: "work-repo", value: "{bad draft" })
      .run();
    db.raw.exec("PRAGMA ignore_check_constraints = OFF");
    expect(store.read(work.id, "primary").recovery).toBeTruthy();

    store.reset(work.id, "primary");
    expect(db.select().from(profileRecovery).get()?.value).toBe("{bad draft");

    store.change(work.id, "primary", {
      kind: "draft",
      repositoryId: "work-repo",
      draft: { version: 1, message: "keep", amend: false },
    });
    store.reset(work.id, "primary");
    expect(store.read(work.id, "primary").drafts["work-repo"]?.message).toBe("keep");
  });

  it("archives a draft with invalid membership and unblocks session updates on reset", async () => {
    const { db, work, store } = await setup();
    const value = JSON.stringify({ version: 1, message: "recover me", amend: false });
    db.raw.exec("PRAGMA foreign_keys = OFF");
    db.insert(profileDrafts).values({ profileId: work.id, repositoryId: "home-repo", value }).run();
    db.raw.exec("PRAGMA foreign_keys = ON");
    expect(store.read(work.id, "primary").recovery).toBeTruthy();

    store.reset(work.id, "primary");
    expect(db.select().from(profileRecovery).get()?.value).toBe(value);
    expect(store.read(work.id, "primary").recovery).toBeNull();
  });

  it("keeps the saved session readable when an additional view exceeds the limit", async () => {
    const { db, work, store } = await setup();
    const ids = Array.from({ length: 2000 }, (_, i) => `view-${i}`);
    db.insert(repositories)
      .values(
        ids.map((id) => ({ id, identityId: work.id, path: `/${id}`, name: id, createdAt: "now" })),
      )
      .run();
    const views = Object.fromEntries(ids.map((id) => [id, emptyView()]));
    db.insert(profileSessions)
      .values({
        profileId: work.id,
        windowId: "primary",
        value: JSON.stringify({ ...emptySession(), views }),
      })
      .run();

    expect(() =>
      store.change(work.id, "primary", {
        kind: "view",
        repositoryId: "work-repo",
        view: emptyView(),
      }),
    ).toThrow();
    const saved = store.read(work.id, "primary");
    expect(saved.recovery).toBeNull();
    expect(Object.keys(saved.session.views)).toHaveLength(ids.length);
  });

  it("rejects invalid state and prunes missing memberships without deleting input elsewhere", async () => {
    const { db, work, store } = await setup();

    expect(() =>
      store.change(work.id, "primary", {
        kind: "tabs",
        tabs: ["work-repo", "work-repo"],
        selectedRepositoryId: null,
      }),
    ).toThrow();
    expect(() =>
      store.change(work.id, "primary", {
        kind: "view",
        repositoryId: "work-repo",
        view: { ...emptyView(), splits: { graph: NaN } },
      }),
    ).toThrow();

    store.change(work.id, "primary", {
      kind: "tabs",
      tabs: ["work-repo"],
      selectedRepositoryId: "work-repo",
    });
    expect(store.openRepositoryIds(work.id)).toEqual(["work-repo"]);
    db.delete(repositories).where(eq(repositories.id, "work-repo")).run();
    expect(store.read(work.id, "primary").session.tabs).toEqual([]);
    expect(store.openRepositoryIds(work.id)).toEqual([]);
  });

  it("keeps the old binding, draft, and active profile after a failed switch", async () => {
    const { sessions, manager, repo, work, home } = await setup();
    const previous = sessions.open(1)!;

    sessions.change(1, previous.context, {
      kind: "draft",
      repositoryId: "work-repo",
      draft: { version: 1, message: "retained", amend: false },
    });
    vi.spyOn(repo.git, "writeConfig").mockRejectedValue(new Error("read-only"));
    await expect(sessions.transition(1, () => manager.setActive(home.id))).rejects.toThrow();
    expect(manager.getActive()?.id).toBe(work.id);
    expect(() =>
      sessions.change(1, previous.context, {
        kind: "tabs",
        tabs: ["work-repo"],
        selectedRepositoryId: "work-repo",
      }),
    ).not.toThrow();
    expect(sessions.open(1)?.drafts["work-repo"]?.message).toBe("retained");
  });
});

describe("profile duplicate/delete", () => {
  it("reassigns memberships explicitly, reuses a same-path destination, and preserves Git config and destination drafts", async () => {
    const { service, store, work, home, db, repo } = await setup();

    await repo.git.writeConfig("user.email", "local@example.com", {
      cwd: repo.path,
      scope: "local",
    });

    for (const [owner, repositoryId] of [
      [work.id, "work-repo"],
      [home.id, "home-repo"],
    ] as const)
      store.change(owner, "primary", {
        kind: "draft",
        repositoryId,
        draft: { version: 1, message: owner, amend: false },
      });

    expect(await service.assignRepository("work-repo", home.id, false)).toBe("home-repo");
    expect(db.select().from(repositories).all()).toHaveLength(2);
    expect(await service.assignRepository("work-repo", home.id, true)).toBe("home-repo");
    expect(db.select().from(repositories).all()).toHaveLength(1);
    expect(store.read(home.id, "primary").drafts["home-repo"]?.message).toBe(home.id);
    expect(store.read(work.id, "primary").drafts).toEqual({});
    expect(await repo.git.readConfig("user.email", { cwd: repo.path, scope: "local" })).toBe(
      "local@example.com",
    );
  });

  it("copies selected settings and remapped memberships/tabs, never credentials, keys or drafts", async () => {
    const { db, service, work, identities, values, settings, store, manager } = await setup();

    identities.assignSshKey(work.id, "/keys/private");
    identities.update(work.id, {
      signing: {
        format: "ssh",
        keyRef: "/keys/public.pub",
        signCommits: true,
      },
    });
    values.set(secretKeys.sshPassphrase(work.id), "secret");
    settings.set("theme", { kind: "profile", profileId: work.id }, nordPreference);
    settings.set("accentHue", { kind: "profile", profileId: work.id }, 330);
    settings.set(
      "diffMode",
      { kind: "repository", profileId: work.id, repositoryId: "work-repo" },
      "split",
    );
    db.insert(settingOverrides)
      .values({
        id: "unknown",
        profileId: work.id,
        key: "providerToken",
        value: '"not a preference"',
      })
      .run();
    store.change(work.id, "primary", {
      kind: "tabs",
      tabs: ["work-repo"],
      selectedRepositoryId: "work-repo",
    });
    store.change(work.id, "primary", {
      kind: "draft",
      repositoryId: "work-repo",
      draft: { version: 1, message: "private draft", amend: false },
    });

    const copy = await service.duplicate(work.id, {
      name: "Copy",
      preferences: true,
      repositories: true,
      tabs: true,
    });

    expect(copy.id).not.toBe(work.id);
    expect(copy.hue).toBe(330);
    expect(copy.sshKeyPath).toBeUndefined();
    expect(copy.signing).toEqual({ format: "none", signCommits: false });

    const membership = db
      .select()
      .from(repositories)
      .where(eq(repositories.identityId, copy.id))
      .get()!;

    expect(membership.id).not.toBe("work-repo");
    expect(store.read(copy.id, "primary")).toMatchObject({
      session: { tabs: [membership.id], selectedRepositoryId: membership.id },
      drafts: {},
    });
    expect(settings.resolve("theme", { profileId: copy.id }).value).toEqual(nordPreference);
    expect(
      settings.resolve("diffMode", { profileId: copy.id, repositoryId: membership.id }).value,
    ).toBe("split");
    expect(
      db
        .select()
        .from(settingOverrides)
        .where(eq(settingOverrides.profileId, copy.id))
        .all()
        .map((r) => r.key),
    ).not.toContain("providerToken");
    expect([...values.keys()]).toEqual([secretKeys.sshPassphrase(work.id)]);
    expect(manager.getActive()?.id).toBe(work.id);
  });

  it("supports a metadata-only copy and rejects duplicate names transactionally", async () => {
    const { service, work, store, db, identities, settings } = await setup();

    settings.set("accentHue", { kind: "application" }, 190);
    settings.set("accentHue", { kind: "profile", profileId: work.id }, 330);

    const copy = await service.duplicate(work.id, {
      name: "Bare",
      preferences: false,
      repositories: false,
      tabs: false,
    });

    expect(copy.hue).toBe(190);
    expect(settings.resolve("accentHue", { profileId: copy.id }).source.kind).toBe("application");
    expect(store.read(copy.id, "primary").session.tabs).toEqual([]);
    expect(
      db.select().from(repositories).where(eq(repositories.identityId, copy.id)).all(),
    ).toEqual([]);
    await expect(
      service.duplicate(work.id, {
        name: "work",
        preferences: true,
        repositories: true,
        tabs: true,
      }),
    ).rejects.toThrow(/already exists/);
    expect(identities.list()).toHaveLength(3);
  });

  it("previews counts and safely deletes the active profile with a synchronized fallback", async () => {
    const { service, work, home, values, manager, store, repo, settings, db } = await setup();

    values.set(secretKeys.sshPassphrase(work.id), "work secret");
    values.set(secretKeys.sshPassphrase(home.id), "home secret");
    settings.set("reducedMotion", { kind: "application" }, true);
    store.change(work.id, "primary", {
      kind: "draft",
      repositoryId: "work-repo",
      draft: { version: 1, message: "draft", amend: false },
    });

    const preview = service.previewDelete(work.id);

    expect(preview).toMatchObject({
      repositories: 1,
      drafts: 1,
      active: true,
      fallback: { id: home.id },
    });

    await service.delete(work.id, preview.token);
    expect(manager.getActive()?.id).toBe(home.id);
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(home.gitEmail);
    expect(values.has(secretKeys.sshPassphrase(work.id))).toBe(false);
    expect(values.get(secretKeys.sshPassphrase(home.id))).toBe("home secret");
    expect(db.select().from(profileDrafts).all()).toEqual([]);
    expect(settings.resolve("reducedMotion").value).toBe(true);
    expect(existsSync(join(repo.path, ".git"))).toBe(true);
  });

  it("rejects an outdated deletion preview after new input was saved", async () => {
    const { service, work, store, identities, values } = await setup();
    values.set(secretKeys.sshPassphrase(work.id), "remembered");
    const preview = service.previewDelete(work.id);

    store.change(work.id, "primary", {
      kind: "draft",
      repositoryId: "work-repo",
      draft: { version: 1, message: "new input", amend: false },
    });
    await expect(service.delete(work.id, preview.token)).rejects.toThrow(/changed/);
    expect(identities.findById(work.id)).toBeDefined();
    expect(values.get(secretKeys.sshPassphrase(work.id))).toBe("remembered");
  });

  it("reports cleared credentials and retains the profile and drafts when another window saves during vault cleanup", async () => {
    const { service, sessions, secrets, values, work, manager, repo, store } = await setup();
    values.set(secretKeys.sshPassphrase(work.id), "remembered");
    const session = sessions.open(2)!;
    const cleanup = secrets.deleteForIdentity.getMockImplementation()!;
    secrets.deleteForIdentity.mockImplementationOnce(async (id) => {
      await cleanup(id);
      sessions.change(2, session.context, {
        kind: "draft",
        repositoryId: "work-repo",
        draft: { version: 1, message: "still editing", amend: false },
      });
    });

    await expect(service.delete(work.id, service.previewDelete(work.id).token)).rejects.toThrow(
      /remembered credentials were removed/i,
    );
    expect(values.has(secretKeys.sshPassphrase(work.id))).toBe(false);
    expect(store.read(work.id, "primary").drafts["work-repo"]?.message).toBe("still editing");
    expect(manager.getActive()?.id).toBe(work.id);
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(work.gitEmail);
  });

  it("retains metadata/session and compensates global Git if vault cleanup fails", async () => {
    const { service, work, manager, identities, secrets, store, repo } = await setup();

    store.change(work.id, "primary", {
      kind: "draft",
      repositoryId: "work-repo",
      draft: { version: 1, message: "keep me", amend: false },
    });
    secrets.deleteForIdentity.mockRejectedValue(new Error("vault unavailable"));
    await expect(service.delete(work.id, service.previewDelete(work.id).token)).rejects.toThrow(
      /vault/,
    );
    expect(identities.findById(work.id)).toBeDefined();
    expect(manager.getActive()?.id).toBe(work.id);
    expect(store.read(work.id, "primary").drafts["work-repo"]?.message).toBe("keep me");
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(work.gitEmail);
  });

  it("deletes an inactive profile without switching and the last profile returns to setup", async () => {
    const { service, work, home, manager, repo } = await setup();

    await service.delete(home.id, service.previewDelete(home.id).token);
    expect(manager.getActive()?.id).toBe(work.id);

    const last = service.previewDelete(work.id);

    expect(last.fallback).toBeNull();

    await service.delete(work.id, last.token);
    expect(manager.getActive()).toBeNull();
    expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe(work.gitEmail);
  });
});
