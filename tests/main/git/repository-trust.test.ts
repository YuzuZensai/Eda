import { RepositoryTrustStore } from "@main/persistence/repository-trust-store";
import { expect, it, vi } from "vitest";
import { access, mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openInMemoryDatabase } from "@main/persistence/database";
import { RepositoryTrust } from "@main/git/security/repository-trust";
import { NodeProcessRunner } from "@main/git/execution/node-process-runner";
import { GitService } from "@main/git/git-service";
import { createTempRepo, resolveTestGitEngine } from "../../helpers/temp-repo";
import { RepositoryVolumeIdentity } from "@main/git/security/repository-volume";
import { FakeProcessRunner } from "../../helpers/fake-process-runner";
import type * as Fs from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return { ...fs, stat: vi.fn(fs.stat) };
});

it("keeps repository approval across reboot device-number changes while rejecting replacement metadata or volumes", async () => {
  const repo = await createTempRepo();
  const db = openInMemoryDatabase();
  try {
    const info = await stat(repo.path, { bigint: true });
    vi.mocked(stat).mockResolvedValue(info);
    const volume = (uuid = "cd699f81-2b43-4792-a146-6d38574df622") =>
      new RepositoryVolumeIdentity(
        new FakeProcessRunner()
          .on(["-P"], { stdout: "Filesystem Mounted on\n/dev/disk3s1 /data\n" })
          .on(["info"], { stdout: `<key>VolumeUUID</key><string>${uuid}</string>` }),
        "darwin",
      );

    const store = new RepositoryTrustStore(db);
    const confirm = vi.fn(async () => true);
    await new RepositoryTrust(store, confirm, repo.home, volume()).authorize(repo.path);

    info.dev += 1n;
    const restarted = new RepositoryTrust(
      new RepositoryTrustStore(db),
      confirm,
      repo.home,
      volume(),
    );
    await expect(restarted.checked(repo.path)).resolves.toMatchObject({
      root: await realpath(repo.path),
    });
    await restarted.authorize(repo.path);
    expect(confirm).toHaveBeenCalledTimes(1);

    info.ino += 1n;
    await expect(restarted.checked(repo.path)).rejects.toThrow();
    info.ino -= 1n;
    info.birthtimeNs += 1n;
    await expect(restarted.checked(repo.path)).rejects.toThrow();
    info.birthtimeNs -= 1n;
    await expect(
      new RepositoryTrust(
        store,
        confirm,
        repo.home,
        volume("cd699f81-2b43-4792-a146-6d38574df623"),
      ).checked(repo.path),
    ).rejects.toThrow();
  } finally {
    vi.mocked(stat).mockReset();
    db.close();
    await repo.cleanup();
  }
});

it("blocks repository-selected programs before approval, including on background reads and directory replacement", async () => {
  const repo = await createTempRepo();
  const db = openInMemoryDatabase();
  try {
    await repo.writeFile(".gitattributes", "*.sample filter=fixture\n");
    await repo.writeFile("run.sample", "contents");
    await repo.run(["config", "filter.fixture.clean", "echo executed > marker; cat"]);
    const confirm = vi.fn(async () => false);
    const trust = new RepositoryTrust(
      new RepositoryTrustStore(db),
      confirm,
      repo.home,
      new RepositoryVolumeIdentity(new FakeProcessRunner(), "win32"),
    );
    const runner = new NodeProcessRunner();
    const git = new GitService(
      runner,
      await resolveTestGitEngine(),
      {
        HOME: repo.home,
        GIT_CONFIG_GLOBAL: join(repo.home, ".gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
      },
      undefined,
      trust,
    );
    expect(await git.isRepository(repo.path)).toBe(false);
    await expect(git.stageAll(repo.path)).rejects.toThrow();
    expect(confirm).not.toHaveBeenCalled();
    await expect(trust.authorize(repo.path)).rejects.toThrow();
    await expect(access(join(repo.path, "marker"))).rejects.toThrow();
    confirm.mockResolvedValue(true);
    await trust.authorize(repo.path);
    expect(await git.isRepository(repo.path)).toBe(true);
    await git.stageAll(repo.path);
    await access(join(repo.path, "marker"));
    await rename(join(repo.path, ".git"), join(repo.path, "old-metadata"));
    await mkdir(join(repo.path, ".git"));
    await expect(git.status(repo.path)).rejects.toThrow();
    await rename(repo.path, join(repo.home, "moved"));
    expect(await git.isRepository(repo.path)).toBe(false);
    await writeFile(repo.path, "replaced by a regular file");
    expect(await git.isRepository(repo.path)).toBe(false);
    await expect(git.status(repo.path)).rejects.toMatchObject({ kind: "not-a-repository" });
    expect(confirm).toHaveBeenCalledTimes(2);
  } finally {
    db.close();
    await repo.cleanup();
  }
});
