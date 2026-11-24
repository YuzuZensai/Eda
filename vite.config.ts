import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";
import { startup as electronStartup } from "vite-plugin-electron";
import { prepareDevelopmentDesktop } from "./scripts/development-desktop.ts";
import { watchDevelopmentRestart } from "./scripts/development-restart.ts";
import { DEVELOPMENT_RESTART } from "./src/shared/application.ts";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareGit } from "./scripts/prepare-git.ts";
import {
  compactMessageCatalogs,
  electronStderr,
  readBuildInfo,
  prepareComponentInventory,
} from "./scripts/build.ts";

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

function devElectronEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    NODE_OPTIONS: "--no-warnings=ExperimentalWarning",
  };
}

export default defineConfig(async ({ command }) => {
  await Promise.all([prepareGit(), prepareComponentInventory()]);
  const buildInfo = readBuildInfo();
  if (command === "serve" && process.platform === "linux")
    await prepareDevelopmentDesktop(resolve("."));

  return {
    root: resolve("./src/renderer"),
    server: { host: "127.0.0.1" },
    resolve: {
      alias: {
        "@shared": resolve("./src/shared"),
        "@renderer": resolve("./src/renderer"),
        "@eda/react/jsx-runtime": resolve("./scripts/react-jsx-runtime.ts"),
        "@eda/react": "react",
      },
    },
    plugins: [
      compactMessageCatalogs(),
      react({ jsxImportSource: command === "build" ? "@eda/react" : "react" }),
      tailwindcss(),
      electron({
        main: {
          entry: resolve("./src/main/index.ts"),
          onstart: async ({ startup }) => {
            const launch = async (args: string[] = []) => {
              await startup([resolve("."), ...args], {
                env: devElectronEnv(),
                stdio: ["inherit", "inherit", "pipe", "ipc"],
              });

              const child = (process as NodeJS.Process & { electronApp?: ChildProcess })
                .electronApp;
              if (!child) return;
              child.stderr
                ?.pipe(electronStderr(process.env["EDA_CHROMIUM_DIAGNOSTICS"] === "1"))
                .pipe(process.stderr, { end: false });
              watchDevelopmentRestart(
                child,
                // Signal 0 registers a planned stop without interrupting Eda's save/quit handshake.
                () => electronStartup.exit(0),
                (action) =>
                  launch(action === "import-release-data" ? [DEVELOPMENT_RESTART.argument] : []),
                (error) => console.error("[Eda Development Restart]", error),
              );
            };

            await launch();
          },
          vite: {
            resolve: {
              alias: {
                "@shared": resolve("./src/shared"),
                "@main": resolve("./src/main"),
              },
            },
            build: {
              minify: command === "build",
              outDir: resolve("./dist/main"),
              rolldownOptions: {
                external: ["electron", "velopack", "node-pty", "@xterm/headless", "node:sqlite"],
                output: { minify: command === "build" },
              },
            },
          },
        },
        preload: {
          input: resolve("./src/main/preload.ts"),
          vite: {
            define: { __EDA_BUILD_INFO__: JSON.stringify(buildInfo) },
            resolve: { alias: { "@shared": resolve("./src/shared") } },
            build: { minify: command === "build", outDir: resolve("./dist/preload") },
          },
        },
      }),
    ],
    build: {
      outDir: resolve("./dist/renderer"),
      emptyOutDir: true,
      manifest: true,
      // Electron loads chunks from disk, so dynamic imports can resolve their dependencies locally.
      modulePreload: false,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: "messages", test: /[\\/]shared[\\/]locales[\\/]/ },
              { name: "icons", test: /[\\/]lucide-react[\\/]/ },
            ],
          },
        },
      },
    },
  };
});
