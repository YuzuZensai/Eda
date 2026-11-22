import { afterEach, describe, expect, it } from "vitest";
import { GitError } from "@shared/errors";
import { createTempRepo, type TempRepo } from "../../helpers/temp-repo";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { SshService } from "@main/ssh/ssh-service";
import { NodeProcessRunner } from "@main/git/execution/node-process-runner";
import type { Identity } from "@shared/identity/identity";

let repos: TempRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
  repos = [];
});

const seeded = async () => {
  const repo = await createTempRepo({ init: true });
  repos.push(repo);
  await repo.writeFile("a.txt", "one");
  await repo.commit("initial");
  return repo;
};

it("reads remote names, ignored paths and configured commit templates from the worktree", async () => {
  const repo = await seeded();
  expect(await repo.git.remoteNames(repo.path)).toEqual([]);
  expect(await repo.git.commitTemplate(repo.path)).toBeNull();

  await repo.run(["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  await repo.writeFile(".gitignore", "*.ignored\n");
  await repo.writeFile("space name.ignored", "ignored");
  await repo.writeFile("visible.txt", "visible");
  await repo.writeFile("template", "Subject\n\n# Details\n");
  await repo.run(["config", "commit.template", "template"]);

  expect(await repo.git.remoteNames(repo.path)).toEqual(["origin"]);
  expect(await repo.git.ignoredFiles(repo.path)).toEqual(["space name.ignored"]);
  expect(await repo.git.commitTemplate(repo.path)).toBe("Subject\n\n# Details\n");
});

describe("branches against real Git", () => {
  it("creates, lists, renames and deletes a branch", async () => {
    const repo = await seeded();

    await repo.git.createBranch(repo.path, "feature/one");
    expect((await repo.git.listBranches(repo.path)).map((b) => b.name)).toContain("feature/one");

    await repo.git.renameBranch(repo.path, "feature/one", "feature/two");

    const names = (await repo.git.listBranches(repo.path)).map((b) => b.name);

    expect(names).toContain("feature/two");
    expect(names).not.toContain("feature/one");

    await repo.git.deleteBranch(repo.path, "feature/two");
    expect((await repo.git.listBranches(repo.path)).map((b) => b.name)).not.toContain(
      "feature/two",
    );
  });

  it("creates and checks out in one step, and marks HEAD", async () => {
    const repo = await seeded();
    await repo.git.createBranch(repo.path, "work", { checkout: true });

    const head = (await repo.git.listBranches(repo.path)).find((b) => b.isHead);
    expect(head?.name).toBe("work");
    expect((await repo.git.status(repo.path)).branch.head).toBe("work");
  });

  it("lists several branches without newline contamination", async () => {
    const repo = await seeded();
    for (const name of ["alpha", "beta", "gamma"]) await repo.git.createBranch(repo.path, name);

    const names = (await repo.git.listBranches(repo.path)).map((b) => b.name);
    expect(names.every((n) => n === n.trim())).toBe(true);
    expect(names).toEqual(expect.arrayContaining(["alpha", "beta", "gamma", "main"]));
  });

  it("checks out an existing branch", async () => {
    const repo = await seeded();
    await repo.git.createBranch(repo.path, "other");
    await repo.git.checkoutBranch(repo.path, "other");
    expect((await repo.git.status(repo.path)).branch.head).toBe("other");
  });

  it("refuses a ref name Git would reject", async () => {
    const repo = await seeded();
    await expect(repo.git.createBranch(repo.path, "bad..name")).rejects.toBeInstanceOf(GitError);
    await expect(repo.git.createBranch(repo.path, "--force")).rejects.toBeInstanceOf(GitError);
  });

  it("reports an unmerged branch delete as a typed error rather than silently forcing", async () => {
    const repo = await seeded();

    await repo.git.createBranch(repo.path, "unmerged", { checkout: true });
    await repo.writeFile("b.txt", "two");
    await repo.commit("on branch");
    await repo.git.checkoutBranch(repo.path, "main");

    await expect(repo.git.deleteBranch(repo.path, "unmerged")).rejects.toMatchObject({
      kind: "invalid-input",
      message: "This branch is not fully merged.",
    });
    expect((await repo.git.listBranches(repo.path)).map((branch) => branch.name)).toContain(
      "unmerged",
    );

    await expect(
      repo.git.deleteBranch(repo.path, "unmerged", { force: true }),
    ).resolves.toBeUndefined();
  });
});

describe("tags against real Git", () => {
  it("signs with the captured profile key, verifies trust, rejects tampering and preserves explicit unsigned tags", async () => {
    const repo = await seeded();
    const key = join(repo.home, "signing-key");

    await new SshService(new NodeProcessRunner(), repo.home).generateKey({
      path: key,
      type: "ed25519",
      comment: "Eda",
    });

    const identity: Identity = {
      id: "fixture",
      name: "Eda",
      gitName: "Eda",
      gitEmail: "test@eda.invalid",
      hue: 0,
      signing: { format: "ssh", keyRef: key, signCommits: false },
      createdAt: "",
      updatedAt: "",
    };

    await repo.git.createTag(
      repo.path,
      "signed",
      { message: "Release notes", sign: true },
      identity,
    );
    expect((await repo.git.verifyTag(repo.path, "signed")).status).toBe("unverified");

    const allowed = join(repo.home, "allowed-signers");

    await writeFile(allowed, `test@eda.invalid ${await readFile(`${key}.pub`, "utf8")}`);
    await repo.run(["config", "gpg.ssh.allowedSignersFile", allowed]);
    expect(await repo.git.verifyTag(repo.path, "signed")).toMatchObject({
      status: "verified",
      validity: "valid",
      signerTrust: "local",
      format: "ssh",
    });

    const bytes = await repo.run(["cat-file", "tag", "refs/tags/signed"]);
    const changed = await repo.git.exec(["hash-object", "-t", "tag", "-w", "--stdin"], {
      cwd: repo.path,
      operation: "tamper fixture",
      stdin: bytes.replace("Release notes", "Altered notes"),
    });

    await repo.run(["update-ref", "refs/tags/tampered", changed.stdout.trim()]);
    expect(await repo.git.verifyTag(repo.path, "tampered")).toMatchObject({
      status: "invalid",
      reasonCode: "bad-signature",
    });

    await repo.run(["config", "tag.gpgSign", "true"]);
    await repo.git.createTag(repo.path, "unsigned", { message: "Unsigned annotation" }, identity);
    await repo.git.createTag(repo.path, "lightweight", {}, identity);
    expect((await repo.git.verifyTag(repo.path, "unsigned")).status).toBe("unsigned");
    expect((await repo.git.verifyTag(repo.path, "lightweight")).status).toBe("unsigned");
  });

  it("returns the target commit for an annotated tag so inspection selects the history row", async () => {
    const repo = await seeded();

    await repo.git.createTag(repo.path, "annotated", { message: "Release notes" });

    const head = (await repo.run(["rev-parse", "HEAD"])).trim();
    const tagObject = (await repo.run(["rev-parse", "refs/tags/annotated"])).trim();

    expect(tagObject).not.toBe(head);
    expect(await repo.git.listTags(repo.path)).toEqual([
      {
        name: "annotated",
        oid: head,
        objectOid: tagObject,
        createdAt: expect.any(String),
        annotated: true,
        tagger: "Eda",
        message: "Release notes\n",
      },
    ]);
  });

  it("omits remote HEAD aliases from the branch navigator", async () => {
    const repo = await seeded();

    await repo.run(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await repo.run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

    const names = (await repo.git.listBranches(repo.path)).map((branch) => branch.name);

    expect(names).toContain("origin/main");
    expect(names).not.toContain("origin");
    expect(names).not.toContain("origin/HEAD");
  });

  it("creates a lightweight tag and lists it", async () => {
    const repo = await seeded();
    await repo.git.createTag(repo.path, "v1.0.0");

    const tags = await repo.git.listTags(repo.path);
    expect(tags.map((t) => t.name)).toEqual(["v1.0.0"]);
  });

  it("reports tagger dates for annotated tags and committer dates for lightweight tags", async () => {
    const repo = await seeded();
    await repo.git.createTag(repo.path, "initial");
    await repo.git.exec(["tag", "-a", "-m", "Later release of the initial commit", "annotated"], {
      cwd: repo.path,
      operation: "test setup",
      env: { overrides: { GIT_COMMITTER_DATE: "2026-03-01T00:00:00+00:00" } },
    });
    await repo.git.exec(["commit", "--allow-empty", "-m", "Later commit"], {
      cwd: repo.path,
      operation: "test setup",
      env: {
        overrides: {
          GIT_AUTHOR_DATE: "2026-01-15T00:00:00+00:00",
          GIT_COMMITTER_DATE: "2026-02-01T00:00:00+00:00",
        },
      },
    });
    await repo.git.createTag(repo.path, "lightweight");

    const tags = await repo.git.listTags(repo.path);
    expect(
      Object.fromEntries(
        tags.map((tag) => [tag.name, tag.createdAt && new Date(tag.createdAt).toISOString()]),
      ),
    ).toEqual({
      annotated: "2026-03-01T00:00:00.000Z",
      initial: "2026-01-01T00:00:00.000Z",
      lightweight: "2026-02-01T00:00:00.000Z",
    });
  });

  it("preserves exact tag names when branches have the same names", async () => {
    const repo = await seeded();
    await repo.run(["branch", "release"]);
    await repo.git.createTag(repo.path, "release", { message: "Release notes" });
    await repo.git.createTag(repo.path, "main");
    await repo.git.createTag(repo.path, "tags/release");
    expect((await repo.git.listTags(repo.path)).map((tag) => tag.name)).toEqual([
      "main",
      "release",
      "tags/release",
    ]);
    expect((await repo.git.listBranches(repo.path)).map((branch) => branch.name)).toEqual([
      "main",
      "release",
    ]);
    await repo.git.deleteTag(repo.path, "release");
    expect((await repo.git.listTags(repo.path)).map((tag) => tag.name)).toEqual([
      "main",
      "tags/release",
    ]);
    expect((await repo.run(["rev-parse", "refs/heads/release"])).trim()).toBe(
      (await repo.run(["rev-parse", "HEAD"])).trim(),
    );
  });

  it("lists several tags without newline contamination", async () => {
    const repo = await seeded();
    for (const name of ["v1.0.0", "v1.1.0", "v2.0.0"]) await repo.git.createTag(repo.path, name);

    const names = (await repo.git.listTags(repo.path)).map((t) => t.name);
    expect(names).toEqual(["v1.0.0", "v1.1.0", "v2.0.0"]);
    expect(names.every((n) => n === n.trim())).toBe(true);
  });

  it("creates an annotated tag with the message from stdin", async () => {
    const repo = await seeded();
    await repo.git.createTag(repo.path, "v2.0.0", { message: "release: two\n\nNotes here.\n" });

    expect(await repo.run(["tag", "-l", "--format=%(contents:subject)", "v2.0.0"])).toContain(
      "release: two",
    );
  });

  it("checks out a tag as a detached HEAD", async () => {
    const repo = await seeded();

    await repo.git.createTag(repo.path, "v1.0.0");
    await repo.writeFile("b.txt", "two");
    await repo.commit("second");

    await repo.git.checkoutTag(repo.path, "v1.0.0");

    const status = await repo.git.status(repo.path);

    expect(status.branch.detached).toBe(true);
  });

  it("deletes a tag", async () => {
    const repo = await seeded();
    await repo.git.createTag(repo.path, "v1.0.0");
    await repo.git.deleteTag(repo.path, "v1.0.0");
    expect(await repo.git.listTags(repo.path)).toEqual([]);
  });

  it("refuses an option-like tag name", async () => {
    const repo = await seeded();
    await expect(repo.git.createTag(repo.path, "-d")).rejects.toBeInstanceOf(GitError);
  });
});
