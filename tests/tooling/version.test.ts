import { fixtureEnvironment } from "../helpers/fixture-environment.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readBuildInfo } from "../../scripts/build.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "eda-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.0.1" }));

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      env: fixtureEnvironment(root),
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Version fixture",
      "-c",
      "user.email=version@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${join(root, "no-hooks")}`,
      "commit",
      "-m",
      "Fixture",
    );
  };

  return { root, git, commit };
}

test("captures the exact commit and dirty state without changing release precedence", (t) => {
  const { root, git, commit } = fixture(t);
  git("init");
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  commit();

  const head = git("rev-parse", "HEAD");
  const clean = readBuildInfo(root);
  assert.equal(clean.commit, head);
  assert.equal(clean.dirty, false);
  assert.equal(clean.displayVersion, `0.0.1-${head.slice(0, 12)}`);

  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "app.js"), "generated");
  assert.deepEqual(readBuildInfo(root), clean);

  writeFileSync(join(root, "new.ts"), "untracked");
  assert.equal(readBuildInfo(root).dirty, true);
  rmSync(join(root, "new.ts"));

  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.0.1", name: "eda" }));
  assert.equal(readBuildInfo(root).displayVersion, `${clean.displayVersion}-dirty`);
  git("add", "package.json");
  assert.equal(readBuildInfo(root).dirty, true);
  commit();

  const next = readBuildInfo(root);
  assert.equal(next.version, clean.version);
  assert.notEqual(next.commit, head);
  assert.equal(next.dirty, false);

  const worktree = join(root, "dist", "worktree");
  git("worktree", "add", "--detach", worktree, "HEAD");
  assert.deepEqual(readBuildInfo(worktree), next);
  writeFileSync(join(worktree, "untracked.ts"), "local");
  assert.equal(readBuildInfo(worktree).dirty, true);
  assert.equal(readBuildInfo(root).dirty, false);
});

test("source archives and unborn repositories never claim an enclosing commit or clean status", (t) => {
  const { root, git, commit } = fixture(t);
  const unknown = { version: "0.0.1", displayVersion: "0.0.1-unknown", commit: null, dirty: null };
  assert.deepEqual(readBuildInfo(root), unknown);

  git("init");
  assert.deepEqual(readBuildInfo(root), unknown);
  commit();

  const archive = join(root, "archive");
  mkdirSync(archive);
  writeFileSync(join(archive, "package.json"), JSON.stringify({ version: "0.0.1" }));
  assert.deepEqual(readBuildInfo(archive), unknown);

  writeFileSync(join(archive, "package.json"), JSON.stringify({ version: "v0.0.1" }));
  assert.throws(() => readBuildInfo(archive), /semantic version/);
  writeFileSync(join(archive, "package.json"), JSON.stringify({ version: ["0.0.1"] }));
  assert.throws(() => readBuildInfo(archive), /semantic version/);
});
