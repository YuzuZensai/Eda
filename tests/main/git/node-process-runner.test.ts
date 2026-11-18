import { describe, expect, it } from "vitest";
import { NodeProcessRunner } from "@main/git/execution/node-process-runner";

describe("NodeProcessRunner output bounds", () => {
  it("returns cancellation without resolving or starting an already cancelled command", async () => {
    const result = await new NodeProcessRunner().run({
      executable: "eda-nonexistent-cancelled-command",
      args: [],
      env: {},
      signal: AbortSignal.abort(),
    });

    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(result.stdout).toHaveLength(0);
    expect(result.stderr).toHaveLength(0);
  });

  it("cancels a running child, including one ignoring graceful termination", async () => {
    const controller = new AbortController();
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); process.stderr.write('ready\\n'); setInterval(() => {}, 1000)",
      ],
      env: {},
      signal: controller.signal,
      onStderrLine: () => controller.abort(),
    });

    expect(result.cancelled).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("returns the child's failure when it exits without consuming a large stdin", async () => {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      args: ["-e", "process.stderr.write('rejected input'); process.exitCode = 3"],
      env: {},
      stdin: "x".repeat(4 * 1024 * 1024),
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toBe("rejected input");
  });

  it("retains at most the configured stdout bytes and terminates the producer", async () => {
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4096))"],
      env: {},
      maxStdoutBytes: 128,
      maxStderrBytes: 128,
    });

    expect(result.stdout).toHaveLength(128);
    expect(result.outputLimitExceeded).toBe("stdout");
  });

  it("bounds stderr even when line progress is enabled and no newline arrives", async () => {
    const lines: string[] = [];
    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      args: ["-e", "process.stderr.write('x'.repeat(4096))"],
      env: {},
      maxStdoutBytes: 128,
      maxStderrBytes: 96,
      onStderrLine: (line) => lines.push(line),
    });

    expect(result.stderr).toHaveLength(96);
    expect(lines.join("")).toHaveLength(96);
    expect(result.outputLimitExceeded).toBe("stderr");
  });
});
