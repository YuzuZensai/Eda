import { errorText, type ErrorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import {
  emptySession,
  updateSessionView,
  type CommitDraft,
  isDraft,
  isSession,
  isSessionChange,
  type SessionSnapshot,
} from "@shared/identity/profile-session";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  identities,
  profileDrafts,
  profileRecovery,
  profileSessions,
  repositories,
} from "./schema";
import type { Database } from "./types";

export class ProfileSessionRepository {
  private validatedDraft?: {
    profileId: string;
    windowId: string;
    repositoryId: string;
    stamp: string;
  };
  constructor(private readonly db: Database) {}

  openRepositoryIds(profileId: string): string[] {
    const rows = this.db
      .select()
      .from(profileSessions)
      .where(eq(profileSessions.profileId, profileId))
      .all();

    const live = this.ownedRepositoryIds(profileId);

    return [
      ...new Set(
        rows.flatMap((row) => {
          const session = parse(row.value);
          return isSession(session) ? session.tabs.filter((id) => live.has(id)) : [];
        }),
      ),
    ];
  }

  read(profileId: string, windowId: string): Omit<SessionSnapshot, "context"> {
    return this.readOwnedSession(profileId, windowId).snapshot;
  }

  private readOwnedSession(profileId: string, windowId: string) {
    this.requireProfile(profileId);

    const row = this.db
      .select()
      .from(profileSessions)
      .where(sessionOwner(profileId, windowId))
      .get();
    const parsed = row ? parse(row.value) : emptySession();
    const valid = isSession(parsed);
    let recovery =
      row && !valid
        ? t("main.persistence.profileSessionRepository.savedTabsLayoutUseAnUnsupportedOrDamaged")
        : null;
    const session = valid ? parsed : emptySession();
    const live = this.ownedRepositoryIds(profileId);

    session.tabs = session.tabs.filter((id) => live.has(id));

    if (session.selectedRepositoryId && !session.tabs.includes(session.selectedRepositoryId))
      session.selectedRepositoryId = session.tabs[0] ?? null;

    session.views = Object.fromEntries(
      Object.entries(session.views).filter(([id]) => live.has(id)),
    );

    const drafts: SessionSnapshot["drafts"] = {};

    for (const draft of this.db
      .select()
      .from(profileDrafts)
      .where(eq(profileDrafts.profileId, profileId))
      .all()) {
      const value = parse(draft.value);
      if (isDraft(value) && live.has(draft.repositoryId)) drafts[draft.repositoryId] = value;
      else
        recovery = t(
          "main.persistence.profileSessionRepository.aSavedDraftHasAnUnsupportedOrDamaged",
        );
    }

    return { snapshot: { session, drafts, recovery }, live };
  }

  change(profileId: string, windowId: string, change: unknown): void {
    if (!isSessionChange(change))
      throw invalid(errorText("main.persistence.profileSessionRepository.invalidSavedStateUpdate"));

    if (change.kind === "draft") {
      this.saveDraft(profileId, windowId, change.repositoryId, change.draft);
      return;
    }
    const current = this.editableSession(
      profileId,
      windowId,
      change.kind === "tabs" ? change.tabs : [change.repositoryId],
    );
    if (change.kind === "tabs") {
      current.session.tabs = change.tabs;
      current.session.selectedRepositoryId = change.selectedRepositoryId;
    } else {
      current.session.views = updateSessionView(current.session.views, change);
      if (!isSession(current.session))
        throw invalid(
          errorText("main.persistence.profileSessionRepository.invalidSavedStateUpdate"),
        );
    }

    const value = JSON.stringify(current.session);

    this.db
      .insert(profileSessions)
      .values({ profileId, windowId, value })
      .onConflictDoUpdate({
        target: [profileSessions.profileId, profileSessions.windowId],
        set: { value },
      })
      .run();
  }

  private editableSession(profileId: string, windowId: string, repositoryIds: string[]) {
    const { snapshot: current, live } = this.readOwnedSession(profileId, windowId);

    if (current.recovery)
      throw invalid(errorText("errors.operationBlocked", { reason: current.recovery }));

    if (repositoryIds.some((id) => !live.has(id)))
      throw invalid(
        errorText(
          "main.persistence.profileSessionRepository.theRepositoryDoesNotBelongToThisProfile",
        ),
      );

    return current;
  }

  private saveDraft(profileId: string, windowId: string, repositoryId: string, draft: CommitDraft) {
    const nested = this.db.raw.isTransaction;
    this.db.transaction(() => {
      // total_changes sees local writes; data_version sees commits on other connections.
      const version = this.db.raw.prepare(
        "SELECT total_changes() || ':' || data_version AS stamp FROM pragma_data_version",
      );
      const stamp = version.get()!["stamp"] as string;
      const last = this.validatedDraft;
      if (
        nested ||
        !last ||
        last.profileId !== profileId ||
        last.windowId !== windowId ||
        last.repositoryId !== repositoryId ||
        last.stamp !== stamp
      )
        this.editableSession(profileId, windowId, [repositoryId]);

      if (!draft.message && !draft.amend && !draft.signOff)
        this.db.delete(profileDrafts).where(draftOwner(profileId, repositoryId)).run();
      else {
        const value = JSON.stringify(draft);
        this.db
          .insert(profileDrafts)
          .values({ profileId, repositoryId, value })
          .onConflictDoUpdate({
            target: [profileDrafts.profileId, profileDrafts.repositoryId],
            set: { value },
          })
          .run();
      }
      if (!nested)
        this.validatedDraft = {
          profileId,
          windowId,
          repositoryId,
          stamp: version.get()!["stamp"] as string,
        };
    });
  }

  reset(profileId: string, windowId: string): void {
    this.requireProfile(profileId);
    this.db.transaction(() => {
      const session = this.db
        .select()
        .from(profileSessions)
        .where(sessionOwner(profileId, windowId))
        .get();
      const rows = this.db
        .select()
        .from(profileDrafts)
        .where(eq(profileDrafts.profileId, profileId))
        .all();

      for (const row of [
        ...(session ? [{ ...session, source: `session:${windowId}` }] : []),
        ...rows.map((r) => ({ ...r, source: `draft:${r.repositoryId}` })),
      ]) {
        this.db
          .insert(profileRecovery)
          .values({
            id: randomUUID(),
            profileId,
            source: row.source,
            value: row.value,
            createdAt: new Date().toISOString(),
          })
          .run();
      }

      this.db.delete(profileSessions).where(sessionOwner(profileId, windowId)).run();

      const live = this.ownedRepositoryIds(profileId);
      for (const row of rows)
        if (!live.has(row.repositoryId) || !isDraft(parse(row.value)))
          this.db.delete(profileDrafts).where(draftOwner(profileId, row.repositoryId)).run();
    });
  }

  private ownedRepositoryIds(profileId: string): Set<string> {
    return new Set(
      this.db
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.identityId, profileId))
        .all()
        .map((r) => r.id),
    );
  }

  private requireProfile(profileId: string): void {
    if (
      !this.db
        .select({ id: identities.id })
        .from(identities)
        .where(eq(identities.id, profileId))
        .get()
    )
      throw invalid(
        errorText("main.persistence.profileSessionRepository.thatProfileNoLongerExists"),
      );
  }
}

function sessionOwner(profileId: string, windowId: string) {
  return and(eq(profileSessions.profileId, profileId), eq(profileSessions.windowId, windowId));
}

function draftOwner(profileId: string, repositoryId: string) {
  return and(eq(profileDrafts.profileId, profileId), eq(profileDrafts.repositoryId, repositoryId));
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function invalid(message: ErrorText): GitError {
  return new GitError({
    kind: "invalid-input",
    operation: t("operations.saveProfileSession"),
    message,
  });
}
