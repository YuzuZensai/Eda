import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import { unsupportedRepositoryFormat } from "../execution/error-mapping";
import { buildGitEnvironment } from "../execution/environment";
import type { GitEngine } from "../execution/git-engine";
import { runGitProcess, type ProcessRunner } from "../execution/process-runner";

export interface RepositoryExecution {
  reasons: string[];
  restrictions: string[];
  blocksWrites: boolean;
}

export class RepositoryExecutionInspector {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly engine: GitEngine,
    private readonly environment: Readonly<Record<string, string>>,
  ) {}

  async inspect(
    root: string,
    commonDir: string,
    signal?: AbortSignal,
    revision = "HEAD",
  ): Promise<RepositoryExecution> {
    const env = buildGitEnvironment({
      overrides: { ...this.engine.environment, ...this.environment },
    });
    const run = async (args: string[], stdin?: string) => {
      const result = await runGitProcess(
        this.runner,
        {
          executable: this.engine.path,
          args: ["--no-pager", "-c", "core.fsmonitor=false", ...args],
          cwd: root,
          signal: signal ?? AbortSignal.timeout(10_000),
          env: { ...env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
          ...(stdin !== undefined && { stdin }),
          maxStdoutBytes: 8 * 1024 * 1024,
          maxStderrBytes: 64 * 1024,
        },
        t("operations.openRepository"),
        root,
      );
      if (result.cancelled || result.outputLimitExceeded || result.exitCode !== 0)
        throw new GitError({
          kind: "invalid-input",
          operation: t("operations.openRepository"),
          message: errorText(
            unsupportedRepositoryFormat.test(result.stderr.toString("utf8"))
              ? "repositoryFormat.unsupported"
              : "main.repositoryTrust.inspectionFailed",
          ),
        });
      return result.stdout.toString("utf8");
    };
    // Git's combined listing includes per-worktree configuration when its optional file exists.
    const fields = (await run(["config", "--null", "--list", "--includes", "--show-scope"])).split(
      "\0",
    );
    const config: { key: string; value: string; local: boolean }[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const entry = fields[i + 1]!;
      const split = entry.indexOf("\n");
      config.push({
        key: split < 0 ? entry : entry.slice(0, split),
        value: split < 0 ? "" : entry.slice(split + 1),
        local: fields[i] === "local" || fields[i] === "worktree",
      });
    }
    const reasons = new Set<string>();
    const executableKey =
      /^(?:core\.(?:sshcommand|gitproxy|alternaterefscommand|fsmonitor)|credential(?:\..+)?\.helper|gpg(?:\..+)?\.program|diff\..+\.(?:command|textconv)|merge\..+\.driver|filter\..+\.(?:clean|smudge|process)|remote\..+\.(?:uploadpack|receivepack|vcs)|uploadpack\.packobjectshook|hook\..+\.command)$/;
    for (const { key, local } of config) {
      if (local && executableKey.test(key.toLowerCase())) reasons.add(key);
    }
    const restrictions = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
    const filters = new Set<string>();
    const merges = new Set<string>();
    for (const { key, value } of config) {
      if (/^hook\..+\.command$/.test(key) && value) {
        reasons.add(key);
        restrictions.push("-c", `${key.slice(0, -"command".length)}enabled=false`);
      }
      if (/^gpg(?:\..+)?\.program$/.test(key) && reasons.has(key))
        restrictions.push("-c", `${key}=/dev/null`);
      if (/^core\.alternaterefscommand$/.test(key)) restrictions.push("-c", `${key}=`);
      const filter = /^filter\.(.+)\.(clean|smudge|process)$/.exec(key);
      if (filter && value) filters.add(filter[1]!);
      const merge = /^merge\.(.+)\.driver$/.exec(key);
      if (merge && value) merges.add(merge[1]!);
    }
    for (const name of filters)
      for (const key of ["clean", "smudge", "process", "required"])
        restrictions.push("-c", `filter.${name}.${key}=${key === "required" ? "false" : ""}`);
    for (const name of merges) restrictions.push("-c", `merge.${name}.driver=false`);

    const sources: (string | null)[] = [];
    if (filters.size > 0 || merges.size > 0 || config.some(({ key }) => key === "core.hookspath")) {
      // Check both the incoming commit and the current index/worktree. No checkout or filter runs here.
      const head = await runGitProcess(
        this.runner,
        {
          executable: this.engine.path,
          args: ["rev-parse", "--verify", "--end-of-options", `${revision}^{tree}`],
          cwd: root,
          signal: signal ?? AbortSignal.timeout(10_000),
          env,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
        },
        t("operations.openRepository"),
        root,
      );
      if (head.cancelled || head.outputLimitExceeded || ![0, 128].includes(head.exitCode))
        throw new GitError({
          kind: "invalid-input",
          operation: t("operations.openRepository"),
          message: errorText("main.repositoryTrust.inspectionFailed"),
        });
      const bare = (await run(["rev-parse", "--is-bare-repository"])).trim() === "true";
      if (head.exitCode === 0) sources.push(head.stdout.toString("utf8").trim());
      if (!bare) sources.push(null);
    }
    const incomingPaths = new Set<string>();
    let blocksWrites = reasons.size > 0;
    for (const source of sources) {
      const files = source
        ? await run(["ls-tree", "-r", "--name-only", "-z", source])
        : await run(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
      if (source) for (const path of files.split("\0").filter(Boolean)) incomingPaths.add(path);
      if (!files) continue;
      const attributes = (
        await run(
          [
            "check-attr",
            ...(source ? [`--source=${source}`] : []),
            "-z",
            "--stdin",
            "filter",
            "merge",
          ],
          files,
        )
      ).split("\0");
      for (let i = 0; i + 2 < attributes.length; i += 3) {
        const kind = attributes[i + 1];
        const name = attributes[i + 2]!;
        if ((kind === "filter" && filters.has(name)) || (kind === "merge" && merges.has(name))) {
          reasons.add(`${kind}.${name}`);
          blocksWrites = true;
        }
      }
    }
    const configuredHooks = config.filter(({ key }) => key === "core.hookspath").at(-1)?.value;
    const selectedHooks = configuredHooks
      ? resolve(
          root,
          (await run(["config", "--path", "--get", "core.hooksPath"])).replace(/\r?\n$/, ""),
        )
      : join(commonDir, "hooks");
    const hooks = await realpath(selectedHooks).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return selectedHooks;
      throw error;
    });
    const within = relative(root, hooks);
    if (
      !configuredHooks ||
      (!isAbsolute(within) && within !== ".." && !within.replaceAll("\\", "/").startsWith("../")) ||
      config.some(({ key, local }) => local && key === "core.hookspath")
    ) {
      const entries = await readdir(hooks, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
          throw error;
        },
      );
      if (entries.length > 256)
        throw new GitError({
          kind: "invalid-input",
          operation: t("operations.openRepository"),
          message: errorText("main.repositoryTrust.inspectionFailed"),
        });
      const prefix = relative(root, hooks).replaceAll("\\", "/") + "/";
      for (const path of incomingPaths)
        if (path.startsWith(prefix) && !path.endsWith(".sample")) reasons.add(path);
      for (const entry of entries) {
        if (entry.name.endsWith(".sample") || entry.isDirectory()) continue;
        const info = await stat(join(hooks, entry.name));
        if (info.isFile() && (process.platform === "win32" || (info.mode & 0o111) !== 0))
          reasons.add(`hooks/${entry.name}`);
      }
    } else {
      // User-owned hooks outside the repository remain trusted.
      restrictions.splice(0, 2);
    }
    return { reasons: [...reasons].sort(), restrictions, blocksWrites };
  }
}
