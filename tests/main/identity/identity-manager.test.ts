import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "@main/persistence/database";
import type { IdentityDraft } from "@shared/identity/identity";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { IdentityManager } from "@main/identity/identity-manager";
import { createTempRepo, type TempRepo } from "../../helpers/temp-repo";

const draft = (name: string, email: string, hue: number): IdentityDraft => ({
  name,
  gitName: name,
  gitEmail: email,
  hue,
  signing: { format: "none", signCommits: false },
});

const setup = async () => {
  const repo = await createTempRepo();
  const db = openInMemoryDatabase();
  const identities = new IdentityRepository(db);
  const manager = new IdentityManager(identities, repo.git);
  return { repo, identities, manager };
};

describe("IdentityManager switch transaction", () => {
  let repo: TempRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it("writes the identity to global Git config", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example", 210));

    const report = await ctx.manager.setActive(work.id);

    expect(report.verified).toBe(true);
    expect(await ctx.repo.git.readConfig("user.email", { scope: "global" })).toBe(
      "dev@work.example",
    );
    expect(await ctx.repo.git.readConfig("user.name", { scope: "global" })).toBe("Work");
  });

  it("inspects global and repository commit settings without unrelated local keys", async () => {
    const ctx = await setup();
    repo = ctx.repo;
    await expect(ctx.manager.inspectGit()).rejects.toMatchObject({ kind: "invalid-input" });
    const profile = ctx.identities.create(draft("Work", "dev@work.example", 210));
    await ctx.manager.setActive(profile.id);
    await repo.run(["config", "--local", "user.email", "local@example.com"]);
    await repo.run(["config", "--local", "eda.unrelated", "value"]);

    const reads = vi.spyOn(repo.git, "exec");
    const global = await ctx.manager.inspectGit();
    expect(reads.mock.calls.length).toBe(1);
    expect(global).toMatchObject({ profileId: profile.id, repository: null, localOverrides: null });
    expect(global.global).toContainEqual(
      expect.objectContaining({ key: "user.email", value: "dev@work.example" }),
    );

    reads.mockClear();
    const local = await ctx.manager.inspectGit(repo.path);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(3);
    expect(local.repository).toContainEqual(
      expect.objectContaining({ key: "user.email", value: "local@example.com" }),
    );
    expect(local.localOverrides).toEqual(["user.email"]);
  });

  it("makes the switch visible to Git itself, not just to Eda", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const oss = ctx.identities.create(draft("Open Source", "dev@oss.example", 330));

    await ctx.manager.setActive(oss.id);

    await ctx.repo.writeFile("a.txt", "hello\n");
    await ctx.repo.run(["add", "--all"]);
    await ctx.repo.run(["commit", "--no-gpg-sign", "-m", "from the active identity"]);

    const author = await ctx.repo.run(["log", "-1", "--format=%ae"]);

    expect(author.trim()).toBe("dev@oss.example");
  });

  it("rolls back to the previous identity when a write fails mid-switch", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example", 210));
    const broken = ctx.identities.create({
      ...draft("Broken", "dev@broken.example", 10),
      signing: { format: "ssh", keyRef: "/keys/id_ed25519.pub", signCommits: true },
    });

    await ctx.manager.setActive(work.id);

    const realWriteConfig = ctx.repo.git.writeConfig.bind(ctx.repo.git);
    let callCount = 0;

    ctx.repo.git.writeConfig = async (key, value, options) => {
      callCount += 1;
      if (key === "user.signingkey") {
        throw new Error("induced failure: config is read-only");
      }
      return realWriteConfig(key, value, options);
    };

    await expect(ctx.manager.setActive(broken.id)).rejects.toThrow();

    ctx.repo.git.writeConfig = realWriteConfig;

    expect(callCount).toBeGreaterThan(0);
    expect(await ctx.repo.git.readConfig("user.email", { scope: "global" })).toBe(
      "dev@work.example",
    );
    expect(await ctx.repo.git.readConfig("user.name", { scope: "global" })).toBe("Work");
    expect(ctx.manager.getActive()?.id).toBe(work.id);
  });

  it("refuses to activate an identity that no longer exists", async () => {
    const ctx = await setup();

    repo = ctx.repo;
    await expect(
      ctx.manager.setActive("00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({
      kind: "invalid-input",
    });
  });

  it("serializes concurrent switches instead of interleaving them", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const a = ctx.identities.create(draft("A", "a@example.com", 10));
    const b = ctx.identities.create(draft("B", "b@example.com", 200));
    const c = ctx.identities.create(draft("C", "c@example.com", 300));

    await Promise.all([
      ctx.manager.setActive(a.id),
      ctx.manager.setActive(b.id),
      ctx.manager.setActive(c.id),
    ]);

    const name = await ctx.repo.git.readConfig("user.name", { scope: "global" });
    const email = await ctx.repo.git.readConfig("user.email", { scope: "global" });
    const active = ctx.manager.getActive();

    expect(active?.gitName).toBe(name);
    expect(active?.gitEmail).toBe(email);
  });

  it("notifies listeners so cached Git state can be invalidated", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const seen: (string | null)[] = [];

    ctx.manager.onChange((identity) => seen.push(identity?.name ?? null));

    const work = ctx.identities.create(draft("Work", "dev@work.example", 210));

    await ctx.manager.setActive(work.id);

    expect(seen).toEqual(["Work"]);
  });
});

describe("IdentityManager pre-commit verification", () => {
  let repo: TempRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it("confirms the effective identity matches before a commit", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example", 210));

    await ctx.manager.setActive(work.id);

    const check = await ctx.manager.verifyEffectiveIdentity(ctx.repo.path, work);

    expect(check.matches).toBe(true);
  });

  it("detects config changed behind Eda's back", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example", 210));

    await ctx.manager.setActive(work.id);

    await ctx.repo.git.writeConfig("user.email", "someone.else@example.com", {
      scope: "local",
      cwd: ctx.repo.path,
    });

    const check = await ctx.manager.verifyEffectiveIdentity(ctx.repo.path, work);

    expect(check.matches).toBe(false);
    expect(check.actual.email).toBe("someone.else@example.com");
    expect(check.expected.email).toBe("dev@work.example");
  });

  it("keeps a repository correctly attributed after the active identity changes", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(draft("Work", "dev@work.example", 210));
    const personal = ctx.identities.create(draft("Personal", "dev@home.example", 330));

    await ctx.manager.setActive(work.id);
    await ctx.manager.applyToRepository(ctx.repo.path, work);

    await ctx.manager.setActive(personal.id);

    const check = await ctx.manager.verifyEffectiveIdentity(ctx.repo.path, work);

    expect(check.matches).toBe(true);
    expect(await ctx.repo.git.readConfig("user.email", { scope: "global" })).toBe(
      "dev@home.example",
    );
  });
});
