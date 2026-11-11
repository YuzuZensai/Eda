import { fixtureEnvironment } from "./fixture-environment";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitService } from "@main/git/git-service";
import {
  bundledGitBinary,
  bundledGitEnvironment,
  bundledGitLocation,
} from "@main/git/execution/bundled-git";
import { resolveGitEngine } from "@main/git/execution/git-engine";
import { NodeProcessRunner } from "@main/git/execution/node-process-runner";

export interface TempRepo {
  path: string;
  home: string;
  git: GitService;
  run(args: string[], cwd?: string): Promise<string>;
  writeFile(relativePath: string, contents: string): Promise<void>;
  commit(message: string): Promise<void>;
  cleanup(): Promise<void>;
}

const runner = new NodeProcessRunner();
const bundle = bundledGitLocation(false, fileURLToPath(new URL("../../", import.meta.url)), "");
const bundledPath = bundledGitBinary(bundle);

let enginePromise: ReturnType<typeof resolveGitEngine> | undefined;
export const resolveTestGitEngine = () =>
  (enginePromise ??= resolveGitEngine(
    runner,
    existsSync(bundledPath)
      ? { bundledPath, bundledEnvironment: bundledGitEnvironment(bundle) }
      : {},
  ));

export async function createTempRepo(
  options: { bare?: boolean; init?: boolean } = {},
): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), "eda-test-"));
  const home = join(root, "home");
  const path = join(root, "repo");

  await mkdir(home, { recursive: true });
  await mkdir(path, { recursive: true });

  const globalConfig = join(home, ".gitconfig");

  await writeFile(
    globalConfig,
    "[user]\n\tname = Eda\n\temail = test@eda.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
    "utf8",
  );

  const sandboxEnv: Record<string, string> = {
    ...fixtureEnvironment(home, {}),
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00",
  };

  const git = new GitService(runner, await resolveTestGitEngine(), sandboxEnv);

  const run = async (args: string[], cwd = path): Promise<string> => {
    const { stdout } = await git.exec(args, { cwd, operation: "test setup" });
    return stdout;
  };

  const repo: TempRepo = {
    path,
    home,
    git,
    run,
    async writeFile(relativePath, contents) {
      const target = join(path, relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, contents, "utf8");
    },
    async commit(message) {
      await run(["add", "--all"]);
      await run(["commit", "--no-gpg-sign", "-m", message]);
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };

  if (options.init !== false) {
    await run(options.bare ? ["init", "--bare", "-b", "main"] : ["init", "-b", "main"]);
  }

  return repo;
}

export async function assertHermetic(repo: TempRepo): Promise<void> {
  const email = await repo.git.readConfig("user.email", { cwd: repo.path });

  if (email !== "test@eda.invalid") {
    throw new Error(
      `Test environment is not hermetic: user.email resolved to "${email}". ` +
        "Tests must never read the real global Git config.",
    );
  }
}
