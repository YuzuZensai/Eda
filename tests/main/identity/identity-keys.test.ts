import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "@main/persistence/database";
import type { IdentityDraft } from "@shared/identity/identity";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { IdentityManager } from "@main/identity/identity-manager";
import { createTempRepo, type TempRepo } from "../../helpers/temp-repo";

const draft = (name: string, email: string, extra: Partial<IdentityDraft> = {}): IdentityDraft => ({
  name,
  gitName: name,
  gitEmail: email,
  hue: 210,
  signing: { format: "none", signCommits: false },
  ...extra,
});

const setup = async () => {
  const repo = await createTempRepo();
  const db = openInMemoryDatabase();
  const identities = new IdentityRepository(db);
  const manager = new IdentityManager(identities, repo.git);
  return { repo, identities, manager };
};

describe("per-identity SSH pinning", () => {
  let repo: TempRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it("captures author, signing and executable before waiting behind other operations", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(
      draft("Work", "work@example.com", {
        signing: { format: "ssh", keyRef: "/work.pub", signCommits: true },
      }),
    );
    const home = ctx.identities.create(draft("Home", "home@example.com"));

    ctx.identities.setActiveId(work.id);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = ctx.manager.serialize(async () => gate);
    const captured = ctx.manager.captureForOperation();

    ctx.identities.setActiveId(home.id);
    release();
    await blocked;
    expect(await captured).toMatchObject({
      identityId: work.id,
      gitEmail: work.gitEmail,
      signing: { keyRef: "/work.pub" },
      gitExecutable: repo.git.gitPath,
    });
  });

  it("captures the identity at operation start so a mid-push switch cannot change it", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const work = ctx.identities.create(
      draft("Work", "dev@work.example", { sshKeyPath: "/keys/work" }),
    );
    const personal = ctx.identities.create(
      draft("Personal", "dev@home.example", { sshKeyPath: "/keys/personal" }),
    );

    await ctx.manager.setActive(work.id);

    const captured = await ctx.manager.captureForOperation();

    await ctx.manager.setActive(personal.id);

    expect(captured?.identityName).toBe("Work");
    expect(captured?.sshKeyPath).toBe("/keys/work");
    expect(ctx.manager.getActive()?.name).toBe("Personal");
  });
});

describe("signing configuration", () => {
  let repo: TempRepo | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  it("writes SSH signing config and verifies it by read-back", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const signer = ctx.identities.create(
      draft("OSS", "dev@oss.example", {
        signing: { format: "ssh", keyRef: "/keys/sign_ed25519.pub", signCommits: true },
      }),
    );

    const report = await ctx.manager.setActive(signer.id);

    expect(report.steps.find((s) => s.name === "write-signing-config")?.status).toBe("ok");
    expect(await ctx.repo.git.readConfig("gpg.format", { scope: "global" })).toBe("ssh");
    expect(await ctx.repo.git.readConfig("user.signingkey", { scope: "global" })).toBe(
      "/keys/sign_ed25519.pub",
    );
    expect(await ctx.repo.git.readConfig("commit.gpgsign", { scope: "global" })).toBe("true");
  });

  it("clears signing when switching to an identity that does not sign", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const signer = ctx.identities.create(
      draft("OSS", "dev@oss.example", {
        signing: { format: "ssh", keyRef: "/keys/sign.pub", signCommits: true },
      }),
    );
    const plain = ctx.identities.create(draft("Work", "dev@work.example"));

    await ctx.manager.setActive(signer.id);
    await ctx.manager.setActive(plain.id);

    expect(await ctx.repo.git.readConfig("user.signingkey", { scope: "global" })).toBeUndefined();
    expect(await ctx.repo.git.readConfig("commit.gpgsign", { scope: "global" })).toBe("false");
    expect(await ctx.repo.git.readConfig("gpg.format", { scope: "global" })).toBeUndefined();
  });

  it("supports GPG signing as well as SSH", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const gpg = ctx.identities.create(
      draft("Work", "dev@work.example", {
        signing: { format: "gpg", keyRef: "ABCD1234", signCommits: true },
      }),
    );

    await ctx.manager.setActive(gpg.id);

    expect(await ctx.repo.git.readConfig("gpg.format", { scope: "global" })).toBe("openpgp");
    expect(await ctx.repo.git.readConfig("user.signingkey", { scope: "global" })).toBe("ABCD1234");
  });

  it("clears every stale local signing field for a non-signing identity", async () => {
    const ctx = await setup();

    repo = ctx.repo;
    await ctx.repo.git.writeConfig("gpg.format", "ssh", { scope: "local", cwd: ctx.repo.path });
    await ctx.repo.git.writeConfig("user.signingkey", "/keys/stale.pub", {
      scope: "local",
      cwd: ctx.repo.path,
    });
    await ctx.repo.git.writeConfig("commit.gpgsign", "true", {
      scope: "local",
      cwd: ctx.repo.path,
    });

    const plain = ctx.identities.create(draft("Work", "dev@work.example"));

    await ctx.manager.applyToRepository(ctx.repo.path, plain);

    expect(await ctx.repo.git.readConfig("gpg.format", { cwd: ctx.repo.path })).toBeUndefined();
    expect(
      await ctx.repo.git.readConfig("user.signingkey", { cwd: ctx.repo.path }),
    ).toBeUndefined();
    expect(await ctx.repo.git.readConfig("commit.gpgsign", { cwd: ctx.repo.path })).toBe("false");
  });

  it("flags a missing key file without rolling back the switch", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const identity = ctx.identities.create(
      draft("Work", "dev@work.example", { sshKeyPath: "/keys/deleted-since-setup" }),
    );

    const report = await ctx.manager.setActive(identity.id);

    expect(ctx.manager.getActive()?.id).toBe(identity.id);
    expect(await ctx.repo.git.readConfig("user.email", { scope: "global" })).toBe(
      "dev@work.example",
    );
    expect(report.verified).toBe(false);
    expect(report.steps.find((s) => s.name === "activate-ssh-key")?.status).toBe("failed");
  });

  it("accepts a key that is present on disk", async () => {
    const ctx = await setup();

    repo = ctx.repo;

    const keyPath = join(ctx.repo.home, "id_ed25519");

    await writeFile(keyPath, "pretend-key", { mode: 0o600 });

    const identity = ctx.identities.create(
      draft("Work", "dev@work.example", { sshKeyPath: keyPath }),
    );
    const report = await ctx.manager.setActive(identity.id);

    expect(report.verified).toBe(true);
    expect(report.steps.find((s) => s.name === "activate-ssh-key")?.status).toBe("ok");
  });
});
