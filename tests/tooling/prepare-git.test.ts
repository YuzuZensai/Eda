import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, writeFile, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  publishGitBundle,
  pruneCredentialManager,
  targetFor,
  verifyArchive,
} from "../../scripts/prepare-git.ts";

test("each supported package target has a pinned upstream checksum", () => {
  for (const platform of ["win32", "darwin", "linux"])
    for (const arch of ["x64", "arm64"]) {
      const target = targetFor(platform, arch);

      assert.match(
        target.url,
        /^https:\/\/github.com\/desktop\/dugite-native\/releases\/download\//,
      );
      assert.match(target.sha256, /^[0-9a-f]{64}$/);
      assert.equal(target.executable, platform === "win32" ? "cmd/git.exe" : "bin/git");
    }

  assert.throws(() => targetFor("win32", "../../outside"), /does not support/);
});

test("a modified download is rejected before extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "eda-bundle-test-"));

  try {
    const archive = join(root, "archive");
    const expected = createHash("sha256").update("original archive").digest("hex");
    await writeFile(archive, "original archive");
    await verifyArchive(archive, expected);
    await writeFile(archive, "tampered archive");
    await assert.rejects(verifyArchive(archive, expected), /checksum mismatch/);
  } finally {
    await rm(join(root, "archive"), { force: true });
    await rmdir(root);
  }
});

test("prunes GCM and its manifest-owned runtime without removing Git transports or LFS", async () => {
  const root = await mkdtemp(join(tmpdir(), "eda-gcm-test-"));
  const core = join(root, "libexec/git-core");
  await mkdir(join(core, "fr"), { recursive: true });
  const removed = [
    "git-credential-manager",
    "git-credential-manager.dll",
    "git-credential-manager.deps.json",
    "git-credential-manager.runtimeconfig.json",
    "System.Private.CoreLib.dll",
    "libcoreclr.dylib",
    "libSkiaSharp.dylib",
    "fr/System.CommandLine.resources.dll",
  ];
  const retained = ["git", "git-lfs", "git-remote-http", "git-credential-osxkeychain", "NOTICE"];
  try {
    for (const file of [...removed, ...retained]) await writeFile(join(core, file), "fixture");
    await writeFile(
      join(core, "git-credential-manager.deps.json"),
      JSON.stringify({
        targets: {
          "net/osx-arm64": {
            runtime: {
              runtime: { "System.Private.CoreLib.dll": {} },
              native: { "libcoreclr.dylib": {} },
              runtimeTargets: { "runtimes/osx/native/libSkiaSharp.dylib": {} },
              resources: { "fr/System.CommandLine.resources.dll": {} },
            },
          },
        },
      }),
    );
    await pruneCredentialManager(root);
    for (const file of removed) await assert.rejects(access(join(core, file)), { code: "ENOENT" });
    for (const file of retained) await access(join(core, file));
    await pruneCredentialManager(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prunes the Linux single-file GCM without a .NET manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "eda-gcm-linux-test-"));
  try {
    for (const file of [
      "git-credential-manager",
      "libSkiaSharp.so",
      "libHarfBuzzSharp.so",
      "git-lfs",
    ])
      await writeFile(join(root, file), "fixture");
    await pruneCredentialManager(root);
    await access(join(root, "git-lfs"));
    for (const file of ["git-credential-manager", "libSkiaSharp.so", "libHarfBuzzSharp.so"])
      await assert.rejects(access(join(root, file)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps Windows documentation directories named git-credential-manager", async () => {
  const root = await mkdtemp(join(tmpdir(), "eda-gcm-windows-test-"));
  const binaries = join(root, "ucrt64/bin");
  const documentation = join(root, "ucrt64/doc/git-credential-manager");

  try {
    await mkdir(binaries, { recursive: true });
    await mkdir(documentation, { recursive: true });
    await writeFile(join(binaries, "git-credential-manager.exe"), "fixture");
    await writeFile(join(binaries, "git.exe"), "fixture");
    await writeFile(join(documentation, "README.md"), "fixture");

    await pruneCredentialManager(root);

    await assert.rejects(access(join(binaries, "git-credential-manager.exe")), { code: "ENOENT" });
    await access(join(binaries, "git.exe"));
    await access(join(documentation, "README.md"));
    await pruneCredentialManager(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps an installed bundle when publishing its replacement fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "eda-git-publish-"));
  try {
    const destination = join(root, "installed");
    await mkdir(destination);
    await writeFile(join(destination, "old"), "working");
    await assert.rejects(publishGitBundle(join(root, "missing"), destination), { code: "ENOENT" });
    await access(join(destination, "old"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
