import { RepositoryMemberships } from "@main/persistence/repository-memberships";
import { afterEach, expect, it } from "vitest";
import { mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempRepo, type TempRepo } from "../../../helpers/temp-repo";
import { openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import { IdentityManager } from "@main/identity/identity-manager";
import { RepositoryManager } from "@main/repo/lifecycle/repository-manager";
import { RepositoryWriter } from "@main/repo/working-tree/repository-writer";
import { ConflictService } from "@main/repo/workflows/conflict-service";
import { ExternalMergeTool } from "@main/git/external-merge-tool";
import { NodeProcessRunner } from "@main/git/execution/node-process-runner";
import { SettingsRepository } from "@main/persistence/settings-repository";
import type { Database } from "@main/persistence/types";

let repo: TempRepo;
let db: Database;

afterEach(async () => {
  db?.close();
  await repo?.cleanup();
});

async function setup() {
  repo = await createTempRepo();
  db = openInMemoryDatabase();

  const identities = new IdentityRepository(db);
  const profile = identities.create({
    name: "Eda",
    gitName: "Eda",
    gitEmail: "test@eda.invalid",
    hue: 0,
    signing: { format: "none", signCommits: false },
  });

  identities.setActiveId(profile.id);

  const identity = new IdentityManager(identities, repo.git);
  const repositories = new RepositoryManager(
    new RepositoryMemberships(db),
    repo.git,
    identity,
    identities,
  );
  const writer = new RepositoryWriter(repo.git, repositories, identity, identities);
  const settings = new SettingsRepository(db);
  const service = new ConflictService(
    repo.git,
    repositories,
    writer,
    undefined,
    new ExternalMergeTool(new NodeProcessRunner()),
    settings,
  );

  const repository = await repositories.open(repo.path);

  return { service, repository, writer, identities, settings };
}

it("reviews an external tool result without touching the index and rejects stale saves after external changes", async () => {
  const { service, repository, settings } = await setup();

  await repo.writeFile("file.txt", "base\n");
  await repo.commit("base");
  await repo.run(["checkout", "-b", "incoming"]);
  await repo.writeFile("file.txt", "incoming\n");
  await repo.commit("incoming");
  await repo.run(["checkout", "main"]);
  await repo.writeFile("file.txt", "current\n");
  await repo.commit("current");
  await repo.git.exec(["merge", "incoming", "--no-edit"], {
    cwd: repo.path,
    operation: "fixture merge",
    allowedExitCodes: [1],
  });

  const script = join(repo.home, "merge tool.cjs");
  const source =
    "const fs = require('node:fs'); const [base,current,incoming,result] = process.argv.slice(2); if (fs.readFileSync(base,'utf8') !== 'base\\n') process.exit(3); fs.writeFileSync(result,fs.readFileSync(current,'utf8') + fs.readFileSync(incoming,'utf8'));";

  await writeFile(script, source);
  settings.set(
    "mergeTool",
    { kind: "application" },
    {
      executable: process.execPath,
      args: [script, "{base}", "{current}", "{incoming}", "{result}"],
    },
  );

  const review = await service.inspect(repository.id, "file.txt");
  const index = await repo.run(["ls-files", "--stage"]);
  const working = await readFile(join(repo.path, "file.txt"), "utf8");
  const result = await service.external(repository.id, review.token);

  expect(result).toEqual({ text: "current\nincoming\n", stale: false });
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe(working);
  expect(await repo.run(["ls-files", "--stage"])).toBe(index);

  await writeFile(script, "process.exit(7);");
  await expect(service.external(repository.id, review.token)).rejects.toThrow(/code 7/);
  expect(await repo.run(["ls-files", "--stage"])).toBe(index);

  await writeFile(
    script,
    source +
      ` require('node:fs').writeFileSync(${JSON.stringify(join(repo.path, "file.txt"))}, 'external edit\\n');`,
  );

  const changed = await service.external(repository.id, review.token);

  expect(changed).toEqual({ text: result.text, stale: true });
  await expect(
    service.resolve({
      repositoryId: repository.id,
      token: review.token,
      choice: "text",
      text: result.text,
      stage: true,
    }),
  ).rejects.toThrow(/changed/);
  expect(await readFile(join(repo.path, "file.txt"), "utf8")).toBe("external edit\n");

  const controller = new AbortController();

  await writeFile(script, "process.stderr.write('ready\\n'); setInterval(() => {}, 1000);");

  const cancelledTool = new ExternalMergeTool(new NodeProcessRunner(), {
    signal: controller.signal,
    progress: (line) => {
      if (line === "ready") controller.abort();
    },
  });

  await expect(
    cancelledTool.run(settings.resolve("mergeTool").value, {
      base: Buffer.from("base\n"),
      current: Buffer.from("current\n"),
      incoming: Buffer.from("incoming\n"),
      result: Buffer.from(working),
    }),
  ).rejects.toMatchObject({ kind: "cancelled" });
  expect(await repo.run(["ls-files", "--stage"])).toBe(index);

  const refreshed = await service.inspect(repository.id, "file.txt");

  await service.resolve({
    repositoryId: repository.id,
    token: refreshed.token,
    choice: "text",
    text: result.text,
    stage: true,
  });
  expect(await repo.run(["show", ":file.txt"])).toBe(result.text);
  expect(
    (await repo.git.status(repo.path)).changes.some((change) => change.kind === "unmerged"),
  ).toBe(false);
}, 30_000);

it("resolves text, rename and modify/delete conflicts without losing external edits or staging unrelated work", async () => {
  const { service, repository, writer, identities } = await setup();

  await repo.writeFile(".gitattributes", "converted.txt text eol=crlf\n");
  await repo.writeFile("converted.txt", "base\r\n");
  await repo.writeFile("text.txt", "base\r\n");
  await repo.writeFile("deleted.txt", "base");
  await repo.writeFile("renamed.txt", "shared content\n".repeat(20));
  await repo.commit("base");
  await repo.run(["checkout", "-b", "incoming"]);
  await repo.writeFile("converted.txt", "incoming\r\n");
  await repo.writeFile("text.txt", "incoming\r\n");
  await repo.writeFile("deleted.txt", "incoming");
  await repo.writeFile("added.txt", "incoming addition\n");
  await repo.run(["mv", "renamed.txt", "incoming-name.txt"]);
  await repo.commit("incoming");
  await repo.run(["checkout", "main"]);
  await repo.writeFile("converted.txt", "current\r\n");
  await repo.writeFile("text.txt", "current\r\n");
  await repo.run(["rm", "deleted.txt"]);
  await repo.writeFile("added.txt", "current addition\n");
  await repo.run(["mv", "renamed.txt", "current-name.txt"]);
  await repo.commit("current");
  await repo.git.exec(["merge", "incoming", "--no-edit"], {
    cwd: repo.path,
    operation: "create conflicts",
    allowedExitCodes: [0, 1],
  });
  await repo.writeFile("unrelated.txt", "keep untracked");

  const addition = await service.inspect(repository.id, "added.txt");

  expect(addition.base).toBeNull();

  await service.resolve({
    repositoryId: repository.id,
    token: addition.token,
    choice: "incoming",
    stage: true,
  });
  expect(await repo.run(["show", ":added.txt"])).toBe("incoming addition\n");

  for (const path of ["renamed.txt", "current-name.txt", "incoming-name.txt"]) {
    const renamed = await service.inspect(repository.id, path);

    await service.resolve({
      repositoryId: repository.id,
      token: renamed.token,
      choice: "incoming",
      stage: true,
    });
  }

  expect(await repo.run(["ls-files", "--", "renamed.txt", "current-name.txt"])).toBe("");
  expect(await repo.run(["show", ":incoming-name.txt"])).toBe("shared content\n".repeat(20));

  const converted = await service.inspect(repository.id, "converted.txt");

  await service.resolve({
    repositoryId: repository.id,
    token: converted.token,
    choice: "incoming",
    stage: true,
  });
  expect(await readFile(join(repo.path, "converted.txt"), "utf8")).toBe("incoming\r\n");
  expect(await repo.run(["show", ":converted.txt"])).toBe("incoming\n");

  const first = await service.inspect(repository.id, "text.txt");

  expect(first.base?.text).toBe("base\r\n");
  expect(first.current?.text).toBe("current\r\n");
  expect(first.incoming?.text).toBe("incoming\r\n");
  await expect(
    service.resolve({
      repositoryId: repository.id,
      token: first.token,
      choice: "worktree",
      stage: true,
    }),
  ).rejects.toThrow(/markers/);

  await repo.writeFile("text.txt", "external edit\r\n");
  await expect(
    service.resolve({
      repositoryId: repository.id,
      token: first.token,
      choice: "text",
      text: "stale",
      stage: true,
    }),
  ).rejects.toThrow(/changed after inspection/);
  expect(await readFile(join(repo.path, "text.txt"), "utf8")).toBe("external edit\r\n");

  const refreshed = await service.inspect(repository.id, "text.txt");

  await service.resolve({
    repositoryId: repository.id,
    token: refreshed.token,
    choice: "text",
    text: "resolved\n",
    stage: false,
  });
  expect(await readFile(join(repo.path, "text.txt"), "utf8")).toBe("resolved\r\n");
  expect((await repo.run(["ls-files", "--unmerged", "--", "text.txt"])).length).toBeGreaterThan(0);

  const saved = await service.inspect(repository.id, "text.txt");

  await service.resolve({
    repositoryId: repository.id,
    token: saved.token,
    choice: "worktree",
    stage: true,
  });

  const deletion = await service.inspect(repository.id, "deleted.txt");

  expect(deletion.current).toBeNull();

  const profile = identities.create({
    name: "Other context",
    gitName: "Eda",
    gitEmail: "other@eda.invalid",
    hue: 10,
    signing: { format: "none", signCommits: false },
  });

  const owner = identities.getActiveId()!;

  identities.setActiveId(profile.id);
  await expect(async () =>
    service.resolve({
      repositoryId: repository.id,
      token: deletion.token,
      choice: "current",
      stage: true,
    }),
  ).rejects.toThrow();

  identities.setActiveId(owner);
  await service.resolve({
    repositoryId: repository.id,
    token: deletion.token,
    choice: "current",
    stage: true,
  });
  expect(await repo.run(["ls-files", "--unmerged"])).toBe("");
  expect(await repo.run(["ls-files", "--", "unrelated.txt"])).toBe("");

  await writer.commit(repository.id, "resolved merge");
  expect(
    (await repo.run(["rev-list", "--parents", "-n", "1", "HEAD"])).trim().split(" "),
  ).toHaveLength(3);
}, 60_000);

// Keep this below Git's output limit so we only hit the preview limit.
it("resolves binary conflicts beyond preview limits without overwriting newer files or staging conflict markers", async () => {
  const { service, repository } = await setup();
  const largeBase = Buffer.alloc(4 * 1024 * 1024 + 32);
  const largeCurrent = Buffer.from(largeBase);
  const largeIncoming = Buffer.from(largeBase);

  largeCurrent[1] = 1;
  largeIncoming[1] = 2;
  await writeFile(join(repo.path, "large.bin"), largeBase);
  await repo.writeFile("binary.bin", "\0base");
  await repo.commit("base");
  await repo.run(["checkout", "-b", "incoming"]);
  await repo.writeFile("binary.bin", "\0incoming");
  await writeFile(join(repo.path, "large.bin"), largeIncoming);
  await repo.commit("incoming");
  await repo.run(["checkout", "main"]);
  await repo.writeFile("binary.bin", "\0current");
  await writeFile(join(repo.path, "large.bin"), largeCurrent);
  await repo.commit("current");
  await repo.git.exec(["merge", "incoming", "--no-edit"], {
    cwd: repo.path,
    operation: "create binary conflicts",
    allowedExitCodes: [1],
  });

  const binary = await service.inspect(repository.id, "binary.bin");

  expect(binary.incoming?.text).toBeNull();

  await service.resolve({
    repositoryId: repository.id,
    token: binary.token,
    choice: "incoming",
    stage: true,
  });
  expect(await readFile(join(repo.path, "binary.bin"))).toEqual(Buffer.from("\0incoming"));

  const large = await service.inspect(repository.id, "large.bin");

  expect(large.output).toBeNull();
  expect(large.incoming).toMatchObject({ bytes: largeIncoming.length, text: null });

  const changed = Buffer.from(largeCurrent);

  changed[changed.length - 1] = 7;
  await writeFile(join(repo.path, "large.bin"), changed);
  await expect(
    service.resolve({
      repositoryId: repository.id,
      token: large.token,
      choice: "incoming",
      stage: true,
    }),
  ).rejects.toThrow(/changed after inspection/);
  expect(await readFile(join(repo.path, "large.bin"))).toEqual(changed);

  await writeFile(
    join(repo.path, "large.bin"),
    `${"a".repeat(600 * 1024)}\n<<<<<<< current\nleft\n=======\nright\n>>>>>>> incoming\n`,
  );

  const freshLarge = await service.inspect(repository.id, "large.bin");

  await expect(
    service.resolve({
      repositoryId: repository.id,
      token: freshLarge.token,
      choice: "worktree",
      stage: true,
    }),
  ).rejects.toThrow(/markers/);

  await service.resolve({
    repositoryId: repository.id,
    token: freshLarge.token,
    choice: "incoming",
    stage: true,
  });
  expect(await readFile(join(repo.path, "large.bin"))).toEqual(largeIncoming);
  expect((await repo.run(["rev-parse", ":large.bin"])).trim()).toBe(freshLarge.incoming!.oid);
}, 60_000);

it("never follows linked parents and records submodule choices without modifying their folders", async () => {
  const { service, repository } = await setup();

  await repo.writeFile("base.txt", "base");
  await repo.commit("base");

  const base = (await repo.run(["rev-parse", "HEAD"])).trim();

  await repo.writeFile("base.txt", "next");
  await repo.commit("next");

  const next = (await repo.run(["rev-parse", "HEAD"])).trim();
  const folder = join(repo.path, "module");

  await mkdir(folder);
  await writeFile(join(folder, "keep.txt"), "independent submodule work");
  await repo.git.exec(["update-index", "--index-info"], {
    cwd: repo.path,
    operation: "submodule conflict fixture",
    stdin: `160000 ${base} 1\tmodule\n160000 ${base} 2\tmodule\n160000 ${next} 3\tmodule\n`,
  });

  const preview = await service.inspect(repository.id, "module");

  await service.resolve({
    repositoryId: repository.id,
    token: preview.token,
    choice: "incoming",
    stage: true,
  });
  expect(await repo.run(["ls-files", "--stage", "module"])).toContain(`160000 ${next} 0`);
  expect(await readFile(join(folder, "keep.txt"), "utf8")).toBe("independent submodule work");

  const fileVersion = (await repo.run(["rev-parse", "HEAD:base.txt"])).trim();

  await repo.git.exec(["update-index", "--index-info"], {
    cwd: repo.path,
    operation: "file and submodule conflict fixture",
    stdin: `0 ${"0".repeat(40)}\tmodule\n160000 ${base} 1\tmodule\n160000 ${next} 2\tmodule\n100644 ${fileVersion} 3\tmodule\n`,
  });

  const mixed = await service.inspect(repository.id, "module");
  const unresolved = await repo.run(["ls-files", "--stage", "--", "module"]);

  await expect(
    service.resolve({
      repositoryId: repository.id,
      token: mixed.token,
      choice: "incoming",
      stage: true,
    }),
  ).rejects.toThrow(/directory occupies/);
  expect(await repo.run(["ls-files", "--stage", "--", "module"])).toBe(unresolved);
  expect(await readFile(join(folder, "keep.txt"), "utf8")).toBe("independent submodule work");

  await rename(folder, join(repo.path, "saved-module"));

  const moved = await service.inspect(repository.id, "module");

  await service.resolve({
    repositoryId: repository.id,
    token: moved.token,
    choice: "incoming",
    stage: true,
  });
  expect(await readFile(folder, "utf8")).toBe("next");
  expect(await repo.run(["ls-files", "--stage", "--", "module"])).toContain(
    `100644 ${fileVersion} 0`,
  );
  expect(await readFile(join(repo.path, "saved-module", "keep.txt"), "utf8")).toBe(
    "independent submodule work",
  );

  await repo.run(["config", "core.symlinks", "false"]);

  const linkBlob = async (target: string) =>
    (
      await repo.git.exec(["hash-object", "-w", "--stdin"], {
        cwd: repo.path,
        operation: "symlink conflict fixture",
        stdin: target,
      })
    ).stdout.trim();

  const currentLink = await linkBlob("current-target");
  const incomingLink = await linkBlob("incoming-target");

  await repo.git.exec(["update-index", "--index-info"], {
    cwd: repo.path,
    operation: "symlink conflict fixture",
    stdin: `120000 ${currentLink} 2\tlink\n120000 ${incomingLink} 3\tlink\n`,
  });
  await repo.writeFile("link", "current-target");

  const link = await service.inspect(repository.id, "link");

  await service.resolve({
    repositoryId: repository.id,
    token: link.token,
    choice: "incoming",
    stage: false,
  });
  expect(await readFile(join(repo.path, "link"), "utf8")).toBe("incoming-target");
  expect(await repo.run(["ls-files", "--unmerged", "--", "link"])).toContain(incomingLink);

  const savedLink = await service.inspect(repository.id, "link");

  await service.resolve({
    repositoryId: repository.id,
    token: savedLink.token,
    choice: "incoming",
    stage: true,
  });
  expect(await repo.run(["ls-files", "--stage", "--", "link"])).toContain(
    `120000 ${incomingLink} 0`,
  );

  let nativeLinks = true;

  try {
    await symlink("current-target", join(repo.path, "native-probe"), "file");
    await unlink(join(repo.path, "native-probe"));
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM")
      throw error;
    nativeLinks = false;
  }

  await repo.run(["config", "core.symlinks", "true"]);
  await repo.git.exec(["update-index", "--index-info"], {
    cwd: repo.path,
    operation: "native symlink conflict fixture",
    stdin: `120000 ${currentLink} 2\tnative-link\n120000 ${incomingLink} 3\tnative-link\n`,
  });
  await repo.writeFile("native-link", "retained local resolution");

  const nativeLink = await service.inspect(repository.id, "native-link");
  const resolveNative = () =>
    service.resolve({
      repositoryId: repository.id,
      token: nativeLink.token,
      choice: "incoming",
      stage: true,
    });

  if (nativeLinks) {
    await resolveNative();
    expect(await readlink(join(repo.path, "native-link"))).toBe("incoming-target");
  } else {
    await expect(resolveNative()).rejects.toThrow(/could not install the selected symlink/);
    expect(await readFile(join(repo.path, "native-link"), "utf8")).toBe(
      "retained local resolution",
    );
    expect(await repo.run(["ls-files", "--unmerged", "--", "native-link"])).toContain(incomingLink);

    await repo.run(["config", "core.symlinks", "false"]);
    await resolveNative();
    expect(await readFile(join(repo.path, "native-link"), "utf8")).toBe("incoming-target");
  }

  expect(await repo.run(["ls-files", "--stage", "--", "native-link"])).toContain(
    `120000 ${incomingLink} 0`,
  );

  const outside = join(repo.home, "outside");

  await mkdir(outside);
  await writeFile(join(outside, "private.txt"), "do not read or write");
  await symlink(
    outside,
    join(repo.path, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(service.inspect(repository.id, "linked/private.txt")).rejects.toThrow(
    /will not follow/,
  );
  expect(await readFile(join(outside, "private.txt"), "utf8")).toBe("do not read or write");
}, 60_000);
