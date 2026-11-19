import { errorFixture } from "../../helpers/error";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError } from "@shared/errors";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { OperationRepository } from "@main/persistence/operation-repository";
import { OperationManager } from "@main/operations/operation-manager";
import { operations } from "@main/persistence/schema";

let db: ReturnType<typeof openInMemoryDatabase>;
let manager: OperationManager;
let store: OperationRepository;
let owner: { profileId: string; repositoryId: string; repositoryName: string };

beforeEach(() => {
  db = openInMemoryDatabase();

  const profile = new IdentityRepository(db).create({
    name: "Work",
    gitName: "Author",
    gitEmail: "a@example.com",
    hue: 0,
    signing: { format: "none", signCommits: false },
  });

  owner = { profileId: profile.id, repositoryId: "repo", repositoryName: "fixture" };
  store = new OperationRepository(db);
  manager = new OperationManager(store);
});

afterEach(() => db.close());

describe("operation journal", () => {
  it("persists a stable operation key independently of translated display text", async () => {
    await manager.run(
      owner,
      "Publier la branche",
      async () => {},
      undefined,
      "operationTitles.pushBranch",
    );
    for (const record of [manager.list(owner.profileId)[0], store.list(owner.profileId)[0]]) {
      expect(record).toMatchObject({
        kind: "Publier la branche",
        kindKey: "operationTitles.pushBranch",
      });
    }
  });

  it("keeps startup usable with a corrupt journal record without exposing or deleting its raw bytes", () => {
    db.raw.exec("PRAGMA ignore_check_constraints = ON");
    db.insert(operations)
      .values({
        id: "broken",
        profileId: owner.profileId,
        updatedAt: new Date().toISOString(),
        record: "token=private broken json",
      })
      .run();
    db.raw.exec("PRAGMA ignore_check_constraints = OFF");
    expect(() => store.recover()).not.toThrow();
    expect(store.list(owner.profileId)[0]).toMatchObject({
      state: "interrupted",
      kind: "Damaged activity record",
      output: "",
    });
    expect(db.select().from(operations).get()?.record).toBe("token=private broken json");
  });

  it("redacts streamed diagnostics, bounds output, and isolates profiles", async () => {
    await manager.run(owner, "Commit", async () => {
      manager.started("run hook");
      manager.progress("token=secret https://user:password@example.com/?token=secret");
      manager.progress("-----BEGIN OPENSSH PRIVATE KEY-----");
      manager.progress("sensitive-key-body");
      manager.progress("-----END OPENSSH PRIVATE KEY-----");
    });

    const [record] = manager.list(owner.profileId);

    expect(record?.state).toBe("succeeded");
    expect(record?.output).toContain("[redacted]");
    expect(record?.output).not.toContain("secret");
    expect(record?.output).not.toContain("sensitive-key-body");
    expect(manager.list("other")).toEqual([]);

    await manager.run(owner, "Bounded", async () => {
      manager.progress("x".repeat(100_000));
    });
    expect(manager.list(owner.profileId)[0]?.output.length).toBeLessThanOrEqual(16_000);
  });

  it("cancels only the originating profile and records an interrupted outcome without claiming rollback", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = manager.run(owner, "Stage", async () => {
      await waiting;
      manager.started("stage");
    });
    const id = manager.list(owner.profileId)[0]!.id;

    expect(() => manager.cancel("other", id)).toThrow();

    manager.cancel(owner.profileId, id);
    release();
    await expect(work).rejects.toMatchObject({ kind: "cancelled" });
    expect(manager.list(owner.profileId)[0]).toMatchObject({
      state: "interrupted",
      cancellable: false,
      retryable: false,
    });
    expect(manager.list(owner.profileId)[0]?.recovery).toContain("does not undo");
  });

  it("retains failure output and retries only an explicitly supplied safe action", async () => {
    let retried = 0;

    await expect(
      manager.run(
        owner,
        "Stage",
        async () => {
          throw new GitError(
            errorFixture({
              kind: "lock-contention",
              operation: "stage",
              message: "Index locked",
              rawStderr: "password=hidden",
              exitCode: 128,
            }),
          );
        },
        async () => {
          retried += 1;
        },
      ),
    ).rejects.toThrow();

    const [record] = manager.list(owner.profileId);

    expect(record).toMatchObject({ state: "failed", retryable: true, exitCode: 128 });
    expect(record?.output).not.toContain("hidden");
    await expect(manager.retry("other", record!.id)).rejects.toThrow();

    await manager.retry(owner.profileId, record!.id);
    expect(retried).toBe(1);
    expect(manager.list(owner.profileId)[0]?.retryable).toBe(false);
  });

  it("reconciles unfinished work on restart and never resumes writes automatically", async () => {
    await manager.run(owner, "Stage", async () => {});

    const record = manager.list(owner.profileId)[0]!;

    store.save({ ...record, state: "running", cancellable: true, retryable: true });

    const restarted = new OperationManager(store);

    expect(restarted.list(owner.profileId)[0]).toMatchObject({
      state: "interrupted",
      retryable: false,
      cancellable: false,
    });
  });
});
