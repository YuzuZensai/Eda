import { spawn } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { resolveExecutable } from "./executable";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./process-runner";
import { ProcessSpawnError } from "./process-runner";

export class NodeProcessRunner implements ProcessRunner {
  async launch(
    executable: string,
    args: readonly string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<void> {
    const resolved = await this.resolve(executable, env);
    return new Promise((resolve, reject) => {
      const child = spawn(resolved, [...args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      });

      child.once("error", (error) => reject(new ProcessSpawnError(executable, error)));
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    if (request.signal?.aborted) return cancelledResult();

    const executable = await this.resolve(request.executable, request.env);

    if (request.signal?.aborted) return cancelledResult();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...request.args], {
        shell: false,
        cwd: request.cwd,
        env: { ...request.env },
        detached: process.platform !== "win32",
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const maxStdoutBytes = request.maxStdoutBytes ?? 16 * 1024 * 1024;
      const maxStderrBytes = request.maxStderrBytes ?? 1024 * 1024;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputLimitExceeded: "stdout" | "stderr" | undefined;
      let cancelled = false;
      let settled = false;
      const stdoutLines = request.onStdoutLine && lineReader(request.onStdoutLine);
      const stderrLines = request.onStderrLine && lineReader(request.onStderrLine);
      let stopKillTimer: (() => void) | undefined;

      const stop = () => {
        stopKillTimer ??= killTree(child.pid);
      };

      const onAbort = () => {
        cancelled = true;
        stop();
      };

      if (request.signal) {
        if (request.signal.aborted) {
          onAbort();
        } else {
          request.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      const cleanup = () => {
        request.signal?.removeEventListener("abort", onAbort);
        stopKillTimer?.();
      };

      const capture = (
        chunk: Buffer,
        chunks: Buffer[],
        currentBytes: number,
        limit: number,
        stream: "stdout" | "stderr",
      ): number => {
        const remaining = Math.max(0, limit - currentBytes);

        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));

        const nextBytes = currentBytes + Math.min(chunk.length, remaining);

        if (chunk.length > remaining && outputLimitExceeded === undefined) {
          outputLimitExceeded = stream;
          stop();
        }

        return nextBytes;
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        const previousBytes = stdoutBytes;
        stdoutBytes = capture(chunk, stdoutChunks, stdoutBytes, maxStdoutBytes, "stdout");
        stdoutLines?.write(chunk.subarray(0, stdoutBytes - previousBytes));
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const previousBytes = stderrBytes;

        stderrBytes = capture(chunk, stderrChunks, stderrBytes, maxStderrBytes, "stderr");

        stderrLines?.write(chunk.subarray(0, stderrBytes - previousBytes));
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new ProcessSpawnError(request.executable, error));
      });

      let inputError: Error | undefined;
      child.stdin.on("error", (error: Error) => {
        inputError = error;
      });

      child.on("close", (code) => {
        if (settled) return;

        settled = true;
        cleanup();

        stdoutLines?.end();
        stderrLines?.end();

        if (inputError && code === 0 && !cancelled && !outputLimitExceeded) {
          reject(inputError);
          return;
        }
        resolve({
          exitCode: code ?? (cancelled ? 130 : 1),
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          cancelled,
          ...(outputLimitExceeded !== undefined && { outputLimitExceeded }),
        });
      });

      if (request.stdin !== undefined) {
        child.stdin?.end(request.stdin);
      } else {
        child.stdin?.end();
      }
    });
  }

  private async resolve(
    executable: string,
    env: Readonly<Record<string, string>>,
  ): Promise<string> {
    try {
      return await resolveExecutable(executable, env);
    } catch (error) {
      throw new ProcessSpawnError(executable, error as NodeJS.ErrnoException);
    }
  }
}

function lineReader(emit: (line: string) => void) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return {
    write(chunk: Buffer) {
      const lines = (pending + decoder.write(chunk)).split(/\r\n|\r|\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line) emit(line);
    },
    end() {
      pending += decoder.end();
      if (pending) emit(pending);
    },
  };
}

function cancelledResult(): ProcessResult {
  return {
    exitCode: 130,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    cancelled: true,
  };
}

function killTree(pid: number | undefined): () => void {
  if (pid === undefined) return () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    if (process.platform === "win32") {
      spawn(
        join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/pid", String(pid), "/T", "/F"],
        {
          shell: false,
          windowsHide: true,
        },
      ).once("error", () => {
        try {
          process.kill(pid);
        } catch {}
      });
    } else {
      process.kill(-pid, "SIGTERM");
      timer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }, 1500);
      timer.unref();
    }
  } catch {}

  return () => {
    if (timer) clearTimeout(timer);
  };
}
