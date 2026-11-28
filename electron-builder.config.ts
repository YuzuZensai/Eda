import type { Configuration } from "electron-builder";
import { prepareGit } from "./scripts/prepare-git.ts";
import { readBuildInfo } from "./scripts/build.ts";

export default {
  appId: "cafe.kirameki.eda",
  productName: "Eda",
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
  },
  npmRebuild: false,
  asarUnpack: ["node_modules/velopack/**/*.node", "node_modules/node-pty/**/*"],
  protocols: [{ name: "Eda repository links", schemes: ["eda"] }],
  directories: { output: "release" },
  files: ["dist/**/*", "package.json"],
  extraResources: [
    { from: "build/icon.png", to: "icon.png" },
    { from: "vendor/git/${os}-${arch}", to: "git", filter: ["**/*"] },
    { from: "LICENSE", to: "LICENSE" },
    {
      from: "src/renderer/assets/providers/LICENSE",
      to: "licenses/provider-icons/LICENSE",
    },
  ],
  beforePack: async (context) => {
    if (process.env["EDA_RELEASE"] === "1" && readBuildInfo().dirty !== false)
      throw new Error("Official Eda releases require a clean Git checkout with a known commit.");
    const arch = ({ 1: "x64", 3: "arm64" } as Record<number, string>)[context.arch];
    if (!arch) throw new Error("Eda packages support x64 and arm64.");
    await prepareGit(context.electronPlatformName, arch);
  },
  win: { target: "dir", icon: "build/icon.ico" },
  mac: {
    icon: "build/icon.icns",
    target: "dir",
    identity: null,
    hardenedRuntime: false,
    category: "public.app-category.developer-tools",
  },
  linux: { target: "dir", category: "Development", icon: "build/icon.png" },
} satisfies Configuration;
