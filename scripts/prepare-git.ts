import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { prepareOpenSsh, sshArtifacts, verifySshTools } from "./prepare-openssh.ts";
import { x as extract } from "tar";

const project = fileURLToPath(new URL("..", import.meta.url));
const bundleLayout = 2;

interface GitArtifact {
  url: string;
  sha256: string;
}

const manifest = JSON.parse(
  await readFile(new URL("./bundled-git.json", import.meta.url), "utf8"),
) as {
  release: string;
  targets: Record<string, GitArtifact>;
};

const platforms: Record<string, string> = { win32: "win", darwin: "mac", linux: "linux" };

export function targetFor(platform: string, arch: string) {
  const artifact = manifest.targets[`${platform}-${arch}`];

  if (!artifact) throw new Error(`Bundled Git does not support ${platform}/${arch}.`);

  return {
    ...artifact,
    directory: `${platforms[platform]}-${arch}`,
    executable: platform === "win32" ? "cmd/git.exe" : "bin/git",
  };
}

export async function verifyArchive(path: string, expected: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expected)
    throw new Error("Bundled Git checksum mismatch. Refusing to extract or run it.");
}

export async function pruneCredentialManager(root: string): Promise<void> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const directories = new Set(
    entries
      .filter(
        (entry) =>
          (entry.isFile() || entry.isSymbolicLink()) &&
          /^git-credential-manager(?:\.exe|\.deps\.json)?$/.test(entry.name),
      )
      .map((entry) => entry.parentPath),
  );

  for (const directory of directories) {
    const files = new Set([
      "git-credential-manager",
      "git-credential-manager.exe",
      "git-credential-manager.dll",
      "git-credential-manager.deps.json",
      "git-credential-manager.runtimeconfig.json",
      "libSkiaSharp.so",
      "libHarfBuzzSharp.so",
    ]);
    let manifest:
      | {
          targets: Record<string, Record<string, Record<string, Record<string, unknown>>>>;
        }
      | undefined;
    try {
      manifest = JSON.parse(
        await readFile(join(directory, "git-credential-manager.deps.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const target of Object.values(manifest?.targets ?? {}))
      for (const dependency of Object.values(target))
        for (const section of ["runtime", "native", "runtimeTargets", "resources"]) {
          for (const asset of Object.keys(dependency[section] ?? {})) {
            const file = section === "resources" ? asset : basename(asset);
            if (file.split(/[\\/]/).some((part) => part === "..") || /^[\\/]/.test(file))
              throw new Error("Invalid Git Credential Manager asset path.");
            files.add(file);
          }
        }
    await Promise.all([...files].map((file) => rm(join(directory, file), { force: true })));
  }
}

async function downloadArchive(target: GitArtifact, cache: string) {
  const archive = join(cache, `${target.sha256}.tar.gz`);

  try {
    await verifyArchive(archive, target.sha256);
  } catch {
    const partial = join(cache, `${target.sha256}.${process.pid}.download`);

    try {
      console.log(`Downloading ${basename(target.url)}...`);

      const response = await fetch(target.url, { signal: AbortSignal.timeout(180_000) });

      if (!response.ok || !response.body)
        throw new Error(`Package download failed: HTTP ${response.status}`);

      await pipeline(response.body, createWriteStream(partial, { flags: "wx", mode: 0o600 }));
      await verifyArchive(partial, target.sha256);
      await rename(partial, archive);
    } finally {
      await rm(partial, { force: true });
    }
  }

  return archive;
}

export async function prepareGit(platform: string = process.platform, arch: string = process.arch) {
  const target = targetFor(platform, arch);
  const sshManifestHash = createHash("sha256")
    .update(JSON.stringify(sshArtifacts(platform, arch)))
    .digest("hex");
  const parent = resolve(project, "vendor/git");
  const destination = join(parent, target.directory);

  try {
    const installed = JSON.parse(await readFile(join(destination, "eda-bundle.json"), "utf8"));
    await access(join(destination, target.executable));
    await verifySshTools(platform, destination);
    if (
      process.env["EDA_RELEASE"] !== "1" &&
      installed.sha256 === target.sha256 &&
      installed.bundleLayout === bundleLayout &&
      installed.sshManifestHash === sshManifestHash
    )
      return destination;
  } catch {}

  const cache = resolve(project, ".cache/bundled-git");

  await mkdir(cache, { recursive: true });
  await mkdir(parent, { recursive: true });

  const archive = await downloadArchive(target, cache);

  const staging = await mkdtemp(join(parent, ".extract-"));

  try {
    await extract({ file: archive, cwd: staging, strict: true, preservePaths: false });
    await access(join(staging, target.executable));
    await pruneCredentialManager(staging);
    await prepareOpenSsh(platform, arch, staging, (item) => downloadArchive(item, cache));
    await verifySshTools(platform, staging);
    await writeFile(
      join(staging, "eda-bundle.json"),
      JSON.stringify(
        { release: manifest.release, bundleLayout, sshManifestHash, ...target },
        null,
        2,
      ),
    );

    if (dirname(destination) !== parent) throw new Error("Invalid Git bundle destination.");

    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    console.log(`Bundled Git ready: ${destination}`);
  } finally {
    if (dirname(staging) !== parent) throw new Error("Invalid extraction directory.");
    await rm(staging, { recursive: true, force: true });
  }

  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareGit(process.argv[2] ?? process.platform, process.argv[3] ?? process.arch);
}
