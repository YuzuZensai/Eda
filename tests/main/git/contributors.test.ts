import { readContributors } from "@main/git/operations/contributors";
import type { GitService } from "@main/git/git-service";
import { createTempRepo, type TempRepo } from "../../helpers/temp-repo";

let repo: TempRepo | undefined;
afterEach(async () => repo?.cleanup());

it("counts each author's commits once across branches, remotes, tags and detached HEAD", async () => {
  repo = await createTempRepo();
  await repo.writeFile("file.txt", "base\n");
  await repo.commit("Base");
  const base = (await repo.run(["rev-parse", "HEAD"])).trim();
  const commit = async (name: string, email: string, message: string, parent = base) => {
    const result = await repo!.git.exec(
      ["commit-tree", `${base}^{tree}`, "-p", parent, "-m", message],
      {
        cwd: repo!.path,
        operation: "test setup",
        env: {
          overrides: {
            GIT_AUTHOR_NAME: name,
            GIT_AUTHOR_EMAIL: email,
            GIT_COMMITTER_NAME: "Integration Bot",
            GIT_COMMITTER_EMAIL: "integration@example.test",
          },
        },
      },
    );
    return result.stdout.trim();
  };
  const alice = await commit("Alice Example", "alice@example.test", "Local author");
  const aliceAgain = await commit("Alice Example", "alice@example.test", "Another commit", alice);
  await repo.run(["branch", "alice", aliceAgain]);
  await repo.run(["update-ref", "refs/remotes/origin/alice", aliceAgain]);
  await repo.run(["tag", "alice-release", alice]);
  const otherEmail = await commit("Alice Example", "alice@other.test", "Different email");
  await repo.run(["update-ref", "refs/remotes/origin/other", otherEmail]);
  const otherName = await commit("Alice Alias", "alice@example.test", "Different name");
  await repo.run(["tag", "alias", otherName]);
  const unicode = await commit("山田 太郎", "taro@example.test", "Tag-only author");
  await repo.run(["tag", "unicode", unicode]);
  const detached = await commit("Detached Author", "detached@example.test", "Detached");
  await repo.run(["checkout", "--detach", detached]);
  const internal = await commit("Checkpoint Bot", "bot@example.test", "Internal checkpoint");
  await repo.run(["update-ref", "refs/t3/checkpoints/hidden", internal]);
  await commit("Lost Author", "lost@example.test", "Unreachable");
  await repo.writeFile(
    ".mailmap",
    "Canonical <canonical@example.test> Alice Example <alice@example.test>\n",
  );
  await repo.run(["config", "shortlog.group", "committer"]);
  await repo.run(["config", "log.mailmap", "true"]);
  const before = await repo.run(["status", "--porcelain=v2"]);
  const refs = await repo.run(["show-ref"]);

  const contributors = await readContributors(repo.git, repo.path);
  expect(contributors[0]).toEqual({
    name: "Alice Example",
    email: "alice@example.test",
    commits: 2,
  });
  expect(contributors).toHaveLength(6);
  expect(contributors).toEqual(
    expect.arrayContaining([
      { name: "Eda", email: "test@eda.invalid", commits: 1 },
      { name: "Alice Example", email: "alice@other.test", commits: 1 },
      { name: "Alice Alias", email: "alice@example.test", commits: 1 },
      { name: "山田 太郎", email: "taro@example.test", commits: 1 },
      { name: "Detached Author", email: "detached@example.test", commits: 1 },
    ]),
  );
  expect(contributors.reduce((total, author) => total + author.commits, 0)).toBe(7);
  expect(await repo.run(["status", "--porcelain=v2"])).toBe(before);
  expect(await repo.run(["show-ref"])).toBe(refs);
});

it("returns no contributors for an unborn repository", async () => {
  repo = await createTempRepo();
  expect(await readContributors(repo.git, repo.path)).toEqual([]);
});

it("finds branch authors when the current HEAD is unborn", async () => {
  repo = await createTempRepo();
  await repo.writeFile("file.txt", "base\n");
  await repo.commit("Base");
  await repo.run(["checkout", "--orphan", "empty"]);
  expect(await readContributors(repo.git, repo.path)).toEqual([
    { name: "Eda", email: "test@eda.invalid", commits: 1 },
  ]);
});

it.each([
  "not a shortlog entry\n",
  "0\tAlice <alice@example.test>\n",
  "9007199254740992\tAlice <alice@example.test>\n",
  Buffer.from([0xff]),
])("rejects malformed contributor data rather than showing partial totals (%s)", async (output) => {
  const bytes = Buffer.from(output);
  const exec = vi.fn<GitService["exec"]>().mockResolvedValue({
    stdout: bytes.toString("utf8"),
    stdoutBytes: bytes,
    stderr: "",
    exitCode: 0,
  });
  await expect(readContributors({ exec }, "/repo")).rejects.toMatchObject({
    code: "INVALID_GIT_OUTPUT",
  });
});
