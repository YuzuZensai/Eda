import { Arch, build, Platform } from "electron-builder";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { VelopackAsset } from "velopack";
import configuration from "../electron-builder.config.ts";
import { UPDATE_PACKAGE_ID, updateChannel, type UpdatePlatform } from "../src/shared/updates.ts";
import { readBuildInfo } from "./build.ts";

const args = process.argv.slice(2).filter((arg) => arg !== "--");

if (
  args.some((arg) => !["--dir", "--x64", "--arm64"].includes(arg)) ||
  (args.includes("--x64") && args.includes("--arm64"))
)
  throw new Error("Usage: pnpm package [--dir] [--x64 | --arm64]");

const arch = args.includes("--arm64") ? "arm64" : args.includes("--x64") ? "x64" : process.arch;

if (!["x64", "arm64"].includes(arch)) throw new Error("Eda supports x64 and arm64 packages.");
if (!["win32", "darwin", "linux"].includes(process.platform))
  throw new Error("Unsupported packaging OS.");

const platform: UpdatePlatform =
  process.platform === "win32" ? "win" : process.platform === "darwin" ? "osx" : "linux";
const channel = updateChannel(platform, arch);
const buildInfo = readBuildInfo();
const output = resolve("release/velopack");
let appOutDir = "";

await build({
  targets: Platform.current().createTarget("dir", arch === "arm64" ? Arch.arm64 : Arch.x64),
  config: {
    ...configuration,
    afterPack: async (context) => {
      appOutDir = context.appOutDir;
    },
  },
  publish: "never",
});

if (!appOutDir) throw new Error("electron-builder did not produce an application directory.");

if (!args.includes("--dir")) {
  const { version: sdkVersion } = JSON.parse(
    await readFile("node_modules/velopack/package.json", "utf8"),
  ) as { version: string };
  const vpkDll = process.env["EDA_VPK_DLL"];
  const prefix = vpkDll ? [resolve(vpkDll)] : ["tool", "run", "vpk", "--"];
  const reportedVersion = execFileSync("dotnet", [...prefix, "--help"], { encoding: "utf8" });

  if (!reportedVersion.includes(`Velopack CLI ${sdkVersion},`))
    throw new Error(`Restore the pinned vpk ${sdkVersion} tool with dotnet tool restore.`);

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await mkdir(".cache", { recursive: true });

  const notes = resolve(".cache/eda-release-notes.md");
  const releaseNotes = process.env["EDA_RELEASE_NOTES"];
  await writeFile(
    notes,
    releaseNotes ? await readFile(resolve(releaseNotes)) : `Eda ${buildInfo.displayVersion}\n`,
  );

  const packArgs = [
    "--skip-updates",
    "--yes",
    "pack",
    "--packId",
    UPDATE_PACKAGE_ID,
    "--packTitle",
    "Eda",
    "--packVersion",
    buildInfo.version,
    "--packDir",
    platform === "osx" ? join(appOutDir, "Eda.app") : appOutDir,
    "--runtime",
    `${platform}-${arch}`,
    "--channel",
    channel,
    "--outputDir",
    output,
    "--delta",
    "None",
    "--releaseNotes",
    notes,
  ];

  if (platform === "linux") {
    packArgs.push(
      "--mainExe",
      "eda",
      "--categories",
      "Development",
      "--icon",
      resolve("build/icon.png"),
    );
  } else if (platform === "win") {
    const thumbprint = process.env["EDA_WINDOWS_CERT_SHA1"];
    if (thumbprint) {
      if (!/^[a-f0-9]{40}$/i.test(thumbprint))
        throw new Error("Invalid signing certificate thumbprint.");
      packArgs.push(
        "--signParams",
        `/sha1 ${thumbprint} /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com`,
      );
    }
    // Electron's bootstrap lives in JS/N-API rather than the stock Electron executable.
    packArgs.push(
      "--mainExe",
      "Eda.exe",
      "--skipVeloAppCheck",
      "--noPortable",
      "--icon",
      resolve("build/icon.ico"),
    );
  } else {
    packArgs.push(
      "--noInst",
      "--signAppIdentity",
      process.env["EDA_MAC_SIGN_IDENTITY"] ?? "-",
      "--signEntitlements",
      resolve("build/mac.entitlements"),
    );

    if (process.env["EDA_MAC_NOTARY_PROFILE"])
      packArgs.push("--notaryProfile", process.env["EDA_MAC_NOTARY_PROFILE"]);
  }

  execFileSync("dotnet", [...prefix, ...packArgs], { stdio: "inherit" });

  const feedPath = join(output, `releases.${channel}.json`);
  const feed = JSON.parse(await readFile(feedPath, "utf8")) as {
    Assets: VelopackAsset[];
  };

  if (
    !Array.isArray(feed.Assets) ||
    feed.Assets.length !== 1 ||
    feed.Assets[0]?.Type !== "Full" ||
    feed.Assets[0].PackageId !== UPDATE_PACKAGE_ID ||
    feed.Assets[0].Version !== buildInfo.version
  )
    throw new Error("A release must contain one full Eda package matching the app version.");

  const asset = feed.Assets[0];
  const filename = `Eda-${buildInfo.version}-${channel}-full.nupkg`;
  const packagePath = join(output, filename);

  if (filename !== asset.FileName) await rename(join(output, asset.FileName), packagePath);
  asset.FileName = filename;

  if ((await stat(packagePath)).size !== asset.Size)
    throw new Error("Package size does not match the feed.");

  const sha256 = createHash("sha256");
  const sha1 = createHash("sha1");

  for await (const chunk of createReadStream(packagePath)) {
    sha256.update(chunk);
    sha1.update(chunk);
  }

  if (
    sha256.digest("hex").toLowerCase() !== asset.SHA256.toLowerCase() ||
    sha1.digest("hex").toLowerCase() !== asset.SHA1.toLowerCase()
  )
    throw new Error("Package checksum does not match the feed.");

  await writeFile(feedPath, JSON.stringify(feed, null, 2) + "\n");

  for (const filename of await readdir(output)) {
    const suffix = filename.endsWith(".AppImage")
      ? ".AppImage"
      : filename.endsWith(".exe")
        ? "-Setup.exe"
        : filename.endsWith(".zip")
          ? "-Portable.zip"
          : null;

    if (suffix)
      await rename(
        join(output, filename),
        join(output, `Eda-${buildInfo.version}-${channel}${suffix}`),
      );
  }

  if (platform === "osx") {
    const staging = resolve(`.cache/eda-dmg-${arch}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    execFileSync("ditto", [
      "-x",
      "-k",
      join(output, `Eda-${buildInfo.version}-${channel}-Portable.zip`),
      staging,
    ]);

    await symlink("/Applications", join(staging, "Applications"));

    execFileSync(
      "hdiutil",
      [
        "create",
        "-volname",
        "Eda",
        "-srcfolder",
        staging,
        "-ov",
        "-format",
        "UDZO",
        join(output, `Eda-${buildInfo.version}-${channel}.dmg`),
      ],
      { stdio: "inherit" },
    );

    await rm(staging, { recursive: true, force: true });
    await rm(join(output, `Eda-${buildInfo.version}-${channel}-Portable.zip`));
    const diskImage = join(output, `Eda-${buildInfo.version}-${channel}.dmg`);
    const signer = process.env["EDA_MAC_SIGN_IDENTITY"];
    const notary = process.env["EDA_MAC_NOTARY_PROFILE"];
    if (signer && signer !== "-")
      execFileSync("codesign", ["--force", "--timestamp", "--sign", signer, diskImage], {
        stdio: "inherit",
      });
    if (notary) {
      execFileSync(
        "xcrun",
        [
          "notarytool",
          "submit",
          diskImage,
          "--keychain-profile",
          notary,
          "--wait",
          "--output-format",
          "json",
        ],
        { stdio: "inherit" },
      );
      execFileSync("xcrun", ["stapler", "staple", diskImage], { stdio: "inherit" });
      execFileSync("xcrun", ["stapler", "validate", diskImage], { stdio: "inherit" });
    }
  }

  const checksums: string[] = [];
  for (const name of (await readdir(output)).sort()) {
    if (name === `SHA256SUMS-${channel}` || !(await stat(join(output, name))).isFile()) continue;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(output, name))) hash.update(chunk);
    checksums.push(hash.digest("hex") + "  " + name);
  }
  await writeFile(join(output, `SHA256SUMS-${channel}`), checksums.join("\n") + "\n");
  console.log(`Velopack ${sdkVersion}: verified ${channel} packages are in ${output}`);
}
