import { RepositoryMemberships } from "@main/persistence/repository-memberships";
import { afterEach, expect, it } from "vitest";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { openDatabase } from "@main/persistence/database";
import type { Database } from "@main/persistence/types";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { ContentRecoveryRepository } from "@main/persistence/content-recovery-repository";
import { WorkflowJournal } from "@main/persistence/workflow-journal";
import { IdentityManager } from "@main/identity/identity-manager";
import { RepositoryManager } from "@main/repo/lifecycle/repository-manager";
import { RepositoryWriter } from "@main/repo/working-tree/repository-writer";
import { WorkflowService } from "@main/repo/workflows/workflow-service";
import { RebaseService } from "@main/repo/workflows/rebase-service";
import { DiscardService } from "@main/repo/working-tree/discard-service";
import { autosquashPlan } from "@shared/workflows/rebase";

let repo: TempRepo;
let db: Database;

afterEach(async () => {
  db?.close();
  await repo?.cleanup();
});

function services() {
  db = openDatabase(join(repo.home, "rebase.db"));

  const identities = new IdentityRepository(db);
  const identity = new IdentityManager(identities, repo.git);
  const repositories = new RepositoryManager(
    new RepositoryMemberships(db),
    repo.git,
    identity,
    identities,
  );
  const writer = new RepositoryWriter(repo.git, repositories, identity, identities);
  const journal = new WorkflowJournal(db);
  const recovery = new ContentRecoveryRepository(db);
  const workflows = new WorkflowService(
    repo.git,
    repositories,
    writer,
    identity,
    journal,
    recovery,
  );

  return {
    identities,
    journal,
    repositories,
    workflows,
    rebase: new RebaseService(
      repo.git,
      repositories,
      writer,
      identity,
      workflows,
      journal,
      recovery,
    ),
    recovery: new DiscardService(repo.git, recovery),
  };
}

it("reviews a rebase, resumes conflicts after database reopen, preserves authors and protects skip/abort resolutions", async () => {
  repo = await createTempRepo();

  let context = services();
  const profile = context.identities.create({
    name: "Eda",
    gitName: "Eda",
    gitEmail: "test@eda.invalid",
    hue: 0,
    signing: { format: "none", signCommits: false },
  });

  context.identities.setActiveId(profile.id);

  const repository = await context.repositories.open(repo.path);

  await repo.writeFile("file.txt", "base\n");
  await repo.commit("base");
  await repo.run(["checkout", "-b", "topic"]);
  await repo.writeFile("file.txt", "topic\n");
  await repo.run(["add", "file.txt"]);
  await repo.run(["commit", "--author=Eda <original@eda.invalid>", "-m", "topic"]);

  const topic = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["checkout", "main"]);
  await repo.writeFile("file.txt", "upstream\n");
  await repo.commit("upstream");

  const onto = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["checkout", "topic"]);

  const stale = await context.rebase.prepare(repository.id, "start", onto);

  expect(stale.publishedCommits).toBe(0);

  await repo.writeFile("file.txt", "dirty\n");
  await expect(context.rebase.execute(repository.id, stale.token)).rejects.toThrow(
    /changed after review/,
  );

  await repo.writeFile("file.txt", "topic\n");
  await repo.run(["update-ref", "refs/remotes/origin/topic", topic]);
  await expect(context.rebase.execute(repository.id, stale.token)).rejects.toThrow(
    /Remote-tracking history changed/,
  );

  const start = await context.rebase.prepare(repository.id, "start", onto, true);
  await repo.git.writeConfig("user.email", "outside@example.com", { scope: "global" });

  expect(start.publishedCommits).toBe(1);
  expect(
    await context.rebase.execute(repository.id, start.token, [
      { ...start.plan![0]!, action: "reword", message: "Reviewed topic after restart" },
    ]),
  ).toMatchObject({
    state: "needs-attention",
  });
  await expect(context.rebase.prepare(repository.id, "continue")).rejects.toThrow(/every conflict/);

  db.close();
  context = services();
  expect(
    await context.workflows.observe(repository.path, await repo.git.status(repo.path)),
  ).toMatchObject({ kind: "rebase", ownerProfileId: profile.id });

  const other = context.identities.create({
    name: "Eda alternate",
    gitName: "Eda",
    gitEmail: "alternate@eda.invalid",
    hue: 1,
    signing: { format: "none", signCommits: false },
  });

  context.identities.setActiveId(other.id);

  const otherRepository = await context.repositories.open(repo.path);

  await expect(context.rebase.prepare(otherRepository.id, "abort")).rejects.toThrow(
    /profile that owns/,
  );

  context.identities.setActiveId(profile.id);
  await repo.writeFile("file.txt", "resolved\n");

  const staleRebase = context.journal.activeLocal(repository.path, "rebase")!;

  expect(staleRebase.nativeInstance).toEqual(expect.any(String));

  await repo.run(["add", "file.txt"]);

  const resume = await context.rebase.prepare(repository.id, "continue");

  expect(resume.publishedCommits).toBe(1);
  expect(await context.rebase.execute(repository.id, resume.token)).toMatchObject({
    state: "completed",
    publishedCommits: 1,
  });
  expect((await repo.run(["rev-parse", "HEAD^"])).trim()).toBe(onto);
  expect((await repo.run(["show", "-s", "--format=%B"])).trim()).toBe(
    "Reviewed topic after restart",
  );
  expect((await repo.run(["show", "-s", "--format=%an <%ae>|%cn <%ce>"])).trim()).toBe(
    "Eda <original@eda.invalid>|Eda <test@eda.invalid>",
  );
  expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe("outside@example.com");
  await repo.git.writeConfig("user.email", "test@eda.invalid", { scope: "global" });
  expect(await repo.run(["status", "--porcelain"])).toBe("");

  context.journal.save(staleRebase);
  await repo.run(["checkout", "-b", "external-topic", topic]);
  await repo.git.exec(["rebase", onto], {
    cwd: repo.path,
    operation: "start external rebase",
    allowedExitCodes: [1],
  });
  db.close();
  context = services();
  expect(
    await context.workflows.observe(repository.path, await repo.git.status(repo.path)),
  ).not.toHaveProperty("ownerProfileId");

  context.journal.save({ ...staleRebase, branch: "external-topic", incoming: [onto] });
  expect(
    await context.workflows.observe(repository.path, await repo.git.status(repo.path)),
  ).not.toHaveProperty("ownerProfileId");

  context.identities.setActiveId(other.id);

  const unownedReview = await context.rebase.prepare(otherRepository.id, "abort");

  expect(unownedReview).toMatchObject({ branch: "external-topic", onto, email: other.gitEmail });

  context.journal.save({ ...staleRebase, branch: "external-topic", incoming: [topic] });
  expect(
    await context.workflows.observe(repository.path, await repo.git.status(repo.path)),
  ).not.toHaveProperty("ownerProfileId");
  expect(await context.rebase.prepare(otherRepository.id, "abort")).toMatchObject({
    branch: "external-topic",
    onto,
    email: other.gitEmail,
  });

  context.identities.setActiveId(profile.id);
  expect(
    await context.workflows.observe(repository.path, await repo.git.status(repo.path)),
  ).toMatchObject({
    kind: "rebase",
    originalBranch: "external-topic",
    rebaseOnto: onto,
  });

  await repo.writeFile("file.txt", "external resolved\n");
  await repo.run(["add", "file.txt"]);

  const external = await context.rebase.prepare(repository.id, "continue");

  expect(external).toMatchObject({ branch: "external-topic", onto, publishedCommits: 1 });

  const hook = join(repo.path, ".git/hooks/prepare-commit-msg");

  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(await context.rebase.execute(repository.id, external.token)).toMatchObject({
    state: "needs-attention",
  });

  db.close();
  context = services();
  expect(
    await context.workflows.observe(repository.path, await repo.git.status(repo.path)),
  ).toMatchObject({ ownerProfileId: profile.id });

  await unlink(hook);

  const externalResume = await context.rebase.prepare(repository.id, "continue");

  expect(await context.rebase.execute(repository.id, externalResume.token)).toMatchObject({
    state: "completed",
    publishedCommits: 1,
  });
  expect((await repo.run(["branch", "--show-current"])).trim()).toBe("external-topic");
  expect((await repo.run(["rev-parse", "HEAD^"])).trim()).toBe(onto);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("external resolved\n");

  await repo.run(["checkout", "-b", "abort-topic", topic]);

  const again = await context.rebase.prepare(repository.id, "start", onto);

  await context.rebase.execute(repository.id, again.token);
  await repo.writeFile("file.txt", "saved abort resolution\n");
  await repo.writeFile("unrelated.txt", "keep\n");

  const abort = await context.rebase.prepare(repository.id, "abort");

  await repo.writeFile("file.txt", "newer resolution\n");
  await expect(context.rebase.execute(repository.id, abort.token)).rejects.toThrow(
    /changed after review/,
  );

  db.close();
  context = services();

  const currentAbort = await context.rebase.prepare(repository.id, "abort");

  expect(await context.rebase.execute(repository.id, currentAbort.token)).toMatchObject({
    state: "completed",
  });
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(topic);
  expect(await readFile(join(repo.path, "unrelated.txt"), "utf8")).toBe("keep\n");

  const snapshot = context.recovery.list(profile.id, repository.id)[0]!;

  expect(snapshot.source).toBe("rebase-recovery");
  expect(
    context.recovery.savedFile(profile.id, repository.id, snapshot.id, "file.txt").toString(),
  ).toBe("newer resolution\n");

  await repo.run(["add", "unrelated.txt"]);
  await repo.commit("keep unrelated");

  const skipStart = await context.rebase.prepare(repository.id, "start", onto, true);

  await context.rebase.execute(
    repository.id,
    skipStart.token,
    skipStart.plan!.map((entry, index) =>
      index === 0
        ? { ...entry, action: "reword", message: "This skipped message must not be used" }
        : entry,
    ),
  );
  await repo.writeFile("file.txt", "skipped resolution\n");

  const skip = await context.rebase.prepare(repository.id, "skip");

  expect(await context.rebase.execute(repository.id, skip.token)).toMatchObject({
    state: "completed",
  });
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("upstream\n");
  expect(await readFile(join(repo.path, "unrelated.txt"), "utf8")).toBe("keep\n");
  expect(await repo.run(["status", "--porcelain"])).toBe("");
  expect((await repo.run(["rev-parse", "HEAD^"])).trim()).toBe(onto);
  expect((await repo.run(["show", "-s", "--format=%s"])).trim()).toBe("keep unrelated");

  const skipped = context.recovery
    .list(profile.id, repository.id)
    .find((item) => item.source === "rebase-recovery")!;

  expect(
    context.recovery.savedFile(profile.id, repository.id, skipped.id, "file.txt").toString(),
  ).toBe("skipped resolution\n");
}, 60_000);

it("applies reviewed history plans and resumes autosquash/edit stops without losing staged or unstaged work", async () => {
  repo = await createTempRepo();

  let context = services();
  const profile = context.identities.create({
    name: "Eda",
    gitName: "Eda",
    gitEmail: "test@eda.invalid",
    hue: 0,
    signing: { format: "none", signCommits: false },
  });

  context.identities.setActiveId(profile.id);

  const repository = await context.repositories.open(repo.path);

  await repo.writeFile("base.txt", "base\n");
  await repo.commit("base");

  const base = (await repo.run(["rev-parse", "HEAD"])).trim();

  for (const name of ["a", "b", "c", "d"]) {
    await repo.writeFile(`${name}.txt`, `${name}\n`);
    await repo.commit(name);
  }

  const original = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["update-ref", "refs/remotes/origin/published-prefix", "HEAD~2"]);

  const review = await context.rebase.prepare(repository.id, "start", base, true);

  expect(review.publishedCommits).toBe(2);

  const [a, b, c, d] = review.plan!;

  expect(review.plan!.map((entry) => entry.message)).toEqual(["a", "b", "c", "d"]);
  await expect(async () =>
    context.rebase.execute(repository.id, review.token, [a, a, c, d]),
  ).rejects.toThrow(/exactly once/);
  await expect(async () =>
    context.rebase.execute(repository.id, review.token, [{ ...a, action: "squash" }, b, c, d]),
  ).rejects.toThrow(/preceding retained/);

  const message =
    "Combined a and b\n\n# Keep this message line\nLiteral $(touch forbidden) `echo nope` 'quotes'";

  expect(
    await context.rebase.execute(repository.id, review.token, [
      { ...b, action: "reword", message: "First b" },
      { ...a, action: "squash", message },
      { ...c, action: "drop" },
      d,
    ]),
  ).toMatchObject({ state: "completed" });
  expect((await repo.run(["rev-list", "--count", `${base}..HEAD`])).trim()).toBe("2");
  expect((await repo.run(["show", "-s", "--format=%B", "HEAD^"])).trim()).toBe(message);
  expect((await repo.run(["show", "-s", "--format=%s", "HEAD"])).trim()).toBe("d");
  expect((await repo.run(["ls-tree", "--name-only", "HEAD"])).trim().split("\n")).toEqual([
    "a.txt",
    "b.txt",
    "base.txt",
    "d.txt",
  ]);
  expect((await repo.run(["show", `${original}:c.txt`])).trim()).toBe("c");
  expect(await repo.run(["status", "--porcelain"])).toBe("");

  const dropAll = await context.rebase.prepare(repository.id, "start", base, true);

  expect(
    await context.rebase.execute(
      repository.id,
      dropAll.token,
      dropAll.plan!.map((entry) => ({ ...entry, action: "drop" })),
    ),
  ).toMatchObject({ state: "completed" });
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);
  expect(await repo.run(["status", "--porcelain"])).toBe("");

  for (const [name, message] of [
    ["target", "Target"],
    ["other", "Other"],
    ["fix", "fixup! Target"],
    ["squash", "squash! Other"],
    ["amend", "amend! Target\n\nRevised target\n\nBody"],
    ["late-fix", "fixup! Target"],
    ["late-other", "fixup! Other"],
    ["orphan", "fixup! Missing target"],
  ]) {
    await repo.writeFile(`${name}.txt`, `${name}\n`);
    await repo.commit(message!);
  }

  const autoReview = await context.rebase.prepare(repository.id, "start", base, true);
  const auto = autosquashPlan(autoReview.plan!);

  expect(auto.warnings).toHaveLength(1);
  expect(auto.plan.map((entry) => entry.action)).toEqual([
    "pick",
    "fixup",
    "fixup-reword",
    "fixup",
    "pick",
    "squash",
    "fixup",
    "pick",
  ]);

  auto.plan.at(-1)!.action = "edit";
  expect(await context.rebase.execute(repository.id, autoReview.token, auto.plan)).toMatchObject({
    state: "needs-attention",
  });

  db.close();
  context = services();
  expect(
    await context.workflows.observe(repository.path, await repo.git.status(repo.path)),
  ).toMatchObject({ rebaseEdit: true, ownerProfileId: profile.id });
  await expect(context.rebase.prepare(repository.id, "skip")).rejects.toThrow(
    /already been replayed/,
  );

  await repo.writeFile("edit.txt", "staged edit\n");
  await repo.run(["add", "edit.txt"]);
  await repo.writeFile("edit.txt", "unstaged edit\n");

  const amend = await context.rebase.prepare(repository.id, "amend");
  const hook = join(repo.path, ".git", "hooks", "commit-msg");

  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await expect(
    context.rebase.execute(repository.id, amend.token, undefined, "Edited orphan"),
  ).rejects.toThrow();

  db.close();
  context = services();

  const retryAmend = await context.rebase.prepare(repository.id, "amend");

  expect(retryAmend.message).toBe("Edited orphan");

  await unlink(hook);
  expect(
    await context.rebase.execute(repository.id, retryAmend.token, undefined, retryAmend.message),
  ).toMatchObject({ state: "needs-attention" });
  expect(await repo.run(["show", "HEAD:edit.txt"])).toBe("staged edit\n");
  expect(await readFile(join(repo.path, "edit.txt"), "utf8")).toBe("unstaged edit\n");

  await repo.run(["restore", "--worktree", "edit.txt"]);

  const finish = await context.rebase.prepare(repository.id, "continue");

  expect(await context.rebase.execute(repository.id, finish.token)).toMatchObject({
    state: "completed",
  });
  expect((await repo.run(["rev-list", "--count", `${base}..HEAD`])).trim()).toBe("3");
  expect((await repo.run(["show", "-s", "--format=%B", "HEAD~2"])).trim()).toBe(
    "Revised target\n\nBody",
  );
  expect((await repo.run(["show", "-s", "--format=%B", "HEAD~1"])).trim()).toBe(
    "Other\n\nsquash! Other",
  );
  expect((await repo.run(["show", "-s", "--format=%s", "HEAD"])).trim()).toBe("Edited orphan");
  expect(await repo.run(["status", "--porcelain"])).toBe("");

  const finishedHead = (await repo.run(["rev-parse", "HEAD"])).trim();
  const tree = (await repo.run(["rev-parse", "HEAD^{tree}"])).trim();
  const unrelated = (await repo.run(["commit-tree", tree, "-m", "Unrelated root"])).trim();

  await expect(context.rebase.prepare(repository.id, "start", unrelated, true)).rejects.toThrow(
    /Root editing is not supported/,
  );
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(finishedHead);

  const merge = (
    await repo.run([
      "commit-tree",
      tree,
      "-p",
      finishedHead,
      "-p",
      unrelated,
      "-m",
      "Merge topology",
    ])
  ).trim();

  await repo.run(["checkout", "-b", "merge-range", merge]);
  await expect(context.rebase.prepare(repository.id, "start", base, true)).rejects.toThrow(
    /Merge-preserving rebase/,
  );
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(merge);
  expect(await repo.run(["status", "--porcelain"])).toBe("");
}, 60_000);

it("rewords the selected commit while preserving its tree, authors, staged files and other branches", async () => {
  repo = await createTempRepo();
  const context = services();
  const profile = context.identities.create({
    name: "Editor",
    gitName: "Editor",
    gitEmail: "editor@eda.invalid",
    hue: 0,
    signing: { format: "none", signCommits: false },
  });
  context.identities.setActiveId(profile.id);
  const { id } = await context.repositories.open(repo.path);
  await repo.writeFile("file.txt", "first\n");
  await repo.commit("First\n\nOriginal body");
  const root = (await repo.run(["rev-parse", "HEAD"])).trim();
  await repo.writeFile("file.txt", "second\n");
  await repo.commit("Second");
  const tip = (await repo.run(["rev-parse", "HEAD"])).trim();
  await repo.run(["branch", "original", tip]);
  await repo.run(["update-ref", "refs/remotes/origin/main", tip]);
  await repo.writeFile("file.txt", "staged\n");
  await repo.run(["add", "file.txt"]);
  await repo.writeFile("file.txt", "unstaged\n");
  const index = await repo.run(["write-tree"]);
  const treesAndAuthors = () => repo.run(["log", "--format=%T %an %ae"]);
  const before = await treesAndAuthors();
  const editTip = await context.rebase.prepare(id, "reword", tip);
  expect(editTip).toMatchObject({ message: "Second", publishedCommits: 1, rewrittenCount: 1 });
  await expect(context.rebase.prepare(id, "reword", root)).rejects.toThrow(/stash/);
  expect(() => context.rebase.execute(id, editTip.token, undefined, "   ")).toThrow();
  await context.rebase.execute(id, editTip.token, undefined, "Edited tip\n\n# Body");
  expect(await repo.run(["log", "-1", "--format=%B"])).toContain("Edited tip\n\n# Body");
  expect(await repo.run(["write-tree"])).toBe(index);
  expect(await repo.run(["diff"])).toContain("+unstaged");
  expect(await treesAndAuthors()).toBe(before);
  await repo.run(["restore", "--staged", "--worktree", "file.txt"]);
  await expect(context.rebase.prepare(id, "reword", tip)).rejects.toThrow(/checked-out branch/);

  const editRoot = await context.rebase.prepare(id, "reword", root);
  expect(editRoot).toMatchObject({
    message: "First\n\nOriginal body",
    publishedCommits: 1,
    rewrittenCount: 2,
  });
  const result = await context.rebase.execute(
    id,
    editRoot.token,
    undefined,
    "Edited root\n\nNew body",
  );
  expect(result.state).toBe("completed");
  expect(await repo.run(["log", "-1", "--format=%B", "HEAD^"])).toContain(
    "Edited root\n\nNew body",
  );
  expect(await repo.run(["log", "-1", "--format=%B"])).toContain("Edited tip\n\n# Body");
  expect(await repo.run(["rev-parse", "original"])).toContain(tip);
  expect(await treesAndAuthors()).toBe(before);

  const head = (await repo.run(["rev-parse", "HEAD"])).trim();
  const stale = await context.rebase.prepare(id, "reword", head);
  await repo.run(["commit", "--allow-empty", "-m", "New head"]);
  await expect(context.rebase.execute(id, stale.token, undefined, "Wrong commit")).rejects.toThrow(
    /changed after review/,
  );
  const unchangedParent = (await repo.run(["rev-parse", "HEAD~2"])).trim();
  const editMiddle = await context.rebase.prepare(id, "reword", head);
  expect(editMiddle.rewrittenCount).toBe(2);
  await context.rebase.execute(id, editMiddle.token, undefined, "Middle");
  expect((await repo.run(["log", "-2", "--format=%s"])).trim().split("\n")).toEqual([
    "New head",
    "Middle",
  ]);
  expect((await repo.run(["rev-parse", "HEAD~2"])).trim()).toBe(unchangedParent);

  const shallowPath = join(repo.home, "shallow");
  await repo.run(["clone", "--depth=1", pathToFileURL(repo.path).href, shallowPath]);
  const shallow = await context.repositories.open(shallowPath);
  const boundary = (await repo.run(["rev-parse", "HEAD"])).trim();
  await expect(context.rebase.prepare(shallow.id, "reword", boundary)).rejects.toThrow(
    /shallow boundary/,
  );
});
