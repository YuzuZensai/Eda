import { createTempRepo } from "../../helpers/temp-repo";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SshService } from "@main/ssh/ssh-service";
import { NodeProcessRunner } from "@main/git/execution/node-process-runner";

describe("history visibility and inspection", () => {
  it("reads the original commit message with line breaks and trailers intact", async () => {
    const repo = await createTempRepo();

    try {
      const message =
        "Subject line\nContinued subject\n\nBody paragraph.\n\nSigned-off-by: Eda <test@eda.invalid>\n";
      await repo.writeFile("file.txt", "base\n");
      await repo.commit(message);
      const oid = (await repo.run(["rev-parse", "HEAD"])).trim();
      const tree = (await repo.run(["rev-parse", "HEAD^{tree}"])).trim();
      await repo.run(["notes", "add", "-m", "Separate Git note", oid]);

      expect(await repo.git.commitMessage(repo.path, oid)).toBe(message);
      await expect(repo.git.commitMessage(repo.path, tree)).rejects.toThrow();
    } finally {
      await repo.cleanup();
    }
  });

  it("filters by a reference even when a working-tree path has the same name", async () => {
    const repo = await createTempRepo();

    try {
      await repo.writeFile("file.txt", "base\n");
      await repo.commit("Base");
      const head = (await repo.run(["rev-parse", "HEAD"])).trim();
      await repo.writeFile("refs/heads/main", "not a revision\n");

      expect(
        (await repo.git.history(repo.path, { refs: ["refs/heads/main"] })).commits.map(
          (commit) => commit.oid,
        ),
      ).toEqual([head]);
    } finally {
      await repo.cleanup();
    }
  });

  it("hides internal history and badges by default, and includes them when all refs are requested", async () => {
    const repo = await createTempRepo();

    try {
      await repo.writeFile("file.txt", "base\n");
      await repo.commit("Base");
      const base = (await repo.run(["rev-parse", "HEAD"])).trim();
      const tree = (await repo.run(["rev-parse", "HEAD^{tree}"])).trim();
      const namespaces = [
        "t3/checkpoints",
        "eda/recovery",
        "notes",
        "original/refs/heads",
        "replace",
        "bisect",
        "rewritten",
        "worktree",
        "keep-around",
        "pipelines",
        "pull/1",
        "merge-requests/1",
        "changes/01/1",
        "gitbutler",
        "custom-tool",
      ];
      const internal: string[] = [];
      for (const namespace of namespaces) {
        const oid = (await repo.run(["commit-tree", tree, "-p", base, "-m", namespace])).trim();
        await repo.run(["update-ref", `refs/${namespace}/snapshot`, oid]);
        internal.push(oid);
      }
      await repo.run(["update-ref", "refs/t3/shared", base]);
      await repo.run(["config", "log.initialDecorationSet", "all"]);
      const before = await repo.run(["show-ref"]);
      const normal = await repo.git.history(repo.path);

      expect(normal.commits.map((commit) => commit.oid)).toEqual([base]);
      expect(normal.commits[0]!.decorations).toEqual([
        { type: "head", name: "main", target: "refs/heads/main" },
      ]);

      const all = await repo.git.history(repo.path, { showInternalRefs: true });
      expect(all.commits.map((commit) => commit.oid).sort()).toEqual([base, ...internal].sort());
      expect(all.commits.find((commit) => commit.oid === base)!.decorations).toContainEqual({
        type: "ref",
        name: "refs/t3/shared",
      });

      const paged: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = await repo.git.history(repo.path, {
          showInternalRefs: true,
          offset,
          limit: 2,
        });
        paged.push(...page.commits.map((commit) => commit.oid));
        offset = page.nextOffset;
      }
      expect(paged).toEqual(all.commits.map((commit) => commit.oid));

      await repo.run(["branch", "shared", internal[0]!]);
      await repo.run(["update-ref", "refs/remotes/origin/shared", internal[1]!]);
      await repo.run(["tag", "shared", internal[2]!]);
      expect(
        (await repo.git.history(repo.path)).commits.map((commit) => commit.oid).sort(),
      ).toEqual([base, ...internal.slice(0, 3)].sort());
      await repo.run(["branch", "-D", "shared"]);
      await repo.run(["update-ref", "-d", "refs/remotes/origin/shared"]);
      await repo.run(["tag", "-d", "shared"]);
      expect(await repo.run(["show-ref"])).toBe(before);
      expect(await repo.run(["status", "--porcelain"])).toBe("");
    } finally {
      await repo.cleanup();
    }
  });

  it("returns empty history for an unborn repository in either reference view", async () => {
    const repo = await createTempRepo();
    try {
      for (const showInternalRefs of [false, true])
        expect(await repo.git.history(repo.path, { showInternalRefs })).toEqual({
          commits: [],
          nextOffset: null,
        });
    } finally {
      await repo.cleanup();
    }
  });

  it("detects signature headers and preserves commit details when the verifier is unavailable", async () => {
    const repo = await createTempRepo();

    try {
      await repo.writeFile("file.txt", "base\n");
      await repo.commit("Unsigned commit\n\ngpgsig -----BEGIN SSH SIGNATURE-----");
      const unsigned = (await repo.run(["rev-parse", "HEAD"])).trim();
      expect((await repo.git.inspectCommit(repo.path, unsigned)).signed).toBe(false);
      expect((await repo.git.commitSignature(repo.path, unsigned)).status).toBe("unsigned");

      const key = join(repo.home, "signing-key");
      await new SshService(new NodeProcessRunner(), repo.home).generateKey({
        path: key,
        type: "ed25519",
        comment: "Eda",
      });
      await repo.run([
        "-c",
        "gpg.format=ssh",
        "-c",
        `user.signingkey=${key}`,
        "commit",
        "--allow-empty",
        "-S",
        "-m",
        "Signed commit",
      ]);
      const signed = (await repo.run(["rev-parse", "HEAD"])).trim();
      await repo.run(["config", "gpg.ssh.program", join(repo.home, "missing-verifier")]);
      const inspection = await repo.git.inspectCommit(repo.path, signed);
      expect(inspection.signed).toBe(true);
      expect(inspection.signature.status).toBe("unverified");
      expect(await repo.git.commitSignature(repo.path, signed)).toEqual(inspection.signature);
      await expect(repo.git.commitSignature(repo.path, "--all")).rejects.toThrow();
      expect((await repo.git.inspectCommit(repo.path, unsigned)).signed).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("shows older stashes and their snapshot topology across pages without changing refs or files", async () => {
    const repo = await createTempRepo();

    try {
      await repo.writeFile("file.txt", "base\n");
      await repo.commit("Base");

      const base = (await repo.run(["rev-parse", "HEAD"])).trim();

      await repo.writeFile("file.txt", "staged\n");
      await repo.run(["add", "file.txt"]);
      await repo.writeFile("file.txt", "working\n");
      await repo.writeFile("new.txt", "untracked\n");
      await repo.run(["stash", "push", "-u", "-m", "Older work"]);

      const older = (await repo.run(["rev-parse", "stash@{0}"])).trim();

      await repo.writeFile("file.txt", "newer\n");
      await repo.run(["stash", "push", "-m", "Newer work"]);

      const saved = await repo.run(["stash", "list"]);
      const visible = await repo.git.history(repo.path, { showStashes: true });

      expect(visible.commits.find((commit) => commit.oid === older)?.stashLabels).toEqual([
        "stash@{1}: On main: Older work",
      ]);

      const parents = (await repo.run(["show", "-s", "--format=%P", older])).trim().split(" ");

      expect(visible.commits.find((commit) => commit.oid === older)?.parents).toEqual(parents);
      expect(visible.commits.find((commit) => commit.oid === parents[1])?.stashLabels).toContain(
        "stash@{1}: staged snapshot",
      );
      expect(visible.commits.find((commit) => commit.oid === parents[2])?.stashLabels).toEqual([
        "stash@{1}: untracked snapshot",
      ]);

      const paged: string[] = [];
      let offset: number | null = 0;

      while (offset !== null) {
        const page = await repo.git.history(repo.path, { showStashes: true, offset, limit: 2 });
        paged.push(...page.commits.map((commit) => commit.oid));
        offset = page.nextOffset;
      }

      expect(paged).toEqual(visible.commits.map((commit) => commit.oid));
      expect(
        (await repo.git.history(repo.path, { showStashes: false })).commits.map(
          (commit) => commit.oid,
        ),
      ).toEqual([base]);
      expect(await repo.run(["stash", "list"])).toBe(saved);
      expect(await repo.run(["status", "--porcelain"])).toBe("");
    } finally {
      await repo.cleanup();
    }
  });

  it("handles independent roots and explicitly reports shallow history", async () => {
    const repo = await createTempRepo();

    try {
      await repo.writeFile("main.txt", "one");
      await repo.commit("First root");
      await repo.writeFile("main.txt", "two");
      await repo.commit("Main tip");

      const clone = join(repo.home, "shallow");

      await repo.run(["clone", "--depth=1", pathToFileURL(repo.path).href, clone], repo.home);

      const shallow = await repo.git.history(clone);

      expect(shallow.commits).toHaveLength(1);
      expect((await repo.git.inspectCommit(clone, shallow.commits[0]!.oid)).shallow).toBe(true);

      await repo.run(["switch", "--orphan", "other-root"]);
      await repo.writeFile("other.txt", "independent");
      await repo.commit("Other root");

      const history = await repo.git.history(repo.path);

      expect(history.commits.filter((commit) => !commit.parents.length)).toHaveLength(2);
    } finally {
      await repo.cleanup();
    }
  });

  it("includes detached commits, filters ancestry, and reports containing references", async () => {
    const repo = await createTempRepo();

    try {
      await repo.writeFile("file.txt", "root\n");
      await repo.commit("Root");

      const root = (await repo.run(["rev-parse", "HEAD"])).trim();

      await repo.run(["switch", "-c", "side"]);
      await repo.writeFile("side.txt", "side\n");
      await repo.commit("Side");

      const side = (await repo.run(["rev-parse", "HEAD"])).trim();

      await repo.run(["switch", "main"]);
      await repo.writeFile("main.txt", "main\n");
      await repo.commit("Main");

      const solo = await repo.git.history(repo.path, { refs: ["refs/heads/side"] });

      expect(solo.commits.map((commit) => commit.subject)).toEqual(["Side", "Root"]);

      const hidden = await repo.git.history(repo.path, { hiddenRefs: ["refs/heads/side"] });

      expect(hidden.commits.some((commit) => commit.oid === side)).toBe(false);

      const details = await repo.git.inspectCommit(repo.path, root);

      expect(details.containingRefs).toEqual(["refs/heads/main", "refs/heads/side"]);
      expect(details.commit.parents).toEqual([]);
      expect(details.shallow).toBe(false);

      await repo.run(["merge", "side", "--no-ff", "--no-edit"]);

      const merged = (await repo.run(["rev-parse", "HEAD"])).trim();

      expect(
        (await repo.git.commitDiff(repo.path, merged)).files.map((file) => file.newPath),
      ).toEqual(["side.txt"]);

      await repo.run(["switch", "--detach", side]);
      await repo.writeFile("detached.txt", "detached\n");
      await repo.commit("Detached");

      const detached = (await repo.run(["rev-parse", "HEAD"])).trim();

      expect(
        (await repo.git.history(repo.path)).commits.some((commit) => commit.oid === detached),
      ).toBe(true);
      expect((await repo.git.inspectCommit(repo.path, detached)).containingRefs).toEqual([]);
      await expect(repo.git.history(repo.path, { refs: ["--output=bad"] })).rejects.toThrow();
      await expect(repo.git.inspectCommit(repo.path, "--all")).rejects.toThrow();
    } finally {
      await repo.cleanup();
    }
  });
});
