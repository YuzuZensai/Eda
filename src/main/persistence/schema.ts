import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const identities = sqliteTable(
  "identities",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    // Use the NFKC-normalized, trimmed, lowercase name for uniqueness. Keep the spelling in name.
    nameKey: text("name_key").notNull().unique(),
    sortOrder: integer("sort_order").notNull().default(0),
    gitName: text("git_name").notNull(),
    gitEmail: text("git_email").notNull(),
    username: text("username"),
    avatarPath: text("avatar_path"),
    sshKeyPath: text("ssh_key_path"),
    signingFormat: text("signing_format", { enum: ["ssh", "gpg", "none"] })
      .notNull()
      .default("none"),
    signingKeyRef: text("signing_key_ref"),
    signCommits: integer("sign_commits").notNull().default(0),
    rules: text("rules").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    check("identities_name", sql`length(trim(${table.name})) BETWEEN 1 AND 100`),
    check("identities_name_key", sql`length(${table.nameKey}) > 0`),
    check("identities_signing_format", sql`${table.signingFormat} IN ('ssh', 'gpg', 'none')`),
    check("identities_sign_commits", sql`${table.signCommits} IN (0, 1)`),
    check(
      "identities_rules_json",
      sql`CASE WHEN json_valid(${table.rules}) THEN json_type(${table.rules}) = 'array' ELSE 0 END`,
    ),
  ],
);

export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").notNull(),
    identityId: text("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    path: text("path").notNull(),
    favourite: integer("favourite").notNull().default(0),
    lastOpenedAt: text("last_opened_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    unique("repositories_identity_path").on(table.identityId, table.path),
    unique("repositories_owner").on(table.identityId, table.id),
    check("repositories_favourite", sql`${table.favourite} IN (0, 1)`),
  ],
);

export const commitSignatures = sqliteTable(
  "commit_signatures",
  {
    profileId: text("profile_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    oid: text("oid").notNull(),
    version: integer("version").notNull().default(1),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.repositoryId, table.oid] }),
    foreignKey({
      columns: [table.profileId, table.repositoryId],
      foreignColumns: [repositories.identityId, repositories.id],
    }).onDelete("cascade"),
    check("commit_signatures_value_json", sql`json_valid(${table.value})`),
  ],
);

export const settings = sqliteTable(
  "settings",
  { key: text("key").notNull(), value: text("value").notNull() },
  (table) => [
    primaryKey({ columns: [table.key] }),
    check("settings_value_json", sql`json_valid(${table.value})`),
  ],
);

export const githubAccounts = sqliteTable(
  "github_accounts",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    login: text("login").notNull(),
    credentialRef: text("credential_ref").notNull(),
    state: text("state", { enum: ["connected", "expired", "revoked"] }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId] }),
    check("github_accounts_state", sql`${table.state} IN ('connected', 'expired', 'revoked')`),
  ],
);

export const gitlabAccounts = sqliteTable(
  "gitlab_accounts",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    login: text("login").notNull(),
    credentialRef: text("credential_ref").notNull(),
    state: text("state", { enum: ["connected", "expired", "revoked"] }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId] }),
    check("gitlab_accounts_state", sql`${table.state} IN ('connected', 'expired', 'revoked')`),
  ],
);

export const gitlabSelfHostedAccounts = sqliteTable(
  "gitlab_self_hosted_accounts",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    baseUrl: text("base_url").notNull(),
    ignoreTlsErrors: integer("ignore_tls_errors", { mode: "boolean" }).notNull().default(false),
    accountId: text("account_id").notNull(),
    login: text("login").notNull(),
    credentialRef: text("credential_ref").notNull(),
    state: text("state", { enum: ["connected", "expired", "revoked"] }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.baseUrl] }),
    check(
      "gitlab_self_hosted_accounts_state",
      sql`${table.state} IN ('connected', 'expired', 'revoked')`,
    ),
  ],
);

export const settingOverrides = sqliteTable(
  "setting_overrides",
  {
    id: text("id").notNull(),
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id"),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    foreignKey({
      columns: [table.profileId, table.repositoryId],
      foreignColumns: [repositories.identityId, repositories.id],
    }).onDelete("cascade"),
    uniqueIndex("setting_overrides_profile_key")
      .on(table.profileId, table.key)
      .where(sql`${table.repositoryId} IS NULL`),
    uniqueIndex("setting_overrides_repository_key")
      .on(table.profileId, table.repositoryId, table.key)
      .where(sql`${table.repositoryId} IS NOT NULL`),
    index("setting_overrides_owner").on(table.profileId, table.repositoryId),
    check("setting_overrides_value_json", sql`json_valid(${table.value})`),
  ],
);

export const appState = sqliteTable(
  "app_state",
  {
    id: integer("id").primaryKey(),
    activeIdentityId: text("active_identity_id").references(() => identities.id, {
      onDelete: "set null",
    }),
  },
  (table) => [check("app_state_single_row", sql`${table.id} = 1`)],
);

export const profileSessions = sqliteTable(
  "profile_sessions",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    windowId: text("window_id").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.windowId] }),
    check(
      "profile_sessions_value_json",
      sql`CASE WHEN json_valid(${table.value}) THEN json_type(${table.value}) = 'object' ELSE 0 END`,
    ),
  ],
);

export const profileDrafts = sqliteTable(
  "profile_drafts",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.repositoryId] }),
    foreignKey({
      columns: [table.profileId, table.repositoryId],
      foreignColumns: [repositories.identityId, repositories.id],
    }).onDelete("cascade"),
    check(
      "profile_drafts_value_json",
      sql`CASE WHEN json_valid(${table.value}) THEN json_type(${table.value}) = 'object' ELSE 0 END`,
    ),
  ],
);

export const profileRecovery = sqliteTable(
  "profile_recovery",
  {
    id: text("id").notNull(),
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    value: text("value").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("profile_recovery_profile_created").on(table.profileId, table.createdAt),
  ],
);

export const operations = sqliteTable(
  "operations",
  {
    id: text("id").notNull(),
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
    record: text("record").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("operations_profile_updated").on(table.profileId, table.updatedAt),
    check("operations_version", sql`${table.version} > 0`),
    check(
      "operations_record_json",
      sql`CASE WHEN json_valid(${table.record}) THEN json_type(${table.record}) = 'object' ELSE 0 END`,
    ),
  ],
);

export const contentRecovery = sqliteTable(
  "content_recovery",
  {
    id: text("id").notNull(),
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    foreignKey({
      columns: [table.profileId, table.repositoryId],
      foreignColumns: [repositories.identityId, repositories.id],
    }).onDelete("cascade"),
    index("content_recovery_owner_created").on(
      table.profileId,
      table.repositoryId,
      table.createdAt,
    ),
    check("content_recovery_version", sql`${table.version} > 0`),
    check(
      "content_recovery_value_json",
      sql`CASE WHEN json_valid(${table.value}) THEN json_type(${table.value}) = 'object' ELSE 0 END`,
    ),
  ],
);

export const workflowJournal = sqliteTable(
  "workflow_journal",
  {
    id: text("id").notNull(),
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").notNull(),
    updatedAt: text("updated_at").notNull(),
    record: text("record").notNull(),
    root: text("root").generatedAlwaysAs(sql`json_extract("record", '$.root')`, { mode: "stored" }),
    commonDirectory: text("common_directory").generatedAlwaysAs(
      sql`json_extract("record", '$.refChange.commonDirectory')`,
      { mode: "stored" },
    ),
    mode: text("mode").generatedAlwaysAs(sql`json_extract("record", '$.mode')`, { mode: "stored" }),
    state: text("state").generatedAlwaysAs(sql`json_extract("record", '$.state')`, {
      mode: "stored",
    }),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    foreignKey({
      columns: [table.profileId, table.repositoryId],
      foreignColumns: [repositories.identityId, repositories.id],
    }).onDelete("cascade"),
    index("workflow_journal_owner_updated").on(
      table.profileId,
      table.repositoryId,
      table.updatedAt,
    ),
    index("workflow_journal_root_updated").on(table.root, table.updatedAt),
    index("workflow_journal_common_updated").on(table.commonDirectory, table.updatedAt),
    check(
      "workflow_journal_record_json",
      sql`CASE WHEN json_valid(${table.record}) THEN json_type(${table.record}) = 'object' ELSE 0 END`,
    ),
  ],
);

export const fetchHistory = sqliteTable(
  "fetch_history",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").notNull(),
    remote: text("remote").notNull(),
    urlHash: text("url_hash").notNull(),
    version: integer("version").notNull().default(1),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.repositoryId, table.remote, table.urlHash] }),
    foreignKey({
      columns: [table.profileId, table.repositoryId],
      foreignColumns: [repositories.identityId, repositories.id],
    }).onDelete("cascade"),
    check("fetch_history_version", sql`${table.version} > 0`),
    check(
      "fetch_history_value_json",
      sql`CASE WHEN json_valid(${table.value}) THEN json_type(${table.value}) = 'object' ELSE 0 END`,
    ),
  ],
);

export type IdentityRow = typeof identities.$inferSelect;
export type RepositoryRow = typeof repositories.$inferSelect;

export const repositoryTrust = sqliteTable("repository_trust", {
  path: text("path").primaryKey().notNull(),
  fingerprint: text("fingerprint").notNull(),
});

export const signerDecisions = sqliteTable(
  "signer_decisions",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    repositoryId: text("repository_id"),
    fingerprint: text("fingerprint").notNull(),
    identity: text("identity").notNull(),
    decision: text("decision", { enum: ["trusted", "distrusted"] }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.scope, table.fingerprint] }),
    foreignKey({
      columns: [table.profileId, table.repositoryId],
      foreignColumns: [repositories.identityId, repositories.id],
    }).onDelete("cascade"),
    check(
      "signer_decision_scope",
      sql`(${table.repositoryId} IS NULL AND ${table.scope} = 'profile') OR (${table.repositoryId} IS NOT NULL AND ${table.scope} = ${table.repositoryId})`,
    ),
    check("signer_decision_value", sql`${table.decision} IN ('trusted', 'distrusted')`),
  ],
);

export const verificationKeys = sqliteTable(
  "verification_keys",
  {
    profileId: text("profile_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    armoredKey: text("armored_key").notNull(),
    source: text("source").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.fingerprint] })],
);
