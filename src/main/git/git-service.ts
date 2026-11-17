import { commitGitConfig } from "@shared/identity/identity";
import { isUtf8 } from "node:buffer";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { Identity } from "@shared/identity/identity";
import type { GitConfigEntry } from "@shared/identity/profile-session";
import {
  HISTORY_PAGE_SIZE,
  MAX_HISTORY_PAGE_SIZE,
  type CommitInspection,
  type CommitSignatureFormat,
  type CommitSignatureVerification,
  UNSIGNED_COMMIT_SIGNATURE,
  type DiffArea,
  type HistoryPage,
  type RepositoryStatus,
  type UnifiedDiff,
} from "@shared/repository/repository-read";
import { dirname, join } from "node:path";
import type { RepositoryTrust } from "./security/repository-trust";
import { existsSync } from "node:fs";
import type { OperationManager } from "../operations/operation-manager";

import { boundDiff } from "@shared/repository/diff-limits";
import type {
  BranchSummary,
  TagSummary,
  TagVerification,
} from "@shared/repository/repository-write";
import { buildGitEnvironment, type GitEnvironmentOptions } from "./execution/environment";
import { mapGitError } from "./execution/error-mapping";
import type { GitEngine } from "./execution/git-engine";
import { ProcessSpawnError, type ProcessRunner } from "./execution/process-runner";
import { readStashHistory } from "./operations/stash-history";
import { readCommitTemplate } from "./commit-template";
import { parseUnifiedDiff } from "./parsers/diff-parser";
import { LOG_ARGUMENTS, parseLog } from "./parsers/log-parser";
import { BRANCH_ARGUMENTS, TAG_ARGUMENTS, parseBranches, parseTags } from "./parsers/ref-parser";
import { commitSignatureFormat, parseCommitVerification } from "./security/commit-signature";

import { parseStatus } from "./parsers/status-parser";
import { assertFullObjectId, assertRepositoryPath, assertValidRefName } from "./validation";

const UNIFIED_DIFF_FLAGS = [
  "--no-ext-diff",
  "--no-textconv",
  "--full-index",
  "--unified=3",
] as const;

const DIFF_OUTPUT_LIMITS = { maxStdoutBytes: 32 * 1024 * 1024, maxStderrBytes: 1024 * 1024 };

export interface GitExecOptions {
  redactValues?: readonly string[];
  cwd?: string;
  operation: string;
  identityName?: string;
  env?: GitEnvironmentOptions;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  stdin?: string;
  allowedExitCodes?: readonly number[];
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

function literalPathspecs(paths: readonly string[] | undefined, operation: string): string[] {
  if (paths === undefined) return [];

  if (paths.length > 256) {
    throw new GitError({
      kind: "invalid-input",
      operation,
      message: errorText("main.git.gitService.tooManyFilePathsWereRequested"),
      suggestedAction: errorText("main.git.gitService.select256FilesOrFewer"),
    });
  }

  return paths.map((path) => {
    assertRepositoryPath(path, operation);
    return `:(literal)${path}`;
  });
}

function outputTooLarge(repositoryPath: string, operation: string): GitError {
  return new GitError({
    kind: "output-too-large",
    operation,
    repositoryPath,
    message: errorText("main.git.gitService.gitProducedMoreDiffDataThanEdaCanSafelyDisplay"),
    suggestedAction: errorText("main.git.gitService.selectFewerFilesAndTryAgain"),
  });
}

function parseOutput<T>(
  parser: (output: Buffer) => T,
  output: Buffer,
  repositoryPath: string,
  operation: string,
): T {
  try {
    return parser(output);
  } catch (error) {
    throw new GitError({
      kind: "repository-corrupt",
      operation,
      repositoryPath,
      message: errorText("main.git.gitService.gitReturnedRepositoryDataEdaCouldNotUnderstand"),
      suggestedAction: errorText(
        "main.git.gitService.checkTheRepositoryWithGitAndReportThisIfItIsHealthy",
      ),
      ...(error instanceof Error && { rawStderr: error.message }),
    });
  }
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBytes: Buffer;
}

export class GitService {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly engine: GitEngine,
    private readonly baseEnv: Readonly<Record<string, string>> = {},
    private readonly operations?: OperationManager,
    readonly trust?: RepositoryTrust,
  ) {}

  get gitVersion(): string {
    return this.engine.version;
  }

  get gitPath(): string {
    return this.engine.path;
  }

  async exec(args: readonly string[], options: GitExecOptions): Promise<GitExecResult> {
    let commandIndex = 0;
    while (args[commandIndex]?.startsWith("-")) {
      commandIndex += args[commandIndex] === "-c" || args[commandIndex] === "-C" ? 2 : 1;
    }
    const command = args[commandIndex] ?? "";
    const redact = (text: string) =>
      (options.redactValues ?? []).reduce(
        (value, secret) => (secret ? value.split(secret).join("[redacted]") : value),
        text,
      );

    this.operations?.started(options.operation);

    const signal =
      options.signal && this.operations?.signal
        ? AbortSignal.any([options.signal, this.operations.signal])
        : (options.signal ?? this.operations?.signal);

    const env = buildGitEnvironment({
      ...options.env,
      overrides: { ...this.engine.environment, ...this.baseEnv, ...options.env?.overrides },
    });

    if (this.baseEnv["SSH_AUTH_SOCK"] !== undefined) {
      // Don't let ~/.ssh/config switch away from Eda's SSH agent.
      env["SSH_AUTH_SOCK"] = this.baseEnv["SSH_AUTH_SOCK"];
      env["GIT_SSH_COMMAND"] = `${env["GIT_SSH_COMMAND"] ?? "ssh"} -o IdentityAgent=SSH_AUTH_SOCK`;
    }

    let cwd = options.cwd ?? this.trust?.neutralDirectory;
    const repositoryArgs: string[] = [];

    if (this.trust) {
      if (options.cwd) {
        if (args[0] === "init" && !(await this.trust.findRoot(options.cwd))) {
          repositoryArgs.push(
            `--git-dir=${join(options.cwd, ".git")}`,
            `--work-tree=${options.cwd}`,
            "-c",
            "init.templateDir=",
          );
        } else {
          const repository = await this.trust.checked(options.cwd, signal);
          if (!repository.trusted) {
            repositoryArgs.push(
              ...(repository.execution?.restrictions ?? ["-c", "core.hooksPath=/dev/null"]),
            );
            const readOnly = new Set([
              "status",
              "diff",
              "log",
              "show",
              "rev-parse",
              "ls-files",
              "ls-tree",
              "cat-file",
              "for-each-ref",
              "config",
              "remote",
              "check-attr",
              "symbolic-ref",
            ]);
            if (
              [
                "checkout",
                "switch",
                "reset",
                "merge",
                "rebase",
                "read-tree",
                "cherry-pick",
                "revert",
              ].includes(command)
            ) {
              for (const argument of args.slice(commandIndex + 1)) {
                if (argument === "--") break;
                if (argument.startsWith("-")) continue;
                const target = await this.trust.checked(options.cwd, signal, argument);
                if (target.execution?.blocksWrites)
                  throw new GitError({
                    kind: "invalid-input",
                    operation: options.operation,
                    message: errorText("main.repositoryTrust.writesBlocked"),
                  });
              }
            }
            if (!readOnly.has(command)) {
              for (let i = 0; i < repositoryArgs.length; i++)
                if (/^filter\..+\.required=false$/.test(repositoryArgs[i]!))
                  repositoryArgs[i] = repositoryArgs[i]!.replace(/false$/, "true");
            }
            if (repository.execution?.blocksWrites && !readOnly.has(command))
              throw new GitError({
                kind: "invalid-input",
                operation: options.operation,
                message: errorText("main.repositoryTrust.writesBlocked"),
              });
          }
          // Let Git discover the approved metadata so its native ownership check still runs.
          cwd = repository.root;
          env["GIT_CEILING_DIRECTORIES"] = dirname(repository.root);

          repositoryArgs.push(
            `--work-tree=${repository.root}`,
            "-c",
            "safe.bareRepository=explicit",
          );

          if (env["EDA_SSH_HOST_TRUST"]) repositoryArgs.push("-c", "core.hooksPath=/dev/null");
        }
      } else {
        env["GIT_CEILING_DIRECTORIES"] = dirname(this.trust.neutralDirectory);
      }
    }

    if (args[0] === "clone") {
      // An attribute in the first checkout can select a global filter that executes a tracked file.
      const remote = args[args.indexOf("--") + 1];

      if (remote?.startsWith("https://") && this.trust) {
        for (const [key, variable] of [
          ["http.sslCAInfo", "GIT_SSL_CAINFO"],
          ["http.sslBackend", ""],
        ] as const) {
          const { stdout, exitCode } = await this.exec(["config", "--get-urlmatch", key, remote], {
            operation: options.operation,
            allowedExitCodes: [0, 1],
            maxStdoutBytes: 16 * 1024,
          });

          if (exitCode === 0) {
            const value = stdout.replace(/\r?\n$/, "");
            if (variable) env[variable] = value;
            else repositoryArgs.push("-c", `${key}=${value}`);
          }
        }
      }

      env["GIT_CONFIG_NOSYSTEM"] = "1";
      env["GIT_CONFIG_GLOBAL"] = "/dev/null";
      env["GIT_TEMPLATE_DIR"] = "";
    }

    env["GIT_NO_LAZY_FETCH"] = "1";
    env["GIT_ALLOW_PROTOCOL"] ??= "https:ssh:file";

    let result;

    try {
      result = await this.runner.run({
        executable: this.engine.path,
        args: [
          "--no-pager",
          ...repositoryArgs,
          "-c",
          "core.fsmonitor=false",
          ...(args[0] === "clone"
            ? ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir="]
            : []),
          "-c",
          "submodule.recurse=false",
          "-c",
          "status.submoduleSummary=false",
          "-c",
          "diff.submodule=short",
          "-c",
          "diff.ignoreSubmodules=dirty",
          ...args,
        ],
        ...(cwd !== undefined && { cwd }),
        env,
        ...(options.stdin !== undefined && { stdin: options.stdin }),
        ...(signal !== undefined && { signal }),
        onStderrLine: (line) => {
          options.onProgress?.(redact(line));
          this.operations?.progress(redact(line));
        },
        ...(options.maxStdoutBytes !== undefined && { maxStdoutBytes: options.maxStdoutBytes }),
        ...(options.maxStderrBytes !== undefined && { maxStderrBytes: options.maxStderrBytes }),
      });
    } catch (error) {
      if (error instanceof ProcessSpawnError) {
        if (options.cwd !== undefined && !existsSync(options.cwd)) {
          throw new GitError({
            kind: "not-a-repository",
            operation: options.operation,
            message: errorText("main.git.gitService.noLongerExists", { cwd: options.cwd }),
            suggestedAction: errorText(
              "main.git.gitService.itMayHaveBeenMovedOrDeletedRemoveItFromEdaOrOpenADifferentFolder",
            ),
            repositoryPath: options.cwd,
          });
        }

        throw new GitError({
          kind: "git-not-found",
          operation: options.operation,
          message: errorText("main.git.gitService.edaCouldNotStartGit"),
          suggestedAction: errorText(
            "main.git.gitService.theGitEngineIsConfiguredAsCheckThatItStillExistsInSettings",
            { path: this.engine.path },
          ),
          ...(options.cwd !== undefined && { repositoryPath: options.cwd }),
          rawStderr: error.message,
        });
      }

      throw error;
    }

    const stderr = redact(result.stderr.toString("utf8"));

    if (result.outputLimitExceeded !== undefined) {
      throw new GitError({
        kind: "output-too-large",
        operation: options.operation,
        message: errorText("main.git.gitService.gitProducedMoreDataThanEdaCanSafelyDisplay", {
          outputLimitExceeded: result.outputLimitExceeded,
        }),
        suggestedAction: errorText(
          "main.git.gitService.narrowTheRequestToFewerCommitsOrFilesAndTryAgain",
        ),
        ...(options.cwd !== undefined && { repositoryPath: options.cwd }),
      });
    }

    if (result.cancelled) {
      throw new GitError({
        kind: "cancelled",
        operation: options.operation,
        message: errorText("main.git.gitService.theOperationWasCancelled", {
          operation: options.operation,
        }),
        ...(options.cwd !== undefined && { repositoryPath: options.cwd }),
        exitCode: result.exitCode,
      });
    }

    const allowed = options.allowedExitCodes ?? [0];

    if (!allowed.includes(result.exitCode)) {
      throw mapGitError({
        operation: options.operation,
        ...(options.cwd !== undefined && { repositoryPath: options.cwd }),
        ...(options.identityName !== undefined && { identityName: options.identityName }),
        exitCode: result.exitCode,
        stderr,
        stdout: redact(result.stdout.toString("utf8")),
      });
    }

    return {
      stdout: redact(result.stdout.toString("utf8")),
      stdoutBytes: options.redactValues?.length
        ? Buffer.from(redact(result.stdout.toString("utf8")))
        : result.stdout,
      stderr,
      exitCode: result.exitCode,
    };
  }

  async execFields(args: readonly string[], options: GitExecOptions): Promise<string[]> {
    const { stdout } = await this.exec(args, options);
    const fields = stdout.split("\0");
    if (fields.at(-1) === "") fields.pop();
    return fields;
  }

  async isRepository(path: string): Promise<boolean> {
    try {
      const { stdout } = await this.exec(["rev-parse", "--is-inside-work-tree"], {
        cwd: path,
        operation: t("operations.checkRepository"),
        signal: AbortSignal.timeout(10_000),
      });

      return stdout.trim() === "true";
    } catch (error) {
      if (error instanceof GitError && error.kind === "not-a-repository") return false;
      throw error;
    }
  }

  async status(path: string): Promise<RepositoryStatus> {
    const { stdoutBytes } = await this.exec(
      [
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=dirty",
        "--",
      ],
      {
        cwd: path,
        operation: t("operations.readStatus"),
        maxStdoutBytes: 8 * 1024 * 1024,
        maxStderrBytes: 1024 * 1024,
      },
    );

    if (!isUtf8(stdoutBytes))
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.readStatus"),
        repositoryPath: path,
        message: errorText("main.git.gitService.unsupportedStatusEncoding"),
      });

    return parseOutput(parseStatus, stdoutBytes, path, t("operations.readStatus"));
  }

  async history(
    path: string,
    page: {
      offset?: number;
      limit?: number;
      refs?: string[];
      hiddenRefs?: string[];
      showStashes?: boolean;
      showInternalRefs?: boolean;
    } = {},
  ): Promise<HistoryPage> {
    const offset = page.offset ?? 0;
    const limit = page.limit ?? HISTORY_PAGE_SIZE;

    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1_000_000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_HISTORY_PAGE_SIZE
    ) {
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.readHistory"),
        message: errorText("main.git.gitService.theHistoryPageIsOutsideTheSupportedRange"),
        suggestedAction: errorText(
          "main.git.gitService.request1To200CommitsFromANonNegativeOffset",
        ),
        repositoryPath: path,
      });
    }

    for (const ref of [...(page.refs ?? []), ...(page.hiddenRefs ?? [])])
      assertValidRefName(ref, t("operations.filterHistory"));

    const publicRefs = ["refs/heads/*", "refs/remotes/*", "refs/tags/*"];
    const excludedRefs = (page.hiddenRefs ?? []).map((ref) => `--exclude=${ref}`);
    let revisions: string[];
    if (page.refs?.length) revisions = page.refs;
    else if (page.showInternalRefs) revisions = [...excludedRefs, "--exclude=refs/stash", "--all"];
    else
      revisions = [
        ...publicRefs.flatMap((pattern) => [...excludedRefs, `--glob=${pattern}`]),
        // --all also includes HEAD, without failing when an unborn HEAD has no commit.
        "--exclude=refs/*",
        "--all",
      ];

    const stashes = page.showStashes ? await readStashHistory(this, path) : null;

    const { stdoutBytes } = await this.exec(
      [
        "log",
        ...revisions,
        ...(stashes?.tips ?? []),
        "--topo-order",
        "--date=unix",
        "--decorate=full",
        ...["HEAD", ...(page.showInternalRefs ? ["refs/*"] : publicRefs)].map(
          (pattern) => `--decorate-refs=${pattern}`,
        ),
        "--decorate-refs-exclude=refs/stash",
        `--max-count=${limit + 1}`,
        `--skip=${offset}`,
        ...LOG_ARGUMENTS,
        "--",
      ],
      {
        cwd: path,
        operation: t("operations.readHistory"),
        maxStdoutBytes: 16 * 1024 * 1024,
        maxStderrBytes: 1024 * 1024,
      },
    );

    const commits = parseOutput(parseLog, stdoutBytes, path, t("operations.readHistory"));

    for (const commit of commits) {
      const labels = stashes?.labels.get(commit.oid);
      if (labels) commit.stashLabels = labels;
    }

    const hasMore = commits.length > limit;

    if (hasMore) commits.pop();

    return { commits, nextOffset: hasMore ? offset + limit : null };
  }

  async inspectCommit(
    path: string,
    oid: string,
    cachedSignature?: CommitSignatureVerification,
  ): Promise<CommitInspection> {
    assertFullObjectId(oid, t("operations.inspectCommit"));

    const [log, refs, shallow, signature] = await Promise.all([
      this.exec(["log", "-1", "--decorate=full", ...LOG_ARGUMENTS, oid, "--"], {
        cwd: path,
        operation: t("operations.inspectCommit"),
        maxStdoutBytes: 1024 * 1024,
      }),
      this.exec(
        [
          "for-each-ref",
          `--contains=${oid}`,
          "--format=%(refname)",
          "refs/heads",
          "refs/remotes",
          "refs/tags",
        ],
        {
          cwd: path,
          operation: t("operations.findContainingReferences"),
          maxStdoutBytes: 1024 * 1024,
        },
      ),
      this.exec(["rev-parse", "--is-shallow-repository"], {
        cwd: path,
        operation: t("operations.inspectHistoryBoundary"),
      }),
      cachedSignature ?? this.commitSignature(path, oid),
    ]);

    const commit = parseOutput(parseLog, log.stdoutBytes, path, t("operations.inspectCommit"))[0];

    if (!commit)
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.inspectCommit"),
        message: errorText("main.git.gitService.theCommitIsNoLongerAvailable"),
        suggestedAction: errorText(
          "main.git.gitService.refreshReferencesAndSelectAnAvailableCommit",
        ),
      });

    return {
      commit,
      containingRefs: refs.stdout.trim().split("\n").filter(Boolean),
      shallow: shallow.stdout.trim() === "true",
      signed: signature.status !== "unsigned",
      signature,
    };
  }

  async commitSignature(
    path: string,
    oid: string,
    verifyOpenPgp?: (path: string, oid: string) => Promise<CommitSignatureVerification>,
  ): Promise<CommitSignatureVerification> {
    assertFullObjectId(oid, t("operations.verifyCommitSignature"));

    const object = await this.exec(["cat-file", "commit", oid], {
      cwd: path,
      operation: t("operations.verifyCommitSignature"),
      maxStdoutBytes: 1024 * 1024,
    });

    const format = commitSignatureFormat(object.stdout);
    const signature =
      format === "openpgp" && verifyOpenPgp
        ? await verifyOpenPgp(path, oid)
        : await this.verifyCommitSignature(path, oid, format);
    const headers = object.stdout.split("\n\n", 1)[0] ?? "";
    const authorEmail = /^author .* <([^>]+)> /m.exec(headers)?.[1];
    const committerEmail = /^committer .* <([^>]+)> /m.exec(headers)?.[1];
    return {
      ...signature,
      ...(authorEmail ? { authorEmail } : {}),
      ...(committerEmail ? { committerEmail } : {}),
    };
  }

  private async verifyCommitSignature(
    path: string,
    oid: string,
    format: CommitSignatureFormat | null,
  ): Promise<CommitSignatureVerification> {
    if (format === null) return UNSIGNED_COMMIT_SIGNATURE;

    try {
      const result = await this.exec(["verify-commit", "--raw", "--", oid], {
        cwd: path,
        operation: t("operations.verifyCommitSignature"),
        allowedExitCodes: [0, 1, 128],
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      });

      const verification = parseCommitVerification(
        format,
        result.exitCode,
        `${result.stdout}\n${result.stderr}`,
      );

      if (
        format === "ssh" &&
        verification.reasonCode === "verification-error" &&
        result.exitCode !== 0 &&
        verification.diagnostics === "Could not verify signature."
      ) {
        const status = await this.exec(
          ["log", "-1", "--no-show-signature", "--format=%G?", oid, "--"],
          {
            cwd: path,
            operation: t("operations.verifyCommitSignature"),
            maxStdoutBytes: 1024,
            maxStderrBytes: 64 * 1024,
          },
        );

        if (status.stdout.trim() === "B")
          return { ...verification, status: "invalid", reasonCode: "bad-signature" };
      }

      return verification;
    } catch (error) {
      if (error instanceof GitError && error.kind === "cancelled") throw error;
      const diagnostics =
        error instanceof GitError ? error.rawStderr || error.message : String(error);

      return {
        ...parseCommitVerification(format, 1, diagnostics),
        status: "unverified",
        reasonCode: "verification-error",
      };
    }
  }

  async workingDiff(
    path: string,
    options: { area: DiffArea; paths?: readonly string[] },
  ): Promise<UnifiedDiff> {
    const paths = literalPathspecs(options.paths, t("operations.readWorkingDiff"));
    const args = ["-c", "core.quotePath=false", "diff", ...UNIFIED_DIFF_FLAGS];

    if (options.area === "staged") args.push("--cached");

    args.push("--", ...paths);

    const { stdoutBytes } = await this.exec(args, {
      cwd: path,
      operation: t("operations.readWorkingDiff"),
      ...DIFF_OUTPUT_LIMITS,
    });

    const diff = parseOutput(parseUnifiedDiff, stdoutBytes, path, t("operations.readWorkingDiff"));

    if (options.area === "staged") return diff;

    const status = await this.status(path);
    const selected = options.paths?.length ? new Set(options.paths) : undefined;

    const untracked = status.changes.filter(
      (change) => change.kind === "untracked" && (!selected || selected.has(change.path)),
    );

    if (untracked.length > 256) throw outputTooLarge(path, t("operations.readWorkingDiff"));

    let remaining = DIFF_OUTPUT_LIMITS.maxStdoutBytes - stdoutBytes.length;

    for (const change of untracked) {
      assertRepositoryPath(change.path, t("operations.readWorkingDiff"));

      if (remaining <= 0) throw outputTooLarge(path, t("operations.readWorkingDiff"));

      const nullPath = process.platform === "win32" ? "NUL" : "/dev/null";

      const result = await this.exec(
        [
          "-c",
          "core.quotePath=false",
          "diff",
          "--no-index",
          ...UNIFIED_DIFF_FLAGS,
          "--",
          nullPath,
          change.path,
        ],
        {
          cwd: path,
          operation: t("operations.readUntrackedDiff"),
          allowedExitCodes: [0, 1],
          ...DIFF_OUTPUT_LIMITS,
          maxStdoutBytes: remaining,
        },
      );

      remaining -= result.stdoutBytes.length;

      diff.files.push(
        ...parseOutput(
          parseUnifiedDiff,
          result.stdoutBytes,
          path,
          t("operations.readUntrackedDiff"),
        ).files,
      );
    }

    return boundDiff(diff);
  }

  async commitDiff(path: string, oid: string, paths?: readonly string[]): Promise<UnifiedDiff> {
    assertFullObjectId(oid, t("operations.readCommitDiff"));

    const safePaths = literalPathspecs(paths, t("operations.readCommitDiff"));

    const { stdoutBytes } = await this.exec(
      [
        "-c",
        "core.quotePath=false",
        "diff-tree",
        "--root",
        "--diff-merges=first-parent",
        "--no-commit-id",
        "-r",
        "-p",
        ...UNIFIED_DIFF_FLAGS,
        oid,
        "--",
        ...safePaths,
      ],
      {
        cwd: path,
        operation: t("operations.readCommitDiff"),
        ...DIFF_OUTPUT_LIMITS,
      },
    ).catch((error: unknown) => {
      if (
        error instanceof GitError &&
        error.kind === "repository-corrupt" &&
        error.rawStderr?.trim() === `fatal: bad object ${oid}`
      ) {
        throw new GitError({
          kind: "invalid-input",
          operation: t("operations.readCommitDiff"),
          repositoryPath: path,
          message: errorText("main.git.gitService.theCommitIsNoLongerAvailable"),
          suggestedAction: errorText(
            "main.git.gitService.refreshReferencesAndSelectAnAvailableCommit",
          ),
          ...(error.exitCode !== undefined && { exitCode: error.exitCode }),
          rawStderr: error.rawStderr,
        });
      }

      throw error;
    });

    return parseOutput(parseUnifiedDiff, stdoutBytes, path, t("operations.readCommitDiff"));
  }

  async compareDiff(path: string, from: string, to: string): Promise<UnifiedDiff> {
    assertFullObjectId(from, t("operations.compareRevisions"));
    assertFullObjectId(to, t("operations.compareRevisions"));

    const { stdoutBytes } = await this.exec(
      ["-c", "core.quotePath=false", "diff", "--no-color", ...UNIFIED_DIFF_FLAGS, from, to, "--"],
      {
        cwd: path,
        operation: t("operations.compareRevisions"),
        ...DIFF_OUTPUT_LIMITS,
      },
    );

    return parseOutput(parseUnifiedDiff, stdoutBytes, path, t("operations.compareRevisions"));
  }

  async stage(path: string, paths: readonly string[]): Promise<void> {
    const safe = literalPathspecs(paths, t("operations.stageChanges"));
    if (safe.length === 0) return;
    await this.exec(["add", "--", ...safe], { cwd: path, operation: t("operations.stageChanges") });
  }

  async stageAll(path: string): Promise<void> {
    await this.exec(["add", "--all", "--"], {
      cwd: path,
      operation: t("operations.stageAllChanges"),
    });
  }

  async unstage(path: string, paths: readonly string[]): Promise<void> {
    const safe = literalPathspecs(paths, t("operations.unstageChanges"));

    if (safe.length === 0) return;

    if (await this.hasCommits(path)) {
      await this.exec(["restore", "--staged", "--", ...safe], {
        cwd: path,
        operation: t("operations.unstageChanges"),
      });

      return;
    }

    await this.exec(["rm", "--cached", "-r", "--force", "--", ...safe], {
      cwd: path,
      operation: t("operations.unstageChanges"),
    });
  }

  async unstageAll(path: string): Promise<void> {
    if (await this.hasCommits(path)) {
      await this.exec(["restore", "--staged", "--", "."], {
        cwd: path,
        operation: t("operations.unstageAllChanges"),
      });

      return;
    }

    await this.exec(["rm", "--cached", "-r", "--force", "--ignore-unmatch", "--", "."], {
      cwd: path,
      operation: t("operations.unstageAllChanges"),
    });
  }

  async commit(
    path: string,
    message: string,
    options: { amend?: boolean; signOff?: boolean; allowEmpty?: boolean } = {},
    identity?: Identity,
  ): Promise<string> {
    if (message.trim().length === 0) {
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.commit"),
        message: errorText("main.git.gitService.aCommitNeedsAMessage"),
        suggestedAction: errorText("main.git.gitService.writeAShortSummaryOfTheChangeAndTryAgain"),
        repositoryPath: path,
      });
    }

    const args = ["commit", "--file=-", "--cleanup=strip"];

    if (options.amend) args.push("--amend");
    if (options.signOff) args.push("--signoff");
    if (options.allowEmpty) args.push("--allow-empty");

    const overrides: Record<string, string> = {};

    if (identity) {
      const config = commitGitConfig(identity);

      args.unshift(...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${value}`]));
      overrides["GIT_COMMITTER_NAME"] = identity.gitName;
      overrides["GIT_COMMITTER_EMAIL"] = identity.gitEmail;

      if (!options.amend) {
        overrides["GIT_AUTHOR_NAME"] = identity.gitName;
        overrides["GIT_AUTHOR_EMAIL"] = identity.gitEmail;
      }
    }

    await this.exec(args, {
      cwd: path,
      operation: t("operations.commit"),
      stdin: message,
      env: { overrides, ...(identity?.sshKeyPath ? { sshKeyPath: identity.sshKeyPath } : {}) },
    });

    const { stdout } = await this.exec(["rev-parse", "HEAD"], {
      cwd: path,
      operation: t("operations.commit"),
    });

    return stdout.trim();
  }

  async createBranch(
    path: string,
    name: string,
    options: { checkout?: boolean; startPoint?: string } = {},
  ): Promise<void> {
    assertValidRefName(name, t("operations.createBranch"));

    if (options.startPoint !== undefined)
      assertFullObjectId(options.startPoint, t("operations.createBranch"));

    const start = options.startPoint === undefined ? [] : [options.startPoint];

    const args = options.checkout
      ? ["checkout", "--no-overwrite-ignore", "-b", name, ...start]
      : ["branch", name, ...start];

    await this.exec(args, { cwd: path, operation: t("operations.createBranch") });
  }

  async checkoutBranch(path: string, name: string): Promise<void> {
    assertValidRefName(name, t("operations.checkoutBranch"));

    await this.exec(["checkout", "--no-overwrite-ignore", name, "--"], {
      cwd: path,
      operation: t("operations.checkoutBranch"),
    });
  }

  async deleteBranch(path: string, name: string, options: { force?: boolean } = {}): Promise<void> {
    assertValidRefName(name, t("operations.deleteBranch"));

    await this.exec(["branch", options.force ? "-D" : "-d", name], {
      cwd: path,
      operation: t("operations.deleteBranch"),
    });
  }

  async renameBranch(path: string, from: string, to: string): Promise<void> {
    assertValidRefName(from, t("operations.renameBranch"));
    assertValidRefName(to, t("operations.renameBranch"));

    await this.exec(["branch", "-m", from, to], {
      cwd: path,
      operation: t("operations.renameBranch"),
    });
  }

  async listBranches(path: string): Promise<BranchSummary[]> {
    const fields = await this.execFields(BRANCH_ARGUMENTS, {
      cwd: path,
      operation: t("operations.listBranches"),
      maxStdoutBytes: 4 * 1024 * 1024,
    });

    return parseBranches(fields);
  }

  async createTag(
    path: string,
    name: string,
    options: { message?: string; target?: string; sign?: boolean } = {},
    identity?: Identity,
  ): Promise<void> {
    assertValidRefName(name, t("operations.createTag"));

    if (options.target !== undefined) assertFullObjectId(options.target, t("operations.createTag"));

    if (
      options.sign &&
      (!options.message?.trim() || !identity || identity.signing.format === "none")
    )
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.signTag"),
        message: errorText("main.git.gitService.chooseSshOrGpgSigningInThisProfile"),
      });

    const target = options.target === undefined ? [] : [options.target];

    const args = options.message
      ? [
          "-c",
          "tag.gpgSign=false",
          "tag",
          options.sign ? "--sign" : "--no-sign",
          "--annotate",
          "--file=-",
          "--cleanup=strip",
          name,
          ...target,
        ]
      : ["-c", "tag.gpgSign=false", "tag", "--no-sign", name, ...target];

    if (identity)
      args.unshift(
        "-c",
        `user.name=${identity.gitName}`,
        "-c",
        `user.email=${identity.gitEmail}`,
        "-c",
        `gpg.format=${identity.signing.format === "ssh" ? "ssh" : "openpgp"}`,
        "-c",
        `user.signingkey=${identity.signing.keyRef ?? ""}`,
      );

    await this.exec(args, {
      cwd: path,
      operation: t("operations.createTag"),
      ...(options.message ? { stdin: options.message } : {}),
      ...(identity
        ? {
            env: {
              overrides: {
                GIT_COMMITTER_NAME: identity.gitName,
                GIT_COMMITTER_EMAIL: identity.gitEmail,
              },
            },
          }
        : {}),
    });
  }

  async verifyTag(path: string, name: string): Promise<TagVerification> {
    assertValidRefName(name, t("operations.verifyTag"));

    const { stdout } = await this.exec(["rev-parse", "--verify", `refs/tags/${name}`], {
      cwd: path,
      operation: t("operations.resolveTag"),
    });

    const oid = stdout.trim();

    assertFullObjectId(oid, t("operations.verifyTag"));

    const type = await this.exec(["cat-file", "-t", oid], {
      cwd: path,
      operation: t("operations.inspectTagType"),
    });

    if (type.stdout.trim() !== "tag")
      return {
        oid,
        status: "unsigned",
        diagnostics: t("main.git.gitService.lightweightTagsDoNotContainATagSignature"),
      };

    const tag = await this.exec(["cat-file", "tag", oid], {
      cwd: path,
      operation: t("operations.inspectTagSignature"),
      maxStdoutBytes: 1024 * 1024,
    });

    if (!/^-----BEGIN (?:PGP SIGNATURE|SSH SIGNATURE|SIGNED MESSAGE)-----$/m.test(tag.stdout))
      return {
        oid,
        status: "unsigned",
        diagnostics: t("main.git.gitService.thisAnnotatedTagHasNoSignature"),
      };

    const result = await this.exec(["verify-tag", "--", oid], {
      cwd: path,
      operation: t("operations.verifyTag"),
      allowedExitCodes: [0, 1],
      maxStderrBytes: 64 * 1024,
    });

    return {
      oid,
      status: result.exitCode === 0 ? "verified" : "unverified",
      diagnostics:
        result.stderr || result.stdout || t("main.git.gitService.gitCouldNotVerifyThisSignature"),
    };
  }

  async deleteTag(path: string, name: string): Promise<void> {
    assertValidRefName(name, t("operations.deleteTag"));
    await this.exec(["tag", "-d", name], { cwd: path, operation: t("operations.deleteTag") });
  }

  async listTags(path: string): Promise<TagSummary[]> {
    const fields = await this.execFields(TAG_ARGUMENTS, {
      cwd: path,
      operation: t("operations.listTags"),
      maxStdoutBytes: 4 * 1024 * 1024,
    });

    return parseTags(fields);
  }

  async remoteNames(path: string): Promise<string[]> {
    const { stdout } = await this.exec(["remote"], {
      cwd: path,
      operation: t("operations.readRemoteNames"),
      maxStdoutBytes: 64 * 1024,
    });

    return stdout.trim().split("\n").filter(Boolean);
  }

  async ignoredFiles(path: string): Promise<string[]> {
    const { stdout } = await this.exec(
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      {
        cwd: path,
        operation: t("operations.listIgnoredFiles"),
        maxStdoutBytes: 4 * 1024 * 1024,
      },
    );

    return stdout.split("\0").filter(Boolean);
  }

  async commitTemplate(path: string): Promise<string | null> {
    return readCommitTemplate(path, await this.readConfig("commit.template", { cwd: path }));
  }

  async checkoutTag(path: string, name: string): Promise<void> {
    assertValidRefName(name, t("operations.checkoutTag"));

    await this.exec(["checkout", "--no-overwrite-ignore", "--detach", `refs/tags/${name}`, "--"], {
      cwd: path,
      operation: t("operations.checkoutTag"),
    });
  }

  async hasCommits(path: string): Promise<boolean> {
    const { exitCode } = await this.exec(["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: path,
      operation: t("operations.readRepositoryState"),
      allowedExitCodes: [0, 1],
    });

    return exitCode === 0;
  }

  async resolveRepositoryRoot(path: string): Promise<string> {
    const { stdout } = await this.exec(["rev-parse", "--show-toplevel"], {
      cwd: path,
      operation: t("operations.openRepository"),
    });

    return stdout.replace(/\r?\n$/, "");
  }

  async isRefNameValid(ref: string): Promise<boolean> {
    assertValidRefName(ref, t("operations.validateReferenceName"));

    const { exitCode } = await this.exec(["check-ref-format", "--branch", ref], {
      operation: t("operations.validateReferenceName"),
      allowedExitCodes: [0, 1, 128, 129],
    });

    return exitCode === 0;
  }

  async inspectConfig(
    key: string,
    options: { cwd?: string; scope?: "global" | "local" } = {},
  ): Promise<GitConfigEntry> {
    const showScope = this.engine.versionParts.major > 2 || this.engine.versionParts.minor >= 26;

    const result = await this.exec(
      [
        "config",
        ...(options.scope ? [`--${options.scope}`] : []),
        "--null",
        "--show-origin",
        ...(showScope ? ["--show-scope"] : []),
        "--get",
        "--",
        key,
      ],
      {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        operation: t("operations.inspectGitConfiguration"),
        allowedExitCodes: [0, 1],
      },
    );

    if (result.exitCode === 1) return { key };

    const parts = result.stdout.split("\0");
    const scope = showScope ? parts.shift() : options.scope;
    const [origin, value] = parts;

    return {
      key,
      ...(scope !== undefined && { scope }),
      ...(origin !== undefined && { origin }),
      ...(value !== undefined && { value }),
    };
  }

  async localConfigKeys(cwd: string): Promise<string[]> {
    const { stdout } = await this.exec(
      ["config", "--local", "--no-includes", "--null", "--name-only", "--list"],
      { cwd, operation: t("operations.inspectLocalCommitOverrides") },
    );

    return stdout.split("\0").filter(Boolean);
  }

  async readConfig(
    key: string,
    options: { cwd?: string; scope?: "global" | "local" } = {},
  ): Promise<string | undefined> {
    const scopeArgs =
      options.scope === "global" ? ["--global"] : options.scope === "local" ? ["--local"] : [];

    const { stdout, exitCode } = await this.exec(["config", ...scopeArgs, "--get", "--", key], {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      operation: t("operations.readGitConfiguration"),
      allowedExitCodes: [0, 1],
    });

    return exitCode === 0 ? stdout.replace(/\n$/, "") : undefined;
  }

  async writeConfig(
    key: string,
    value: string,
    options: { cwd?: string; scope: "global" | "local" },
  ): Promise<void> {
    await this.exec(["config", `--${options.scope}`, "--", key, value], {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      operation: t("operations.writeGitConfiguration"),
    });
  }

  async unsetConfig(
    key: string,
    options: { cwd?: string; scope: "global" | "local" },
  ): Promise<void> {
    await this.exec(["config", `--${options.scope}`, "--unset-all", "--", key], {
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      operation: t("operations.clearGitConfiguration"),
      allowedExitCodes: [0, 5],
    });
  }
}
