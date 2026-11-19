import { errorText } from "@shared/error-codes";
import { GitError } from "@shared/errors";
import { t } from "@shared/i18n";
import type { Identity, IdentityCreateOptions, IdentityDraft } from "@shared/identity/identity";
import { builtInSetting } from "@shared/preferences/settings";
import { eq, max } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { appState, identities, type IdentityRow } from "./schema";
import { SettingsRepository } from "./settings-repository";
import type { Database } from "./types";

export class IdentityRepository {
  constructor(
    private readonly db: Database,
    private readonly preferences = new SettingsRepository(db),
  ) {}

  list(): Identity[] {
    return this.db
      .select()
      .from(identities)
      .orderBy(identities.sortOrder, identities.nameKey)
      .all()
      .map((row) => this.present(row));
  }

  reorder(ids: string[]): Identity[] {
    return this.db.transaction(() => {
      const current = this.list();
      const known = new Set(current.map((profile) => profile.id));

      if (
        ids.length !== current.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !known.has(id))
      )
        throw new GitError({
          kind: "invalid-input",
          operation: t("operations.manageProfile"),
          message: errorText("main.persistence.identityRepository.invalidProfileOrder"),
        });

      for (const [sortOrder, id] of ids.entries())
        this.db.update(identities).set({ sortOrder }).where(eq(identities.id, id)).run();

      return this.list();
    });
  }

  findById(id: string): Identity | undefined {
    const row = this.db.select().from(identities).where(eq(identities.id, id)).get();
    return row ? this.present(row) : undefined;
  }

  create(draft: IdentityDraft, options: IdentityCreateOptions = {}): Identity {
    this.requireAvailableName(draft.name);

    const now = new Date().toISOString();
    const id = randomUUID();

    this.write(() => {
      const last = this.db
        .select({ value: max(identities.sortOrder) })
        .from(identities)
        .get();

      this.db
        .insert(identities)
        .values({
          id,
          ...toColumns(draft),
          sortOrder: (last?.value ?? -1) + 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      if (draft.hue !== builtInSetting("accentHue").value)
        this.preferences.set(
          "accentHue",
          { kind: "profile", profileId: id },
          typeof draft.hue === "number" ? Math.round(draft.hue) : draft.hue,
        );

      if (
        options.syncGlobalGitConfig !== undefined &&
        options.syncGlobalGitConfig !== this.preferences.resolve("syncGlobalGitConfig").value
      )
        this.preferences.set(
          "syncGlobalGitConfig",
          { kind: "profile", profileId: id },
          options.syncGlobalGitConfig,
        );
    });

    return this.findById(id)!;
  }

  update(id: string, draft: Partial<IdentityDraft>): Identity | undefined {
    const existing = this.findById(id);

    if (!existing) return undefined;

    const merged: IdentityDraft = {
      ...existing,
      ...draft,
      signing: { ...existing.signing, ...draft.signing },
    };

    this.requireAvailableName(merged.name, id);

    this.write(() => {
      this.db
        .update(identities)
        .set({ ...toColumns(merged), updatedAt: new Date().toISOString() })
        .where(eq(identities.id, id))
        .run();

      if (draft.hue !== undefined)
        this.preferences.set(
          "accentHue",
          { kind: "profile", profileId: id },
          typeof draft.hue === "number" ? Math.round(draft.hue) : draft.hue,
        );
    });

    return this.findById(id);
  }

  assignSshKey(id: string, path: string | null): Identity | undefined {
    this.db
      .update(identities)
      .set({ sshKeyPath: path, updatedAt: new Date().toISOString() })
      .where(eq(identities.id, id))
      .run();

    return this.findById(id);
  }

  configureSigning(id: string, signing: IdentityDraft["signing"]): Identity | undefined {
    this.db
      .update(identities)
      .set({
        signingFormat: signing.format,
        signingKeyRef: signing.keyRef ?? null,
        signCommits: signing.signCommits ? 1 : 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(identities.id, id))
      .run();

    return this.findById(id);
  }

  delete(id: string): void {
    this.db.delete(identities).where(eq(identities.id, id)).run();
  }

  getActiveId(): string | null {
    const row = this.db.select().from(appState).where(eq(appState.id, 1)).get();
    return row?.activeIdentityId ?? null;
  }

  setActiveId(id: string | null): void {
    this.db.update(appState).set({ activeIdentityId: id }).where(eq(appState.id, 1)).run();
  }

  requireAvailableName(name: string, exceptId?: string): void {
    const existing = this.db
      .select({ id: identities.id })
      .from(identities)
      .where(eq(identities.nameKey, profileNameKey(name)))
      .get();

    if (existing && existing.id !== exceptId) {
      throw new GitError({
        kind: "invalid-input",
        operation: t("operations.saveProfile"),
        message: errorText("main.persistence.identityRepository.aProfileWithThatNameAlreadyExists"),
        suggestedAction: errorText(
          "main.persistence.identityRepository.chooseADifferentProfileName",
        ),
      });
    }
  }

  private present(row: IdentityRow): Identity {
    return {
      ...toIdentity(row),
      hue: this.preferences.resolve("accentHue", { profileId: row.id }).value,
    };
  }

  private write(work: () => void): void {
    if (this.db.raw.isTransaction) work();
    else this.db.transaction(work);
  }
}

function toColumns(draft: IdentityDraft) {
  return {
    name: draft.name,
    nameKey: profileNameKey(draft.name),
    gitName: draft.gitName,
    gitEmail: draft.gitEmail,
    username: draft.username ?? null,
    avatarPath: draft.avatarPath ?? null,
    sshKeyPath: draft.sshKeyPath ?? null,
    signingFormat: draft.signing.format,
    signingKeyRef: draft.signing.keyRef ?? null,
    signCommits: draft.signing.signCommits ? 1 : 0,
  };
}

function toIdentity(row: IdentityRow): Omit<Identity, "hue"> {
  return {
    id: row.id,
    name: row.name,
    gitName: row.gitName,
    gitEmail: row.gitEmail,
    ...(row.username !== null && { username: row.username }),
    ...(row.avatarPath !== null && { avatarPath: row.avatarPath }),
    ...(row.gitEmail.trim() && {
      gravatarUrl: `https://www.gravatar.com/avatar/${createHash("sha256").update(row.gitEmail.trim().toLowerCase()).digest("hex")}?s=96&d=404&r=g`,
    }),
    ...(row.sshKeyPath !== null && { sshKeyPath: row.sshKeyPath }),
    signing: {
      format: row.signingFormat,
      ...(row.signingKeyRef !== null && { keyRef: row.signingKeyRef }),
      signCommits: row.signCommits === 1,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function profileNameKey(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
}
