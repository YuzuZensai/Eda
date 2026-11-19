import { afterEach, beforeEach, expect, it } from "vitest";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { OperationRepository } from "@main/persistence/operation-repository";
import { ContentRecoveryRepository } from "@main/persistence/content-recovery-repository";
import { FetchHistoryRepository } from "@main/persistence/fetch-history-repository";
import { WorkflowJournal } from "@main/persistence/workflow-journal";
import {
  contentRecovery,
  fetchHistory,
  operations,
  repositories,
  workflowJournal,
} from "@main/persistence/schema";
import type { Database } from "@main/persistence/types";

let db: Database;
let profileId: string;
beforeEach(() => {
  db = openInMemoryDatabase();
  profileId = new IdentityRepository(db).create({
    name: "Work",
    gitName: "Author",
    gitEmail: "a@example.com",
    hue: 210,
    signing: { format: "none", signCommits: false },
  }).id;
  db.insert(repositories)
    .values({ id: "repo", identityId: profileId, name: "repo", path: "/repo", createdAt: "now" })
    .run();
});
afterEach(() => db.close());

it("preserves unsupported operation records during startup recovery and pruning", () => {
  db.insert(operations)
    .values({
      id: "future",
      profileId,
      version: 2,
      updatedAt: "2000-01-01T00:00:00.000Z",
      record: '{"future":"keep"}',
    })
    .run();
  const store = new OperationRepository(db);
  store.recover();
  store.prune(profileId);
  expect(store.list(profileId)[0]).toMatchObject({ state: "interrupted", output: "" });
  expect(db.select().from(operations).get()).toMatchObject({
    version: 2,
    record: '{"future":"keep"}',
  });
});

it("preserves unreadable recovery records without breaking lists or deleting another record", () => {
  const store = new ContentRecoveryRepository(db);
  const record = {
    id: "snapshot",
    profileId,
    repositoryId: "repo",
    root: "/repo",
    createdAt: "2000-01-01T00:00:00.000Z",
    state: "completed" as const,
    bytes: 0,
    paths: [],
    files: [],
  };
  store.save(record);
  db.update(contentRecovery).set({ version: 2 }).run();
  expect(store.get(profileId, "repo", record.id)).toBeUndefined();
  expect(store.list(profileId, "repo")).toEqual([]);
  store.prune(profileId, "repo");
  expect(db.select().from(contentRecovery).get()?.version).toBe(2);

  db.update(contentRecovery)
    .set({ version: 1, value: JSON.stringify({ ...record, id: "another-row" }) })
    .run();
  expect(store.get(profileId, "repo", record.id)).toBeUndefined();
  expect(store.list(profileId, "repo")).toEqual([]);
  store.prune(profileId, "repo");
  expect(db.select().from(contentRecovery).all()).toHaveLength(1);

  db.raw.exec("PRAGMA ignore_check_constraints = ON");
  db.update(contentRecovery).set({ value: "broken" }).run();
  db.raw.exec("PRAGMA ignore_check_constraints = OFF");
  expect(store.get(profileId, "repo", record.id)).toBeUndefined();
  expect(store.list(profileId, "repo")).toEqual([]);
  expect(db.select().from(contentRecovery).get()?.value).toBe("broken");
});

it("keys fetch history by profile, repository, remote, and URL without storing credential URLs", () => {
  const store = new FetchHistoryRepository(db);
  const url = "https://private-token@example.test/repo.git";
  store.record(profileId, "repo", "origin", url, 100, null);
  store.record(profileId, "repo", "origin", url, 200, "failed");
  store.record(profileId, "repo", "upstream", url, 300, null);
  store.record(profileId, "repo", "origin", "https://example.test/other.git", 400, null);
  expect(db.select().from(fetchHistory).all()).toHaveLength(3);
  expect(store.read(profileId, "repo", "origin", url)).toMatchObject({
    lastAttempt: 200,
    lastSuccess: 100,
    failures: 1,
  });
  expect(JSON.stringify(db.select().from(fetchHistory).all())).not.toContain("private-token");
  db.update(fetchHistory).set({ version: 2 }).run();
  expect(store.read(profileId, "repo", "origin", url)).toBeNull();
});

it("ignores inconsistent workflow payload ownership without losing the stored record", () => {
  const profile = new IdentityRepository(db).findById(profileId)!;
  const record = {
    id: "some-other-row",
    profileId,
    repositoryId: "repo",
    root: "/repo",
    updatedAt: "now",
    version: 1,
    identity: profile,
    workflowToken: "token",
    tree: "tree",
    message: "message",
    state: "prepared",
    mode: "reset",
    refChange: { commonDirectory: "/repo/.git" },
  };
  db.insert(workflowJournal)
    .values({
      id: "actual-row",
      profileId,
      repositoryId: "repo",
      updatedAt: "now",
      record: JSON.stringify(record),
    })
    .run();
  const store = new WorkflowJournal(db);
  expect(store.historyActions("/repo")).toEqual([]);
  expect(store.historyActions("/repo", "/repo/.git")).toEqual([]);
  expect(store.latest(profileId, "repo")).toBeUndefined();
  expect(db.select().from(workflowJournal).all()).toHaveLength(1);
});

it.each([
  { recovery: { unexpected: "object" } },
  { exitCode: "failure" },
  { kindKey: "unknown.translation" },
  { durationMs: -1 },
])("uses a safe fallback for malformed operation fields: %j", (invalid) => {
  const record = JSON.stringify({
    id: "damaged",
    profileId,
    repositoryId: "repo",
    repositoryName: "repo",
    kind: "fetch",
    state: "succeeded",
    startedAt: "now",
    updatedAt: "now",
    durationMs: 0,
    output: "",
    message: "done",
    cancellable: false,
    retryable: false,
    ...invalid,
  });
  db.insert(operations)
    .values({ id: "damaged", profileId, version: 1, updatedAt: "now", record })
    .run();
  expect(new OperationRepository(db).list(profileId)[0]).toMatchObject({
    state: "interrupted",
    output: "",
  });
  expect(db.select().from(operations).get()?.record).toBe(record);
});

it.each([
  { paths: [42] },
  { files: [null] },
  { files: [{ path: "file", content: 42, mode: 420, hash: "hash", tracked: true }] },
  { savedIndex: [{ path: "file", stage: 4, mode: "100644", content: "" }] },
  { after: { file: 42 } },
  { indexVersions: [{ path: "file", stage: "0", mode: "100644" }] },
])("rejects malformed recovery payloads without deleting their evidence: %j", (invalid) => {
  const record = {
    id: "damaged-snapshot",
    profileId,
    repositoryId: "repo",
    root: "/repo",
    createdAt: "2000-01-01T00:00:00.000Z",
    state: "completed",
    bytes: 0,
    paths: ["file"],
    files: [],
    ...invalid,
  };
  db.insert(contentRecovery)
    .values({
      id: record.id,
      profileId,
      repositoryId: "repo",
      version: 1,
      createdAt: record.createdAt,
      value: JSON.stringify(record),
    })
    .run();
  const store = new ContentRecoveryRepository(db);
  expect(store.get(profileId, "repo", record.id)).toBeUndefined();
  store.prune(profileId, "repo");
  expect(db.select().from(contentRecovery).all()).toHaveLength(1);
});
