import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { access, mkdir, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { zstdDecompressSync } from "node:zlib";
import { x } from "tar";

interface PackageArchive {
  name: string;
  url: string;
  sha256: string;
}
const packages = JSON.parse(
  await readFile(new URL("./bundled-openssh.json", import.meta.url), "utf8"),
) as Record<string, PackageArchive[]>;
const clientFile =
  /^(?:bin\/(?:ssh|ssh-agent|ssh-add|ssh-keygen)|libexec\/ssh-(?:sk|pkcs11)-helper|lib\/(?:[^/]+\.so(?:\.[\d.]+)?|[^/]+\.dylib))$/;
const noticeFile = /^info\/(?:licenses\/|recipe\/(?:meta|recipe)\.yaml$|about\.json$)/;
const limit = 256 * 1024 * 1024;

export function sshArtifacts(platform: string, arch: string) {
  const target = packages[platform === "win32" ? "win32" : platform + "-" + arch];
  if (!target) throw new Error("Unsupported OpenSSH distribution");
  return target;
}

export async function verifySshTools(platform: string, root: string) {
  const win = platform === "win32";
  await Promise.all(
    ["ssh", "ssh-agent", "ssh-add", "ssh-keygen"].map((tool) =>
      access(join(root, win ? "usr/bin" : "openssh/bin", win ? tool + ".exe" : tool)),
    ),
  );
}

export async function prepareOpenSsh(
  platform: string,
  arch: string,
  staging: string,
  download: (item: PackageArchive) => Promise<string>,
) {
  const target = sshArtifacts(platform, arch);
  if (platform === "win32") {
    // Both Git for Windows builds ship the x64 MSYS runtime and omit ssh-keygen.
    const archive = await download(target[0]!);
    const bytes = zstdDecompressSync(await readFile(archive), { maxOutputLength: limit });
    await pipeline(
      Readable.from([bytes]),
      x({
        cwd: staging,
        strict: true,
        filter: (path) =>
          path === "usr/bin/ssh-keygen.exe" || path === "usr/share/licenses/openssh/LICENCE",
      }),
    );
    return;
  }
  const directory = join(staging, "openssh");
  await mkdir(directory, { recursive: true });
  for (const item of target) {
    const file = await download(item);
    const notices = join(directory, "licenses", item.name);
    await mkdir(notices, { recursive: true });
    const unpack = async (bytes: Buffer, metadata: boolean) => {
      // Conda metapackages can contain an empty tar stream.
      if (bytes.length >= 1024 && bytes.every((byte) => byte === 0)) return;
      await pipeline(
        Readable.from([bytes]),
        x({
          cwd: metadata ? notices : directory,
          strict: true,
          filter: (path) => (metadata ? noticeFile : clientFile).test(path),
        }),
      );
    };
    if (item.url.endsWith(".tar.bz2")) {
      const bytes = execFileSync("bzip2", ["-dc", file], { maxBuffer: limit });
      await unpack(bytes, false);
      await unpack(bytes, true);
    } else {
      for (const section of ["pkg", "info"]) {
        const name = basename(item.url, ".conda");
        const archive = execFileSync("unzip", ["-p", file, `${section}-${name}.tar.zst`], {
          maxBuffer: limit,
        });
        await unpack(zstdDecompressSync(archive, { maxOutputLength: limit }), section === "info");
      }
    }
  }
}
