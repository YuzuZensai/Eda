import * as fs from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDatabase } from "@main/persistence/database";
import { SettingsRepository } from "@main/persistence/settings-repository";
import {
  applyReleaseDataImport,
  prepareReleaseDataImport,
} from "@main/persistence/import-release-data";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

let root: string;
let release: string;
let development: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "eda-release-import-"));
  release = join(root, "Eda");
  development = join(root, "Eda-Dev");
  await mkdir(release);
  await mkdir(development);
  for (const [path, strength] of [
    [release, 70],
    [development, 20],
  ] as const) {
    const db = openDatabase(join(path, "eda.db"));
    new SettingsRepository(db).set(
      "background",
      { kind: "application" },
      { image: "", strength, blur: 2 },
    );
    db.close();
  }
  await writeFile(join(development, "secrets.vault"), "development credentials");
});

afterEach(async () => {
  vi.mocked(fs.renameSync).mockRestore();
  await rm(root, { recursive: true, force: true });
});

function strength(path: string): number {
  const db = openDatabase(join(path, "eda.db"));
  try {
    return new SettingsRepository(db).resolve("background").value.strength;
  } finally {
    db.close();
  }
}

it("stages committed WAL data without changing release data, then replaces development data on startup", async () => {
  const db = openDatabase(join(release, "eda.db"));
  try {
    new SettingsRepository(db).set(
      "background",
      { kind: "application" },
      { image: "", strength: 85, blur: 2 },
    );
    const releaseBytes = await readFile(join(release, "eda.db"));
    await writeFile(join(release, "secrets.vault"), "release credentials");
    await writeFile(join(development, "unrelated"), "keep");
    await prepareReleaseDataImport(release, development);
    expect(strength(development)).toBe(20);
    expect(await readFile(join(release, "eda.db"))).toEqual(releaseBytes);
    applyReleaseDataImport(development);
    expect(strength(development)).toBe(85);
    expect(strength(release)).toBe(85);
    expect(await readFile(join(development, "secrets.vault"), "utf8")).toBe("release credentials");
    expect(await readFile(join(release, "secrets.vault"), "utf8")).toBe("release credentials");
    expect(await readFile(join(development, "unrelated"), "utf8")).toBe("keep");
    expect((await readdir(development)).some((name) => name.startsWith(".release-import"))).toBe(
      false,
    );
  } finally {
    db.close();
  }
});

it("removes development credentials and stale SQLite sidecars when release has no vault", async () => {
  await prepareReleaseDataImport(release, development);
  for (const name of ["eda.db-wal", "eda.db-shm", "eda.db-journal"])
    await writeFile(join(development, name), "stale");
  applyReleaseDataImport(development);
  expect(await readdir(development)).toEqual(["eda.db"]);
  expect(strength(development)).toBe(70);
});

it("preserves development data when the release migration history is incompatible", async () => {
  const db = openDatabase(join(release, "eda.db"));
  db.raw.exec("UPDATE __drizzle_migrations SET hash = 'incompatible'");
  db.close();
  await expect(prepareReleaseDataImport(release, development)).rejects.toThrow();
  expect(strength(development)).toBe(20);
  expect(await readFile(join(development, "secrets.vault"), "utf8")).toBe(
    "development credentials",
  );
  expect(await readdir(development)).toEqual(["eda.db", "secrets.vault"]);
});

it("refuses to overwrite the release folder even through an alias", async () => {
  await expect(prepareReleaseDataImport(release, release)).rejects.toThrow();
  if (process.platform !== "win32") {
    const alias = join(root, "alias");
    await symlink(release, alias);
    await expect(prepareReleaseDataImport(release, alias)).rejects.toThrow();
  }
  expect(strength(release)).toBe(70);
});

it("rolls back the development database and credentials if installing the copied vault fails", async () => {
  await writeFile(join(release, "secrets.vault"), "release credentials");
  await prepareReleaseDataImport(release, development);
  const rename = fs.renameSync;
  const original = vi.mocked(rename).getMockImplementation()!;
  vi.mocked(rename).mockImplementation((source, destination) => {
    if (String(source).endsWith(join(".release-import-pending", "secrets.vault")))
      throw new Error("fixture installation failure");
    original(source, destination);
  });
  expect(() => applyReleaseDataImport(development)).toThrow("fixture installation failure");
  expect(strength(development)).toBe(20);
  expect(await readFile(join(development, "secrets.vault"), "utf8")).toBe(
    "development credentials",
  );
  expect(strength(release)).toBe(70);
});

it.each([
  ...[0, 1, 2, 3, 4].map((count) => ({ count, journal: true })),
  ...[1, 2, 3, 4].map((count) => ({ count, journal: false })),
])(
  "restores both original files after interruption at rename $count (journal=$journal)",
  async ({ count, journal }) => {
    await writeFile(join(release, "secrets.vault"), "new vault");
    await prepareReleaseDataImport(release, development);
    const stage = join(development, ".release-import-pending");
    const names = ["eda.db", "secrets.vault"];
    if (journal) await writeFile(join(stage, "original-files.json"), JSON.stringify(names));
    const moves = [
      ...names.map((name) => [join(development, name), join(stage, "previous-" + name)] as const),
      ...names.map((name) => [join(stage, name), join(development, name)] as const),
    ];
    for (const [from, to] of moves.slice(0, count)) fs.renameSync(from, to);
    expect(applyReleaseDataImport(development, false)).toBe(true);
    expect(strength(development)).toBe(20);
    expect(await readFile(join(development, "secrets.vault"), "utf8")).toBe(
      "development credentials",
    );
  },
);

it("finishes interrupted cleanup on an ordinary development restart", async () => {
  const retired = join(development, ".release-import-retired");
  await mkdir(retired);
  await writeFile(join(retired, "previous-secrets.vault"), "old vault");
  expect(applyReleaseDataImport(development, false)).toBe(true);
  expect(await readdir(development)).toEqual(["eda.db", "secrets.vault"]);
  expect(strength(development)).toBe(20);
  expect(applyReleaseDataImport(development, false)).toBe(false);
});
