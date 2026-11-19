import { RepositoryMemberships } from "@main/persistence/repository-memberships";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { openDatabase } from "@main/persistence/database";
import type { Database } from "@main/persistence/types";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { IdentityManager } from "@main/identity/identity-manager";
import { ContentRecoveryRepository } from "@main/persistence/content-recovery-repository";
import { WorkflowJournal } from "@main/persistence/workflow-journal";
import { RepositoryManager } from "@main/repo/lifecycle/repository-manager";
import { RepositoryWriter } from "@main/repo/working-tree/repository-writer";
import { WorkflowService } from "@main/repo/workflows/workflow-service";
import { ResetService } from "@main/repo/workflows/reset-service";
import { DiscardService } from "@main/repo/working-tree/discard-service";
import { HistoryRecoveryService } from "@main/repo/history/history-recovery-service";
import { HistoryReversalService } from "@main/repo/history/history-reversal-service";

let repo: TempRepo;
let db: Database;

afterEach(async () => {
  db?.close();
  await repo?.cleanup();
});

function services() {
  db = openDatabase(join(repo.home, "reset.db"));

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
    repositories,
    journal,
    reset: new ResetService(repo.git, repositories, writer, workflows, journal, recovery),
    recovery: new DiscardService(repo.git, recovery),
    historyRecovery: new HistoryRecoveryService(repo.git, repositories, writer, journal),
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

it.each(["original", "applied", "undoing"] as const)(
  "propagates unexpected reset inspection failures in %s state without changing recovery",
  async (state) => {
    repo = await createTempRepo();
    const context = services();
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
    const base = (await repo.run(["rev-parse", "HEAD"])).trim();
    await repo.writeFile("file.txt", "current\n");
    await repo.commit("current");

    const review = await context.reset.prepare(repository.id, base, "mixed");
    await context.reset.execute(repository.id, review.token);
    const record = context.journal.historyActions(repository.path)[0]!;
    if (state === "original") {
      record.state = "prepared";
      delete record.refChange!.reversal;
      delete record.refChange!.afterHead;
      delete record.refChange!.afterFingerprint;
    } else {
      record.refChange!.reversal!.state = state;
    }
    context.journal.save(record);

    const failure = new Error("fixture cannot read repository status");
    const status = vi.spyOn(repo.git, "status").mockRejectedValue(failure);
    try {
      await expect(context.reversal.list(repository.id)).rejects.toBe(failure);
      if (state === "undoing")
        await expect(context.reversal.reconcile(repository.id, record.id, "applied")).rejects.toBe(
          failure,
        );
    } finally {
      status.mockRestore();
    }

    expect(context.journal.historyActions(repository.path)).toEqual([record]);
    expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);
    expect(await repo.run(["show", ":file.txt"])).toBe("base\n");
    expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("current\n");
    expect(await context.reversal.list(repository.id)).toEqual([
      expect.objectContaining({ id: record.id, available: state === "applied" }),
    ]);
  },
);

it("reviews all reset modes and preserves index/content recovery across restart while refusing stale or colliding hard resets", async () => {
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
  await repo.writeFile("occupied.txt", "tracked base\n");
  await repo.commit("base");

  const base = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["commit", "--allow-empty", "-m", "Published prefix"]);

  const published = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.writeFile("file.txt", "current\n");
  await repo.run(["rm", "occupied.txt"]);
  await repo.writeFile(".gitignore", "occupied.txt\n");
  await repo.commit("current");

  const current = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.writeFile("file.txt", "staged\n");
  await repo.run(["add", "file.txt"]);
  await repo.writeFile("file.txt", "working\n");
  await repo.writeFile("untracked.txt", "keep\n");

  const unpublished = await context.reset.prepare(repository.id, base, "soft");

  expect(unpublished.publishedCommits).toBe(0);

  await repo.run(["update-ref", "refs/remotes/origin/published-prefix", published]);
  await expect(context.reset.execute(repository.id, unpublished.token)).rejects.toThrow(
    /Remote-tracking history changed/,
  );

  const soft = await context.reset.prepare(repository.id, base, "soft");

  expect(soft.publishedCommits).toBe(1);
  expect(soft.indexPaths).toEqual([]);
  expect(soft.workingPaths).toEqual([]);

  const softResult = await context.reset.execute(repository.id, soft.token);

  expect(softResult.publishedCommits).toBe(1);
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);
  expect(await repo.run(["show", ":file.txt"])).toBe("staged\n");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("working\n");
  expect((await repo.run(["rev-parse", softResult.recoveryRef])).trim()).toBe(current);
  expect(
    await repo.run(["show", `${softResult.recoveryRef.replace(/head$/, "index")}:file.txt`]),
  ).toBe("staged\n");

  const history = await repo.git.history(repo.path);

  expect(history.commits.map((commit) => commit.oid)).not.toContain(current);
  expect(
    history.commits.every((commit) => !JSON.stringify(commit.decorations).includes("refs/eda/")),
  ).toBe(true);

  const softUndo = (await context.reversal.list(repository.id)).find((item) => item.available)!;

  await repo.writeFile(".git/index.lock", "external lock");
  await expect(context.reversal.execute(repository.id, softUndo.id, "undo")).rejects.toThrow(
    /index lock/,
  );
  expect(await readFile(join(repo.path, ".git/index.lock"), "utf8")).toBe("external lock");

  await unlink(join(repo.path, ".git/index.lock"));
  await context.reversal.execute(repository.id, softUndo.id, "undo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(current);
  expect(await repo.run(["show", ":file.txt"])).toBe("staged\n");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("working\n");

  db.close();
  context = services();
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === softUndo.id),
  ).toMatchObject({ direction: "redo", available: true });

  await context.reversal.execute(repository.id, softUndo.id, "redo");

  const mixed = await context.reset.prepare(repository.id, base, "mixed");
  const rewriteHistory = await context.historyRecovery.list(repository.id, "rewrites");

  expect(rewriteHistory.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        oid: current,
        description: expect.stringContaining("1 published commits"),
      }),
    ]),
  );
  expect(mixed.workingPaths).toEqual([]);
  expect(mixed.indexPaths).toContain("file.txt");

  const mixedResult = await context.reset.execute(repository.id, mixed.token);

  expect(await repo.run(["show", ":file.txt"])).toBe("base\n");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("working\n");

  db.close();
  context = services();

  const indexSnapshot = context.recovery
    .list(profile.id, repository.id)
    .find((record) => record.id === mixedResult.snapshotId)!;

  expect(indexSnapshot.indexOnly).toBe(true);

  const mixedUndo = (await context.reversal.list(repository.id)).find((item) => item.available)!;

  await context.reversal.execute(repository.id, mixedUndo.id, "undo");
  expect(await repo.run(["show", ":file.txt"])).toBe("staged\n");

  await context.reversal.execute(repository.id, mixedUndo.id, "redo");
  expect(await repo.run(["show", ":file.txt"])).toBe("base\n");
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("working\n");
  expect(
    context.recovery
      .savedFile(profile.id, repository.id, indexSnapshot.id, "file.txt", 0)
      .toString(),
  ).toBe("staged\n");
  await expect(
    context.recovery.restore(repository.path, profile.id, repository.id, indexSnapshot.id),
  ).rejects.toThrow(/index versions only/);

  await repo.run(["reset", "--hard", current]);
  await repo.writeFile("occupied.txt", "ignored private content\n");
  await expect(context.reset.prepare(repository.id, base, "hard")).rejects.toThrow(
    /Untracked or ignored/,
  );
  expect(await readFile(join(repo.path, "occupied.txt"), "utf8")).toBe("ignored private content\n");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(current);

  await unlink(join(repo.path, "occupied.txt"));
  await repo.writeFile("file.txt", "unfinished\n");
  await repo.run(["update-index", "--assume-unchanged", "file.txt"]);
  await expect(context.reset.prepare(repository.id, base, "hard")).rejects.toThrow(
    /assume-unchanged/,
  );

  await repo.run(["update-index", "--no-assume-unchanged", "file.txt"]);

  const stale = await context.reset.prepare(repository.id, base, "hard");

  await repo.writeFile("file.txt", "newer unfinished\n");
  await expect(context.reset.execute(repository.id, stale.token)).rejects.toThrow(
    /changed after review/,
  );

  const hard = await context.reset.prepare(repository.id, base, "hard");

  expect(hard.workingPaths).toContain("file.txt");

  const hardResult = await context.reset.execute(repository.id, hard.token);

  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("base\n");
  expect(await readFile(join(repo.path, "occupied.txt"), "utf8")).toBe("tracked base\n");
  expect(await readFile(join(repo.path, "untracked.txt"), "utf8")).toBe("keep\n");

  db.close();
  context = services();

  const hardUndo = (await context.reversal.list(repository.id)).find((item) => item.available)!;

  await repo.writeFile("file.txt", "external newer work\n");
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === hardUndo.id)?.available,
  ).toBe(false);
  await expect(context.reversal.execute(repository.id, hardUndo.id, "undo")).rejects.toThrow(
    /changed since/,
  );
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("external newer work\n");

  await repo.writeFile("file.txt", "base\n");
  await context.reversal.execute(repository.id, hardUndo.id, "undo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(current);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("newer unfinished\n");
  expect(await repo.run(["show", ":file.txt"])).toBe("current\n");

  db.close();
  context = services();
  await context.reversal.execute(repository.id, hardUndo.id, "redo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("base\n");
  expect(
    context.recovery
      .savedFile(profile.id, repository.id, hardResult.snapshotId!, "file.txt")
      .toString(),
  ).toBe("newer unfinished\n");

  await context.recovery.restore(
    repository.path,
    profile.id,
    repository.id,
    hardResult.snapshotId!,
  );
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("newer unfinished\n");
  expect(await repo.run(["show", ":file.txt"])).toBe("base\n");

  const expired = context.journal
    .historyActions(repository.path)
    .find((record) => `${record.refChange!.recoveryRef}/head` === softResult.recoveryRef)!;

  expired.updatedAt = "2000-01-01T00:00:00.000Z";
  context.journal.save(expired);

  const linkedPath = join(repo.home, "linked");

  await repo.run(["worktree", "add", "-b", "linked-reset", linkedPath, base]);

  const linked = await context.repositories.open(linkedPath);
  const next = await context.reset.prepare(linked.id, base, "soft");

  await context.reset.execute(linked.id, next.token);
  expect(
    (
      await repo.git.exec(["rev-parse", "--verify", "--quiet", softResult.recoveryRef], {
        cwd: repo.path,
        operation: "inspect expired snapshot",
        allowedExitCodes: [1],
      })
    ).exitCode,
  ).toBe(1);
  expect(
    context.journal.historyActions(repository.path).some((record) => record.id === expired.id),
  ).toBe(false);
  expect(context.journal.historyActions(linked.path)).toHaveLength(1);

  const beforeRecovery = await repo.run(["status", "--porcelain=v2"]);
  const reflog = await context.historyRecovery.list(repository.id, "reflog");

  expect(reflog.entries.some((entry) => entry.oid === current)).toBe(true);

  const saved = await context.historyRecovery.list(repository.id, "saved");

  expect(saved.entries.some((entry) => entry.oid === current)).toBe(true);

  const inspected = await context.historyRecovery.inspect(repository.id, current);

  expect(inspected.inspection.commit.subject).toBe("current");
  expect(inspected.diff.files.some((file) => file.newPath === "file.txt")).toBe(true);

  await repo.run(["branch", "recovered", base]);
  await expect(
    context.historyRecovery.restore(repository.id, inspected.token, "recovered"),
  ).rejects.toThrow();
  expect((await repo.run(["rev-parse", "recovered"])).trim()).toBe(base);

  await repo.run(["branch", "-D", "recovered"]);
  await context.historyRecovery.restore(repository.id, inspected.token, "recovered");
  expect((await repo.run(["rev-parse", "recovered"])).trim()).toBe(current);
  expect(await repo.run(["status", "--porcelain=v2"])).toBe(beforeRecovery);

  const orphan = (
    await repo.run(["commit-tree", `${base}^{tree}`, "-p", base, "-m", "Deleted branch work"])
  ).trim();

  await repo.run(["branch", "deleted-work", orphan]);
  await repo.run(["branch", "-D", "deleted-work"]);
  db.close();
  context = services();

  const unreachable = await context.historyRecovery.list(repository.id, "unreachable");

  expect(unreachable.entries.some((entry) => entry.oid === orphan)).toBe(true);

  const lost = await context.historyRecovery.inspect(repository.id, orphan);

  expect(lost.inspection.containingRefs).toEqual([]);

  await context.historyRecovery.restore(repository.id, lost.token, "deleted-work");
  expect((await repo.run(["rev-parse", "deleted-work"])).trim()).toBe(orphan);
  expect(await repo.run(["status", "--porcelain=v2"])).toBe(beforeRecovery);

  const interruptReset = await context.reset.prepare(repository.id, current, "mixed");

  await context.reset.execute(repository.id, interruptReset.token);

  const interrupted = (await context.reversal.list(repository.id)).find((item) => item.available)!;
  const execute = repo.git.exec.bind(repo.git);
  const failure = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    if (options.operation === "undo reset index")
      throw new Error("fixture interrupted index write");
    return execute(args, options);
  });

  try {
    await expect(context.reversal.execute(repository.id, interrupted.id, "undo")).rejects.toThrow(
      /interrupted index write/,
    );
  } finally {
    failure.mockRestore();
  }

  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);
  expect(await repo.run(["show", ":file.txt"])).toBe("current\n");

  db.close();
  context = services();
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === interrupted.id),
  ).toMatchObject({ available: false, reason: expect.stringMatching(/interrupted/) });
  await expect(context.reversal.execute(repository.id, interrupted.id, "undo")).rejects.toThrow(
    /interrupted/,
  );
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);
  await expect(context.reversal.reconcile(repository.id, interrupted.id, "undone")).rejects.toThrow(
    /partial/,
  );

  await repo.run(["update-ref", "refs/heads/main", current, base]);

  const beforeReconcile = await repo.run(["reflog", "--format=%H %gs"]);

  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === interrupted.id),
  ).toMatchObject({ available: false, reconciliation: "applied" });

  await context.reversal.reconcile(repository.id, interrupted.id, "applied");
  expect(await repo.run(["reflog", "--format=%H %gs"])).toBe(beforeReconcile);
  expect(await repo.run(["show", ":file.txt"])).toBe("current\n");

  const save = context.journal.save.bind(context.journal);
  const journalFailure = vi.spyOn(context.journal, "save").mockImplementation((record) => {
    if (record.id === interrupted.id && record.refChange?.reversal?.state === "undone")
      throw new Error("fixture interrupted final journal write");
    save(record);
  });

  try {
    await expect(context.reversal.execute(repository.id, interrupted.id, "undo")).rejects.toThrow(
      /final journal write/,
    );
  } finally {
    journalFailure.mockRestore();
  }

  db.close();
  context = services();
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === interrupted.id),
  ).toMatchObject({ available: false, reconciliation: "undone" });

  const completedReflog = await repo.run(["reflog", "--format=%H %gs"]);

  await context.reversal.reconcile(repository.id, interrupted.id, "undone");
  expect(await repo.run(["reflog", "--format=%H %gs"])).toBe(completedReflog);
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);

  await context.reversal.execute(repository.id, interrupted.id, "redo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(current);

  const interruptUndo = async () => {
    const fault = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
      if (options.operation === "undo reset index")
        throw new Error("interrupted index publication");
      return execute(args, options);
    });

    try {
      await expect(context.reversal.execute(repository.id, interrupted.id, "undo")).rejects.toThrow(
        /index publication/,
      );
    } finally {
      fault.mockRestore();
    }
  };

  await interruptUndo();

  const pending = context.journal
    .historyActions(repository.path)
    .find((record) => record.id === interrupted.id)!;
  const newerRecords: string[] = [];

  for (let index = 0; index < 20; index++) {
    const historical = structuredClone(pending);

    historical.id = randomUUID();
    historical.updatedAt = new Date(
      Date.parse(pending.updatedAt) + (index + 1) * 1000,
    ).toISOString();
    delete historical.refChange!.reversal;
    context.journal.save(historical);
    newerRecords.push(historical.id);
  }

  db.close();
  context = services();
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === interrupted.id),
  ).toMatchObject({ available: false, resumeIndex: true });

  const partialReflog = await repo.run(["reflog", "--format=%H %gs"]);

  await expect(context.reversal.resumeIndex(repository.id, interrupted.id, "redo")).rejects.toThrow(
    /changed after review/,
  );
  expect(await context.reversal.resumeIndex(repository.id, interrupted.id)).toEqual({
    preservedNewerWork: false,
  });
  expect(await repo.run(["reflog", "--format=%H %gs"])).toBe(partialReflog);
  expect(await repo.run(["show", ":file.txt"])).toBe("base\n");

  for (const id of newerRecords) context.journal.remove(id);

  await context.reversal.execute(repository.id, interrupted.id, "redo");
  await interruptUndo();
  await repo.writeFile("file.txt", "new work after interruption\n");
  await repo.run(["add", "file.txt"]);
  await expect(context.reversal.resumeIndex(repository.id, interrupted.id)).rejects.toThrow(
    /newer staged changes/,
  );
  expect(await repo.run(["show", ":file.txt"])).toBe("new work after interruption\n");

  await repo.run(["restore", `--source=${current}`, "--staged", "--", "file.txt"]);
  expect(await context.reversal.resumeIndex(repository.id, interrupted.id)).toEqual({
    preservedNewerWork: true,
  });
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("new work after interruption\n");
  expect(await repo.run(["show", ":file.txt"])).toBe("base\n");
  await expect(context.reversal.execute(repository.id, interrupted.id, "redo")).rejects.toThrow(
    /newer repository state retained/,
  );

  await repo.run(["reset", "--hard", current]);

  const hardReview = await context.reset.prepare(repository.id, base, "hard");
  const retainedStatus = await repo.run(["status", "--porcelain"]);

  await context.reset.execute(repository.id, hardReview.token);

  const interruptedHard = (await context.reversal.list(repository.id)).find(
    (item) => item.mode === "hard" && item.available,
  )!;

  for (const direction of ["undo", "redo"] as const) {
    const failure = vi
      .spyOn(DiscardService.prototype, "restoreOperationFiles")
      .mockImplementationOnce(async (snapshot) => {
        const file = snapshot.files.find((saved) => saved.path === "file.txt")!;
        await repo.writeFile(file.path, Buffer.from(file.content!, "base64").toString());
        throw new Error("interrupted working-file restoration");
      });

    try {
      await expect(
        context.reversal.execute(repository.id, interruptedHard.id, direction),
      ).rejects.toThrow(/interrupted working-file/);
    } finally {
      failure.mockRestore();
    }

    const reflog = await repo.run(["reflog", "--format=%H %gs"]);

    db.close();
    context = services();
    expect(
      (await context.reversal.list(repository.id)).find((item) => item.id === interruptedHard.id),
    ).toMatchObject({ resumeIndex: true, direction });

    const partial = await readFile(join(repo.path, "file.txt"), "utf8");

    await repo.writeFile("file.txt", "newer external contents\n");
    await expect(
      context.reversal.resumeIndex(repository.id, interruptedHard.id, direction),
    ).rejects.toThrow(/protect newer work/);
    expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("newer external contents\n");

    await repo.writeFile("file.txt", partial);
    expect(
      await context.reversal.resumeIndex(repository.id, interruptedHard.id, direction),
    ).toEqual({
      preservedNewerWork: false,
    });
    expect(await repo.run(["reflog", "--format=%H %gs"])).toBe(reflog);
    expect(await repo.run(["show", ":file.txt"])).toBe(
      direction === "undo" ? "current\n" : "base\n",
    );
    expect(await repo.run(["status", "--porcelain"])).toBe(retainedStatus);
  }
}, 90_000);

it("resumes the original reset intent before Git runs or after Git reached the target", async () => {
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

  const base = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.writeFile("file.txt", "current\n");
  await repo.commit("current");

  const current = (await repo.run(["rev-parse", "HEAD"])).trim();

  const review = await context.reset.prepare(repository.id, base, "mixed");
  const exec = repo.git.exec.bind(repo.git);
  const before = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    if (options.operation === "reset mixed") throw new Error("fixture interrupted before reset");
    return exec(args, options);
  });

  try {
    await expect(context.reset.execute(repository.id, review.token)).rejects.toThrow(
      /interrupted before reset/,
    );
  } finally {
    before.mockRestore();
  }

  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(current);

  db.close();
  context = services();
  context.identities.setActiveId(profile.id);

  const pending = (await context.reversal.list(repository.id)).find((item) => item.resumeReset)!;

  expect(pending).toMatchObject({ kind: "reset", direction: "undo", available: false });

  await repo.run(["update-ref", "refs/remotes/origin/shared", current]);
  await expect(
    context.reversal.resumeReset(repository.id, pending.id, pending.publishedCommits),
  ).rejects.toThrow(/Remote-tracking history changed/);
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(current);

  const reviewedPublication = (await context.reversal.list(repository.id)).find(
    (item) => item.id === pending.id,
  )!;

  expect(reviewedPublication.publishedCommits).toBe(1);
  expect(
    await context.reversal.resumeReset(
      repository.id,
      pending.id,
      reviewedPublication.publishedCommits,
    ),
  ).toEqual({
    outcome: "reset",
  });
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);
  expect(await repo.run(["show", ":file.txt"])).toBe("base\n");

  const completed = (await context.reversal.list(repository.id)).find(
    (item) => item.id === pending.id,
  )!;

  expect(completed).toMatchObject({ available: true, direction: "undo" });

  await context.reversal.execute(repository.id, pending.id, "undo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(current);

  const after = await context.reset.prepare(repository.id, base, "mixed");
  const afterFailure = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    if (options.operation === "preserve reset result index")
      throw new Error("fixture interrupted after reset");
    return exec(args, options);
  });

  try {
    await expect(context.reset.execute(repository.id, after.token)).rejects.toThrow(
      /interrupted after reset/,
    );
  } finally {
    afterFailure.mockRestore();
  }

  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);

  const reflog = await repo.run(["reflog", "--format=%H %gs"]);

  db.close();
  context = services();
  context.identities.setActiveId(profile.id);

  const pendingAfter = (await context.reversal.list(repository.id)).find(
    (item) => item.id !== pending.id && item.resumeReset,
  )!;

  expect(pendingAfter.reason).toMatch(/already reached/);
  expect(await context.reversal.resumeReset(repository.id, pendingAfter.id)).toEqual({
    outcome: "recorded",
  });
  expect(await repo.run(["reflog", "--format=%H %gs"])).toBe(reflog);
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === pendingAfter.id),
  ).toMatchObject({ available: true, direction: "undo" });

  await context.reversal.execute(repository.id, pendingAfter.id, "undo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(current);
  expect(await repo.run(["show", ":file.txt"])).toBe("current\n");

  await repo.writeFile("collision.txt", "saved target\n");
  await repo.commit("target with collision path");

  const hardTarget = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["rm", "collision.txt"]);
  await repo.commit("remove collision path");

  const hardStart = (await repo.run(["rev-parse", "HEAD"])).trim();
  const hardReview = await context.reset.prepare(repository.id, hardTarget, "hard");
  const hardFailure = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    if (options.operation === "reset hard") throw new Error("interrupted hard reset");
    return exec(args, options);
  });

  try {
    await expect(context.reset.execute(repository.id, hardReview.token)).rejects.toThrow(
      /interrupted hard reset/,
    );
  } finally {
    hardFailure.mockRestore();
  }

  db.close();
  context = services();

  const hardPending = (await context.reversal.list(repository.id)).find(
    (item) => item.mode === "hard" && item.resumeReset,
  )!;

  await repo.writeFile(".git/info/exclude", "collision.txt\n");
  await repo.writeFile("collision.txt", "new ignored contents\n");
  await expect(context.reversal.resumeReset(repository.id, hardPending.id)).rejects.toThrow(
    /Untracked or ignored/,
  );
  expect(await readFile(join(repo.path, "collision.txt"), "utf8")).toBe("new ignored contents\n");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(hardStart);

  await unlink(join(repo.path, "collision.txt"));

  const hardRecord = context.journal
    .historyActions(repository.path)
    .find((item) => item.id === hardPending.id)!;
  const snapshots = new ContentRecoveryRepository(db);
  const saved = snapshots.get(profile.id, repository.id, hardRecord.refChange!.snapshotId!)!;

  snapshots.remove(profile.id, repository.id, saved.id);
  await expect(context.reversal.resumeReset(repository.id, hardPending.id)).rejects.toThrow(
    /snapshot is unavailable/,
  );
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(hardStart);

  snapshots.save(saved);
  await context.reversal.resumeReset(repository.id, hardPending.id);
  expect(await readFile(join(repo.path, "collision.txt"), "utf8")).toBe("saved target\n");

  await context.reversal.execute(repository.id, hardPending.id, "undo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(hardStart);
  await expect(readFile(join(repo.path, "collision.txt"))).rejects.toThrow();

  for (const mode of ["soft", "mixed", "hard"] as const) {
    await repo.writeFile("file.txt", "same-head staged\n");
    await repo.run(["add", "file.txt"]);
    await repo.writeFile("file.txt", "same-head working\n");

    const sameHead = await context.reset.prepare(repository.id, hardStart, mode);
    const fault = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
      if (options.operation === `reset ${mode}`) throw new Error("interrupted same-head reset");
      return exec(args, options);
    });

    try {
      await expect(context.reset.execute(repository.id, sameHead.token)).rejects.toThrow(
        /interrupted same-head/,
      );
    } finally {
      fault.mockRestore();
    }

    db.close();
    context = services();

    const intent = (await context.reversal.list(repository.id)).find(
      (item) => item.resumeReset && item.mode === mode,
    )!;
    const beforeResume = await repo.run(["reflog", "--format=%H %gs"]);

    expect(await context.reversal.resumeReset(repository.id, intent.id)).toEqual({
      outcome: mode === "soft" ? "recorded" : "reset",
    });

    if (mode === "soft") expect(await repo.run(["reflog", "--format=%H %gs"])).toBe(beforeResume);

    expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(hardStart);
    expect(await repo.run(["show", ":file.txt"])).toBe(
      mode === "soft" ? "same-head staged\n" : "current\n",
    );
    expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe(
      mode === "hard" ? "current\n" : "same-head working\n",
    );

    await context.reversal.execute(repository.id, intent.id, "undo");
    expect(await repo.run(["show", ":file.txt"])).toBe("same-head staged\n");
    expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("same-head working\n");
  }
}, 60_000);
