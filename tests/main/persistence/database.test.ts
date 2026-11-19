import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase, openInMemoryDatabase } from "@main/persistence/database";
import { IdentityRepository } from "@main/persistence/identity-repository";
import * as schema from "@main/persistence/schema";
import { appState, identities, repositories, settings } from "@main/persistence/schema";

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

async function fileDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "eda-db-"));
  dirs.push(dir);
  return { path: join(dir, "nested", "eda.db"), dir };
}

const identity = (id: string) => ({
  id,
  name: id,
  nameKey: id,
  gitName: "Eda",
  gitEmail: "eda@example.com",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

describe("database initialization", () => {
  it("creates every table the application reads", () => {
    const db = openInMemoryDatabase();

    try {
      for (const table of Object.values(schema)) {
        expect(() => db.select().from(table).all()).not.toThrow();
      }
    } finally {
      db.close();
    }
  });

  it("is idempotent across reopens of the same file", async () => {
    const { path } = await fileDatabase();

    const first = openDatabase(path);
    const membership = {
      id: "repo",
      identityId: "work",
      name: "repo",
      path: "/repos/repo",
      createdAt: "now",
    };

    try {
      first.insert(identities).values(identity("work")).run();
      first.insert(repositories).values(membership).run();
      first
        .insert(settings)
        .values({
          key: "theme",
          value: JSON.stringify({ mode: "dark", light: "nord-light", dark: "nord" }),
        })
        .run();
      first.update(appState).set({ activeIdentityId: "work" }).run();
    } finally {
      first.close();
    }

    const second = openDatabase(path);

    try {
      expect(second.select().from(identities).get()).toMatchObject(identity("work"));
      expect(second.select().from(repositories).get()).toMatchObject(membership);
      expect(second.select().from(settings).all()).toEqual([
        {
          key: "theme",
          value: JSON.stringify({ mode: "dark", light: "nord-light", dark: "nord" }),
        },
      ]);
      expect(second.select().from(appState).get()?.activeIdentityId).toBe("work");
    } finally {
      second.close();
    }
  });
});

describe("schema constraints", () => {
  it("seeds exactly one app_state row and refuses a second", () => {
    const db = openInMemoryDatabase();
    expect(db.select().from(appState).all()).toEqual([{ id: 1, activeIdentityId: null }]);
    expect(() => db.insert(appState).values({ id: 2 }).run()).toThrow();
  });

  it("enforces the signing format check", () => {
    const db = openInMemoryDatabase();

    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO identities (id, name, name_key, git_name, git_email, signing_format, sign_commits, created_at, updated_at)
           VALUES ('x', 'x', 'x', 'n', 'e', 'x509', 0, 'now', 'now')`,
        )
        .run(),
    ).toThrow();
  });

  it("rejects a duplicate identity name", () => {
    const db = openInMemoryDatabase();

    db.insert(identities).values(identity("work")).run();
    expect(() =>
      db
        .insert(identities)
        .values({ ...identity("other"), name: "work", nameKey: "work" })
        .run(),
    ).toThrow();
  });

  it("cascades repository deletion when its identity is removed", () => {
    const db = openInMemoryDatabase();

    db.insert(identities).values(identity("work")).run();
    db.insert(repositories)
      .values({
        id: "r1",
        identityId: "work",
        name: "infra",
        path: "/repos/infra",
        createdAt: "now",
      })
      .run();

    db.delete(identities).where(eq(identities.id, "work")).run();
    expect(db.select().from(repositories).all()).toEqual([]);
  });

  it("clears the active identity rather than orphaning it", () => {
    const db = openInMemoryDatabase();
    db.insert(identities).values(identity("work")).run();
    db.update(appState).set({ activeIdentityId: "work" }).where(eq(appState.id, 1)).run();

    db.delete(identities).where(eq(identities.id, "work")).run();
    expect(db.select().from(appState).get()?.activeIdentityId).toBeNull();
  });

  it("refuses a repository whose identity does not exist", () => {
    const db = openInMemoryDatabase();

    expect(() =>
      db
        .insert(repositories)
        .values({
          id: "r1",
          identityId: "ghost",
          name: "x",
          path: "/x",
          createdAt: "now",
        })
        .run(),
    ).toThrow();
  });

  it("rejects the same path twice under one identity but allows it across identities", () => {
    const db = openInMemoryDatabase();

    db.insert(identities).values(identity("work")).run();
    db.insert(identities).values(identity("personal")).run();

    const repo = { name: "infra", path: "/repos/infra", createdAt: "now" };

    db.insert(repositories)
      .values({ id: "r1", identityId: "work", ...repo })
      .run();
    expect(() =>
      db
        .insert(repositories)
        .values({ id: "r2", identityId: "work", ...repo })
        .run(),
    ).toThrow();
    expect(() =>
      db
        .insert(repositories)
        .values({ id: "r3", identityId: "personal", ...repo })
        .run(),
    ).not.toThrow();
  });

  it("applies column defaults", () => {
    const db = openInMemoryDatabase();

    db.raw
      .prepare(
        `INSERT INTO identities (id, name, name_key, git_name, git_email, created_at, updated_at)
         VALUES ('d', 'd', 'd', 'n', 'e', 'now', 'now')`,
      )
      .run();

    expect(db.select().from(identities).get()).toMatchObject({
      signingFormat: "none",
      signCommits: 0,
    });
  });
});

function ownedDatabase() {
  const db = openInMemoryDatabase();
  db.insert(identities)
    .values([identity("work"), identity("personal")])
    .run();
  db.insert(repositories)
    .values({ id: "repo", identityId: "work", name: "repo", path: "/repo", createdAt: "now" })
    .run();
  return db;
}

it("requires all text primary keys to be non-null in the generated SQL", () => {
  const db = openInMemoryDatabase();
  try {
    const tables = db.raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as {
      name: string;
    }[];
    for (const { name } of tables) {
      const columns = db.raw.prepare(`PRAGMA table_info("${name}")`).all() as {
        name: string;
        pk: number;
        type: string;
        notnull: number;
      }[];
      for (const column of columns.filter(
        (column) => column.pk && column.type.toLowerCase() === "text",
      ))
        expect(column.notnull, `${name}.${column.name}`).toBe(1);
    }
    expect(() => db.raw.exec("INSERT INTO settings (key, value) VALUES (NULL, 'true')")).toThrow(
      /NOT NULL/,
    );
  } finally {
    db.close();
  }
});

const ownedRecords = [
  [
    "profile_drafts",
    "INSERT INTO profile_drafts (profile_id, repository_id, value) VALUES (?, 'repo', '{}')",
  ],
  [
    "setting_overrides",
    "INSERT INTO setting_overrides (id, profile_id, repository_id, key, value) VALUES ('setting', ?, 'repo', 'theme', '{}')",
  ],
  [
    "content_recovery",
    "INSERT INTO content_recovery (id, profile_id, repository_id, created_at, value) VALUES ('recovery', ?, 'repo', 'now', '{}')",
  ],
  [
    "workflow_journal",
    "INSERT INTO workflow_journal (id, profile_id, repository_id, updated_at, record) VALUES ('workflow', ?, 'repo', 'now', '{}')",
  ],
  [
    "fetch_history",
    "INSERT INTO fetch_history (profile_id, repository_id, remote, url_hash, value) VALUES (?, 'repo', 'origin', 'hash', '{}')",
  ],
] as const;

it.each(ownedRecords)(
  "enforces profile membership and cascades repository deletion for %s",
  (table, insert) => {
    const db = ownedDatabase();
    try {
      expect(() => db.raw.prepare(insert).run("personal")).toThrow(/FOREIGN KEY/);
      db.raw.prepare(insert).run("work");
      expect(db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
      db.delete(repositories).where(eq(repositories.id, "repo")).run();
      expect(db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  },
);

it("enforces one session, draft, and setting per logical owner", () => {
  const db = ownedDatabase();
  try {
    db.raw.exec("INSERT INTO profile_sessions VALUES ('work', 'primary', '{}')");
    expect(() =>
      db.raw.exec("INSERT INTO profile_sessions VALUES ('work', 'primary', '{}')"),
    ).toThrow(/UNIQUE/);
    db.raw.exec("INSERT INTO profile_drafts VALUES ('work', 'repo', '{}')");
    expect(() => db.raw.exec("INSERT INTO profile_drafts VALUES ('work', 'repo', '{}')")).toThrow(
      /UNIQUE/,
    );
    db.raw.exec(
      "INSERT INTO setting_overrides (id, profile_id, key, value) VALUES ('a', 'work', 'theme', '{}')",
    );
    expect(() =>
      db.raw.exec(
        "INSERT INTO setting_overrides (id, profile_id, key, value) VALUES ('b', 'work', 'theme', '{}')",
      ),
    ).toThrow(/UNIQUE/);
    db.raw.exec("INSERT INTO setting_overrides VALUES ('c', 'work', 'repo', 'theme', '{}')");
    expect(() =>
      db.raw.exec("INSERT INTO setting_overrides VALUES ('d', 'work', 'repo', 'theme', '{}')"),
    ).toThrow(/UNIQUE/);
    db.raw.exec(
      "INSERT INTO setting_overrides (id, profile_id, key, value) VALUES ('e', 'personal', 'theme', '{}')",
    );
  } finally {
    db.close();
  }
});

it("rejects invalid booleans, provider states, and live JSON while allowing raw recovery archives", () => {
  const db = ownedDatabase();
  try {
    for (const query of [
      "UPDATE identities SET sign_commits = 7",
      "UPDATE repositories SET favourite = -1",
      "INSERT INTO github_accounts VALUES ('work', '1', 'login', 'secret-ref', 'invalid')",
      "INSERT INTO settings VALUES ('bad', 'broken')",
      "INSERT INTO profile_sessions VALUES ('work', 'primary', 'null')",
      "INSERT INTO profile_drafts VALUES ('work', 'repo', '[]')",
      "INSERT INTO operations (id, profile_id, updated_at, record) VALUES ('op', 'work', 'now', 'broken')",
      "INSERT INTO content_recovery (id, profile_id, repository_id, created_at, value) VALUES ('r', 'work', 'repo', 'now', 'broken')",
      "INSERT INTO workflow_journal (id, profile_id, repository_id, updated_at, record) VALUES ('w', 'work', 'repo', 'now', 'broken')",
      "INSERT INTO fetch_history (profile_id, repository_id, remote, url_hash, value) VALUES ('work', 'repo', 'origin', 'hash', 'broken')",
    ])
      expect(() => db.raw.exec(query), query).toThrow();
    db.raw.exec(
      "INSERT INTO profile_recovery VALUES ('archive', 'work', 'draft:repo', 'broken', 'now')",
    );
    expect(db.select().from(schema.profileRecovery).get()?.value).toBe("broken");
  } finally {
    db.close();
  }
});

it("uses indexes for growing history queries and keeps generated workflow metadata in sync", () => {
  const db = ownedDatabase();
  try {
    const cases = [
      [
        "SELECT * FROM operations WHERE profile_id='work' ORDER BY updated_at DESC LIMIT 200",
        "operations_profile_updated",
      ],
      [
        "SELECT * FROM content_recovery WHERE profile_id='work' AND repository_id='repo' ORDER BY created_at DESC",
        "content_recovery_owner_created",
      ],
      [
        "SELECT * FROM workflow_journal WHERE root='/repo' ORDER BY updated_at DESC",
        "workflow_journal_root_updated",
      ],
      [
        "SELECT * FROM workflow_journal WHERE common_directory='/repo/.git' ORDER BY updated_at DESC",
        "workflow_journal_common_updated",
      ],
    ];
    for (const [query, name] of cases) {
      const plan = db.raw
        .prepare(`EXPLAIN QUERY PLAN ${query}`)
        .all()
        .map((row) => row["detail"])
        .join("\n");
      expect(plan).toContain(name);
      expect(plan).not.toContain("TEMP B-TREE");
    }
    const insert = db.raw.prepare(
      "INSERT INTO workflow_journal (id, profile_id, repository_id, updated_at, record) VALUES ('w', 'work', 'repo', 'now', ?)",
    );
    insert.run(
      JSON.stringify({
        root: "/repo",
        mode: "reset",
        state: "prepared",
        refChange: { commonDirectory: "/repo/.git" },
      }),
    );
    expect(db.select().from(schema.workflowJournal).get()).toMatchObject({
      root: "/repo",
      mode: "reset",
      state: "prepared",
      commonDirectory: "/repo/.git",
    });
    db.update(schema.workflowJournal)
      .set({ record: JSON.stringify({ root: "/moved", mode: "commit", state: "completed" }) })
      .run();
    expect(db.select().from(schema.workflowJournal).get()).toMatchObject({
      root: "/moved",
      mode: "commit",
      state: "completed",
      commonDirectory: null,
    });
  } finally {
    db.close();
  }
});

it("persists profile order across database restarts", async () => {
  const { path } = await fileDatabase();
  const first = openDatabase(path);

  try {
    first
      .insert(identities)
      .values([identity("work"), identity("home")])
      .run();
    new IdentityRepository(first).reorder(["home", "work"]);
  } finally {
    first.close();
  }

  const reopened = openDatabase(path);

  try {
    expect(new IdentityRepository(reopened).list().map((profile) => profile.id)).toEqual([
      "home",
      "work",
    ]);
  } finally {
    reopened.close();
  }
});
