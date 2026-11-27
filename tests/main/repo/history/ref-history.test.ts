import { activateTestProfile, workflowFixture } from "../../../helpers/workflow-fixture";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { openDatabase } from "@main/persistence/database";
import type { Database } from "@main/persistence/types";
import { HistoryReversalService } from "@main/repo/history/history-reversal-service";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";

let repo: TempRepo;
let db: Database;

afterEach(async () => {
  db?.close();
  await repo?.cleanup();
});

function services() {
  db = openDatabase(join(repo.home, "refs.db"));

  const { identities, repositories, writer, workflows, journal, recovery } = workflowFixture(
    db,
    repo.git,
    { recordWriterHistory: true },
  );

  return {
    identities,
    journal,
    repositories,
    writer,
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

async function setup() {
  repo = await createTempRepo();

  let context = services();
  const profile = activateTestProfile(context.identities);

  const repository = await context.repositories.open(repo.path);

  await repo.writeFile("base.txt", "base\n");
  await repo.commit("base");

  return {
    repository,
    get context() {
      return context;
    },
    reopen() {
      db.close();
      context = services();
      context.identities.setActiveId(profile.id);
      return context;
    },
  };
}

async function interruptOriginal(operation: string, work: () => Promise<void>) {
  const exec = repo.git.exec.bind(repo.git);
  const failure = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    const result = await exec(args, options);
    if (options.operation === operation) throw new Error("interrupted original action after Git");
    return result;
  });

  try {
    await expect(work()).rejects.toThrow(/interrupted original action/);
  } finally {
    failure.mockRestore();
  }
}

it.each(["applied", "undoing", "redoing"] as const)(
  "propagates unexpected reference inspection failures in %s state without changing recovery",
  async (state) => {
    const { repository, context } = await setup();
    await context.writer.createBranch(repository.id, "feature");

    const record = context.journal.refActions(repository.path)[0]!;
    record.refOperation!.state = state;
    context.journal.save(record);

    const failure = new GitError({
      kind: "repository-corrupt",
      operation: "inspect reference recovery",
      message: errorText("errors.unexpected"),
    });
    const status = vi.spyOn(repo.git, "status").mockRejectedValue(failure);

    try {
      await expect(context.reversal.list(repository.id)).rejects.toBe(failure);
      if (state !== "applied")
        await expect(context.reversal.reconcile(repository.id, record.id, "applied")).rejects.toBe(
          failure,
        );
    } finally {
      status.mockRestore();
    }

    expect(context.journal.refActions(repository.path)).toEqual([record]);
    expect((await repo.run(["rev-parse", "feature"])).trim()).toBe(record.refOperation!.tip);
    expect(await context.reversal.list(repository.id)).toEqual([
      expect.objectContaining(
        state === "applied" ? { available: true } : { available: false, reconciliation: "applied" },
      ),
    ]);
  },
);

it("writes reference fingerprints compatible with existing recovery journals", async () => {
  const { repository, context } = await setup();
  await repo.writeFile("base.txt", "staged\n");
  await repo.run(["add", "base.txt"]);
  await repo.writeFile("base.txt", "unstaged\n");

  const status = await repo.git.status(repo.path);
  const index = await repo.run(["ls-files", "--stage", "-z"]);
  const diff = await repo.run(["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"]);
  const storedDigest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).update(index).update(diff).digest("hex");

  await context.writer.createBranch(repository.id, "feature");
  expect(context.journal.refActions(repository.path)[0]?.refOperation).toMatchObject({
    beforeFingerprint: storedDigest(status),
    startContentFingerprint: storedDigest(status.changes),
  });
});

it("reverses branch creation and checkout, and refuses an externally moved HEAD", async () => {
  const run = await setup();
  const { repository } = run;
  let context = run.context;
  const base = (await repo.run(["rev-parse", "HEAD"])).trim();

  const exec = repo.git.exec.bind(repo.git);
  const beforeGit = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    if (options.operation === "create branch") throw new Error("interrupted before Git");
    return exec(args, options);
  });

  await expect(context.writer.createBranch(repository.id, "unstarted")).rejects.toThrow(
    /interrupted before Git/,
  );

  beforeGit.mockRestore();
  context = run.reopen();

  const unstarted = (await context.reversal.list(repository.id)).find(
    (item) => item.label === "Undo Create branch unstarted",
  )!;

  expect(unstarted).toMatchObject({ available: false, dismissUnstarted: true });

  const startingLog = await repo.run(["reflog", "--format=%H %gs"]);

  await repo.run(["branch", "unstarted"]);
  await expect(context.reversal.dismissUnstarted(repository.id, unstarted.id)).rejects.toThrow(
    /created branch changed/,
  );
  expect(context.journal.refActions(repository.path).some((item) => item.id === unstarted.id)).toBe(
    true,
  );

  await repo.run(["branch", "-D", "unstarted"]);
  await context.reversal.dismissUnstarted(repository.id, unstarted.id);
  expect(context.journal.refActions(repository.path).some((item) => item.id === unstarted.id)).toBe(
    false,
  );
  expect(await repo.run(["reflog", "--format=%H %gs"])).toBe(startingLog);

  await interruptOriginal("create branch", () =>
    context.writer.createBranch(repository.id, "feature", { checkout: true }),
  );
  context = run.reopen();
  expect((await repo.run(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("feature");

  const create = (await context.reversal.list(repository.id)).find(
    (item) => item.kind === "branch" && item.label === "Undo Create branch feature",
  )!;

  expect(create).toMatchObject({ available: false, reconciliation: "applied" });

  const createdLog = await repo.run(["reflog", "--format=%H %gs"]);

  await repo.writeFile("base.txt", "newer checkout work\n");
  await expect(context.reversal.reconcile(repository.id, create.id, "applied")).rejects.toThrow(
    /local changes/,
  );
  expect(await readFile(join(repo.path, "base.txt"), "utf8")).toBe("newer checkout work\n");

  await repo.writeFile("base.txt", "base\n");
  await context.reversal.reconcile(repository.id, create.id, "applied");
  expect(await repo.run(["reflog", "--format=%H %gs"])).toBe(createdLog);

  await context.reversal.execute(repository.id, create.id, "undo");
  expect((await repo.run(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("main");
  expect(
    (
      await repo.git.exec(["rev-parse", "--verify", "--quiet", "refs/heads/feature"], {
        cwd: repo.path,
        operation: "inspect reversed branch",
        allowedExitCodes: [1],
      })
    ).exitCode,
  ).toBe(1);

  await context.reversal.execute(repository.id, create.id, "redo");
  expect((await repo.run(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("feature");
  expect((await repo.run(["rev-parse", "feature"])).trim()).toBe(base);

  await repo.run(["checkout", "main"]);
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === create.id),
  ).toMatchObject({ available: false, reason: expect.stringMatching(/changed since|HEAD/) });
  await expect(context.reversal.execute(repository.id, create.id, "undo")).rejects.toThrow(
    /changed since|HEAD/,
  );
  expect((await repo.run(["rev-parse", "feature"])).trim()).toBe(base);

  context = run.reopen();
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === create.id),
  ).toMatchObject({ available: false });
}, 60_000);

it("recovers branch deletion and its settings while refusing externally changed refs", async () => {
  const run = await setup();
  const { repository } = run;
  let context = run.context;
  const base = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.writeFile("next.txt", "next\n");
  await repo.commit("next");
  await repo.run(["branch", "feature", base]);
  await repo.run(["config", "branch.feature.remote", "origin"]);
  await repo.run(["config", "branch.feature.merge", "refs/heads/shared"]);
  await repo.run(["config", "--add", "branch.feature.merge", "refs/heads/secondary"]);
  await repo.run(["config", "branch.feature.description", "Eda branch\nwith description"]);
  await repo.run(["config", "branch.feature.child.remote", "other"]);

  const next = (await repo.run(["rev-parse", "HEAD"])).trim();

  await interruptOriginal("delete branch", () =>
    context.writer.deleteBranch(repository.id, "feature"),
  );
  context = run.reopen();

  const remove = (await context.reversal.list(repository.id)).find(
    (item) => item.label === "Undo Delete branch feature",
  )!;

  expect(remove).toMatchObject({ kind: "branch", available: false, reconciliation: "applied" });

  await context.reversal.reconcile(repository.id, remove.id, "applied");

  const configLock = join(repo.path, ".git", "config.lock");

  await writeFile(configLock, "another writer");
  await expect(context.reversal.execute(repository.id, remove.id, "undo")).rejects.toThrow(
    /config lock/,
  );
  expect(await readFile(configLock, "utf8")).toBe("another writer");

  await unlink(configLock);
  await context.reversal.reconcile(repository.id, remove.id, "applied");
  await context.reversal.execute(repository.id, remove.id, "undo");
  expect((await repo.run(["rev-parse", "feature"])).trim()).toBe(base);
  expect((await repo.run(["config", "branch.feature.remote"])).trim()).toBe("origin");
  expect(await repo.run(["config", "--get-all", "branch.feature.merge"])).toBe(
    "refs/heads/shared\nrefs/heads/secondary\n",
  );
  expect(await repo.run(["config", "branch.feature.description"])).toBe(
    "Eda branch\nwith description\n",
  );

  await repo.run(["config", "branch.feature.remote", "newer"]);
  await expect(context.reversal.execute(repository.id, remove.id, "redo")).rejects.toThrow(
    /configuration changed/,
  );

  await repo.run(["config", "branch.feature.remote", "origin"]);

  const linked = join(repo.home, "linked-feature");

  await repo.run(["worktree", "add", linked, "feature"]);
  await expect(context.reversal.execute(repository.id, remove.id, "redo")).rejects.toThrow(
    /another worktree/,
  );
  expect((await repo.run(["rev-parse", "feature"])).trim()).toBe(base);

  await repo.run(["worktree", "remove", linked]);
  await repo.run(["branch", "-f", "feature", next]);
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === remove.id),
  ).toMatchObject({ available: false });
  await expect(context.reversal.execute(repository.id, remove.id, "redo")).rejects.toThrow(
    /changed/,
  );

  await repo.run(["branch", "-f", "feature", base]);
  await context.reversal.execute(repository.id, remove.id, "redo");
  expect(
    (
      await repo.git.exec(["rev-parse", "--verify", "--quiet", "refs/heads/feature"], {
        cwd: repo.path,
        operation: "inspect removed branch",
        allowedExitCodes: [1],
      })
    ).exitCode,
  ).toBe(1);
  expect((await repo.run(["config", "branch.feature.child.remote"])).trim()).toBe("other");

  const removedConfig = await repo.git.exec(["config", "--get", "branch.feature.remote"], {
    cwd: repo.path,
    operation: "inspect removed branch tracking",
    allowedExitCodes: [1],
  });

  expect(removedConfig.exitCode).toBe(1);

  const exec = repo.git.exec.bind(repo.git);
  const race = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    if (options.operation === "undo branch-delete" && args[0] === "update-ref")
      await exec(["update-ref", "refs/heads/feature", next, ""], {
        cwd: repo.path,
        operation: "fixture concurrent branch creation",
      });
    return exec(args, options);
  });

  try {
    await expect(context.reversal.execute(repository.id, remove.id, "undo")).rejects.toThrow();
  } finally {
    race.mockRestore();
  }

  expect((await repo.run(["rev-parse", "feature"])).trim()).toBe(next);

  await repo.run(["update-ref", "-d", "refs/heads/feature", next]);
  await context.reversal.reconcile(repository.id, remove.id, "applied");

  const interruptedConfig = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    const result = await exec(args, options);
    if (options.operation === "undo branch-delete" && args[0] === "update-ref")
      throw new Error("interrupted before settings publication");
    return result;
  });

  try {
    await expect(context.reversal.execute(repository.id, remove.id, "undo")).rejects.toThrow(
      /settings publication/,
    );
  } finally {
    interruptedConfig.mockRestore();
  }

  context = run.reopen();
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === remove.id),
  ).toMatchObject({ resumeConfiguration: true });

  const reflog = await repo.run(["reflog", "show", "feature", "--format=%H %gs"]);

  await repo.run(["config", "branch.feature.remote", "newer"]);
  await expect(
    context.reversal.resumeConfiguration(repository.id, remove.id, "undo"),
  ).rejects.toThrow(/newer settings/);
  expect((await repo.run(["config", "branch.feature.remote"])).trim()).toBe("newer");

  await repo.run(["config", "--unset-all", "branch.feature.remote"]);
  await expect(
    context.reversal.resumeConfiguration(repository.id, remove.id, "redo"),
  ).rejects.toThrow(/direction changed/);

  await context.reversal.resumeConfiguration(repository.id, remove.id, "undo");
  expect(await repo.run(["reflog", "show", "feature", "--format=%H %gs"])).toBe(reflog);
  expect((await repo.run(["config", "branch.feature.remote"])).trim()).toBe("origin");

  await context.reversal.execute(repository.id, remove.id, "redo");
}, 60_000);

it("retains deleted branch objects through Git pruning and expires only owned unchanged recovery refs", async () => {
  const run = await setup();
  const { repository } = run;
  const context = run.context;
  const head = (await repo.run(["rev-parse", "HEAD"])).trim();
  const tree = (await repo.run(["rev-parse", "HEAD^{tree}"])).trim();
  const orphan = (await repo.run(["commit-tree", tree, "-m", "retained Eda branch"])).trim();

  await repo.run(["branch", "lost", orphan]);
  await context.writer.deleteBranch(repository.id, "lost", { force: true });

  const action = context.journal
    .refActions(repository.path)
    .find((record) => record.message === "Delete branch lost")!;
  const ref = `${action.refOperation!.recoveryRef}/tip`;

  await repo.run(["reflog", "expire", "--expire=now", "--all"]);
  await repo.run(["gc", "--prune=now"]);
  expect((await repo.run(["cat-file", "-t", orphan])).trim()).toBe("commit");

  await repo.run(["update-ref", ref, head]);
  await expect(context.reversal.execute(repository.id, action.id, "undo")).rejects.toThrow(
    /saved reference/,
  );

  action.updatedAt = "2000-01-01T00:00:00.000Z";
  context.journal.save(action);
  await context.writer.createBranch(repository.id, "keep-newer-ref");
  expect((await repo.run(["rev-parse", ref])).trim()).toBe(head);
  expect(
    context.journal.refActions(repository.path).some((record) => record.id === action.id),
  ).toBe(true);

  await repo.run(["update-ref", ref, orphan]);
  await context.reversal.execute(repository.id, action.id, "undo");
  expect((await repo.run(["rev-parse", "lost"])).trim()).toBe(orphan);

  action.refOperation!.state = "undone";
  context.journal.save(action);
  await context.writer.createBranch(repository.id, "expire-owned-ref");
  expect(
    context.journal.refActions(repository.path).some((record) => record.id === action.id),
  ).toBe(false);
  expect(await repo.run(["for-each-ref", action.refOperation!.recoveryRef!])).toBe("");
}, 30_000);

it("reverses configured branch renames and protects settings at both names", async () => {
  const run = await setup();
  const { repository } = run;
  let context = run.context;
  const base = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["branch", "old", base]);
  await repo.run(["config", "branch.old.remote", "."]);
  await repo.run(["config", "branch.old.merge", "refs/heads/main"]);
  await repo.run(["config", "branch.old.description", "Eda rename settings"]);
  await interruptOriginal("rename branch", () =>
    context.writer.renameBranch(repository.id, "old", "renamed"),
  );
  context = run.reopen();

  const rename = (await context.reversal.list(repository.id)).find(
    (item) => item.label === "Undo Rename branch old to renamed",
  )!;

  expect(rename).toMatchObject({ available: false, reconciliation: "applied" });

  await context.reversal.reconcile(repository.id, rename.id, "applied");
  expect((await repo.run(["config", "branch.renamed.remote"])).trim()).toBe(".");

  await repo.run(["config", "branch.old.description", "new settings at old name"]);
  await expect(context.reversal.execute(repository.id, rename.id, "undo")).rejects.toThrow(
    /configuration changed/,
  );

  await repo.run(["config", "--unset-all", "branch.old.description"]);
  await repo.run(["config", "branch.renamed.remote", "newer"]);
  await expect(context.reversal.execute(repository.id, rename.id, "undo")).rejects.toThrow(
    /configuration changed/,
  );

  await repo.run(["config", "branch.renamed.remote", "."]);
  await context.reversal.execute(repository.id, rename.id, "undo");
  expect((await repo.run(["rev-parse", "old"])).trim()).toBe(base);
  expect((await repo.run(["config", "branch.old.merge"])).trim()).toBe("refs/heads/main");
  await expect(repo.run(["rev-parse", "renamed"])).rejects.toThrow();

  await context.reversal.execute(repository.id, rename.id, "redo");
  expect((await repo.run(["rev-parse", "renamed"])).trim()).toBe(base);
  expect((await repo.run(["config", "branch.renamed.description"])).trim()).toBe(
    "Eda rename settings",
  );
  await expect(repo.run(["rev-parse", "old"])).rejects.toThrow();

  await context.writer.checkoutBranch(repository.id, "renamed");
  await context.writer.renameBranch(repository.id, "renamed", "active-name");

  const active = (await context.reversal.list(repository.id)).find(
    (item) => item.label === "Undo Rename branch renamed to active-name",
  )!;

  await context.reversal.execute(repository.id, active.id, "undo");
  expect((await repo.run(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("renamed");
  expect((await repo.run(["config", "branch.renamed.remote"])).trim()).toBe(".");

  await context.reversal.execute(repository.id, active.id, "redo");
  expect((await repo.run(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("active-name");
  expect((await repo.run(["config", "branch.active-name.description"])).trim()).toBe(
    "Eda rename settings",
  );
}, 30_000);

it("recovers a rename that combines pre-existing destination settings", async () => {
  const run = await setup();
  const { repository } = run;
  let context = run.context;

  await repo.run(["checkout", "-b", "active-name"]);
  await repo.run(["config", "branch.active-name.remote", "."]);
  await repo.run(["config", "branch.active-name.merge", "refs/heads/main"]);
  await repo.run(["config", "branch.active-name.description", "Eda rename settings"]);
  await repo.run(["config", "branch.settings-target.description", "existing destination"]);
  await interruptOriginal("rename branch", () =>
    context.writer.renameBranch(repository.id, "active-name", "settings-target"),
  );
  context = run.reopen();

  const combined = (await context.reversal.list(repository.id)).find(
    (item) => item.label === "Undo Rename branch active-name to settings-target",
  )!;

  expect(combined.reconciliation).toBe("applied");

  await context.reversal.reconcile(repository.id, combined.id, "applied");

  const exec = repo.git.exec.bind(repo.git);
  const interrupted = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    if (options.operation === "prepare branch configuration")
      throw new Error("interrupted rename settings");
    return exec(args, options);
  });

  try {
    await expect(context.reversal.execute(repository.id, combined.id, "undo")).rejects.toThrow(
      /interrupted rename settings/,
    );
  } finally {
    interrupted.mockRestore();
  }

  context = run.reopen();
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === combined.id),
  ).toMatchObject({ resumeConfiguration: true });

  const log = await repo.run(["reflog", "--format=%H %gs"]);

  await context.reversal.resumeConfiguration(repository.id, combined.id, "undo");
  expect(await repo.run(["reflog", "--format=%H %gs"])).toBe(log);
  expect((await repo.run(["config", "--get-all", "branch.active-name.description"])).trim()).toBe(
    "Eda rename settings",
  );
  expect(
    (await repo.run(["config", "--get-all", "branch.settings-target.description"])).trim(),
  ).toBe("existing destination");

  await context.reversal.execute(repository.id, combined.id, "redo");
  expect((await repo.run(["branch", "--show-current"])).trim()).toBe("settings-target");
}, 30_000);

it("checks out the remote tip even with a same-named local branch and can undo and redo it", async () => {
  const { repository, context } = await setup();
  const name = "origin/branches";
  const remoteTip = (await repo.run(["rev-parse", "HEAD"])).trim();
  await repo.run(["update-ref", `refs/remotes/${name}`, remoteTip]);
  await repo.run(["commit", "--allow-empty", "-m", "Local commit"]);
  await repo.run(["branch", name]);

  await context.writer.checkoutBranch(repository.id, name, true);
  expect((await repo.git.status(repo.path)).branch).toMatchObject({
    detached: true,
    oid: remoteTip,
  });

  const [action] = await context.reversal.list(repository.id);
  expect(action).toMatchObject({ kind: "checkout", available: true });
  await context.reversal.execute(repository.id, action!.id, "undo");
  expect((await repo.git.status(repo.path)).branch.head).toBe("main");

  await repo.run(["update-ref", `refs/remotes/${name}`, "HEAD"]);
  await context.reversal.execute(repository.id, action!.id, "redo");
  expect((await repo.git.status(repo.path)).branch).toMatchObject({
    detached: true,
    oid: remoteTip,
  });
});

it("reverses branch and tag checkout and blocks a changed checkout", async () => {
  const run = await setup();
  const { repository } = run;
  const context = run.context;
  const base = (await repo.run(["rev-parse", "HEAD"])).trim();

  await context.writer.createBranch(repository.id, "feature");
  await context.writer.createTag(repository.id, "v1.0.0");

  await context.writer.checkoutBranch(repository.id, "feature");

  const branch = (await context.reversal.list(repository.id)).find(
    (item) => item.label === "Undo Checkout branch feature",
  )!;

  expect(branch).toMatchObject({ kind: "checkout", available: true });

  const tree = (await repo.run(["rev-parse", "HEAD^{tree}"])).trim();
  const mergeHead = (
    await repo.run(["commit-tree", tree, "-p", base, "-m", "external merge"])
  ).trim();

  await repo.run(["merge", "--no-ff", "--no-commit", mergeHead]);
  await expect(context.reversal.execute(repository.id, branch.id, "undo")).rejects.toThrow(
    /Finish or abort/,
  );
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);

  await repo.run(["merge", "--abort"]);
  await context.reversal.execute(repository.id, branch.id, "undo");
  expect((await repo.run(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("main");

  await context.reversal.execute(repository.id, branch.id, "redo");
  expect((await repo.run(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("feature");

  await repo.run(["checkout", "main"]);
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === branch.id),
  ).toMatchObject({ available: false });
  await expect(context.reversal.execute(repository.id, branch.id, "undo")).rejects.toThrow(
    /changed|HEAD/,
  );

  await context.writer.checkoutTag(repository.id, "v1.0.0");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);
  expect((await repo.git.status(repo.path)).branch.detached).toBe(true);

  const tag = (await context.reversal.list(repository.id)).find(
    (item) => item.label === "Undo Checkout detached commit",
  )!;

  await context.reversal.execute(repository.id, tag.id, "undo");
  expect((await repo.run(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("main");

  await context.reversal.execute(repository.id, tag.id, "redo");
  expect((await repo.run(["rev-parse", "HEAD"])).trim()).toBe(base);
  expect((await repo.git.status(repo.path)).branch.detached).toBe(true);
}, 60_000);

it("recovers partial original checkout and reconciles interrupted reference reversals", async () => {
  const run = await setup();
  const { repository } = run;
  let context = run.context;

  await repo.run(["checkout", "-b", "destination"]);
  await repo.writeFile("generated.txt", "tracked destination\n");
  await repo.commit("destination content");

  const destination = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.run(["tag", "destination-tag"]);
  await repo.run(["checkout", "main"]);
  await writeFile(join(repo.path, ".git", "info", "exclude"), "generated.txt\n");

  const nativeExec = repo.git.exec.bind(repo.git);
  const partialCreation = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    if (options.operation === "create branch") {
      await nativeExec(["branch", "resume-created", destination], options);
      throw new Error("interrupted after branch creation");
    }
    return nativeExec(args, options);
  });

  try {
    await expect(
      context.writer.createBranch(repository.id, "resume-created", {
        checkout: true,
        startPoint: destination,
      }),
    ).rejects.toThrow(/interrupted after branch creation/);
  } finally {
    partialCreation.mockRestore();
  }

  context = run.reopen();

  const interrupted = (await context.reversal.list(repository.id)).find(
    (item) => item.label === "Undo Create branch resume-created",
  )!;

  expect(interrupted).toMatchObject({ available: false, resumeBranchCheckout: "original" });

  const createdReflog = await repo.run(["reflog", "show", "resume-created", "--format=%H %gs"]);

  await repo.writeFile("base.txt", "newer local work\n");
  await expect(
    context.reversal.resumeBranchCheckout(repository.id, interrupted.id),
  ).rejects.toThrow(/changed since/);
  expect(await readFile(join(repo.path, "base.txt"), "utf8")).toBe("newer local work\n");

  await repo.writeFile("base.txt", "base\n");
  await repo.writeFile("generated.txt", "ignored local work\n");
  await expect(repo.git.checkoutBranch(repo.path, "destination")).rejects.toBeDefined();
  await expect(repo.git.checkoutTag(repo.path, "destination-tag")).rejects.toBeDefined();
  await expect(
    repo.git.createBranch(repo.path, "collision", { checkout: true, startPoint: destination }),
  ).rejects.toBeDefined();
  await expect(
    context.reversal.resumeBranchCheckout(repository.id, interrupted.id),
  ).rejects.toBeDefined();
  expect(await readFile(join(repo.path, "generated.txt"), "utf8")).toBe("ignored local work\n");
  expect((await repo.run(["branch", "--show-current"])).trim()).toBe("main");

  await unlink(join(repo.path, "generated.txt"));
  await context.reversal.resumeBranchCheckout(repository.id, interrupted.id);
  expect((await repo.run(["branch", "--show-current"])).trim()).toBe("resume-created");
  expect(await repo.run(["reflog", "show", "resume-created", "--format=%H %gs"])).toBe(
    createdReflog,
  );
  expect(await readFile(join(repo.path, "generated.txt"), "utf8")).toBe("tracked destination\n");

  await context.reversal.execute(repository.id, interrupted.id, "undo");
  expect((await repo.run(["branch", "--show-current"])).trim()).toBe("main");

  await context.writer.createBranch(repository.id, "cleanup");

  const cleanup = (await context.reversal.list(repository.id)).find(
    (item) => item.label === "Undo Create branch cleanup",
  )!;
  const save = context.journal.save.bind(context.journal);
  const failure = vi.spyOn(context.journal, "save").mockImplementation((record) => {
    if (record.id === cleanup.id && record.refOperation?.state === "undone")
      throw new Error("fixture interrupted reference journal write");
    save(record);
  });

  try {
    await expect(context.reversal.execute(repository.id, cleanup.id, "undo")).rejects.toThrow(
      /interrupted reference journal write/,
    );
  } finally {
    failure.mockRestore();
  }

  expect(
    (
      await repo.git.exec(["rev-parse", "--verify", "--quiet", "refs/heads/cleanup"], {
        cwd: repo.path,
        operation: "inspect interrupted reference",
        allowedExitCodes: [1],
      })
    ).exitCode,
  ).toBe(1);

  context = run.reopen();
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === cleanup.id),
  ).toMatchObject({ available: false, reconciliation: "undone" });

  await context.reversal.reconcile(repository.id, cleanup.id, "undone");
  await context.reversal.execute(repository.id, cleanup.id, "redo");
  expect((await repo.run(["rev-parse", "cleanup"])).trim()).toBe(
    (await repo.run(["rev-parse", "main"])).trim(),
  );

  await context.writer.createBranch(repository.id, "partial", { checkout: true });

  const partial = (await context.reversal.list(repository.id)).find(
    (item) => item.label === "Undo Create branch partial",
  )!;
  const exec = repo.git.exec.bind(repo.git);
  const fault = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    if (options.operation === "undo branch-create" && args[0] === "update-ref")
      throw new Error("fixture interrupted branch deletion");
    return exec(args, options);
  });

  try {
    await expect(context.reversal.execute(repository.id, partial.id, "undo")).rejects.toThrow(
      /interrupted branch deletion/,
    );
  } finally {
    fault.mockRestore();
  }

  expect((await repo.run(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("main");
  expect((await repo.run(["rev-parse", "partial"])).trim()).toBe(
    (await repo.run(["rev-parse", "main"])).trim(),
  );

  context = run.reopen();
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === partial.id),
  ).toMatchObject({ available: false, reason: expect.stringMatching(/partial/) });
  await expect(context.reversal.reconcile(repository.id, partial.id, "undone")).rejects.toThrow(
    /partial/,
  );

  const checkoutLog = await repo.run(["reflog", "--format=%H %gs"]);

  await expect(
    context.reversal.resumeBranchCheckout(repository.id, partial.id, "redo"),
  ).rejects.toThrow(/direction changed/);

  await context.reversal.resumeBranchCheckout(repository.id, partial.id, "undo");
  expect(await repo.run(["reflog", "--format=%H %gs"])).toBe(checkoutLog);

  const interruptedRedo = vi.spyOn(repo.git, "exec").mockImplementation(async (args, options) => {
    if (options.operation === "redo branch-create" && args[0] === "checkout")
      throw new Error("interrupted redo checkout");
    return exec(args, options);
  });

  try {
    await expect(context.reversal.execute(repository.id, partial.id, "redo")).rejects.toThrow(
      /interrupted redo checkout/,
    );
  } finally {
    interruptedRedo.mockRestore();
  }

  context = run.reopen();
  expect(
    (await context.reversal.list(repository.id)).find((item) => item.id === partial.id),
  ).toMatchObject({ resumeBranchCheckout: "redo" });

  const partialLog = await repo.run(["reflog", "show", "partial", "--format=%H %gs"]);

  await context.reversal.resumeBranchCheckout(repository.id, partial.id, "redo");
  expect(await repo.run(["reflog", "show", "partial", "--format=%H %gs"])).toBe(partialLog);
  expect((await repo.run(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("partial");
}, 90_000);
