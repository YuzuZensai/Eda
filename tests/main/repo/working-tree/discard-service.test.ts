import { link, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import {
  ContentRecoveryRepository,
  recoveryFileHash,
} from "@main/persistence/content-recovery-repository";
import { repositories, workflowJournal } from "@main/persistence/schema";
import { DiscardService } from "@main/repo/working-tree/discard-service";

let repo: TempRepo;

afterEach(async () => {
  if (repo) await repo.cleanup();
});

async function setup() {
  repo = await createTempRepo();

  const db = openInMemoryDatabase();
  const profile = new IdentityRepository(db).create({
    name: "Work",
    gitName: "Eda",
    gitEmail: "eda@example.com",
    hue: 210,
    signing: { format: "none", signCommits: false },
  });

  db.insert(repositories)
    .values({
      id: "r",
      identityId: profile.id,
      name: "Fixture",
      path: repo.path,
      favourite: 0,
      createdAt: "now",
    })
    .run();

  const store = new ContentRecoveryRepository(db);

  return { db, profileId: profile.id, store, service: new DiscardService(repo.git, store) };
}

it("snapshots tracked and untracked bytes, preserves the index, and restores after service restart", async () => {
  const { service, profileId, store } = await setup();

  await repo.writeFile("file.txt", "base\r\n");
  await repo.commit("initial");
  await repo.writeFile("file.txt", "staged\r\n");
  await repo.run(["add", "file.txt"]);
  await repo.writeFile("file.txt", "worktree\r\n");
  await repo.writeFile("日本語.bin", "binary\0bytes");

  const index = await repo.run(["write-tree"]);
  const preview = await service.preview(repo.path, profileId, "r", ["file.txt", "日本語.bin"]);

  expect(preview).toMatchObject({ tracked: 1, untracked: 1 });

  await service.apply(repo.path, profileId, "r", preview.token);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("staged\r\n");
  await expect(readFile(join(repo.path, "日本語.bin"))).rejects.toThrow();
  expect(await repo.run(["write-tree"])).toBe(index);

  await repo.writeFile("file.txt", "worktree\r\n");
  await repo.writeFile("日本語.bin", "newer bytes");
  await expect(
    service.restore(repo.path, profileId, "r", service.list(profileId, "r")[0]!.id),
  ).rejects.toThrow("protect newer work");
  expect(await readFile(join(repo.path, "日本語.bin"), "utf8")).toBe("newer bytes");

  await unlink(join(repo.path, "日本語.bin"));

  const restarted = new DiscardService(repo.git, store);

  await restarted.restore(repo.path, profileId, "r", restarted.list(profileId, "r")[0]!.id);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("worktree\r\n");
  expect(await readFile(join(repo.path, "日本語.bin"), "utf8")).toBe("binary\0bytes");
  expect(await repo.run(["write-tree"])).toBe(index);
});

it("refuses stale previews, cross-profile access and restoration over newer work", async () => {
  const { service, profileId } = await setup();

  await repo.writeFile("file.txt", "base");
  await repo.commit("initial");
  await repo.writeFile("file.txt", "first");

  const preview = await service.preview(repo.path, profileId, "r", ["file.txt"]);

  await expect(service.apply(repo.path, "other", "r", preview.token)).rejects.toThrow(
    "another context",
  );

  await repo.writeFile("file.txt", "second");
  await expect(service.apply(repo.path, profileId, "r", preview.token)).rejects.toThrow(
    "changed after",
  );

  const fresh = await service.preview(repo.path, profileId, "r", ["file.txt"]);

  await service.apply(repo.path, profileId, "r", fresh.token);
  await repo.writeFile("file.txt", "new external work");

  const id = service.list(profileId, "r")[0]!.id;

  await expect(service.restore(repo.path, profileId, "r", id)).rejects.toThrow(
    "protect newer work",
  );
  expect(service.list("other", "r")).toEqual([]);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("new external work");
});

it("discards one hunk with an exact reverse patch and recovers its original working bytes", async () => {
  const { service, profileId } = await setup();
  const original = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";

  await repo.writeFile("file.txt", original);
  await repo.commit("initial");

  const changed = original.replace("line 1\n", "first\n").replace("line 25\n", "second\n");

  await repo.writeFile("file.txt", changed);

  const preview = await service.previewPartial(repo.path, profileId, {
    repositoryId: "r",
    path: "file.txt",
    area: "unstaged",
    hunks: [0],
  });

  expect(preview.patch).toContain("-first");
  expect(preview.patch).not.toContain("second");

  await service.apply(repo.path, profileId, "r", preview.token);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe(
    original.replace("line 25\n", "second\n"),
  );
  expect(await repo.run(["diff", "--cached"])).toBe("");

  await service.restore(repo.path, profileId, "r", service.list(profileId, "r")[0]!.id);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe(changed);
});

it("rejects corrupted saved bytes before restoring any file and preserves the snapshot", async () => {
  const { service, profileId, store } = await setup();
  for (const path of ["first.txt", "second.txt"]) await repo.writeFile(path, "base");
  await repo.commit("initial");
  for (const path of ["first.txt", "second.txt"]) await repo.writeFile(path, "working changes");
  const preview = await service.preview(repo.path, profileId, "r", ["first.txt", "second.txt"]);
  await service.apply(repo.path, profileId, "r", preview.token);
  const id = service.list(profileId, "r")[0]!.id;
  const record = store.get(profileId, "r", id)!;
  record.files[1]!.content = Buffer.from("corrupted content").toString("base64");
  store.save(record);
  await expect(service.restore(repo.path, profileId, "r", id)).rejects.toThrow();
  for (const path of ["first.txt", "second.txt"])
    expect(await readFile(join(repo.path, path), "utf8")).toBe("base");
  expect(store.list(profileId, "r").map((entry) => entry.id)).toContain(id);
});

it("restores a tracked file without writing through a hard link outside the worktree", async () => {
  const { service, profileId } = await setup();
  await repo.writeFile("file", "base");
  await repo.commit("base");
  await repo.writeFile("file", "changes");
  const preview = await service.preview(repo.path, profileId, "r", ["file"]);
  await service.apply(repo.path, profileId, "r", preview.token);
  const external = join(repo.home, "outside");
  await link(join(repo.path, "file"), external);
  await service.restore(repo.path, profileId, "r", service.list(profileId, "r")[0]!.id);
  expect(await readFile(external, "utf8")).toBe("base");
  expect(await readFile(join(repo.path, "file"), "utf8")).toBe("changes");
});

it("restores prototype-named files and can export verified bytes from earlier snapshots", async () => {
  const { service, profileId, store } = await setup();
  await repo.writeFile("__proto__", "keep me");
  await repo.writeFile("sibling", "keep this too");
  const preview = await service.preview(repo.path, profileId, "r", ["__proto__", "sibling"]);
  await service.apply(repo.path, profileId, "r", preview.token);
  const id = service.list(profileId, "r")[0]!.id;
  const snapshot = store.get(profileId, "r", id)!;
  expect(Object.hasOwn(snapshot.after!, "__proto__")).toBe(true);
  await service.restore(repo.path, profileId, "r", id);
  expect(await readFile(join(repo.path, "__proto__"), "utf8")).toBe("keep me");

  delete snapshot.after!["__proto__"];
  store.save(snapshot);
  expect(service.savedFile(profileId, "r", id, "__proto__").toString()).toBe("keep me");
  expect(service.savedFile(profileId, "r", id, "sibling").toString()).toBe("keep this too");
  await expect(service.restore(repo.path, profileId, "r", id)).rejects.toThrow();
  expect(() => service.savedFile("another-profile", "r", id, "sibling")).toThrow();
  service.forget(profileId, "r", id);
  expect(service.list(profileId, "r")).toEqual([]);
});

it("exports earlier rewrite snapshots that recorded a symlink as a file with zero permissions", async () => {
  const { service, profileId, store } = await setup();
  const content = Buffer.from("old-link-target");
  const id = "legacy-rewrite";
  store.save({
    id,
    root: repo.path,
    profileId,
    repositoryId: "r",
    source: "rewrite-recovery",
    state: "completed",
    createdAt: new Date().toISOString(),
    paths: ["entry"],
    bytes: content.length,
    files: [
      {
        path: "entry",
        content: content.toString("base64"),
        mode: 0,
        hash: recoveryFileHash(content, 0),
        tracked: true,
      },
    ],
    after: { entry: "missing" },
  });
  expect(service.savedFile(profileId, "r", id, "entry")).toEqual(content);
  await expect(service.restore(repo.path, profileId, "r", id)).rejects.toThrow();
  await expect(readFile(join(repo.path, "entry"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("checks the original Git mode before restoring an earlier Windows rewrite snapshot", async () => {
  const { service, profileId, store, db } = await setup();
  await repo.writeFile("entry", "target");
  await repo.commit("base");
  const regularTree = (await repo.run(["write-tree"])).trim();
  const blob = (await repo.run(["rev-parse", "HEAD:entry"])).trim();
  await repo.run(["update-index", "--cacheinfo", `120000,${blob},entry`]);
  const linkTree = (await repo.run(["write-tree"])).trim();
  await unlink(join(repo.path, "entry"));
  const content = Buffer.from("target");
  for (const [id, tree] of [
    ["old-symlink", linkTree],
    ["old-regular", regularTree],
  ] as const) {
    const createdAt = new Date().toISOString();
    store.save({
      id,
      root: repo.path,
      profileId,
      repositoryId: "r",
      source: "rewrite-recovery",
      state: "completed",
      createdAt,
      paths: ["entry"],
      bytes: content.length,
      files: [
        {
          path: "entry",
          content: content.toString("base64"),
          mode: 0o666,
          hash: recoveryFileHash(content, 0o666),
          tracked: true,
        },
      ],
      after: { entry: "missing" },
    });
    expect(service.savedFile(profileId, "r", id, "entry")).toEqual(content);
    await expect(service.restore(repo.path, profileId, "r", id)).rejects.toThrow();
    db.insert(workflowJournal)
      .values({
        id,
        profileId,
        repositoryId: "r",
        updatedAt: createdAt,
        record: JSON.stringify({ root: repo.path, refChange: { snapshotId: id, indexTree: tree } }),
      })
      .run();
    if (tree === linkTree) {
      await expect(service.restore(repo.path, profileId, "r", id)).rejects.toThrow(/symlink/i);
      await expect(readFile(join(repo.path, "entry"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await service.restore(repo.path, profileId, "r", id);
      expect(await readFile(join(repo.path, "entry"))).toEqual(content);
    }
  }
});

it("rejects a rewrite snapshot with a symlink in either commit tree", async () => {
  const { service, profileId } = await setup();
  await repo.writeFile("entry", "target");
  await repo.commit("regular");
  const regular = (await repo.run(["rev-parse", "HEAD"])).trim();
  const blob = (await repo.run(["rev-parse", "HEAD:entry"])).trim();
  await repo.run(["update-index", "--cacheinfo", `120000,${blob},entry`]);
  await repo.run(["commit", "-m", "symlink"]);
  const symlink = (await repo.run(["rev-parse", "HEAD"])).trim();
  for (const [from, to] of [
    [regular, symlink],
    [symlink, regular],
  ] as const) {
    await expect(
      service.prepareTreeOperation(repo.path, profileId, "r", from, to, ["entry"]),
    ).rejects.toThrow(/symlink/i);
  }
  expect(service.list(profileId, "r")).toEqual([]);
});
