import { beforeEach, describe, expect, it } from "vitest";
import type { IdentityDraft } from "@shared/identity/identity";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { SettingsRepository } from "@main/persistence/settings-repository";

let identities: IdentityRepository;

const draft = (overrides: Partial<IdentityDraft> = {}): IdentityDraft => ({
  name: "Work",
  gitName: "Eda",
  gitEmail: "dev@work.example",
  hue: 210,
  signing: { format: "none", signCommits: false },
  ...overrides,
});

beforeEach(() => {
  identities = new IdentityRepository(openInMemoryDatabase());
});

describe("creating identities", () => {
  it("uses one normalized Unicode name key for creates and renames", () => {
    identities.create(draft({ name: "Café" }));
    for (const name of ["CAFÉ", "Cafe\u0301", "Ｃａｆé", " Café "])
      expect(() => identities.create(draft({ name }))).toThrow(/already exists/);
    const other = identities.create(draft({ name: "Other" }));
    expect(() => identities.update(other.id, { name: "CAFÉ" })).toThrow(/already exists/);
    expect(identities.findById(other.id)?.name).toBe("Other");
  });

  it("creates the sync opt-out atomically while keeping global appearance and workflow inherited", () => {
    const db = openInMemoryDatabase();
    const settings = new SettingsRepository(db);
    const repository = new IdentityRepository(db, settings);

    try {
      settings.set("accentHue", { kind: "application" }, "#c46c9e");
      settings.set("conventionalCommitsEnabled", { kind: "application" }, true);

      const profile = repository.create(draft(), { syncGlobalGitConfig: false });

      expect(profile.hue).toBe("#c46c9e");

      repository.update(profile.id, { name: "Renamed" });
      expect(repository.findById(profile.id)?.hue).toBe("#c46c9e");
      expect(settings.resolve("syncGlobalGitConfig", { profileId: profile.id })).toMatchObject({
        value: false,
        source: { kind: "profile", profileId: profile.id },
      });

      for (const key of ["accentHue", "conventionalCommitsEnabled"] as const)
        expect(settings.resolve(key, { profileId: profile.id }).source).toEqual({
          kind: "application",
        });

      const failure = vi.spyOn(settings, "set").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });

      try {
        expect(() =>
          repository.create(draft({ name: "Failed" }), { syncGlobalGitConfig: false }),
        ).toThrow("Storage unavailable");
        expect(repository.list().map((item) => item.id)).toEqual([profile.id]);
      } finally {
        failure.mockRestore();
      }
    } finally {
      db.close();
    }
  });

  it("round-trips every field it was given", () => {
    const created = identities.create(
      draft({
        username: "exampledev",
        avatarPath: "/avatars/eda.png",
        sshKeyPath: "/home/dev/.ssh/id_work",
        signing: { format: "ssh", keyRef: "/home/dev/.ssh/id_work.pub", signCommits: true },
      }),
    );

    expect(created).toMatchObject({
      name: "Work",
      gitName: "Eda",
      gitEmail: "dev@work.example",
      username: "exampledev",
      avatarPath: "/avatars/eda.png",
      sshKeyPath: "/home/dev/.ssh/id_work",
      hue: 210,
    });
    expect(created.signing).toEqual({
      format: "ssh",
      keyRef: "/home/dev/.ssh/id_work.pub",
      signCommits: true,
    });
  });

  it("derives Gravatar from the normalized Git email without changing stored email", () => {
    const created = identities.create(draft({ gitEmail: " MyEmailAddress@example.com " }));
    expect(created.gravatarUrl).toBe(
      "https://www.gravatar.com/avatar/84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee?s=96&d=404&r=g",
    );
    expect(created.gitEmail).toBe(" MyEmailAddress@example.com ");
  });

  it("assigns a distinct id to each identity", () => {
    const first = identities.create(draft());
    const second = identities.create(draft({ name: "Personal" }));
    expect(first.id).not.toBe(second.id);
  });

  it("stores text that would break a naive query, proving parameters are bound", () => {
    const created = identities.create(draft({ name: "O'Brien; DROP TABLE identities;--" }));
    expect(identities.findById(created.id)?.name).toBe("O'Brien; DROP TABLE identities;--");
    expect(identities.list()).toHaveLength(1);
  });
});

describe("reading identities", () => {
  it("returns undefined for an unknown id instead of throwing", () => {
    expect(identities.findById("3d7cbfac-c122-4457-9e8c-5040dbb7832f")).toBeUndefined();
  });

  it("appends new profiles in creation order", () => {
    identities.create(draft({ name: "zeta" }));
    identities.create(draft({ name: "Alpha" }));
    identities.create(draft({ name: "beta" }));
    expect(identities.list().map((i) => i.name)).toEqual(["zeta", "Alpha", "beta"]);
  });
});

describe("updating identities", () => {
  it("changes only the supplied fields", () => {
    const created = identities.create(draft({ username: "keepme" }));
    const updated = identities.update(created.id, { gitEmail: "new@work.example" });

    expect(updated?.gitEmail).toBe("new@work.example");
    expect(updated?.gravatarUrl).not.toBe(created.gravatarUrl);
    expect(identities.findById(created.id)?.gravatarUrl).toBe(updated?.gravatarUrl);
    expect(updated?.gitName).toBe("Eda");
    expect(updated?.username).toBe("keepme");
  });

  it("returns undefined for an unknown id", () => {
    expect(
      identities.update("3d7cbfac-c122-4457-9e8c-5040dbb7832f", { gitName: "X" }),
    ).toBeUndefined();
  });
});

describe("ssh key assignment", () => {
  it("assigns and then clears a key path", () => {
    const created = identities.create(draft());
    expect(identities.assignSshKey(created.id, "/home/dev/.ssh/id_work")?.sshKeyPath).toBe(
      "/home/dev/.ssh/id_work",
    );
    expect(identities.assignSshKey(created.id, null)?.sshKeyPath).toBeUndefined();
  });
});

describe("signing configuration", () => {
  it("stores an ssh signing key", () => {
    const created = identities.create(draft());
    const updated = identities.update(created.id, {
      signing: {
        format: "ssh",
        keyRef: "/home/dev/.ssh/id_work.pub",
        signCommits: true,
      },
    });

    expect(updated?.signing).toEqual({
      format: "ssh",
      keyRef: "/home/dev/.ssh/id_work.pub",
      signCommits: true,
    });
  });

  it("clears the key reference when switching to no signing", () => {
    const created = identities.create(
      draft({
        signing: { format: "gpg", keyRef: "ABCD1234", signCommits: true },
      }),
    );
    const updated = identities.update(created.id, {
      signing: { format: "none", signCommits: false },
    });

    expect(updated?.signing.format).toBe("none");
    expect(updated?.signing.keyRef).toBeUndefined();
    expect(updated?.signing.signCommits).toBe(false);
  });
});

describe("deleting identities", () => {
  it("removes the identity", () => {
    const created = identities.create(draft());
    identities.delete(created.id);
    expect(identities.findById(created.id)).toBeUndefined();
    expect(identities.list()).toEqual([]);
  });

  it("deleting an unknown id is a no-op, not an error", () => {
    identities.create(draft());
    expect(() => identities.delete("3d7cbfac-c122-4457-9e8c-5040dbb7832f")).not.toThrow();
    expect(identities.list()).toHaveLength(1);
  });
});

describe("the active identity", () => {
  it("starts with no active identity", () => {
    expect(identities.getActiveId()).toBeNull();
  });

  it("remembers the active identity and can clear it", () => {
    const created = identities.create(draft());
    identities.setActiveId(created.id);
    expect(identities.getActiveId()).toBe(created.id);

    identities.setActiveId(null);
    expect(identities.getActiveId()).toBeNull();
  });
});

describe("profile order", () => {
  it("keeps custom order after renames, creation and deletion without changing the active profile", () => {
    const work = identities.create(draft());
    const home = identities.create(draft({ name: "Home" }));
    identities.setActiveId(work.id);

    expect(identities.reorder([home.id, work.id]).map((profile) => profile.id)).toEqual([
      home.id,
      work.id,
    ]);
    expect(identities.getActiveId()).toBe(work.id);
    identities.update(home.id, { name: "Zebra" });
    const extra = identities.create(draft({ name: "Alpha" }));
    expect(identities.list().map((profile) => profile.id)).toEqual([home.id, work.id, extra.id]);
    identities.delete(work.id);
    expect(identities.list().map((profile) => profile.id)).toEqual([home.id, extra.id]);
    expect(identities.getActiveId()).toBeNull();
  });

  it("rejects missing, duplicate and stale profile IDs without partially changing order", () => {
    const work = identities.create(draft());
    const home = identities.create(draft({ name: "Home" }));
    identities.setActiveId(work.id);

    for (const invalid of [[home.id], [home.id, home.id], [home.id, "missing"]]) {
      expect(() => identities.reorder(invalid)).toThrow(/profile list changed/);
      expect(identities.list().map((profile) => profile.id)).toEqual([work.id, home.id]);
      expect(identities.getActiveId()).toBe(work.id);
    }
  });
});
