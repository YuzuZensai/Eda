import { activateTestProfile, workflowFixture } from "../../../helpers/workflow-fixture";
import { afterEach, expect, it, vi } from "vitest";
import { chmod, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { openDatabase } from "@main/persistence/database";
import { SettingsRepository } from "@main/persistence/settings-repository";
import { ContentRecoveryRepository } from "@main/persistence/content-recovery-repository";
import type { Database } from "@main/persistence/types";
import { DiscardService } from "@main/repo/working-tree/discard-service";
import { ConflictService } from "@main/repo/workflows/conflict-service";

vi.setConfig({ testTimeout: 60_000 });

let repo: TempRepo;
let db: Database | undefined;

afterEach(async () => {
  db?.close();
  await repo?.cleanup();
});

it("aborts only a current review and retains working and staged resolution copies across restart", async () => {
  repo = await createTempRepo();

  let context = services();
  const profile = activateTestProfile(context.identities);

  const repository = await context.repositories.open(repo.path);

  await repo.writeFile("file.txt", "base\n");
  await repo.commit("base");
  await repo.run(["checkout", "-b", "incoming"]);
  await repo.writeFile("file.txt", "incoming\n");
  await repo.commit("incoming");
  await repo.run(["checkout", "main"]);
  await repo.writeFile("file.txt", "current\n");
  await repo.commit("current");

  const original = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.git.exec(["merge", "incoming", "--no-edit"], {
    cwd: repo.path,
    operation: "fixture merge",
    allowedExitCodes: [0, 1],
  });

  const stale = await context.workflow.prepareAbort(repository.id);

  await repo.writeFile("file.txt", "new resolution\n");
  await expect(context.workflow.abortMerge(repository.id, stale.token)).rejects.toThrow(
    /file changed/,
  );
  expect((await repo.run(["rev-parse", "MERGE_HEAD"])).trim()).not.toBe("");

  await repo.writeFile("file.txt", "staged resolution\n");
  await repo.run(["add", "file.txt"]);
  await repo.writeFile("file.txt", "working resolution\n");
  await repo.writeFile("unrelated.txt", "keep untracked\n");

  const preview = await context.workflow.prepareAbort(repository.id);

  expect(preview.paths).toEqual(["file.txt"]);
  await expect(context.workflow.abortMerge(repository.id, preview.token)).rejects.toThrow(
    /Recovery copies were saved/,
  );
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("working resolution\n");

  const retained = new DiscardService(repo.git, new ContentRecoveryRepository(db!)).list(
    profile.id,
    repository.id,
  )[0]!;

  await repo.run(["add", "file.txt"]);

  const reviewedAgain = await context.workflow.prepareAbort(repository.id);

  await context.workflow.abortMerge(repository.id, reviewedAgain.token);
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(original);
  expect(await repo.run(["ls-files", "--unmerged"])).toBe("");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("current\n");
  expect(await readFile(join(repo.path, "unrelated.txt"), "utf8")).toBe("keep untracked\n");

  db!.close();
  db = undefined;
  context = services();

  const recovery = new DiscardService(repo.git, new ContentRecoveryRepository(db!));
  const [snapshot] = recovery.list(profile.id, repository.id);

  expect(snapshot).toMatchObject({
    source: "merge-abort",
    state: "completed",
    paths: ["file.txt"],
  });
  expect(recovery.savedFile(profile.id, repository.id, retained.id, "file.txt", 0).toString()).toBe(
    "staged resolution\n",
  );

  await repo.writeFile("file.txt", "newer work\n");
  await expect(
    recovery.restore(repository.path, profile.id, repository.id, snapshot!.id),
  ).rejects.toThrow(/newer work/);

  await repo.writeFile("file.txt", "current\n");
  await recovery.restore(repository.path, profile.id, repository.id, snapshot!.id);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("working resolution\n");
  expect(await repo.run(["show", ":file.txt"])).toBe("current\n");
  await expect(context.workflow.prepareAbort(repository.id)).rejects.toThrow(/No native merge/);
});

function services() {
  db = openDatabase(join(repo.home, "workflow.db"));

  const settings = new SettingsRepository(db);
  const { identities, repositories, writer, workflows } = workflowFixture(db, repo.git, {
    settings,
  });

  return {
    identities,
    settings,
    repositories,
    writer,
    workflow: workflows,
  };
}

it("continues a reviewed merge after hook failure and database reopen while rejecting unresolved or changed index state", async () => {
  repo = await createTempRepo();

  let context = services();
  activateTestProfile(context.identities);

  const repository = await context.repositories.open(repo.path);

  await repo.writeFile("file.txt", "base\n");
  await repo.commit("base");
  await repo.run(["checkout", "-b", "incoming"]);
  await repo.writeFile("file.txt", "incoming\n");
  await repo.commit("incoming");

  const incoming = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["checkout", "main"]);
  await repo.writeFile("file.txt", "current\n");
  await repo.commit("current");

  const original = (await repo.run(["rev-parse", "HEAD"])).trim();

  await expect(context.workflow.prepareStart(repository.id, incoming, "ff-only")).rejects.toThrow(
    /diverged/,
  );

  const indexBefore = await readFile(join(repo.path, ".git", "index"));
  await repo.run(["branch", "--set-upstream-to=incoming", "main"]);
  expect(await context.workflow.predictUpstream(repository.id)).toEqual({
    state: "conflicted",
    paths: ["file.txt"],
    totalPaths: 1,
  });
  const start = await context.workflow.prepareStart(repository.id, incoming, "no-ff");

  expect(start.prediction).toEqual({ state: "conflicted", paths: ["file.txt"], totalPaths: 1 });
  expect(await readFile(join(repo.path, ".git", "index"))).toEqual(indexBefore);
  expect(await repo.run(["status", "--porcelain"])).toBe("");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(original);
  expect(await repo.run(["show", ":file.txt"])).toBe("current\n");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("current\n");
  expect(await context.workflow.startMerge(repository.id, start.token)).toMatchObject({
    state: "conflicted",
    head: original,
  });
  await expect(context.workflow.prepareMerge(repository.id)).rejects.toThrow(
    /every conflicted path/,
  );

  await repo.writeFile("file.txt", "resolution\n");
  await repo.run(["add", "file.txt"]);

  const reviewed = await context.workflow.prepareMerge(repository.id);

  await repo.writeFile("another.txt", "new staged content\n");
  await repo.run(["add", "another.txt"]);
  await expect(context.workflow.continueMerge(repository.id, reviewed.id, "stale")).rejects.toThrow(
    /staged content changed/,
  );
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(original);

  const fresh = await context.workflow.prepareMerge(repository.id);

  await repo.writeFile(
    ".git/hooks/pre-commit",
    "#!/bin/sh\necho 'fixture hook refused merge' >&2\nexit 1\n",
  );
  await chmod(join(repo.path, ".git/hooks/pre-commit"), 0o755);
  await expect(
    context.workflow.continueMerge(repository.id, fresh.id, "Retain this merge message"),
  ).rejects.toThrow();
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(original);

  db!.close();
  db = undefined;
  context = services();

  const resumed = await context.workflow.prepareMerge(repository.id);

  expect(resumed).toMatchObject({
    id: fresh.id,
    state: "paused",
    message: "Retain this merge message",
  });

  await unlink(join(repo.path, ".git/hooks/pre-commit"));
  await repo.writeFile("file.txt", "unstaged work retained\n");

  const oid = await context.workflow.continueMerge(repository.id, resumed.id, resumed.message);

  expect((await repo.run(["rev-list", "--parents", "-n", "1", oid])).trim()).toBe(
    `${oid} ${original} ${incoming}`,
  );
  expect(await repo.run(["show", "HEAD:file.txt"])).toBe("resolution\n");
  expect(await repo.run(["show", "HEAD:another.txt"])).toBe("new staged content\n");
  expect(await repo.run(["log", "-1", "--format=%B"])).toContain("Retain this merge message");
  expect((await repo.git.status(repo.path)).changes.map((change) => change.path)).toEqual([
    "file.txt",
  ]);
  await expect(context.workflow.prepareMerge(repository.id)).rejects.toThrow(/no native merge/);
});

it("restores conflicted squash ownership after restart, commits one parent, and aborts a later squash with recovery", async () => {
  repo = await createTempRepo();

  let context = services();
  const profile = activateTestProfile(context.identities);

  const repository = await context.repositories.open(repo.path);

  await repo.writeFile("file.txt", "base\n");
  await repo.commit("base");
  await repo.run(["checkout", "-b", "topic"]);
  await repo.writeFile("file.txt", "source\n");
  await repo.commit("source");

  const source = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["checkout", "main"]);
  await repo.writeFile("file.txt", "target\n");
  await repo.commit("target");

  const target = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["config", "merge.ff", "only"]);

  const start = await context.workflow.prepareStart(repository.id, source, "squash");

  expect(await context.workflow.startMerge(repository.id, start.token)).toEqual({
    state: "conflicted",
    head: target,
  });
  await expect(repo.run(["rev-parse", "--verify", "MERGE_HEAD"])).rejects.toThrow();

  db!.close();
  db = undefined;
  context = services();
  expect(
    await context.workflow.observe(repository.path, await repo.git.status(repo.path)),
  ).toMatchObject({
    kind: "squash",
    ownerProfileId: profile.id,
    originalHead: target,
    conflicts: ["file.txt"],
  });

  const other = context.identities.create({
    name: "Other context",
    gitName: "Eda",
    gitEmail: "test@eda.invalid",
    hue: 20,
    signing: { format: "none", signCommits: false },
  });

  context.identities.setActiveId(other.id);

  const membership = await context.repositories.open(repo.path);

  await expect(context.workflow.prepareAbort(membership.id)).rejects.toThrow(/originating profile/);
  await expect(context.workflow.prepareStart(membership.id, source, "ff")).rejects.toThrow(
    /current Git operation/,
  );

  context.identities.setActiveId(profile.id);

  const conflicts = new ConflictService(
    repo.git,
    context.repositories,
    context.writer,
    context.workflow,
  );

  const conflict = await conflicts.inspect(repository.id, "file.txt");

  await conflicts.resolve({
    repositoryId: repository.id,
    token: conflict.token,
    choice: "incoming",
    stage: true,
  });

  const reviewed = await context.workflow.prepareMerge(repository.id);

  expect(reviewed.squash).toBe(true);

  const completed = await context.workflow.continueMerge(
    repository.id,
    reviewed.id,
    "Squashed source",
  );

  expect((await repo.run(["rev-list", "--parents", "-n", "1", completed])).trim()).toBe(
    `${completed} ${target}`,
  );
  expect(
    await context.workflow.observe(repository.path, await repo.git.status(repo.path)),
  ).toBeNull();

  await repo.run(["checkout", "-b", "abort-squash", target]);

  const again = await context.workflow.prepareStart(repository.id, source, "squash");

  await context.workflow.startMerge(repository.id, again.token);
  await repo.writeFile("file.txt", "saved squash resolution\n");
  db!.close();
  db = undefined;
  context = services();

  const abort = await context.workflow.prepareAbort(repository.id);

  await context.workflow.abortMerge(repository.id, abort.token);
  expect(await repo.run(["status", "--porcelain"])).toBe("");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(target);
  expect(
    await context.workflow.observe(repository.path, await repo.git.status(repo.path)),
  ).toBeNull();

  const recovery = new DiscardService(repo.git, new ContentRecoveryRepository(db!));
  const [saved] = recovery.list(profile.id, repository.id);

  expect(recovery.savedFile(profile.id, repository.id, saved!.id, "file.txt").toString()).toBe(
    "saved squash resolution\n",
  );
});

it("fast-forwards only the reviewed clean branch and preserves an explicit merge commit when requested", async () => {
  repo = await createTempRepo();

  const context = services();
  const profile = activateTestProfile(context.identities);

  const repository = await context.repositories.open(repo.path);

  await repo.writeFile("file.txt", "base\n");
  await repo.commit("base");

  const base = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["checkout", "-b", "topic"]);
  await repo.writeFile("file.txt", "topic\n");
  await repo.commit("topic");

  const source = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["checkout", "main"]);

  const preview = await context.workflow.prepareStart(repository.id, source, "ff-only");

  expect(preview.prediction).toEqual({ state: "clean", paths: [], totalPaths: 0 });
  expect(preview).toMatchObject({ head: base, fastForward: true, upToDate: false, branch: "main" });

  await repo.writeFile("untracked.txt", "keep\n");
  await expect(context.workflow.startMerge(repository.id, preview.token)).rejects.toThrow(
    /local changes/,
  );
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);

  await unlink(join(repo.path, "untracked.txt"));
  await repo.run(["checkout", "-b", "other"]);
  await expect(context.workflow.startMerge(repository.id, preview.token)).rejects.toThrow(
    /target branch changed/,
  );

  await repo.run(["checkout", "main"]);
  expect(await context.workflow.startMerge(repository.id, preview.token)).toEqual({
    state: "completed",
    head: source,
  });

  const contained = await context.workflow.prepareStart(repository.id, base, "ff");

  expect(contained.upToDate).toBe(true);

  await repo.run(["checkout", "-b", "merge-target", base]);

  context.settings.set(
    "repositoryCommitIdentity",
    { kind: "repository", profileId: profile.id, repositoryId: repository.id },
    { name: "Merge Author", email: "merge@example.com" },
  );
  const noff = await context.workflow.prepareStart(repository.id, source, "no-ff");
  await repo.git.writeConfig("user.email", "outside@example.com", { scope: "global" });

  expect(await context.workflow.startMerge(repository.id, noff.token)).toEqual({
    state: "ready-to-commit",
    head: base,
  });

  const ready = await context.workflow.prepareMerge(repository.id);
  const merged = await context.workflow.continueMerge(repository.id, ready.id, "Explicit merge");
  expect((await repo.run(["log", "-1", "--format=%an:%ae:%cn:%ce"])).trim()).toBe(
    "Merge Author:merge@example.com:Merge Author:merge@example.com",
  );
  expect(await repo.git.readConfig("user.email", { scope: "global" })).toBe("outside@example.com");

  expect((await repo.run(["rev-list", "--parents", "-n", "1", merged])).trim()).toBe(
    `${merged} ${base} ${source}`,
  );

  const tree = (await repo.run(["rev-parse", "HEAD^{tree}"])).trim();
  const unrelated = (await repo.run(["commit-tree", tree, "-m", "Unrelated root"])).trim();
  const unknown = await context.workflow.prepareStart(repository.id, unrelated, "ff");

  expect(unknown.prediction.state).toBe("unavailable");
  expect(unknown.prediction.reason).toBeTruthy();
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(merged);
  expect(await repo.run(["status", "--porcelain"])).toBe("");
});
