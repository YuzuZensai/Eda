import { RepositoryMemberships } from "@main/persistence/repository-memberships";
import { rm, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { normalize, join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "@main/persistence/database";
import type { IdentityDraft } from "@shared/identity/identity";
import { IdentityManager } from "@main/identity/identity-manager";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { repositories } from "@main/persistence/schema";
import { ProfileSessionRepository } from "@main/persistence/profile-session-repository";
import { RepositoryManager } from "@main/repo/lifecycle/repository-manager";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";

const draft = (name: string, email: string): IdentityDraft => ({
  name,
  gitName: name,
  gitEmail: email,
  hue: 210,
  signing: { format: "none", signCommits: false },
});

const setup = async () => {
  const repo = await createTempRepo();
  const db = openInMemoryDatabase();
  const identities = new IdentityRepository(db);
  const identity = new IdentityManager(identities, repo.git);
  const repositories = new RepositoryManager(
    new RepositoryMemberships(db),
    repo.git,
    identity,
    identities,
  );
  return { repo, db, identities, identity, repositories };
};

describe("RepositoryManager", () => {
  it("explains bare repositories and unsupported formats without registering a membership", async () => {
    const ctx = await setup();
    repo = ctx.repo;
    const owner = ctx.identities.create(draft("Work", "work@example.com"));
    await ctx.identity.setActive(owner.id);
    const bare = join(repo.home, "bare");
    await repo.run(["init", "--bare", bare]);
    await expect(ctx.repositories.open(bare)).rejects.toThrow(/bare Git repository/);
    await repo.run(["config", "core.repositoryformatversion", "99"]);
    await expect(ctx.repositories.open(repo.path)).rejects.toThrow(
      /cannot interpret this repository format/,
    );
    expect(await ctx.repositories.listForActiveIdentity()).toEqual([]);
    ctx.db.close();
  });

  it("initializes a chosen branch and starter files without overwriting existing content", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "work@example.com"));

    await ctx.identity.setActive(work.id);

    const path = join(repo.home, "new-project");

    await mkdir(path);
    await writeFile(join(path, "README.md"), "Existing readme");

    const options = {
      branch: "trunk",
      readme: true,
      ignore: "node" as const,
      license: "MIT" as const,
    };

    await expect(ctx.repositories.init(path, options)).rejects.toThrow("already exists");
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("Existing readme");
    expect(await repo.git.isRepository(path)).toBe(false);

    await ctx.repositories.init(path, { ...options, readme: false });
    expect(
      (
        await repo.git.exec(["symbolic-ref", "--short", "HEAD"], {
          cwd: path,
          operation: "inspect fixture branch",
        })
      ).stdout.trim(),
    ).toBe("trunk");
    expect(await readFile(join(path, ".gitignore"), "utf8")).toContain("node_modules/");
    expect(await readFile(join(path, "LICENSE"), "utf8")).toContain("MIT License");
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("Existing readme");
  });

  it("stores aliases and favourites only in the owning profile", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "work@example.com"));
    const personal = ctx.identities.create(draft("Personal", "personal@example.com"));

    await ctx.identity.setActive(work.id);

    const opened = await ctx.repositories.open(repo.path);

    ctx.repositories.updateMetadata(opened.id, "Favourite alias", true);
    expect(await ctx.repositories.listForActiveIdentity()).toEqual([
      expect.objectContaining({ name: "Favourite alias", favourite: true, path: opened.path }),
    ]);

    await ctx.identity.setActive(personal.id);
    expect(() => ctx.repositories.updateMetadata(opened.id, "Wrong profile", false)).toThrow();
    expect(await ctx.repositories.open(repo.path)).toMatchObject({ favourite: false });
  });

  let repo: TempRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it("relocates a missing membership without losing saved state or changing another profile/config", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "work@example.com"));
    const home = ctx.identities.create(draft("Home", "home@example.com"));

    await ctx.identity.setActive(home.id);

    const shared = await ctx.repositories.open(repo.path);

    await ctx.identity.setActive(work.id);

    const original = await ctx.repositories.open(repo.path);
    const missing = join(repo.home, "moved-away");

    ctx.db
      .update(repositories)
      .set({ path: missing })
      .where(eq(repositories.id, original.id))
      .run();
    ctx.db.update(repositories).set({ path: missing }).where(eq(repositories.id, shared.id)).run();

    const sessions = new ProfileSessionRepository(ctx.db);

    sessions.change(work.id, "main", {
      kind: "tabs",
      tabs: [original.id],
      selectedRepositoryId: original.id,
    });
    sessions.change(work.id, "main", {
      kind: "draft",
      repositoryId: original.id,
      draft: { version: 1, message: "Unfinished", amend: true },
    });
    await repo.git.writeConfig("user.email", "local@example.com", {
      cwd: repo.path,
      scope: "local",
    });

    const before = sessions.read(work.id, "main");
    const previousLocation = ctx.repositories.resolveActiveRepository(original.id);
    const relocated = await ctx.repositories.relocate(original.id, repo.path);

    expect(() => ctx.repositories.assertCurrentRepository(previousLocation)).toThrow(
      "The repository changed",
    );
    expect(() => ctx.repositories.assertCurrentRepository(relocated)).not.toThrow();
    expect(relocated.id).toBe(original.id);
    expect(normalize(relocated.path)).toBe(normalize(await realpath(repo.path)));
    expect(sessions.read(work.id, "main")).toEqual(before);
    expect(
      ctx.db.select().from(repositories).where(eq(repositories.id, shared.id)).get()?.path,
    ).toBe(missing);
    expect(await repo.git.readConfig("user.email", { cwd: repo.path, scope: "local" })).toBe(
      "local@example.com",
    );
  });

  it("rejects available, foreign, invalid and duplicate locations without merging memberships", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "work@example.com"));
    const home = ctx.identities.create(draft("Home", "home@example.com"));

    await ctx.identity.setActive(work.id);

    const original = await ctx.repositories.open(repo.path);

    await expect(ctx.repositories.relocate(original.id, repo.path)).rejects.toThrow(
      "still available",
    );

    ctx.db
      .update(repositories)
      .set({ path: join(repo.home, "missing") })
      .where(eq(repositories.id, original.id))
      .run();
    await expect(ctx.repositories.relocate(original.id, repo.home)).rejects.toMatchObject({
      kind: "not-a-repository",
    });

    const other = await ctx.repositories.open(repo.path);

    await expect(ctx.repositories.relocate(original.id, repo.path)).rejects.toThrow(
      "already lists",
    );
    expect((await ctx.repositories.listForActiveIdentity()).map((r) => r.id)).toContain(other.id);

    await ctx.identity.setActive(home.id);
    await expect(ctx.repositories.relocate(original.id, repo.path)).rejects.toThrow(
      "does not belong",
    );
  });

  it("does not retarget relocation when a queued switch activates another profile", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "work@example.com"));
    const home = ctx.identities.create(draft("Home", "home@example.com"));

    await ctx.identity.setActive(work.id);

    const original = await ctx.repositories.open(repo.path);
    const missing = join(repo.home, "missing");

    ctx.db
      .update(repositories)
      .set({ path: missing })
      .where(eq(repositories.id, original.id))
      .run();

    const switching = ctx.identity.setActive(home.id);
    const locating = ctx.repositories.relocate(original.id, repo.path);

    await expect(locating).rejects.toThrow("does not belong");

    await switching;
    expect(
      ctx.db.select().from(repositories).where(eq(repositories.id, original.id)).get()?.path,
    ).toBe(missing);
  });

  it("refuses to register a repository with no active identity", async () => {
    const ctx = await setup();
    repo = ctx.repo;
    await expect(ctx.repositories.open(ctx.repo.path)).rejects.toMatchObject({
      kind: "invalid-input",
    });
  });

  it("registers a repository under the active identity", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example"));

    await ctx.identity.setActive(work.id);

    const summary = await ctx.repositories.open(ctx.repo.path);

    expect(summary.identityId).toBe(work.id);
    expect(summary.available).toBe(true);
  });

  it("preserves local identity config when a repository is opened", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example"));

    await ctx.identity.setActive(work.id);
    await ctx.repo.git.writeConfig("user.email", "existing@example.com", {
      cwd: ctx.repo.path,
      scope: "local",
    });
    await ctx.repositories.open(ctx.repo.path);

    expect(
      await ctx.repo.git.readConfig("user.email", { cwd: ctx.repo.path, scope: "local" }),
    ).toBe("existing@example.com");
  });

  it("shows each identity only its own repositories", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example"));
    const personal = ctx.identities.create(draft("Personal", "dev@home.example"));

    await ctx.identity.setActive(work.id);
    await ctx.repositories.open(ctx.repo.path);
    expect(await ctx.repositories.listForActiveIdentity()).toHaveLength(1);

    await ctx.identity.setActive(personal.id);
    expect(await ctx.repositories.listForActiveIdentity()).toHaveLength(0);
  });

  it("resolves repository IDs only for the active owning identity", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example"));
    const personal = ctx.identities.create(draft("Personal", "dev@home.example"));

    await ctx.identity.setActive(work.id);

    const summary = await ctx.repositories.open(ctx.repo.path);

    expect(normalize(ctx.repositories.resolveActiveRepository(summary.id).path)).toBe(
      normalize(await realpath(ctx.repo.path)),
    );

    await ctx.identity.setActive(personal.id);
    expect(() => ctx.repositories.resolveActiveRepository(summary.id)).toThrowError(
      /active identity/i,
    );
  });

  it("cannot remove a repository owned by another identity", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example"));
    const personal = ctx.identities.create(draft("Personal", "dev@home.example"));

    await ctx.identity.setActive(work.id);

    const summary = await ctx.repositories.open(ctx.repo.path);

    await ctx.identity.setActive(personal.id);

    expect(() => ctx.repositories.remove(summary.id)).toThrowError(/active identity/i);

    await ctx.identity.setActive(work.id);
    expect(await ctx.repositories.listForActiveIdentity()).toHaveLength(1);
  });

  it("rejects a folder that is not a repository", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example"));

    await ctx.identity.setActive(work.id);

    await expect(ctx.repositories.open(ctx.repo.home)).rejects.toMatchObject({
      kind: "not-a-repository",
    });
  });

  it("reports a deleted folder as unavailable instead of failing the list", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example"));

    await ctx.identity.setActive(work.id);
    await ctx.repositories.open(ctx.repo.path);

    await rm(ctx.repo.path, { recursive: true, force: true });

    const list = await ctx.repositories.listForActiveIdentity();

    expect(list).toHaveLength(1);
    expect(list[0]?.available).toBe(false);
  });

  it("does not duplicate a repository opened twice", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example"));

    await ctx.identity.setActive(work.id);

    await ctx.repositories.open(ctx.repo.path);
    await ctx.repositories.open(ctx.repo.path);

    expect(await ctx.repositories.listForActiveIdentity()).toHaveLength(1);
  });

  it("deletes an identity's repositories along with it", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example"));

    await ctx.identity.setActive(work.id);
    await ctx.repositories.open(ctx.repo.path);

    ctx.identities.delete(work.id);

    expect(ctx.db.select().from(repositories).all()).toEqual([]);
  });
});
