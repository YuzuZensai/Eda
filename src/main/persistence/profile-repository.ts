import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { DuplicateProfileOptions } from "@shared/identity/profile-session";
import { builtInSetting, requireSettingKey, validateSetting } from "@shared/preferences/settings";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { IdentityRepository } from "./identity-repository";
import type { ProfileSessionRepository } from "./profile-session-repository";
import {
  contentRecovery,
  profileDrafts,
  profileRecovery,
  profileSessions,
  repositories,
  settingOverrides,
} from "./schema";
import type { Database } from "./types";
export class ProfileRepository {
  constructor(
    private readonly db: Database,
    private readonly identities: IdentityRepository,
    private readonly sessions: ProfileSessionRepository,
  ) {}

  assignRepository(
    repositoryId: string,
    owner: string,
    targetProfileId: string,
    move: boolean,
  ): string {
    return this.db.transaction(() => {
      const source = this.db
        .select()
        .from(repositories)
        .where(and(eq(repositories.id, repositoryId), eq(repositories.identityId, owner)))
        .get();

      if (!source || !this.identities.findById(targetProfileId))
        throw invalid(
          errorText(
            "main.identity.profileService.theSourceRepositoryOrDestinationProfileNoLongerExists",
          ),
        );

      const existing = this.db
        .select()
        .from(repositories)
        .where(
          and(eq(repositories.identityId, targetProfileId), eq(repositories.path, source.path)),
        )
        .get();

      const targetId = existing?.id ?? randomUUID();

      if (!existing)
        this.db
          .insert(repositories)
          .values({ ...source, id: targetId, identityId: targetProfileId })
          .run();

      // Don't move drafts or credentials along with the repository.
      if (move) this.db.delete(repositories).where(eq(repositories.id, source.id)).run();

      return targetId;
    });
  }

  duplicate(id: string, options: DuplicateProfileOptions) {
    const source = this.identities.findById(id);

    if (!source) throw invalid(errorText("main.identity.profileService.thatProfileNoLongerExists"));
    if (!options.name.trim() || options.name.length > 100)
      throw invalid(errorText("main.identity.profileService.enterAProfileNameOf1To100Characters"));
    if (options.tabs && !options.repositories)
      throw invalid(errorText("main.identity.profileService.copyRepositoriesToCopyTheirTabs"));

    return this.db.transaction(() => {
      const copy = this.identities.create({
        name: options.name.trim(),
        gitName: source.gitName,
        gitEmail: source.gitEmail,
        hue: builtInSetting("accentHue").value,
        signing: { format: "none", signCommits: false },
      });

      const remap = new Map<string, string>();

      if (options.repositories)
        for (const row of this.db
          .select()
          .from(repositories)
          .where(eq(repositories.identityId, id))
          .all()) {
          const membershipId = randomUUID();
          remap.set(row.id, membershipId);
          this.db
            .insert(repositories)
            .values({ ...row, id: membershipId, identityId: copy.id })
            .run();
        }

      if (options.preferences)
        for (const row of this.db
          .select()
          .from(settingOverrides)
          .where(eq(settingOverrides.profileId, id))
          .all()) {
          const repositoryId = row.repositoryId ? remap.get(row.repositoryId) : null;

          if (row.repositoryId && !repositoryId) continue;

          try {
            const key = requireSettingKey(row.key);

            validateSetting(
              key,
              repositoryId
                ? { kind: "repository", profileId: copy.id, repositoryId }
                : { kind: "profile", profileId: copy.id },
              JSON.parse(row.value),
            );
          } catch {
            continue;
          }

          this.db
            .insert(settingOverrides)
            .values({
              ...row,
              id: randomUUID(),
              profileId: copy.id,
              repositoryId: repositoryId ?? null,
            })
            .run();
        }

      if (options.tabs)
        for (const row of this.db
          .select()
          .from(profileSessions)
          .where(eq(profileSessions.profileId, id))
          .all()) {
          const saved = this.sessions.read(id, row.windowId);

          if (saved.recovery)
            throw invalid(
              errorText(
                "main.identity.profileService.recoverTheSourceSavedStateBeforeCopyingItsTabs",
              ),
            );

          const tabs = saved.session.tabs.flatMap((old) => remap.get(old) ?? []);
          const selectedRepositoryId = saved.session.selectedRepositoryId
            ? (remap.get(saved.session.selectedRepositoryId) ?? null)
            : null;

          this.sessions.change(copy.id, row.windowId, {
            kind: "tabs",
            tabs,
            selectedRepositoryId,
          });

          for (const [old, view] of Object.entries(saved.session.views)) {
            const repositoryId = remap.get(old);
            if (repositoryId)
              this.sessions.change(copy.id, row.windowId, { kind: "view", repositoryId, view });
          }
        }

      return this.identities.findById(copy.id)!;
    });
  }

  snapshot(id: string) {
    const rows = this.db.select().from(repositories).where(eq(repositories.identityId, id)).all();
    const drafts = this.db
      .select()
      .from(profileDrafts)
      .where(eq(profileDrafts.profileId, id))
      .all();
    const state = this.db
      .select()
      .from(profileSessions)
      .where(eq(profileSessions.profileId, id))
      .all();
    const overrides = this.db
      .select()
      .from(settingOverrides)
      .where(eq(settingOverrides.profileId, id))
      .all();
    const recovery = this.db
      .select()
      .from(profileRecovery)
      .where(eq(profileRecovery.profileId, id))
      .all();
    const contentSnapshots = this.db
      .select({ id: contentRecovery.id })
      .from(contentRecovery)
      .where(eq(contentRecovery.profileId, id))
      .all();
    return { rows, drafts, state, overrides, recovery, contentSnapshots };
  }

  delete(id: string, active: boolean, fallback: string | null): void {
    this.db.transaction(() => {
      this.identities.delete(id);
      if (active) this.identities.setActiveId(fallback);
    });
  }
}

function invalid(message: ErrorText): GitError {
  return new GitError({ kind: "invalid-input", operation: t("operations.manageProfile"), message });
}
