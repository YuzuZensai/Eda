import { RepositoryReader } from "@main/repo/repository-reader";
import type { GitService } from "@main/git/git-service";

import { sshReferenceRemote } from "@main/ssh/reference-host";

it("resolves a literal SSH alias only for its matching host block", () => {
  const remote = "git@work-fork:group/project.git";
  const config = "Host personal\n HostName github.com\nHost work-fork\n HostName gitlab.com";
  expect(sshReferenceRemote(remote, config)).toBe("https://gitlab.com/group/project.git");
  expect(sshReferenceRemote(remote, "Include ~/.ssh/conf.d/*\n" + config)).toBeUndefined();
  expect(sshReferenceRemote(remote, "Match exec something\n" + config)).toBeUndefined();
});

function setup() {
  const repository = { id: "repo", identityId: "profile", path: "/repo" };
  const repositories = {
    resolveActiveRepository: vi.fn((id: string) => {
      if (id !== repository.id) throw new Error("Repository is not in this profile");
      return repository;
    }),
  };
  const git = {
    status: vi.fn<GitService["status"]>(),
    exec: vi.fn<GitService["exec"]>(),
    filePatch: vi.fn<GitService["filePatch"]>(),
    compareDiff: vi.fn<GitService["compareDiff"]>(),
    remoteNames: vi.fn(async () => ["origin"]),
    readConfig: vi.fn(async (): Promise<string | undefined> => "https://github.com/owner/repo.git"),
    ignoredFiles: vi.fn(async (): Promise<string[]> => []),
    commitTemplate: vi.fn(async (): Promise<string | null> => "Subject\n\n# Details\n"),
  };
  const instances = vi.fn((_profileId: string): readonly string[] => []);

  return {
    reader: new RepositoryReader(git, repositories, instances),
    git,
    instances,
    repositories,
  };
}

it("selects the longest remote prefix and removes only that prefix from a branch link", async () => {
  const { reader, git } = setup();
  git.remoteNames.mockResolvedValue(["team", "origin", "team/project"]);

  expect(await reader.referenceUrl("repo", "remote-branch", "team/project/feature/topic")).toBe(
    "https://github.com/owner/repo/tree/feature%2Ftopic",
  );
  expect(git.readConfig).toHaveBeenCalledWith("remote.team/project.url", { cwd: "/repo" });
});

it("opens a local branch at its configured fork and upstream branch name", async () => {
  const { reader, git } = setup();
  git.remoteNames.mockResolvedValue(["origin", "fork"]);
  git.readConfig
    .mockResolvedValueOnce("fork")
    .mockResolvedValueOnce("refs/heads/published/topic")
    .mockResolvedValueOnce("git@github.com:fork/project.git");
  expect(await reader.referenceUrl("repo", "branch", "local-topic")).toBe(
    "https://github.com/fork/project/tree/published%2Ftopic",
  );
  expect(git.readConfig).toHaveBeenLastCalledWith("remote.fork.url", { cwd: "/repo" });
});

it.each([
  [["backup", "origin"], "origin"],
  [["backup", "other"], "backup"],
] as const)(
  "preserves the preferred remote for non-remote references (%j)",
  async (names, expected) => {
    const { reader, git } = setup();
    git.remoteNames.mockResolvedValue([...names]);

    expect(await reader.referenceUrl("repo", "tag", "v1")).toBe(
      "https://github.com/owner/repo/tree/v1",
    );
    expect(git.readConfig).toHaveBeenCalledWith(`remote.${expected}.url`, { cwd: "/repo" });
  },
);

it("returns no link for missing remotes, unmatched remote branches, or missing URLs", async () => {
  const { reader, git } = setup();
  git.remoteNames.mockResolvedValueOnce([]);
  expect(await reader.referenceUrl("repo", "commit", "head")).toBeNull();
  expect(await reader.referenceUrl("repo", "remote-branch", "other/main")).toBeNull();
  expect(git.readConfig).not.toHaveBeenCalled();

  git.readConfig.mockResolvedValue(undefined);
  expect(await reader.referenceUrl("repo", "branch", "main")).toBeNull();
});

it("uses only the repository profile's configured self-hosted instances", async () => {
  const { reader, git, instances } = setup();
  git.readConfig.mockResolvedValue("https://git.company.test/team/repo.git");
  expect(await reader.referenceUrl("repo", "commit", "abc")).toBeNull();

  instances.mockReturnValue(["https://git.company.test"]);
  expect(await reader.referenceUrl("repo", "commit", "abc")).toBe(
    "https://git.company.test/team/repo/-/commit/abc",
  );
  expect(instances).toHaveBeenLastCalledWith("profile");
});

it.each([5_000, 5_001])(
  "bounds ignored files and reports truncation for %i paths",
  async (count) => {
    const { reader, git } = setup();
    const paths = Array.from({ length: count }, (_, index) => `ignored-${index}`);
    git.ignoredFiles.mockResolvedValue(paths);

    expect(await reader.ignoredFiles("repo")).toEqual({
      paths: paths.slice(0, 5_000),
      truncated: count > 5_000,
    });
  },
);

it("reads the template for the resolved worktree without altering its contents", async () => {
  const { reader, git } = setup();

  expect(await reader.commitTemplate("repo")).toBe("Subject\n\n# Details\n");
  expect(git.commitTemplate).toHaveBeenCalledWith("/repo");
});

it("rejects repositories outside the current profile before reading Git or provider data", async () => {
  const { reader, git, instances } = setup();

  await expect(reader.referenceUrl("other", "branch", "main")).rejects.toThrow(
    "not in this profile",
  );
  await expect(reader.ignoredFiles("other")).rejects.toThrow("not in this profile");
  await expect(reader.commitTemplate("other")).rejects.toThrow("not in this profile");
  await expect(
    reader.compareRevisions({
      repositoryId: "other",
      left: "main",
      right: "topic",
      mode: "direct",
    }),
  ).rejects.toThrow("not in this profile");
  await expect(
    reader.comparisonDiff({
      repositoryId: "other",
      baseOid: "a".repeat(40),
      rightOid: "b".repeat(40),
      path: "file.txt",
    }),
  ).rejects.toThrow("not in this profile");
  for (const method of Object.values(git)) expect(method).not.toHaveBeenCalled();
  expect(instances).not.toHaveBeenCalled();
});

it("drops a comparison file read if the repository was relocated before Git replied", async () => {
  const { reader, git, repositories } = setup();
  git.compareDiff.mockImplementation(async () => {
    repositories.resolveActiveRepository.mockReturnValue({
      id: "repo",
      identityId: "profile",
      path: "/moved",
    });
    return { files: [] };
  });
  await expect(
    reader.comparisonDiff({
      repositoryId: "repo",
      baseOid: "a".repeat(40),
      rightOid: "b".repeat(40),
      path: "file.txt",
    }),
  ).rejects.toMatchObject({
    code: "main.repositoryManager.theRepositoryChangedRefreshAndTryAgain",
  });
});
