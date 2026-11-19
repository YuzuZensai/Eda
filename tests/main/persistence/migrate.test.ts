import profileOrderSql from "@main/persistence/migrations/20261111075032_profile_order/migration.sql?raw";
import repositoryTrustSql from "@main/persistence/migrations/20261107000000_repository_trust/migration.sql?raw";
import gitlabAccountsSql from "@main/persistence/migrations/20261110074538_gitlab_self_hosted_accounts/migration.sql?raw";
import gitlabTlsSql from "@main/persistence/migrations/20261110090653_gitlab_tls_errors/migration.sql?raw";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyMigrations, type Migration } from "@main/persistence/migrate";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const initial: Migration = {
  id: "001_initial",
  sql: `CREATE TABLE parents (id TEXT PRIMARY KEY NOT NULL);
        CREATE TABLE children (id TEXT PRIMARY KEY NOT NULL, parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE);
        INSERT INTO parents VALUES ('parent');
        INSERT INTO children VALUES ('child', 'parent');`,
};

function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyMigrations(db, [initial]);
  return db;
}

it("adds strict TLS defaults without losing existing GitLab accounts", () => {
  const db = setup();

  const accounts = {
    id: "002_gitlab_accounts",
    sql: `CREATE TABLE identities (id TEXT PRIMARY KEY);
      INSERT INTO identities VALUES ('work');
      ${gitlabAccountsSql}
      INSERT INTO gitlab_self_hosted_accounts VALUES ('work', 'https://git.company.test', '7', 'work.user', 'credential-ref', 'connected');`,
  };

  applyMigrations(db, [initial, accounts]);
  const tls = { id: "003_gitlab_tls", sql: gitlabTlsSql };
  applyMigrations(db, [initial, accounts, tls]);

  expect(
    db.prepare("SELECT credential_ref, ignore_tls_errors FROM gitlab_self_hosted_accounts").get(),
  ).toEqual({ credential_ref: "credential-ref", ignore_tls_errors: 0 });

  db.exec("UPDATE gitlab_self_hosted_accounts SET ignore_tls_errors = 1");
  applyMigrations(db, [initial, accounts, tls]);

  expect(db.prepare("SELECT ignore_tls_errors FROM gitlab_self_hosted_accounts").get()).toEqual({
    ignore_tls_errors: 1,
  });
});

it("backs up the pre-upgrade database, including WAL data, without overwriting the backup", () => {
  const directory = mkdtempSync(join(tmpdir(), "eda-migration-backup-"));
  const db = new DatabaseSync(join(directory, "eda.db"));
  const backupPath = join(directory, "before-upgrade.db");

  try {
    db.exec("PRAGMA journal_mode = WAL");
    applyMigrations(db, [initial]);
    db.exec("INSERT INTO parents VALUES ('in-wal')");
    const next = { id: "002_upgrade", sql: "ALTER TABLE parents ADD COLUMN name TEXT" };
    applyMigrations(db, [initial, next], { backupPath });
    if (process.platform !== "win32") expect(statSync(backupPath).mode & 0o077).toBe(0);
    const backup = new DatabaseSync(backupPath, { readOnly: true });

    try {
      expect(backup.prepare("SELECT * FROM parents ORDER BY id").all()).toEqual([
        { id: "in-wal" },
        { id: "parent" },
      ]);

      expect(backup.prepare("SELECT id FROM __drizzle_migrations").all()).toEqual([
        { id: initial.id },
      ]);
    } finally {
      backup.close();
    }

    expect(() =>
      applyMigrations(db, [initial, next, { id: "003_more", sql: "SELECT 1" }], { backupPath }),
    ).toThrow();

    expect(db.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get()).toEqual({
      count: 2,
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rebuilds a parent table without cascading deletion into its children", () => {
  const db = setup();

  const rebuild: Migration = {
    id: "002_rebuild",
    sql: `CREATE TABLE parents_new (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL DEFAULT 'new');
          INSERT INTO parents_new (id) SELECT id FROM parents;
          DROP TABLE parents;
          ALTER TABLE parents_new RENAME TO parents;`,
  };

  applyMigrations(db, [initial, rebuild]);
  applyMigrations(db, [initial, rebuild]);

  expect(db.prepare("SELECT * FROM children").all()).toEqual([
    { id: "child", parent_id: "parent" },
  ]);

  expect(db.prepare("SELECT * FROM parents").all()).toEqual([{ id: "parent", name: "new" }]);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

  expect(
    db
      .prepare("SELECT id, length(hash) AS hash_length FROM __drizzle_migrations ORDER BY id")
      .all(),
  ).toEqual([
    { id: initial.id, hash_length: 64 },
    { id: rebuild.id, hash_length: 64 },
  ]);
});

it.each([
  ["invalid foreign keys", "DELETE FROM parents;"],
  ["SQL failures", "CREATE TABLE temporary_table (id TEXT); INSERT INTO missing_table VALUES (1);"],
])(
  "rolls back the entire pending batch on %s and restores foreign key enforcement",
  (_name, sql) => {
    const db = setup();

    expect(() =>
      applyMigrations(db, [
        initial,
        { id: "002_pending", sql: "CREATE TABLE pending_table (id TEXT);" },
        { id: "003_failure", sql },
      ]),
    ).toThrow();

    expect(db.prepare("SELECT * FROM children").all()).toEqual([
      { id: "child", parent_id: "parent" },
    ]);

    expect(db.prepare("SELECT * FROM parents").all()).toEqual([{ id: "parent" }]);
    expect(db.prepare("SELECT id FROM __drizzle_migrations").all()).toEqual([{ id: initial.id }]);

    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('pending_table', 'temporary_table')",
        )
        .all(),
    ).toEqual([]);

    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.isTransaction).toBe(false);
  },
);

it.each([
  ["edited SQL", [{ ...initial, sql: initial.sql + "\n-- changed" }]],
  ["unknown migrations", []],
  ["a missing earlier migration", [{ id: "000_inserted", sql: "SELECT 1" }, initial]],
])("refuses %s without modifying existing data", (_name, migrations) => {
  const db = setup();
  expect(() => applyMigrations(db, migrations)).toThrow(/history does not match/);
  expect(db.prepare("SELECT * FROM parents").all()).toEqual([{ id: "parent" }]);
  expect(db.prepare("SELECT id FROM __drizzle_migrations").all()).toEqual([{ id: initial.id }]);
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
});

it("rejects duplicate or unordered migration IDs", () => {
  const db = setup();
  expect(() => applyMigrations(db, [initial, initial])).toThrow(/unique and ordered/);

  expect(() => applyMigrations(db, [{ id: "002_later", sql: "SELECT 1" }, initial])).toThrow(
    /unique and ordered/,
  );
});

it("opens the earlier repository trust schema while rejecting other edits to the same migration", () => {
  const db = setup();
  const id = "20261107000000_repository-trust";
  const earlierSql =
    "CREATE TABLE repository_trust (\n  path TEXT PRIMARY KEY NOT NULL,\n  fingerprint TEXT NOT NULL\n);\n";
  applyMigrations(db, [initial, { id, sql: earlierSql }]);
  db.exec("INSERT INTO repository_trust VALUES ('/fixture', 'saved')");

  applyMigrations(db, [initial, { id, sql: repositoryTrustSql }]);

  expect(
    db.prepare("SELECT fingerprint FROM repository_trust WHERE path = '/fixture'").get(),
  ).toEqual({
    fingerprint: "saved",
  });

  expect(() =>
    applyMigrations(db, [initial, { id, sql: repositoryTrustSql + "\nSELECT 1;" }]),
  ).toThrow(/history does not match/);
});

it("removes legacy GitHub connections through the SQL migration and preserves OAuth connections on reruns", async () => {
  const { default: initialSql } =
    await import("@main/persistence/migrations/20261030212245_initial_schema/migration.sql?raw");
  const { default: oauthSql } =
    await import("@main/persistence/migrations/20261108000000_github_oauth/migration.sql?raw");
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const initial = { id: "20261030212245_initial-schema", sql: initialSql };
  const upgrade = { id: "20261108000000_github-oauth", sql: oauthSql };
  applyMigrations(db, [initial]);

  for (const [id, provider, state] of [
    ["work", "github", "connected"],
    ["personal", "github", "expired"],
    ["old", "github", "revoked"],
    ["new", "github-oauth", "connected"],
  ]) {
    db.prepare(
      "INSERT INTO identities (id, name, name_key, git_name, git_email, created_at, updated_at) VALUES (?, ?, ?, 'Eda', 'eda@example.test', 'now', 'now')",
    ).run(id!, id!, id!);

    const ref = `identity:${id}:provider:${JSON.stringify([id, provider, "github.com", "7"])}:token`;
    db.prepare("INSERT INTO github_accounts VALUES (?, '7', 'user', ?, ?)").run(id!, ref, state!);
  }

  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
    "theme",
    JSON.stringify("saved"),
  );

  applyMigrations(db, [initial, upgrade]);

  expect(db.prepare("SELECT profile_id FROM github_accounts").all()).toEqual([
    { profile_id: "new" },
  ]);

  expect(db.prepare("SELECT COUNT(*) AS count FROM identities").get()).toEqual({ count: 4 });

  expect(db.prepare("SELECT value FROM settings WHERE key = 'theme'").get()).toEqual({
    value: JSON.stringify("saved"),
  });

  applyMigrations(db, [initial, upgrade]);

  expect(db.prepare("SELECT profile_id FROM github_accounts").all()).toEqual([
    { profile_id: "new" },
  ]);
});

it("accepts underscore names for applied migrations without rewriting history or rerunning SQL", () => {
  const db = setup();
  const legacy = { id: "002_cleanup-old", sql: "DELETE FROM children;" };
  applyMigrations(db, [initial, legacy]);
  db.exec("INSERT INTO children VALUES ('after-cleanup', 'parent')");
  applyMigrations(db, [initial, { ...legacy, id: "002_cleanup_old" }]);
  expect(db.prepare("SELECT id FROM children").all()).toEqual([{ id: "after-cleanup" }]);

  expect(db.prepare("SELECT id FROM __drizzle_migrations ORDER BY id").all()).toEqual([
    { id: initial.id },
    { id: legacy.id },
  ]);

  expect(() => applyMigrations(db, [initial, { id: "002_cleanup_old", sql: "SELECT 1;" }])).toThrow(
    /history does not match/,
  );
});

it("rejects migration names that differ only by separators", () => {
  const db = setup();

  expect(() =>
    applyMigrations(db, [
      initial,
      { id: "002_cleanup-old", sql: "SELECT 1;" },
      { id: "002_cleanup_old", sql: "SELECT 1;" },
    ]),
  ).toThrow(/unique and ordered/);
});

it("preserves alphabetical profile order when adding saved positions", () => {
  const db = setup();
  const profiles = {
    id: "002_profiles",
    sql: `CREATE TABLE identities (id TEXT PRIMARY KEY, name_key TEXT NOT NULL);
      INSERT INTO identities VALUES ('work', 'work'), ('home', 'home'), ('alpha', 'alpha');`,
  };

  applyMigrations(db, [initial, profiles, { id: "003_order", sql: profileOrderSql }]);

  expect(db.prepare("SELECT id, sort_order FROM identities ORDER BY sort_order").all()).toEqual([
    { id: "alpha", sort_order: 0 },
    { id: "home", sort_order: 1 },
    { id: "work", sort_order: 2 },
  ]);
});

it("removes profile path rules while preserving profiles, memberships, credentials, and saved work", () => {
  const sql = import.meta.glob<string>("../../../src/main/persistence/migrations/*/migration.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const migrations = Object.entries(sql)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, sql]) => ({ id: path.split("/").at(-2)!, sql }));
  const upgradeIndex = migrations.findIndex((migration) =>
    migration.id.endsWith("remove_profile_path_rules"),
  );
  expect(upgradeIndex).toBeGreaterThan(0);
  const upgrade = migrations.slice(0, upgradeIndex + 1);
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyMigrations(db, migrations.slice(0, upgradeIndex));
  db.exec(`
    INSERT INTO identities (id, name, name_key, sort_order, git_name, git_email, ssh_key_path, signing_format, signing_key_ref, sign_commits, rules, created_at, updated_at)
    VALUES ('work', 'Work', 'work', 4, 'Author', 'work@example.com', '/keys/work', 'ssh', '/keys/work.pub', 1, '["~/Work/*"]', 'created', 'updated');
    INSERT INTO app_state (id, active_identity_id) VALUES (1, 'work');
    INSERT INTO repositories (id, identity_id, name, path, created_at) VALUES ('repo', 'work', 'Repo', '/work/repo', 'created');
    INSERT INTO github_accounts VALUES ('work', '7', 'author', 'secret-ref', 'connected');
    INSERT INTO profile_sessions VALUES ('work', 'primary', '{}');
    INSERT INTO profile_drafts VALUES ('work', 'repo', '{"message":"unsent"}');
    INSERT INTO setting_overrides VALUES ('override', 'work', NULL, 'accentHue', '330');
  `);
  const tables = [
    "app_state",
    "repositories",
    "github_accounts",
    "profile_sessions",
    "profile_drafts",
    "setting_overrides",
  ];
  const before = tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  const profile = db.prepare("SELECT * FROM identities").get()!;
  const { rules, ...expectedProfile } = profile;
  expect(rules).toBe('["~/Work/*"]');

  applyMigrations(db, upgrade);
  applyMigrations(db, upgrade);

  expect(db.prepare("SELECT * FROM identities").get()).toEqual(expectedProfile);
  expect(tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
