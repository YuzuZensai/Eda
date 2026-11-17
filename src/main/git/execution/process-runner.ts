import { t } from "@shared/i18n";
export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env: Readonly<Record<string, string>>;
  stdin?: string | Uint8Array;
  signal?: AbortSignal;
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
