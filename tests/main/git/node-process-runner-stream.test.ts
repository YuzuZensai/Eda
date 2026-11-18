import type * as ChildProcessModule from "node:child_process";
import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { NodeProcessRunner } from "@main/git/execution/node-process-runner";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  return { ...original, spawn: vi.fn() };
});

it.each([true, false])(
  "preserves UTF-8 split across stderr chunks (newline: %s)",
  async (newline) => {
    const child = new ChildProcess();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const message = "remote: café 日本語";
    const bytes = Buffer.from(message + (newline ? "\n" : ""));
    const lines: string[] = [];

    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => {
        for (const byte of bytes) child.stderr!.emit("data", Buffer.from([byte]));
        child.emit("close", 0);
      });
      return child;
    });

    const result = await new NodeProcessRunner().run({
      executable: process.execPath,
      args: [],
      env: {},
      onStderrLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([message]);
    expect(result.stderr).toEqual(bytes);
  },
);
