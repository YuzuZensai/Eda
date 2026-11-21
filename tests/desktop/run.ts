import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const suites = [
  "onboarding",
  "repository-trust",
  "tutorial",
  "commands",
  "debug",
  "navigation",
  "updates",
  "homebrew-updates",
  "workspace",
  "git-tools",
  "foundations",
  "local",
  "signing-keys",
  "profiles",
  "identity-warning",
  "large-repo",
  "bundled-git",
  "remotes",
  "gitlab-tls",
  "ssh-remotes",
];

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const project = fileURLToPath(new URL("../../", import.meta.url));

if (!args.length || args.some((arg) => ["-h", "--help"].includes(arg))) {
  console.log(`Usage: pnpm test:desktop <suite... | all> [--packaged]

Suites: ${suites.join(", ")}

Run pnpm build first. Suites run sequentially and stop at the first failure.
Use --packaged with bundled-git after pnpm package --dir. Set EDA_PACKAGED_EXECUTABLE when using a custom output path.
Remotes requires OpenSSL and Git http-backend; gitlab-tls requires OpenSSL; ssh-remotes requires ssh-keygen and GPG.
Homebrew-updates requires macOS and Homebrew, builds two disposable dev packages, and runs only when selected explicitly.`);
} else {
  const packaged = args.includes("--packaged");
  const names = args.filter((arg) => arg !== "--packaged");
  const selected =
    names.length === 1 && names[0] === "all"
      ? suites.filter((name) => name !== "homebrew-updates")
      : names;
  const invalid = selected.filter((name) => !suites.includes(name));

  if (!selected.length || invalid.length) {
    console.error(`Choose a desktop suite: ${suites.join(", ")}, or all. See --help.`);
    process.exitCode = 1;
  } else if (packaged && (selected.length !== 1 || selected[0] !== "bundled-git")) {
    console.error("--packaged requires the bundled-git suite alone.");
    process.exitCode = 1;
  } else if (!packaged && !existsSync(new URL("../../dist/main/index.js", import.meta.url))) {
    console.error("Build Eda first with pnpm build, then run pnpm test:desktop again.");
    process.exitCode = 1;
  } else {
    for (const name of new Set(selected)) {
      console.log(`Running desktop suite: ${name}`);

      const code = await new Promise<number>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL(`./${name}.ts`, import.meta.url)),
            ...(packaged ? ["--packaged"] : []),
          ],
          { cwd: project, stdio: "inherit", shell: false },
        );

        child.on("error", (error) => {
          console.error(`Could not start ${name}: ${error.message}`);
          resolve(1);
        });

        child.on("exit", (status) => resolve(status ?? 1));
      });

      if (code !== 0) {
        process.exitCode = code;
        break;
      }
    }
  }
}
