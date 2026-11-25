import { activateTestProfile, workflowFixture } from "../../../helpers/workflow-fixture";
import { afterEach, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { openDatabase } from "@main/persistence/database";
import type { Database } from "@main/persistence/types";
import { RebaseService } from "@main/repo/workflows/rebase-service";
import { ReplayService } from "@main/repo/workflows/replay-service";
import { HistoryReversalService } from "@main/repo/history/history-reversal-service";

let repo: TempRepo;
let db: Database;

afterEach(async () => {
  db?.close();
  await repo?.cleanup();
});

async function setup() {
  repo = await createTempRepo();
  db = openDatabase(join(repo.home, "rewrites.db"));

  const { identities, identity, repositories, writer, workflows, journal, recovery } =
    workflowFixture(db, repo.git, { recordWriterHistory: true });

  activateTestProfile(identities);

  const repository = await repositories.open(repo.path);

  return {
    repository,
    rebase: new RebaseService(
      repo.git,
      repositories,
      writer,
      identity,
      workflows,
      journal,
      recovery,
    ),
    replay: new ReplayService(
      repo.git,
      repositories,
      writer,
      identity,
      workflows,
      journal,
      recovery,
    ),
    reversal: new HistoryReversalService(
      repo.git,
      repositories,
      writer,
      workflows,
      journal,
      recovery,
    ),
  };
}

it("reverses a completed rebase including introduced and removed paths", async () => {
  const context = await setup();

  await repo.writeFile("base.txt", "base\n");
  await repo.commit("base");
  await repo.run(["checkout", "-b", "topic"]);
  await repo.writeFile("topic.txt", "topic\n");
  await repo.commit("topic");

  const topic = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["checkout", "main"]);
  await repo.writeFile("main.txt", "upstream\n");
  await repo.commit("upstream");

  const onto = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["checkout", "topic"]);

  const review = await context.rebase.prepare(context.repository.id, "start", onto);
  const result = await context.rebase.execute(context.repository.id, review.token);

  expect(result).toMatchObject({ state: "completed" });

  const rewritten = result.head!;

  expect(rewritten).not.toBe(topic);
  expect(await repo.run(["status", "--porcelain"])).toBe("");
  expect(await readFile(join(repo.path, "main.txt"), "utf8")).toBe("upstream\n");

  const action = (await context.reversal.list(context.repository.id)).find(
    (item) => item.kind === "rebase",
  )!;

  expect(action).toMatchObject({
    kind: "rebase",
    direction: "undo",
    available: true,
    label: expect.stringContaining(`Undo Rebase onto ${onto.slice(0, 12)}`),
  });

  await context.reversal.execute(context.repository.id, action.id, "undo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(topic);
  expect(await repo.run(["status", "--porcelain"])).toBe("");
  await expect(readFile(join(repo.path, "main.txt"), "utf8")).rejects.toThrow();
  expect(await readFile(join(repo.path, "topic.txt"), "utf8")).toBe("topic\n");

  await context.reversal.execute(context.repository.id, action.id, "redo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(rewritten);
  expect(await repo.run(["status", "--porcelain"])).toBe("");
  expect(await readFile(join(repo.path, "main.txt"), "utf8")).toBe("upstream\n");
  expect(await readFile(join(repo.path, "topic.txt"), "utf8")).toBe("topic\n");
}, 60_000);

it("reverses completed cherry-pick and revert commits", async () => {
  const context = await setup();

  await repo.writeFile("base.txt", "base\n");
  await repo.commit("base");
  await repo.run(["checkout", "-b", "side"]);
  await repo.writeFile("side.txt", "side\n");
  await repo.commit("side");

  const side = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["checkout", "main"]);

  const main = (await repo.run(["rev-parse", "HEAD"])).trim();

  const pickReview = await context.replay.prepare(context.repository.id, "cherry-pick", "start", [
    side,
  ]);
  const pick = await context.replay.execute(context.repository.id, pickReview.token);

  expect(pick.state).toBe("completed");
  expect(await readFile(join(repo.path, "side.txt"), "utf8")).toBe("side\n");

  const pickAction = (await context.reversal.list(context.repository.id)).find(
    (item) => item.kind === "cherry-pick",
  )!;

  expect(pickAction).toMatchObject({ direction: "undo", available: true });

  await context.reversal.execute(context.repository.id, pickAction.id, "undo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(main);
  await expect(readFile(join(repo.path, "side.txt"), "utf8")).rejects.toThrow();

  await context.reversal.execute(context.repository.id, pickAction.id, "redo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(pick.head);
  expect(await readFile(join(repo.path, "side.txt"), "utf8")).toBe("side\n");

  const revertReview = await context.replay.prepare(context.repository.id, "revert", "start", [
    pick.head!,
  ]);
  const revert = await context.replay.execute(context.repository.id, revertReview.token);

  expect(revert.state).toBe("completed");
  await expect(readFile(join(repo.path, "side.txt"), "utf8")).rejects.toThrow();

  const revertAction = (await context.reversal.list(context.repository.id)).find(
    (item) => item.kind === "revert",
  )!;

  expect(revertAction).toMatchObject({ direction: "undo", available: true });

  await context.reversal.execute(context.repository.id, revertAction.id, "undo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(pick.head);
  expect(await readFile(join(repo.path, "side.txt"), "utf8")).toBe("side\n");

  await context.reversal.execute(context.repository.id, revertAction.id, "redo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(revert.head);
  await expect(readFile(join(repo.path, "side.txt"), "utf8")).rejects.toThrow();
  expect(await repo.run(["status", "--porcelain"])).toBe("");

  const retryReview = await context.replay.prepare(context.repository.id, "cherry-pick", "start", [
    side,
  ]);
  const exec = repo.git.exec.bind(repo.git);
  const failure = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    if (options.operation === "preserve rewrite recovery refs")
      throw new Error("recovery ref unavailable");
    return exec(args, options);
  });

  try {
    const completed = await context.replay.execute(context.repository.id, retryReview.token);

    expect(completed).toMatchObject({
      state: "completed",
      recoveryWarning: expect.stringContaining("automatic Undo could not be prepared"),
    });
    expect((await repo.run(["rev-parse", "HEAD^"])).trim()).toBe(revert.head);
    expect(await readFile(join(repo.path, "side.txt"), "utf8")).toBe("side\n");
    expect(
      (await context.reversal.list(context.repository.id)).find(
        (item) => item.fromHead === completed.head,
      ),
    ).toMatchObject({ available: false, reason: completed.recoveryWarning });
  } finally {
    failure.mockRestore();
  }
}, 60_000);

it.runIf(process.platform === "linux")(
  "keeps the recovery refs but blocks automatic Undo for ambiguous rewritten paths",
  async () => {
    const { replay, repository, reversal } = await setup();
    await repo.writeFile("base", "base");
    await repo.commit("base");
    const base = (await repo.run(["rev-parse", "HEAD"])).trim();
    await repo.run(["checkout", "-b", "side"]);
    const rawPath = Buffer.concat([Buffer.from(join(repo.path, "bad")), Buffer.from([0xff])]);
    await writeFile(rawPath, "raw");
    await repo.writeFile("bad�", "unicode");
    await repo.commit("unusual paths");
    const side = (await repo.run(["rev-parse", "HEAD"])).trim();
    await repo.run(["checkout", "main"]);
    const review = await replay.prepare(repository.id, "cherry-pick", "start", [side]);
    const result = await replay.execute(repository.id, review.token);
    expect(result.state).toBe("completed");
    const action = (await reversal.list(repository.id)).find(
      (item) => item.kind === "cherry-pick",
    )!;
    expect(action).toMatchObject({
      available: false,
      reason: expect.stringContaining("invalid UTF-8"),
    });
    expect((await repo.run(["rev-parse", `refs/eda/recovery/${action.id}/head`])).trim()).toBe(
      base,
    );
    expect(await readFile(rawPath, "utf8")).toBe("raw");
    expect(await readFile(join(repo.path, "bad�"), "utf8")).toBe("unicode");
  },
);
