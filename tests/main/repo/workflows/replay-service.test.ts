import { activateTestProfile, workflowFixture } from "../../../helpers/workflow-fixture";
import { afterEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { openDatabase } from "@main/persistence/database";
import type { Database } from "@main/persistence/types";
import { ReplayService } from "@main/repo/workflows/replay-service";
import { DiscardService } from "@main/repo/working-tree/discard-service";

let repo: TempRepo;
let db: Database;

afterEach(async () => {
  db?.close();
  await repo?.cleanup();
});

function services() {
  db = openDatabase(join(repo.home, "replay.db"));

  const { identities, identity, repositories, writer, workflows, journal, recovery } =
    workflowFixture(db, repo.git);

  return {
    identities,
    repositories,
    workflows,
    replay: new ReplayService(
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

async function setup() {
  repo = await createTempRepo();

  const context = services();
  const profile = activateTestProfile(context.identities);

  const repository = await context.repositories.open(repo.path);

  await repo.writeFile("file.txt", "base\n");
  await repo.commit("base");

  return { context, repository, profile, base: (await repo.run(["rev-parse", "HEAD"])).trim() };
}

const head = async () => (await repo.run(["rev-parse", "HEAD"])).trim();

it("cherry-picks in reviewed order and preserves profile, author and recovery through conflict, restart, abort and skip", async () => {
  const { context: initial, repository, profile, base } = await setup();
  let context = initial;

  await repo.run(["checkout", "-b", "source"]);
  await repo.writeFile("file.txt", "incoming\n");
  await repo.run(["add", "file.txt"]);
  await repo.run(["commit", "--author=Eda <original@eda.invalid>", "-m", "first"]);

  const first = await head();

  await repo.writeFile("second.txt", "second\n");
  await repo.commit("second");

  const second = await head();

  await repo.run(["checkout", "-b", "destination", base]);
  await repo.writeFile("file.txt", "destination\n");
  await repo.commit("destination");

  const destination = await head();
  const review = await context.replay.prepare(repository.id, "cherry-pick", "start", [
    first,
    second,
  ]);
  await repo.git.writeConfig("user.email", "outside@example.com", { scope: "global" });

  expect(await context.replay.execute(repository.id, review.token)).toMatchObject({
    state: "needs-attention",
  });

  db.close();
  context = services();
  expect(
    await context.workflows.observe(repository.path, await repo.git.status(repo.path)),
  ).toMatchObject({ kind: "cherry-pick", originalHead: destination, ownerProfileId: profile.id });
  await expect(context.replay.prepare(repository.id, "cherry-pick", "continue")).rejects.toThrow(
    /every conflict/,
  );

  const alternate = context.identities.create({
    ...profile,
    name: "Eda alternate",
    gitEmail: "alternate@eda.invalid",
  });

  context.identities.setActiveId(alternate.id);

  const alternateRepo = await context.repositories.open(repo.path);

  await expect(context.replay.prepare(alternateRepo.id, "cherry-pick", "abort")).rejects.toThrow(
    /profile that owns/,
  );

  context.identities.setActiveId(profile.id);
  await repo.writeFile("file.txt", "resolved\n");
  await repo.run(["add", "file.txt"]);

  const resume = await context.replay.prepare(repository.id, "cherry-pick", "continue");

  expect(await context.replay.execute(repository.id, resume.token)).toMatchObject({
    state: "completed",
  });
  expect((await repo.run(["rev-parse", "HEAD~2"])).trim()).toBe(destination);
  expect((await repo.run(["show", "-s", "--format=%s|%ae", "HEAD^"])).trim()).toBe(
    "first|original@eda.invalid",
  );
  expect((await repo.run(["log", "-1", "--format=%ce"])).trim()).toBe(profile.gitEmail);
  await repo.git.writeConfig("user.email", profile.gitEmail, { scope: "global" });
  expect((await repo.run(["show", "-s", "--format=%s"])).trim()).toBe("second");

  await repo.run(["checkout", "-b", "reverse-order", base]);

  const emptyTree = (await repo.run(["rev-parse", `${second}^{tree}`])).trim();
  const empty = (await repo.run(["commit-tree", emptyTree, "-p", second, "-m", "empty"])).trim();
  const reverse = await context.replay.prepare(repository.id, "cherry-pick", "start", [
    second,
    empty,
    first,
  ]);

  await context.replay.execute(repository.id, reverse.token);
  expect((await repo.run(["log", "-3", "--format=%s"])).trim()).toBe("first\nempty\nsecond");

  await repo.run(["checkout", "-b", "abort-replay", destination]);

  const abortStart = await context.replay.prepare(repository.id, "cherry-pick", "start", [first]);

  await context.replay.execute(repository.id, abortStart.token);
  await repo.writeFile("file.txt", "saved resolution\n");

  const stale = await context.replay.prepare(repository.id, "cherry-pick", "abort");

  await repo.writeFile("file.txt", "newer resolution\n");
  await expect(context.replay.execute(repository.id, stale.token)).rejects.toThrow(
    /changed after review/,
  );

  const abort = await context.replay.prepare(repository.id, "cherry-pick", "abort");

  await context.replay.execute(repository.id, abort.token);
  expect(await head()).toBe(destination);

  const saved = context.recovery.list(profile.id, repository.id)[0]!;

  expect(
    context.recovery.savedFile(profile.id, repository.id, saved.id, "file.txt").toString(),
  ).toBe("newer resolution\n");

  const skipStart = await context.replay.prepare(repository.id, "cherry-pick", "start", [
    first,
    second,
  ]);

  await context.replay.execute(repository.id, skipStart.token);

  const skip = await context.replay.prepare(repository.id, "cherry-pick", "skip");

  await context.replay.execute(repository.id, skip.token);
  expect((await repo.run(["rev-parse", "HEAD^"])).trim()).toBe(destination);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("destination\n");
  expect(await repo.run(["status", "--porcelain"])).toBe("");
}, 60_000);

it("reverts ordered selections and explicit merge mainlines, then resumes an external single-commit conflict after restart", async () => {
  const { context: initial, repository, base } = await setup();
  let context = initial;

  await repo.writeFile("file.txt", "first\n");
  await repo.commit("first");

  const first = await head();

  await repo.writeFile("second.txt", "second\n");
  await repo.commit("second");

  const second = await head();
  const review = await context.replay.prepare(repository.id, "revert", "start", [second, first]);
  await repo.git.writeConfig("author.email", "outside@example.com", { scope: "global" });

  expect(await context.replay.execute(repository.id, review.token)).toMatchObject({
    state: "completed",
  });
  expect((await repo.run(["rev-parse", "HEAD^{tree}"])).trim()).toBe(
    (await repo.run(["rev-parse", `${base}^{tree}`])).trim(),
  );
  expect((await repo.run(["log", "-2", "--format=%s"])).trim()).toBe(
    'Revert "first"\nRevert "second"',
  );
  expect((await repo.run(["log", "-1", "--format=%ae:%ce"])).trim()).toBe(
    "test@eda.invalid:test@eda.invalid",
  );
  await repo.git.unsetConfig("author.email", { scope: "global" });

  await repo.run(["checkout", "-b", "merge-side", base]);
  await repo.writeFile("side.txt", "side\n");
  await repo.commit("side");

  const side = await head();

  await repo.run(["checkout", "-b", "merge-main", base]);
  await repo.writeFile("main.txt", "main\n");
  await repo.commit("main change");
  await repo.run(["merge", "--no-ff", "merge-side", "-m", "merge"]);

  const merge = await head();
  const missing = await context.replay.prepare(repository.id, "revert", "start", [merge]);

  await expect(async () => context.replay.execute(repository.id, missing.token)).rejects.toThrow(
    /mainline parent/,
  );
  expect(await head()).toBe(merge);
  await expect(
    context.replay.prepare(repository.id, "revert", "start", [merge, first], 2),
  ).rejects.toThrow(/every selected commit/);
  expect(await head()).toBe(merge);

  const mainline = await context.replay.prepare(repository.id, "revert", "start", [merge], 2);

  await context.replay.execute(repository.id, mainline.token);
  expect((await repo.run(["rev-parse", "HEAD^{tree}"])).trim()).toBe(
    (await repo.run(["rev-parse", `${side}^{tree}`])).trim(),
  );

  await repo.run(["checkout", "-b", "external-revert", first]);
  await repo.writeFile("file.txt", "later\n");
  await repo.commit("later");

  const before = await head();

  await repo.git.exec(["revert", "--no-edit", first], {
    cwd: repo.path,
    operation: "fixture revert",
    allowedExitCodes: [1],
  });
  db.close();
  context = services();
  expect(
    await context.workflows.observe(repository.path, await repo.git.status(repo.path)),
  ).toMatchObject({ kind: "revert", originalHead: before });

  await repo.writeFile("file.txt", "base\n");
  await repo.run(["add", "file.txt"]);

  const resume = await context.replay.prepare(repository.id, "revert", "continue");

  expect(await context.replay.execute(repository.id, resume.token)).toMatchObject({
    state: "completed",
  });
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("base\n");
  expect(await repo.run(["status", "--porcelain"])).toBe("");
}, 60_000);
