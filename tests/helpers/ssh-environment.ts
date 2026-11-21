import { access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";

export async function sshTestEnvironment(): Promise<Record<string, string>> {
  if (process.platform !== "win32") {
    const platform = process.platform === "darwin" ? "mac" : process.platform;
    const bin = resolve("vendor/git", platform + "-" + process.arch, "openssh/bin");
    return await access(join(bin, "ssh-keygen")).then(
      () => ({ PATH: bin + delimiter + (process.env["PATH"] ?? "") }),
      () => ({}),
    );
  }

  const gitPaths = execFileSync("where.exe", ["git"], { encoding: "utf8" }).trim().split(/\r?\n/);
  for (const gitPath of gitPaths) {
    const bin = resolve(dirname(gitPath), "../usr/bin");
    try {
      await Promise.all(
        ["ssh", "ssh-agent", "ssh-add", "ssh-keygen", "sh"].map((tool) =>
          access(join(bin, `${tool}.exe`)),
        ),
      );
      return { PATH: `${bin};${process.env["PATH"] ?? process.env["Path"] ?? ""}` };
    } catch {}
  }
  throw new Error(
    "Install Git for Windows with its SSH tools and add Git to PATH before running SSH integration tests.",
  );
}
