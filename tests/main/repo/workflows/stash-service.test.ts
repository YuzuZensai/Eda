import { RepositoryMemberships } from "@main/persistence/repository-memberships";
import { afterEach, expect, it, vi } from "vitest";
import { readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { ContentRecoveryRepository } from "@main/persistence/content-recovery-repository";
import { WorkflowJournal } from "@main/persistence/workflow-journal";
import { IdentityManager } from "@main/identity/identity-manager";
import type { Database } from "@main/persistence/types";
import { RepositoryManager } from "@main/repo/lifecycle/repository-manager";
import { RepositoryWriter } from "@main/repo/working-tree/repository-writer";
import { WorkflowService } from "@main/repo/workflows/workflow-service";
import { StashService } from "@main/repo/workflows/stash-service";
import { DiscardService } from "@main/repo/working-tree/discard-service";

let repo: TempRepo;
let db: Database;

afterEach(async () => {
  vi.restoreAllMocks();
  db?.close();
  await repo?.cleanup();
});

it("renames older stashes without changing saved trees or local work and keeps both entries when cleanup fails", async () => {
  const { service, repository } = await setup();

  await repo.writeFile("file.txt", "base\n");
  await repo.commit("base");
  await repo.writeFile("file.txt", "saved index\n");
  await repo.run(["add", "file.txt"]);
  await repo.writeFile("file.txt", "saved working\n");
  await repo.writeFile("untracked.txt", "saved untracked\n");
  await service.create(repository.id, "Original", "untracked");

  const original = (await service.list(repository.id)).entries[0]!;
  const stale = await service.inspect(repository.id, original.selector, original.oid);

  await repo.writeFile("file.txt", "newer stash\n");
  await service.create(repository.id, "Newer", "tracked");
  await expect(service.rename(repository.id, stale.token, "Renamed")).rejects.toThrow(
    /list changed/,
  );

  const newer = (await service.list(repository.id)).entries[0]!;

  await repo.writeFile("file.txt", "current staged\n");
  await repo.run(["add", "file.txt"]);
  await repo.writeFile("file.txt", "current working\n");

  const review = await service.inspect(repository.id, "stash@{1}", original.oid);
  const structure = await repo.run(["show", "-s", "--format=%T %P", original.oid]);

  expect(await service.rename(repository.id, review.token, "Renamed")).toEqual({
    keptOriginal: false,
  });

  const renamed = (await service.list(repository.id)).entries;

  expect(renamed.map((entry) => entry.message)).toEqual(["Renamed", newer.message]);
  expect(renamed[1]!.oid).toBe(newer.oid);
  expect(await repo.run(["show", "-s", "--format=%T %P", renamed[0]!.oid])).toBe(structure);
  expect(await repo.run(["show", ":file.txt"])).toBe("current staged\n");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("current working\n");

  const retry = await service.inspect(repository.id, "stash@{0}", renamed[0]!.oid);
  const exec = repo.git.exec.bind(repo.git);

  vi.spyOn(repo.git, "exec").mockImplementation((args, options) => {
    if (options.operation === "remove original stash description")
      return Promise.reject(new Error("Git refused cleanup"));
    return exec(args, options);
  });
  expect(await service.rename(repository.id, retry.token, "Retained copy")).toEqual({
    keptOriginal: true,
  });

  const retained = (await service.list(repository.id)).entries;

  expect(retained.map((entry) => entry.message)).toEqual([
    "Retained copy",
    "Renamed",
    newer.message,
  ]);
  expect(await repo.run(["show", "-s", "--format=%T %P", retained[0]!.oid])).toBe(structure);
  expect(await repo.run(["show", ":file.txt"])).toBe("current staged\n");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("current working\n");
}, 30_000);

async function setup() {
  repo = await createTempRepo();
  db = openInMemoryDatabase();

  const identities = new IdentityRepository(db);
  const profile = identities.create({
    name: "Eda",
    gitName: "Eda",
    gitEmail: "test@eda.invalid",
    hue: 0,
    signing: { format: "none", signCommits: false },
  });

  identities.setActiveId(profile.id);

  const identity = new IdentityManager(identities, repo.git);
  const repositories = new RepositoryManager(
    new RepositoryMemberships(db),
    repo.git,
    identity,
    identities,
  );
  const writer = new RepositoryWriter(repo.git, repositories, identity, identities);
  const workflows = new WorkflowService(
    repo.git,
    repositories,
    writer,
    identity,
    new WorkflowJournal(db),
    new ContentRecoveryRepository(db),
  );

  const service = new StashService(
    repo.git,
    repositories,
    writer,
    identity,
    workflows,
    new ContentRecoveryRepository(db),
  );

  const repository = await repositories.open(repo.path);

  return { service, repository, workflows, repositories, writer, identity, identities, profile };
}

it("preserves tracked/index/untracked/ignored stash contents and shares the list across worktrees while rejecting stale drops", async () => {
  const { service, repository, repositories, writer, identity } = await setup();

  await repo.writeFile("file.txt", "base\n");
  await repo.writeFile(".gitignore", "ignored.txt\n");
  await repo.writeFile("base-only.txt", "tracked on stash base\n");
  await repo.commit("base");

  const head = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.writeFile("file.txt", "staged version\n");
  await repo.run(["add", "file.txt"]);
  await repo.writeFile("file.txt", "working version\n");
  await repo.writeFile("untracked.txt", "untracked version\n");
  await repo.writeFile("ignored.txt", "ignored version\n");
  await service.create(repository.id, "Tracked work", "tracked");

  let list = await service.list(repository.id);

  expect(list.entries).toHaveLength(1);

  const tracked = list.entries[0]!;

  expect(tracked.message).toContain("Tracked work");

  const inspection = await service.inspect(repository.id, tracked.selector, tracked.oid);

  expect(inspection.tracked.files.map((file) => file.newPath)).toEqual(["file.txt"]);
  expect(inspection.staged.files.map((file) => file.newPath)).toEqual(["file.txt"]);
  expect(JSON.stringify(inspection.tracked)).toContain("working version");
  expect(JSON.stringify(inspection.staged)).toContain("staged version");
  expect(inspection.untracked).toBeNull();
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("base\n");
  expect(await readFile(join(repo.path, "untracked.txt"), "utf8")).toBe("untracked version\n");

  await service.create(repository.id, "Untracked work", "untracked");
  await expect(service.drop(repository.id, inspection.token)).rejects.toThrow(/list changed/);

  list = await service.list(repository.id);

  const untracked = list.entries[0]!;

  expect(
    JSON.stringify(
      (await service.inspect(repository.id, untracked.selector, untracked.oid)).untracked,
    ),
  ).toContain("untracked version");
  await expect(readFile(join(repo.path, "untracked.txt"))).rejects.toThrow();
  expect(await readFile(join(repo.path, "ignored.txt"), "utf8")).toBe("ignored version\n");

  await service.create(repository.id, "Ignored work", "all");
  list = await service.list(repository.id);

  const ignored = list.entries[0]!;

  expect(
    JSON.stringify((await service.inspect(repository.id, ignored.selector, ignored.oid)).untracked),
  ).toContain("ignored version");
  await expect(readFile(join(repo.path, "ignored.txt"))).rejects.toThrow();
  expect((await repo.run(["show", "-s", "--format=%an <%ae>", ignored.oid])).trim()).toBe(
    "Eda <test@eda.invalid>",
  );

  const linkedPath = join(repo.home, "linked");

  await repo.run(["worktree", "add", "-b", "linked", linkedPath]);

  const linked = await repositories.open(linkedPath);

  expect((await service.list(linked.id)).entries).toEqual(list.entries);

  const selected = list.entries.find((item) => item.oid === untracked.oid)!;
  const removal = await service.inspect(repository.id, selected.selector, selected.oid);
  const index = await repo.run(["write-tree"]);

  await service.drop(repository.id, removal.token);
  expect((await service.list(linked.id)).entries.map((item) => item.oid)).toEqual([
    ignored.oid,
    tracked.oid,
  ]);
  expect(await repo.run(["write-tree"])).toBe(index);
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(head);
  expect(await repo.run(["status", "--porcelain"])).toBe("");
  await expect(service.create(repository.id, "Empty", "tracked")).rejects.toThrow(
    /no eligible changes/,
  );

  const cleanReview = await service.inspect(
    repository.id,
    (await service.list(repository.id)).entries.find((entry) => entry.oid === tracked.oid)!
      .selector,
    tracked.oid,
  );

  expect(await service.apply(repository.id, cleanReview.token, true, true)).toEqual({
    applied: true,
    kept: false,
  });
  expect(await repo.run(["show", ":file.txt"])).toBe("staged version\n");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("working version\n");

  await repo.writeFile("restored.txt", "saved untracked\n");
  await service.create(repository.id, "Conflicting work", "untracked");
  await repo.writeFile("file.txt", "other branch content\n");
  await repo.commit("change destination");

  const conflictEntry = (await service.list(repository.id)).entries[0]!;
  const conflictReview = await service.inspect(
    repository.id,
    conflictEntry.selector,
    conflictEntry.oid,
  );

  expect(await service.apply(repository.id, conflictReview.token, true, false)).toEqual({
    applied: false,
    kept: true,
  });
  expect((await service.list(repository.id)).entries[0]!.oid).toBe(conflictEntry.oid);

  const resumed = new WorkflowService(
    repo.git,
    repositories,
    writer,
    identity,
    new WorkflowJournal(db),
    new ContentRecoveryRepository(db),
  );

  let workflow = await resumed.observe(repository.path, await repo.git.status(repo.path));

  expect(workflow?.kind).toBe("stash");
  await expect(resumed.finishStash(repository.id, workflow!.token)).rejects.toThrow(
    /every conflict/,
  );

  const sourceReview = await service.inspect(
    repository.id,
    conflictEntry.selector,
    conflictEntry.oid,
  );

  await expect(service.drop(repository.id, sourceReview.token)).rejects.toThrow(/before dropping/);

  await repo.writeFile("unrelated.txt", "keep me\n");

  const abort = await resumed.prepareAbort(repository.id);

  await resumed.abortMerge(repository.id, abort.token);
  expect(await resumed.observe(repository.path, await repo.git.status(repo.path))).toBeNull();
  await expect(readFile(join(repo.path, "restored.txt"))).rejects.toThrow();
  expect(await readFile(join(repo.path, "unrelated.txt"), "utf8")).toBe("keep me\n");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("other branch content\n");

  await repo.run(["add", "unrelated.txt"]);
  await repo.commit("retain unrelated work");

  const retry = await service.inspect(repository.id, conflictEntry.selector, conflictEntry.oid);

  expect((await service.apply(repository.id, retry.token, false, false)).applied).toBe(false);

  await repo.writeFile("file.txt", "resolved content\n");
  await repo.run(["add", "file.txt"]);
  workflow = await resumed.observe(repository.path, await repo.git.status(repo.path));

  const beforeFinish = await repo.run(["rev-parse", "HEAD"]);

  await resumed.finishStash(repository.id, workflow!.token);
  expect(await resumed.observe(repository.path, await repo.git.status(repo.path))).toBeNull();
  expect(await repo.run(["rev-parse", "HEAD"])).toBe(beforeFinish);
  expect(await repo.run(["show", ":file.txt"])).toBe("resolved content\n");
  expect((await service.list(repository.id)).entries[0]!.oid).toBe(conflictEntry.oid);

  const branchReview = await service.inspect(
    repository.id,
    conflictEntry.selector,
    conflictEntry.oid,
  );

  await expect(
    service.prepareBranch(repository.id, branchReview.token, "stash/recovered"),
  ).rejects.toThrow(/local changes/);

  await repo.commit("Retain resolved work");
  await repo.run(["rm", "base-only.txt"]);
  await repo.commit("Remove base-only file");

  const staleBranch = await service.prepareBranch(
    repository.id,
    branchReview.token,
    "stash/recovered",
  );

  await repo.run(["commit", "--allow-empty", "-m", "Moved current branch"]);
  await expect(service.createBranch(repository.id, staleBranch.token)).rejects.toThrow(
    /branch changed/,
  );

  await writeFile(join(repo.path, ".git", "info", "exclude"), "base-only.txt\n");
  await repo.writeFile("base-only.txt", "preserve ignored local work\n");

  const ignoredBranch = await service.prepareBranch(
    repository.id,
    branchReview.token,
    "stash/recovered",
  );

  await expect(service.createBranch(repository.id, ignoredBranch.token)).rejects.toThrow();
  expect(await readFile(join(repo.path, "base-only.txt"), "utf8")).toBe(
    "preserve ignored local work\n",
  );
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(ignoredBranch.head);

  await unlink(join(repo.path, "base-only.txt"));

  const hookPath = join(repo.path, ".git", "hooks", "post-checkout");

  await writeFile(hookPath, "#!/bin/sh\necho 'checkout hook refused' >&2\nexit 1\n");
  await chmod(hookPath, 0o755);

  const failedHook = await service.prepareBranch(
    repository.id,
    branchReview.token,
    "stash/hook-failure",
  );

  await expect(service.createBranch(repository.id, failedHook.token)).rejects.toThrow(
    /checked out.*needs attention/,
  );
  expect((await repo.run(["branch", "--show-current"])).trim()).toBe("stash/hook-failure");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(failedHook.base);
  expect((await service.list(repository.id)).entries[0]!.oid).toBe(conflictEntry.oid);

  await unlink(hookPath);
  await repo.run(["checkout", "main"]);

  const branch = await service.prepareBranch(repository.id, branchReview.token, "stash/recovered");

  expect(branch.base).toBe((await repo.run(["rev-parse", `${conflictEntry.oid}^1`])).trim());
  expect(await service.createBranch(repository.id, branch.token)).toEqual({ applied: true });
  expect((await repo.run(["branch", "--show-current"])).trim()).toBe("stash/recovered");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(branch.base);
  expect(await repo.run(["show", ":file.txt"])).toBe("staged version\n");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("working version\n");
  expect(await readFile(join(repo.path, "restored.txt"), "utf8")).toBe("saved untracked\n");
  expect((await service.list(repository.id)).entries[0]!.oid).toBe(conflictEntry.oid);
}, 60_000);

it("restores individual stash versions with recoverable overwrites, unchanged index, and stale-review protection", async () => {
  const { service, repository, profile, identities } = await setup();

  await repo.writeFile("file.txt", "base\n");
  await repo.writeFile("deleted.txt", "keep until restore\n");
  await repo.commit("base");
  await repo.writeFile("file.txt", "saved staged\n");
  await repo.run(["add", "file.txt"]);
  await repo.writeFile("file.txt", "saved working\n");
  await repo.run(["rm", "deleted.txt"]);
  await repo.writeFile("untracked.txt", "saved untracked\n");
  await service.create(repository.id, "Individual versions", "untracked");

  const entry = (await service.list(repository.id)).entries[0]!;
  const inspection = await service.inspect(repository.id, entry.selector, entry.oid);

  await repo.writeFile("file.txt", "current index\n");
  await repo.run(["add", "file.txt"]);
  await repo.writeFile("file.txt", "current working\n");

  const stale = await service.prepareFile(repository.id, inspection.token, "tracked", "file.txt");

  await repo.writeFile("file.txt", "external edit\n");
  await expect(service.restoreFile(repository.id, stale.token)).rejects.toThrow(/file changed/);

  const fresh = await service.prepareFile(repository.id, inspection.token, "tracked", "file.txt");

  identities.setActiveId(null);
  await expect(async () => service.restoreFile(repository.id, fresh.token)).rejects.toThrow();

  identities.setActiveId(profile.id);
  await service.restoreFile(repository.id, fresh.token);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("saved working\n");
  expect(await repo.run(["show", ":file.txt"])).toBe("current index\n");

  const recovery = new DiscardService(repo.git, new ContentRecoveryRepository(db));
  const record = recovery.list(profile.id, repository.id)[0]!;

  expect(record.source).toBe("stash-file-restore");
  expect(recovery.savedFile(profile.id, repository.id, record.id, "file.txt").toString()).toBe(
    "external edit\n",
  );

  await recovery.restore(repository.path, profile.id, repository.id, record.id);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("external edit\n");
  expect(await repo.run(["show", ":file.txt"])).toBe("current index\n");

  const staged = await service.prepareFile(repository.id, inspection.token, "staged", "file.txt");

  await service.restoreFile(repository.id, staged.token);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("saved staged\n");
  expect(await repo.run(["show", ":file.txt"])).toBe("current index\n");

  const untracked = await service.prepareFile(
    repository.id,
    inspection.token,
    "untracked",
    "untracked.txt",
  );

  await service.restoreFile(repository.id, untracked.token);
  expect(await readFile(join(repo.path, "untracked.txt"), "utf8")).toBe("saved untracked\n");
  expect(await repo.run(["ls-files", "--", "untracked.txt"])).toBe("");

  const deletion = await service.prepareFile(
    repository.id,
    inspection.token,
    "tracked",
    "deleted.txt",
  );

  expect(deletion.deleted).toBe(true);

  await service.restoreFile(repository.id, deletion.token);
  await expect(readFile(join(repo.path, "deleted.txt"))).rejects.toThrow();
  expect(await repo.run(["show", ":deleted.txt"])).toBe("keep until restore\n");
  expect((await service.list(repository.id)).entries[0]!.oid).toBe(entry.oid);
}, 60_000);

it("stashes selected paths without copying unrelated staged work, preserves the requested index, and stashes only staged changes", async () => {
  const { service, repository } = await setup();

  for (const path of ["selected.txt", "unrelated.txt", "working.txt", "literal[1].txt"])
    await repo.writeFile(path, "base\n");

  await repo.commit("base");
  await repo.writeFile("selected.txt", "selected staged\n");
  await repo.writeFile("unrelated.txt", "unrelated staged\n");
  await repo.run(["add", "selected.txt", "unrelated.txt"]);
  await repo.writeFile("selected.txt", "selected working\n");
  await repo.writeFile("working.txt", "unrelated working\n");
  await repo.writeFile("untracked.txt", "keep untracked\n");
  await writeFile(join(repo.path, ".git", "index.lock"), "another operation");
  await expect(
    service.create(repository.id, "Blocked selection", "tracked", { paths: ["selected.txt"] }),
  ).rejects.toThrow(/index lock/);
  expect(await readFile(join(repo.path, ".git", "index.lock"), "utf8")).toBe("another operation");
  expect((await service.list(repository.id)).entries).toHaveLength(0);

  await unlink(join(repo.path, ".git", "index.lock"));
  await service.create(repository.id, "Selected only", "tracked", { paths: ["selected.txt"] });

  const selected = (await service.list(repository.id)).entries[0]!;
  const inspection = await service.inspect(repository.id, selected.selector, selected.oid);

  expect(inspection.tracked.files.map((file) => file.newPath)).toEqual(["selected.txt"]);
  expect(inspection.staged.files.map((file) => file.newPath)).toEqual(["selected.txt"]);
  expect(await repo.run(["show", ":selected.txt"])).toBe("base\n");
  expect(await readFile(join(repo.path, "selected.txt"), "utf8")).toBe("base\n");
  expect(await repo.run(["show", ":unrelated.txt"])).toBe("unrelated staged\n");
  expect(await readFile(join(repo.path, "working.txt"), "utf8")).toBe("unrelated working\n");

  await repo.writeFile("literal[1].txt", "keep staged\n");
  await repo.run(["add", "--", "literal[1].txt"]);
  await repo.writeFile("literal[1].txt", "save working\n");
  await service.create(repository.id, "Keep staged selection", "tracked", {
    paths: ["literal[1].txt"],
    keepIndex: true,
  });
  expect(await repo.run(["show", ":literal[1].txt"])).toBe("keep staged\n");
  expect(await readFile(join(repo.path, "literal[1].txt"), "utf8")).toBe("keep staged\n");

  const kept = (await service.list(repository.id)).entries[0]!;

  expect(
    (await service.inspect(repository.id, kept.selector, kept.oid)).tracked.files.map(
      (file) => file.newPath,
    ),
  ).toEqual(["literal[1].txt"]);

  await service.create(repository.id, "Staged only", "tracked", { stagedOnly: true });

  const staged = (await service.list(repository.id)).entries[0]!;

  expect(
    (await service.inspect(repository.id, staged.selector, staged.oid)).tracked.files.map(
      (file) => file.newPath,
    ),
  ).toEqual(["literal[1].txt", "unrelated.txt"]);
  expect(await repo.run(["diff", "--cached", "--name-only"])).toBe("");
  expect(await readFile(join(repo.path, "working.txt"), "utf8")).toBe("unrelated working\n");
  expect(await readFile(join(repo.path, "untracked.txt"), "utf8")).toBe("keep untracked\n");

  await repo.run(["mv", "selected.txt", "renamed.txt"]);
  await service.create(repository.id, "Selected rename", "tracked", { paths: ["renamed.txt"] });
  expect(await readFile(join(repo.path, "selected.txt"), "utf8")).toBe("base\n");
  await expect(readFile(join(repo.path, "renamed.txt"))).rejects.toThrow();
  expect(await repo.run(["diff", "--cached", "--name-only"])).toBe("");

  const renamed = (await service.list(repository.id)).entries[0]!;

  expect(await repo.run(["show", `${renamed.oid}:renamed.txt`])).toBe("base\n");
  expect(await repo.run(["ls-tree", "--name-only", renamed.oid, "--", "selected.txt"])).toBe("");

  await writeFile(join(repo.path, ".git", "info", "exclude"), "ignored.txt\n");
  await repo.writeFile("ignored.txt", "keep ignored\n");
  await repo.run(["rm", "selected.txt"]);
  await service.create(repository.id, "Selected deletion", "all", { paths: ["selected.txt"] });
  expect(await readFile(join(repo.path, "selected.txt"), "utf8")).toBe("base\n");
  expect(await readFile(join(repo.path, "ignored.txt"), "utf8")).toBe("keep ignored\n");
  expect(await readFile(join(repo.path, "untracked.txt"), "utf8")).toBe("keep untracked\n");

  const deleted = (await service.list(repository.id)).entries[0]!;

  expect(await repo.run(["ls-tree", "--name-only", deleted.oid, "--", "selected.txt"])).toBe("");
}, 60_000);
