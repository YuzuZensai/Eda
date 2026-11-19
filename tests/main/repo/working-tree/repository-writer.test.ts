import { afterEach, describe, expect, it, vi } from "vitest";
import { GitError } from "@shared/errors";
import { IdentityManager } from "@main/identity/identity-manager";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { SettingsRepository } from "@main/persistence/settings-repository";
import { repositories as repositoryTable } from "@main/persistence/schema";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { RepositoryWriter } from "@main/repo/working-tree/repository-writer";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chmod, readFile, writeFile } from "node:fs/promises";

let repos: TempRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
  repos = [];
});

async function setup(options: { gitName?: string; gitEmail?: string } = {}) {
  const repo = await createTempRepo({ init: true });

  repos.push(repo);
  await repo.writeFile("a.txt", "one");
  await repo.commit("initial");

  const db = openInMemoryDatabase();
  const identities = new IdentityRepository(db);
  const identity = identities.create({
    name: "Work",
    gitName: options.gitName ?? "Eda",
    gitEmail: options.gitEmail ?? "test@eda.invalid",
    hue: 210,
    signing: { format: "none", signCommits: false },
  });

  identities.setActiveId(identity.id);

  db.insert(repositoryTable)
    .values([
      { id: "r1", identityId: identity.id, path: repo.path, name: "repo", createdAt: "now" },
      {
        id: "r2",
        identityId: identity.id,
        path: join(repo.home, "linked"),
        name: "linked",
        createdAt: "now",
      },
    ])
    .run();
  const settings = new SettingsRepository(db);
  const manager = new IdentityManager(identities, repo.git, settings);
  const paths = new Map([["r1", repo.path]]);
  const repositories = {
    resolveActiveRepository: (id: string) => ({
      id,
      identityId: identity.id,
      path: paths.get(id)!,
    }),
  } as never;

  const writer = new RepositoryWriter(repo.git, repositories, manager, identities);

  return { repo, writer, identities, identity, paths, settings, manager };
}

describe("staging and committing through the writer", () => {
  it("stages, commits, and reports the new oid", async () => {
    const { repo, writer } = await setup();

    await repo.writeFile("b.txt", "two");

    await writer.stage("r1", ["b.txt"]);

    const { oid } = await writer.commit("r1", "feat: add b");

    expect(oid).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await repo.run(["log", "-1", "--format=%s"])).toContain("feat: add b");
  });

  it("stages everything when no paths are given", async () => {
    const { repo, writer } = await setup();

    await repo.writeFile("b.txt", "two");
    await repo.writeFile("c.txt", "three");

    await writer.stage("r1");
    await writer.commit("r1", "feat: add both");

    expect(await repo.run(["show", "--stat", "--format=", "HEAD"])).toContain("c.txt");
  });

  it("unstages without discarding the working tree change", async () => {
    const { repo, writer } = await setup();

    await repo.writeFile("a.txt", "changed");

    await writer.stage("r1", ["a.txt"]);
    await writer.unstage("r1", ["a.txt"]);

    const status = await repo.git.status(repo.path);

    expect(status.changes.map((c) => c.worktree)).toEqual(["M"]);
  });
});

describe("pre-commit identity verification", () => {
  it("creates an actual SSH-signed commit with the originating profile key", async () => {
    const { repo, writer, identities, identity } = await setup();
    const key = join(repo.home, "signing-key");

    execFileSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-f", key, "-C", "fixture@example.test"],
      { stdio: "pipe" },
    );
    identities.configureSigning(identity.id, { format: "ssh", keyRef: key, signCommits: true });
    await repo.writeFile("signed.txt", "signed");
    await writer.stage("r1", ["signed.txt"]);
    await writer.commit("r1", "signed by Work");
    expect(await repo.run(["cat-file", "commit", "HEAD"])).toContain(
      "gpgsig -----BEGIN SSH SIGNATURE-----",
    );
    expect((await repo.run(["log", "-1", "--format=%ae"])).trim()).toBe(identity.gitEmail);
  });

  it("explains a missing signing key and keeps staged changes after signing fails", async () => {
    const { repo, writer, identities, identity } = await setup();

    identities.configureSigning(identity.id, {
      format: "ssh",
      keyRef: join(repo.home, "missing-key"),
      signCommits: true,
    });
    await repo.writeFile("signed.txt", "keep staged");
    await writer.stage("r1", ["signed.txt"]);
    await expect(writer.commit("r1", "must fail")).rejects.toMatchObject({
      message: "Git could not sign this change with the selected key.",
    });
    expect(
      (await repo.git.status(repo.path)).changes.some(
        (c) => c.path === "signed.txt" && c.index === "A",
      ),
    ).toBe(true);
    expect((await repo.run(["rev-list", "--count", "HEAD"])).trim()).toBe("1");
  });

  it("pins author/signing settings for hook child Git even after an external global edit", async () => {
    const { repo, writer, identity } = await setup();

    await repo.writeFile(
      ".git/hooks/pre-commit",
      "#!/bin/sh\ngit config user.email > hook-email.txt\ngit config commit.gpgsign > hook-signing.txt\n",
    );
    await chmod(join(repo.path, ".git/hooks/pre-commit"), 0o755);
    await repo.writeFile("b.txt", "two");
    await writer.stage("r1", ["b.txt"]);

    const original = repo.git.commit.bind(repo.git);

    vi.spyOn(repo.git, "commit").mockImplementationOnce(async (...args) => {
      await repo.git.writeConfig("user.email", "external@example.com", { scope: "global" });
      await repo.git.writeConfig("commit.gpgsign", "true", { scope: "global" });
      return original(...args);
    });
    await writer.commit("r1", "pinned hook");
    expect((await repo.run(["log", "-1", "--format=%ae:%ce"])).trim()).toBe(
      `${identity.gitEmail}:${identity.gitEmail}`,
    );
    expect((await readFile(join(repo.path, "hook-email.txt"), "utf8")).trim()).toBe(
      identity.gitEmail,
    );
    expect((await readFile(join(repo.path, "hook-signing.txt"), "utf8")).trim()).toBe("false");
  });

  it("keeps the accepted identity when the visible profile changes while the commit is queued", async () => {
    const { repo, writer, identities, identity } = await setup();

    await repo.writeFile("queued.txt", "queued content");

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stage = repo.git.stage.bind(repo.git);

    repo.git.stage = async (path, paths) => {
      await blocked;
      return stage(path, paths);
    };

    const staging = writer.stage("r1", ["queued.txt"]);
    const committing = writer.commit("r1", "queued under Work");
    const other = identities.create({
      ...identity,
      name: "Other",
      gitName: "Other Author",
      gitEmail: "other@example.com",
    });

    identities.setActiveId(other.id);
    release();
    await Promise.all([staging, committing]);
    expect((await repo.run(["log", "-1", "--format=%ae"])).trim()).toBe(identity.gitEmail);
    expect(identities.getActiveId()).toBe(other.id);
  });

  it("uses the approved profile even when external author and committer configuration differs", async () => {
    const { repo, writer } = await setup({ gitEmail: "work@example.com" });

    await repo.writeFile("b.txt", "two");
    await writer.stage("r1", ["b.txt"]);

    for (const key of ["user.email", "author.email", "committer.email"])
      await repo.git.writeConfig(key, "external@example.com", { cwd: repo.path, scope: "local" });
    await writer.commit("r1", "feat: b");
    expect((await repo.run(["log", "-1", "--format=%ae:%ce"])).trim()).toBe(
      "work@example.com:work@example.com",
    );
    expect(await repo.git.readConfig("user.email", { cwd: repo.path, scope: "local" })).toBe(
      "external@example.com",
    );
  });

  it("uses only an explicitly saved repository identity and restores profile inheritance", async () => {
    const { repo, writer, identity, settings } = await setup({ gitEmail: "work@example.com" });
    const scope = { kind: "repository", profileId: identity.id, repositoryId: "r1" } as const;
    settings.set("repositoryCommitIdentity", scope, {
      name: "Repo Author",
      email: "repo@example.com",
    });
    await repo.git.writeConfig("user.email", "outside@example.com", {
      cwd: repo.path,
      scope: "local",
    });
    expect((await writer.previewCommit("r1")).author).toEqual({
      name: "Repo Author",
      email: "repo@example.com",
    });
    await repo.writeFile("b.txt", "two");
    await writer.stageAndCommit("r1", ["b.txt"], "repo author");
    expect((await repo.run(["log", "-1", "--format=%an:%ae:%cn:%ce"])).trim()).toBe(
      "Repo Author:repo@example.com:Repo Author:repo@example.com",
    );
    settings.reset("repositoryCommitIdentity", scope);
    await repo.writeFile("c.txt", "three");
    await writer.stageAndCommit("r1", ["c.txt"], "profile author");
    expect((await repo.run(["log", "-1", "--format=%ae:%ce"])).trim()).toBe(
      "work@example.com:work@example.com",
    );
  });

  it("refuses an invalid saved profile identity before creating a commit", async () => {
    const { repo, writer, identities, identity } = await setup();
    identities.update(identity.id, { gitName: "Invalid <author>" });
    await repo.writeFile("b.txt", "two");
    await writer.stage("r1", ["b.txt"]);
    expect(() => writer.commit("r1", "must fail")).toThrow(GitError);
    expect((await repo.run(["rev-list", "--count", "HEAD"])).trim()).toBe("1");
  });

  it("preserves original authorship on amend and pins the approved committer", async () => {
    const { repo, writer } = await setup({ gitEmail: "work@example.com" });
    await repo.git.writeConfig("committer.email", "outside@example.com", { scope: "global" });
    await writer.commit("r1", "amended", { amend: true });
    expect((await repo.run(["log", "-1", "--format=%ae:%ce"])).trim()).toBe(
      "test@eda.invalid:work@example.com",
    );
  });
});

describe("per-repository write serialization", () => {
  it("does not let a concurrent commit steal files staged for another commit", async () => {
    const { repo, writer } = await setup();

    await repo.writeFile("mine.txt", "mine");
    await repo.writeFile("theirs.txt", "theirs");

    await Promise.all([
      writer.stageAndCommit("r1", ["mine.txt"], "feat: mine"),
      writer.stageAndCommit("r1", ["theirs.txt"], "feat: theirs"),
    ]);

    const named = async (subject: string) =>
      (await repo.run(["show", "--name-only", "--format=", `:/${subject}`]))
        .trim()
        .split("\n")
        .filter(Boolean);

    expect(await named("feat: mine")).toEqual(["mine.txt"]);
    expect(await named("feat: theirs")).toEqual(["theirs.txt"]);
  });

  it("runs concurrent commits without surfacing an index.lock error", async () => {
    const { repo, writer } = await setup();

    for (let index = 0; index < 6; index += 1) {
      await repo.writeFile(`file-${index}.txt`, String(index));
    }

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_unused, index) =>
        writer.stageAndCommit("r1", [`file-${index}.txt`], `feat: file ${index}`),
      ),
    );

    const failures = results.filter((r) => r.status === "rejected");

    expect(failures).toEqual([]);
    expect((await repo.run(["rev-list", "--count", "HEAD"])).trim()).toBe("7");
  });

  it("coordinates shared refs while preserving independent indexes across linked worktrees", async () => {
    const { repo, writer, paths } = await setup();
    const linked = join(repo.home, "linked");

    await repo.run(["worktree", "add", "-b", "linked", linked]);
    paths.set("r2", linked);
    await writeFile(join(linked, "linked.txt"), "linked content");

    await Promise.all([
      writer.createBranch("r1", "alpha"),
      writer.createBranch("r2", "beta"),
      writer.stage("r2", ["linked.txt"]),
      (async () => {
        await repo.writeFile("b.txt", "two");
        await writer.stage("r1", ["b.txt"]);
      })(),
      writer.createTag("r1", "v1.0.0"),
    ]);

    const branches = (await writer.listBranches("r1")).map((b) => b.name);

    expect(branches).toEqual(expect.arrayContaining(["alpha", "beta"]));
    expect((await writer.listTags("r1")).map((t) => t.name)).toEqual(["v1.0.0"]);
    expect((await writer.listBranches("r2")).map((branch) => branch.name)).toEqual(
      expect.arrayContaining(["alpha", "beta"]),
    );

    await Promise.all([
      writer.commit("r1", "main worktree content"),
      writer.commit("r2", "linked worktree content"),
    ]);
    expect((await repo.run(["show", "--name-only", "--format=", "main"])).trim()).toBe("b.txt");
    expect((await repo.run(["show", "--name-only", "--format=", "linked"])).trim()).toBe(
      "linked.txt",
    );
  });

  it("keeps serving writes after one fails", async () => {
    const { repo, writer } = await setup();

    const failed = writer.commit("r1", "nothing staged").catch((error: unknown) => error);

    await repo.writeFile("b.txt", "two");
    await writer.stage("r1", ["b.txt"]);

    const succeeded = await writer.commit("r1", "feat: recovered");

    expect(await failed).toBeInstanceOf(GitError);
    expect(succeeded.oid).toMatch(/^[0-9a-f]{40,64}$/);
  });
});

describe("removing local commit configuration", () => {
  it("removes selected author/signing keys, including repeated values, while preserving inherited and unrelated configuration", async () => {
    const { repo, writer, identity } = await setup();
    const included = join(repo.home, "included.gitconfig");
    const includedContent = "[user]\nname = Included author\nemail = included@example.com\n";

    await writeFile(included, includedContent);

    const globalBefore = await readFile(join(repo.home, ".gitconfig"), "utf8");

    await repo.run(["config", "include.path", included]);
    await repo.run(["config", "remote.origin.url", "https://example.com/repo.git"]);
    await repo.run(["config", "core.editor", "keep-editor"]);
    await repo.run(["config", "user.useConfigOnly", "true"]);
    await writer.applyProfile("r1");
    await repo.run(["config", "--add", "user.email", "second@example.com"]);

    await writer.clearLocalCommitConfig("r1", "author");
    expect(
      await repo.git.readConfig("user.name", { cwd: repo.path, scope: "local" }),
    ).toBeUndefined();
    expect(
      await repo.git.readConfig("user.email", { cwd: repo.path, scope: "local" }),
    ).toBeUndefined();
    expect(await repo.git.readConfig("user.email", { cwd: repo.path })).toBe(
      "included@example.com",
    );
    expect(await repo.git.readConfig("commit.gpgsign", { cwd: repo.path, scope: "local" })).toBe(
      "false",
    );

    await writer.applyProfile("r1");
    await repo.run(["config", "gpg.format", "ssh"]);
    await repo.run(["config", "user.signingkey", "local-key"]);
    await writer.clearLocalCommitConfig("r1", "signing");
    expect(await repo.git.readConfig("user.email", { cwd: repo.path, scope: "local" })).toBe(
      identity.gitEmail,
    );

    for (const key of ["gpg.format", "user.signingkey", "commit.gpgsign"])
      expect(await repo.git.readConfig(key, { cwd: repo.path, scope: "local" })).toBeUndefined();

    expect(await repo.git.readConfig("commit.gpgsign", { cwd: repo.path })).toBe("false");

    await writer.applyProfile("r1");
    await writer.clearLocalCommitConfig("r1", "all");
    await writer.clearLocalCommitConfig("r1", "all");
    expect(await repo.git.readConfig("user.email", { cwd: repo.path })).toBe(
      "included@example.com",
    );
    expect(await repo.run(["config", "remote.origin.url"])).toBe("https://example.com/repo.git\n");
    expect(await repo.run(["config", "core.editor"])).toBe("keep-editor\n");
    expect(await repo.run(["config", "user.useConfigOnly"])).toBe("true\n");
    expect(await readFile(included, "utf8")).toBe(includedContent);
    expect(await readFile(join(repo.home, ".gitconfig"), "utf8")).toBe(globalBefore);
  });

  it("preserves the original config on a preparation failure or a foreign config lock", async () => {
    const { repo, writer } = await setup();

    await writer.applyProfile("r1");
    await repo.run(["config", "--add", "user.email", "second@example.com"]);

    const path = join(repo.path, ".git", "config");
    const original = await readFile(path, "utf8");
    const exec = repo.git.exec.bind(repo.git);
    const failure = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
      if (options.operation === "remove local commit override" && args.at(-1) === "user.email")
        throw new Error("config denied");
      return exec(args, options);
    });

    try {
      await expect(writer.clearLocalCommitConfig("r1", "all")).rejects.toThrow("config denied");
    } finally {
      failure.mockRestore();
    }

    expect(await readFile(path, "utf8")).toBe(original);

    await writeFile(`${path}.lock`, "another writer");
    await expect(writer.clearLocalCommitConfig("r1", "all")).rejects.toMatchObject({
      kind: "lock-contention",
    });
    expect(await readFile(`${path}.lock`, "utf8")).toBe("another writer");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("removes the shared local keys from a linked worktree while retaining its worktree overrides", async () => {
    const { repo, writer, paths } = await setup();
    const linked = join(repo.home, "linked");

    await repo.run(["worktree", "add", "--detach", linked]);
    paths.set("r2", linked);
    await repo.run(["config", "extensions.worktreeConfig", "true"]);
    await writer.applyProfile("r1");
    await repo.run(["config", "--worktree", "user.email", "worktree@example.com"], linked);
    await writer.clearLocalCommitConfig("r2", "all");
    expect(
      await repo.git.readConfig("user.email", { cwd: repo.path, scope: "local" }),
    ).toBeUndefined();
    expect(await repo.git.readConfig("user.email", { cwd: linked })).toBe("worktree@example.com");
    expect(await repo.git.readConfig("user.email", { cwd: repo.path })).toBe("test@eda.invalid");
  });
});

describe("branches and tags through the writer", () => {
  it("pins the tagger to the accepted profile when external config changes after verification", async () => {
    const { repo, writer, identity } = await setup();
    const original = repo.git.createTag.bind(repo.git);

    vi.spyOn(repo.git, "createTag").mockImplementationOnce(async (...args) => {
      await repo.git.writeConfig("user.email", "external@example.com", { scope: "global" });
      return original(...args);
    });
    await writer.createTag("r1", "owned-tag", { message: "owned" });
    expect(await repo.run(["cat-file", "tag", "owned-tag"])).toContain(`<${identity.gitEmail}>`);
  });

  it("creates, checks out, renames and deletes branches", async () => {
    const { writer } = await setup();

    await writer.createBranch("r1", "work", { checkout: true });
    expect((await writer.listBranches("r1")).find((b) => b.isHead)?.name).toBe("work");

    await writer.checkoutBranch("r1", "main");
    await writer.renameBranch("r1", "work", "renamed");
    await writer.deleteBranch("r1", "renamed");

    expect((await writer.listBranches("r1")).map((b) => b.name)).not.toContain("renamed");
  });

  it("creates and deletes tags", async () => {
    const { writer } = await setup();
    await writer.createTag("r1", "v1.0.0", { message: "first release" });
    expect((await writer.listTags("r1")).map((t) => t.name)).toEqual(["v1.0.0"]);

    await writer.deleteTag("r1", "v1.0.0");
    expect(await writer.listTags("r1")).toEqual([]);
  });
});
