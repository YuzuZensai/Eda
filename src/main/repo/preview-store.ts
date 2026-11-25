import type { RepositorySummary } from "@shared/repository/repository";

export function matchesReviewContext(
  review: { repositoryId: string; root: string; identity: { id: string } },
  repository: Pick<RepositorySummary, "id" | "path" | "identityId">,
) {
  return (
    review.repositoryId === repository.id &&
    review.root === repository.path &&
    review.identity.id === repository.identityId
  );
}

export class PreviewStore<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();

  constructor(
    private readonly capacity = 8,
    private readonly lifetimeMs = 5 * 60_000,
  ) {}

  set(token: string, value: T): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expires < now) this.entries.delete(key);
    }
    this.entries.set(token, { value, expires: now + this.lifetimeMs });
    if (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  get(token: string): T | undefined {
    const entry = this.entries.get(token);
    if (entry && entry.expires < Date.now()) {
      this.entries.delete(token);
      return undefined;
    }
    return entry?.value;
  }

  delete(token: string): void {
    this.entries.delete(token);
  }
}
