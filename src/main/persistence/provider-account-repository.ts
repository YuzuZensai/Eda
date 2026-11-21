import { and, eq } from "drizzle-orm";
import type { Database } from "./types";
import { githubAccounts, gitlabAccounts } from "./schema";

export type SavedProviderAccount = Omit<typeof githubAccounts.$inferSelect, "active">;

export class ProviderAccountRepository {
  private readonly table: typeof githubAccounts | typeof gitlabAccounts;

  constructor(
    private readonly db: Database,
    provider: "github" | "gitlab",
  ) {
    this.table = provider === "github" ? githubAccounts : gitlabAccounts;
  }

  list(profileId: string): SavedProviderAccount[] {
    return this.db
      .select()
      .from(this.table)
      .where(eq(this.table.profileId, profileId))
      .orderBy(this.table.login, this.table.accountId)
      .all()
      .map(({ active: _active, ...account }) => account);
  }

  find(profileId: string, accountId?: string): SavedProviderAccount | undefined {
    const row = this.db
      .select()
      .from(this.table)
      .where(
        and(
          eq(this.table.profileId, profileId),
          accountId === undefined
            ? eq(this.table.active, true)
            : eq(this.table.accountId, accountId),
        ),
      )
      .get();
    if (!row) return undefined;
    const { active: _active, ...account } = row;
    return account;
  }

  save(account: SavedProviderAccount): void {
    this.db.transaction(() => {
      this.db
        .update(this.table)
        .set({ active: false })
        .where(and(eq(this.table.profileId, account.profileId), eq(this.table.active, true)))
        .run();
      const selected = { ...account, active: true };
      this.db
        .insert(this.table)
        .values(selected)
        .onConflictDoUpdate({ target: [this.table.profileId, this.table.accountId], set: selected })
        .run();
    });
  }

  delete(profileId: string, credentialRef?: string): void {
    this.db
      .delete(this.table)
      .where(
        and(
          eq(this.table.profileId, profileId),
          credentialRef === undefined
            ? eq(this.table.active, true)
            : eq(this.table.credentialRef, credentialRef),
        ),
      )
      .run();
  }
}
