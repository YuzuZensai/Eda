import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  builtInSetting,
  SETTING_DEFINITIONS,
  settingScopes,
  validateSetting,
  type ResolvedSetting,
  type SettingKey,
  type SettingsContext,
  type SettingScope,
} from "@shared/preferences/settings";
import { isRecord } from "@shared/validation";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { identities, repositories, settingOverrides, settings } from "./schema";
import type { Database } from "./types";

const portableSettings: readonly SettingKey[] = [
  "shortcutOverrides",
  "toolbarLabels",
  "updateNotices",
  "compactHistory",
  "historyAvatars",
  "historyDateStyle",
  "historyVisibleColumns",
  "mailboxPreview",
  "showInternalRefs",
  "language",
  "commitSummaryLimit",
  "conventionalCommitsEnabled",
  "vigilantMode",
  "commitPrefixes",
  "accentHue",
  "theme",
  "reducedMotion",
  "uiZoom",
  "diffMode",
  "fetchPrune",
  "fetchTags",
  "backgroundFetchMinutes",
  "pullStrategy",
  "predictUpstreamConflicts",
];

export class SettingsRepository {
  constructor(private readonly db: Database) {}

  resolve<K extends SettingKey>(key: K, context: SettingsContext = {}): ResolvedSetting<K> {
    let result = builtInSetting(key);

    for (const scope of settingScopes(context)) {
      this.requireOwner(scope);

      if (!(SETTING_DEFINITIONS[key].scopes as readonly string[]).includes(scope.kind)) continue;

      const row =
        scope.kind === "application"
          ? this.db.select().from(settings).where(eq(settings.key, key)).get()
          : this.db.select().from(settingOverrides).where(scopeFilter(key, scope)).get();

      if (!row) continue;

      try {
        const value: unknown = JSON.parse(row.value);
        validateSetting(key, scope, value);
        result = { key, value, source: scope, hasOverride: scope.kind !== "application" };
      } catch {}
    }

    return result;
  }

  set<K extends SettingKey>(key: K, scope: SettingScope, value: unknown): void {
    validateSetting(key, scope, value);
    this.requireOwner(scope);

    const serialized = JSON.stringify(value);

    if (scope.kind === "application") {
      this.db
        .insert(settings)
        .values({ key, value: serialized })
        .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
        .run();
    } else {
      this.db
        .insert(settingOverrides)
        .values({
          id: randomUUID(),
          profileId: scope.profileId,
          repositoryId: scope.kind === "repository" ? scope.repositoryId : null,
          key,
          value: serialized,
        })
        .onConflictDoUpdate({
          target:
            scope.kind === "repository"
              ? [settingOverrides.profileId, settingOverrides.repositoryId, settingOverrides.key]
              : [settingOverrides.profileId, settingOverrides.key],
          targetWhere:
            scope.kind === "repository"
              ? isNotNull(settingOverrides.repositoryId)
              : isNull(settingOverrides.repositoryId),
          set: { value: serialized },
        })
        .run();
    }
  }

  reset(key: SettingKey, scope: SettingScope): void {
    validateSetting(key, scope, SETTING_DEFINITIONS[key].defaultValue);
    this.requireOwner(scope);

    if (scope.kind === "application") this.db.delete(settings).where(eq(settings.key, key)).run();
    else this.db.delete(settingOverrides).where(scopeFilter(key, scope)).run();
  }

  exportPortable(scope: SettingScope) {
    this.requireOwner(scope);
    const values: Record<string, unknown> = {};
    const context = scope.kind === "application" ? {} : scope;
    for (const key of portableSettings) {
      const setting = this.resolve(key, context);
      if (setting.source.kind === scope.kind) values[key] = setting.value;
    }
    if (scope.kind === "profile") {
      const known = this.db
        .select({ path: repositories.path })
        .from(repositories)
        .where(eq(repositories.identityId, scope.profileId))
        .all();
      const paths = [
        ...new Set([
          ...this.resolve("repositoryHints", context).value,
          ...known.map((row) => row.path),
        ]),
      ];
      validateSetting("repositoryHints", scope, paths);
      values["repositoryHints"] = paths;
    }
    return { format: "eda-preferences", version: 1, scope: scope.kind, values };
  }

  importPortable(scope: SettingScope, file: unknown): SettingKey[] {
    const invalid = () =>
      new GitError({
        kind: "invalid-input",
        operation: t("settings.portable.import"),
        message: errorText("settings.portable.invalid"),
      });
    if (
      !isRecord(file) ||
      file["format"] !== "eda-preferences" ||
      file["version"] !== 1 ||
      file["scope"] !== scope.kind ||
      !isRecord(file["values"])
    )
      throw invalid();
    const entries = Object.entries(file["values"]).map(([name, value]) => {
      const key =
        name === "repositoryHints" && scope.kind === "profile"
          ? name
          : portableSettings.find((item) => item === name);
      if (!key) throw invalid();
      validateSetting(key, scope, value);
      return { key, value };
    });
    this.requireOwner(scope);
    this.db.transaction(() => {
      for (const { key, value } of entries) this.set(key, scope, value);
    });
    return entries.map((entry) => entry.key);
  }

  private requireOwner(scope: SettingScope): void {
    if (scope.kind === "application") return;

    if (
      !this.db
        .select({ id: identities.id })
        .from(identities)
        .where(eq(identities.id, scope.profileId))
        .get()
    )
      throw missing();

    if (
      scope.kind === "repository" &&
      !this.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(
          and(
            eq(repositories.id, scope.repositoryId),
            eq(repositories.identityId, scope.profileId),
          ),
        )
        .get()
    )
      throw missing();
  }
}

function scopeFilter(key: SettingKey, scope: Exclude<SettingScope, { kind: "application" }>) {
  return and(
    eq(settingOverrides.profileId, scope.profileId),
    scope.kind === "repository"
      ? eq(settingOverrides.repositoryId, scope.repositoryId)
      : isNull(settingOverrides.repositoryId),
    eq(settingOverrides.key, key),
  );
}

function missing(): GitError {
  return new GitError({
    kind: "invalid-input",
    operation: t("operations.preferences"),
    message: errorText(
      "main.persistence.settingsRepository.thatPreferenceOwnerNoLongerExistsOrBelongsToAnotherProfile",
    ),
  });
}
