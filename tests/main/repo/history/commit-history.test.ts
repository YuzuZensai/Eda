import { activateTestProfile, workflowFixture } from "../../../helpers/workflow-fixture";
import { afterEach, expect, it, vi } from "vitest";
import { chmod, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { openDatabase } from "@main/persistence/database";
import type { Database } from "@main/persistence/types";
import { HistoryReversalService } from "@main/repo/history/history-reversal-service";
import { HistoryRecoveryService } from "@main/repo/history/history-recovery-service";

let repo: TempRepo;
let db: Database;

afterEach(async () => {
  vi.restoreAllMocks();
  db?.close();
  await repo?.cleanup();
});

function services() {
  db = openDatabase(join(repo.home, "history.db"));

  const { identities, repositories, writer, workflows, journal, content, recovery } =
    workflowFixture(db, repo.git, { recordWriterHistory: true });

  return {
    identities,
    repositories,
    writer,
    journal,
    historyRecovery: new HistoryRecoveryService(repo.git, repositories, writer, journal),
    reversal: new HistoryReversalService(
      repo.git,
      repositories,
      writer,
      workflows,
      journal,
      content,
      recovery,
    ),
  };
}

it("reverses first commits, ordinary commits and amendments across restart while preserving staged/working bytes and refusing external or hook changes", async () => {
  repo = await createTempRepo();

  let context = services();
  const profile = activateTestProfile(context.identities);

  const repository = await context.repositories.open(repo.path);

  await repo.writeFile("file.txt", "first staged\n");
  await context.writer.stage(repository.id, ["file.txt"]);
  await repo.writeFile("file.txt", "first working\n");

  const first = await context.writer.commit(repository.id, "First commit");
  const firstAction = (await context.reversal.list(repository.id)).find((item) => item.available)!;

  expect(
    context.journal.historyActions(repository.path).find((record) => record.id === firstAction.id)
      ?.refChange,
  ).toMatchObject({
    beforeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    beforeFlags: expect.any(String),
    beforeWorking: expect.any(String),
  });
  expect(firstAction.kind).toBe("commit");
  expect(firstAction.publishedCommits).toBe(0);

  await repo.run(["update-ref", "refs/remotes/origin/published-first", first.oid]);
  await expect(context.reversal.execute(repository.id, firstAction.id, "undo", 0)).rejects.toThrow(
    /Remote-tracking history changed/,
  );
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === firstAction.id)
      ?.publishedCommits,
  ).toBe(1);

  await context.reversal.execute(repository.id, firstAction.id, "undo", 1);
  expect((await repo.git.status(repo.path)).branch.unborn).toBe(true);
  expect(await repo.run(["show", ":file.txt"])).toBe("first staged\n");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("first working\n");

  db.close();
  context = services();
  expect((await context.historyRecovery.list(repository.id, "rewrites")).entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        oid: first.oid,
        description: expect.stringContaining("Latest published reversal: undo"),
      }),
    ]),
  );

  await context.reversal.execute(repository.id, firstAction.id, "redo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(first.oid);

  await repo.writeFile("file.txt", "second staged\n");
  await context.writer.stage(repository.id, ["file.txt"]);
  await repo.writeFile("file.txt", "second working\n");

  const second = await context.writer.commit(repository.id, "Second commit");
  const secondAction = (await context.reversal.list(repository.id)).find((item) => item.available)!;

  await context.reversal.execute(repository.id, secondAction.id, "undo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(first.oid);
  expect(await repo.run(["show", ":file.txt"])).toBe("second staged\n");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("second working\n");

  await context.reversal.execute(repository.id, secondAction.id, "redo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(second.oid);

  await repo.writeFile("file.txt", "amended staged\n");
  await repo.run(["update-ref", "refs/remotes/origin/published", second.oid]);
  await context.writer.stage(repository.id, ["file.txt"]);
  await repo.writeFile("file.txt", "amended working\n");

  const amended = await context.writer.commit(repository.id, "Amended commit", { amend: true });

  expect(amended.publishedCommits).toBe(1);

  const amendAction = (await context.reversal.list(repository.id)).find((item) => item.available)!;

  expect(amendAction.kind).toBe("amend");

  await context.reversal.execute(repository.id, amendAction.id, "undo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(second.oid);
  expect(await repo.run(["show", ":file.txt"])).toBe("amended staged\n");

  db.close();
  context = services();
  await context.reversal.execute(repository.id, amendAction.id, "redo");
  expect((await context.historyRecovery.list(repository.id, "rewrites")).entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ oid: second.oid, label: "Amend commit: Amended commit" }),
    ]),
  );
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(amended.oid);

  const other = context.identities.create({
    name: "Eda alternate",
    gitName: "Eda",
    gitEmail: "alternate@eda.invalid",
    hue: 1,
    signing: { format: "none", signCommits: false },
  });

  context.identities.setActiveId(other.id);

  const otherMembership = await context.repositories.open(repo.path);

  expect((await context.historyRecovery.list(otherMembership.id, "rewrites")).entries).toEqual([]);

  context.identities.setActiveId(profile.id);
  await repo.writeFile("file.txt", "external edit\n");
  await expect(context.reversal.execute(repository.id, amendAction.id, "undo")).rejects.toThrow(
    /changed since/,
  );
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("external edit\n");

  const refsBefore = await repo.run([
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/eda/recovery",
  ]);

  await repo.writeFile(".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n");
  await chmod(join(repo.path, ".git/hooks/pre-commit"), 0o755);
  await expect(
    context.writer.commit(repository.id, "Refused amendment", { amend: true }),
  ).rejects.toThrow();
  expect(
    await repo.run(["for-each-ref", "--format=%(refname) %(objectname)", "refs/eda/recovery"]),
  ).toBe(refsBefore);

  await unlink(join(repo.path, ".git/hooks/pre-commit"));
  await repo.writeFile(
    ".git/hooks/post-commit",
    "#!/bin/sh\nprintf 'hook changed working file\\n' > file.txt\n",
  );
  await chmod(join(repo.path, ".git/hooks/post-commit"), 0o755);

  const hooked = await context.writer.commit(repository.id, "Hook changed work", { amend: true });
  const blocked = (await context.reversal.list(repository.id)).find(
    (item) => item.fromHead === hooked.oid,
  )!;

  expect(blocked).toMatchObject({
    available: false,
    reason: expect.stringMatching(/Hooks or another process/),
  });
  await expect(context.reversal.execute(repository.id, blocked.id, "undo")).rejects.toThrow(
    /Hooks or another process/,
  );
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(hooked.oid);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("hook changed working file\n");

  await unlink(join(repo.path, ".git/hooks/post-commit"));

  const exec = repo.git.exec.bind(repo.git);

  vi.spyOn(repo.git, "exec").mockImplementation((args, options) => {
    if (options.operation === "preserve commit redo refs")
      throw new Error("Recovery storage unavailable");
    return exec(args, options);
  });
  await expect(
    context.writer.commit(repository.id, "Created despite recovery failure", { amend: true }),
  ).rejects.toThrow(/was created, but recording its recovery state failed/);

  vi.restoreAllMocks();

  const created = (await repo.run(["rev-parse", "HEAD"])).trim();

  expect(created).not.toBe(hooked.oid);
  expect((await repo.run(["show", "-s", "--format=%s", "HEAD"])).trim()).toBe(
    "Created despite recovery failure",
  );

  db.close();
  context = services();
  expect(
    context.journal
      .historyActions(repository.path)
      .find((record) => record.refChange?.afterHead === created),
  ).toMatchObject({ state: "paused" });
}, 90_000);
