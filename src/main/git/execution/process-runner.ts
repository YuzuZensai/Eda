import { existsSync } from "node:fs";
import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env: Readonly<Record<string, string>>;
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  cancelled: boolean;
  outputLimitExceeded?: "stdout" | "stderr";
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export class ProcessSpawnError extends Error {
  constructor(
    readonly executable: string,
    override readonly cause: NodeJS.ErrnoException,
  ) {
    super(
      t("main.git.processRunner.failedToStart", { executable: executable, message: cause.message }),
    );
    this.name = "ProcessSpawnError";
  }
}

export async function runGitProcess(
  runner: ProcessRunner,
  request: ProcessRequest,
  operation: string,
  repositoryPath: string | undefined,
): Promise<ProcessResult> {
  try {
    return await runner.run(request);
  } catch (error) {
    if (!(error instanceof ProcessSpawnError)) throw error;

    if (repositoryPath !== undefined && !existsSync(repositoryPath)) {
      throw new GitError({
        kind: "not-a-repository",
        operation,
        message: errorText("main.git.gitService.noLongerExists", { cwd: repositoryPath }),
        suggestedAction: errorText(
          "main.git.gitService.itMayHaveBeenMovedOrDeletedRemoveItFromEdaOrOpenADifferentFolder",
        ),
        repositoryPath,
      });
    }

    throw new GitError({
      kind: "git-not-found",
      operation,
      message: errorText("main.git.gitService.edaCouldNotStartGit"),
      suggestedAction: errorText(
        "main.git.gitService.theGitEngineIsConfiguredAsCheckThatItStillExistsInSettings",
        { path: request.executable },
      ),
      ...(repositoryPath !== undefined && { repositoryPath }),
      rawStderr: error.message,
    });
  }
}
