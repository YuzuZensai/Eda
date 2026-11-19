import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "@main/persistence/migrate";
import initialSql from "@main/persistence/migrations/20261030212245_initial_schema/migration.sql?raw";
import { openDatabase } from "@main/persistence/database";
import { clearDatabase } from "@main/persistence/reset-data";
import { expect, it } from "vitest";

it("wipes every user table but preserves migrations and a usable fresh database", async () => {
  const { openInMemoryDatabase } = await import("@main/persistence/database");
  const { SettingsRepository } = await import("@main/persistence/settings-repository");
  const { IdentityRepository } = await import("@main/persistence/identity-repository");
  const db = openInMemoryDatabase();
  try {
    const settings = new SettingsRepository(db);
    const profiles = new IdentityRepository(db, settings);
    const profile = profiles.create({
      name: "Old profile",
      gitName: "Old author",
      gitEmail: "old@example.com",
      hue: 210,
      signing: { format: "none", signCommits: false },
    });
    profiles.setActiveId(profile.id);
    settings.set("background", { kind: "application" }, { image: "", strength: 70, blur: 12 });
    const migrations = db.raw.prepare("SELECT * FROM __drizzle_migrations").all();
    clearDatabase(db);
    expect(profiles.list()).toEqual([]);
    expect(profiles.getActiveId()).toBeNull();
    expect(settings.resolve("background").value).toEqual({ image: "", strength: 20, blur: 2 });
    expect(db.raw.prepare("SELECT * FROM __drizzle_migrations").all()).toEqual(migrations);
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const fresh = profiles.create({
      name: "New profile",
      gitName: "New author",
      gitEmail: "new@example.com",
      hue: 210,
      signing: { format: "none", signCommits: false },
    });
    profiles.setActiveId(fresh.id);
    expect(profiles.getActiveId()).toBe(fresh.id);
  } finally {
    db.close();
  }
});

it("removes generated pre-upgrade backups while preserving unrelated files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eda-reset-"));
  try {
    const path = join(dir, "eda.db");
    const old = new DatabaseSync(path);
    try {
      applyMigrations(old, [{ id: "20261030212245_initial-schema", sql: initialSql }]);
    } finally {
      old.close();
    }
    await writeFile(path + ".backup-personal", "user file");
    const db = openDatabase(path);
    try {
      expect((await readdir(dir)).filter((name) => name.startsWith("eda.db.backup-"))).toHaveLength(
        2,
      );
      clearDatabase(db);
      expect((await readdir(dir)).filter((name) => name.startsWith("eda.db.backup-"))).toEqual([
        "eda.db.backup-personal",
      ]);
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("recovers from an unusable database without opening it and preserves repository and SSH key files", async () => {
  const { mkdir, readFile } = await import("node:fs/promises");
  const { clearStartupData } = await import("@main/persistence/reset-data");
  const dir = await mkdtemp(join(tmpdir(), "eda-startup-reset-"));
  try {
    const managed = [
      "eda.db",
      "eda.db-wal",
      "eda.db-shm",
      "eda.db-journal",
      "secrets.vault",
      "eda.db.backup-123-12345678-1234-1234-1234-123456789abc",
    ];
    for (const name of managed) await writeFile(join(dir, name), "unusable data");
    await mkdir(join(dir, "repository"));
    await writeFile(join(dir, "repository", "eda.db"), "repository content");
    await writeFile(join(dir, "id_ed25519"), "SSH key");
    await writeFile(join(dir, "eda.db.backup-personal"), "user backup");
    clearStartupData(dir);
    expect((await readdir(dir)).sort()).toEqual([
      "eda.db.backup-personal",
      "id_ed25519",
      "repository",
    ]);
    expect(await readFile(join(dir, "repository", "eda.db"), "utf8")).toBe("repository content");
    expect(await readFile(join(dir, "id_ed25519"), "utf8")).toBe("SSH key");
    const fresh = openDatabase(join(dir, "eda.db"));
    try {
      expect(fresh.raw.prepare("SELECT COUNT(*) AS count FROM identities").get()).toEqual({
        count: 0,
      });
      expect(fresh.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      fresh.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
