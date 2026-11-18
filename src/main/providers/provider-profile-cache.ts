type Pending<T> = { work: Promise<T | null>; invalidated: boolean };
type Entry<T> = { value: T | null; expiresAt: number };
const TTL = 5 * 60_000;
const MAX_ENTRIES = 128;

export class ProviderProfileCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly pending = new Map<string, Pending<T>>();

  constructor(private readonly now = Date.now) {}

  peek(key: string): T | null {
    return this.entries.get(key)?.value ?? null;
  }

  set(key: string, value: T): void {
    this.invalidate(key);
    this.save(key, value, TTL);
  }

  async get(
    key: string,
    load: () => Promise<T | null>,
    fallback: T | null = null,
  ): Promise<T | null> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;
    const pending = this.pending.get(key);
    if (pending) {
      if (!pending.invalidated) return pending.work;
      await pending.work;
      return this.get(key, load, fallback);
    }
    if (this.pending.size >= MAX_ENTRIES) return cached?.value ?? fallback;
    const entry: Pending<T> = {
      invalidated: false,
      work: this.refresh(load, cached?.value ?? fallback)
        .then(({ value, ttl }) => {
          if (!entry.invalidated) this.save(key, value, ttl);
          return value;
        })
        .finally(() => this.pending.delete(key)),
    };
    this.pending.set(key, entry);
    return entry.work;
  }

  delete(key: string): void {
    this.invalidate(key);
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    await Promise.allSettled([...this.pending.values()].map((entry) => entry.work));
    this.entries.clear();
  }

  private invalidate(key: string): void {
    const pending = this.pending.get(key);
    if (pending) pending.invalidated = true;
  }

  private async refresh(
    load: () => Promise<T | null>,
    fallback: T | null,
  ): Promise<{ value: T | null; ttl: number }> {
    let value = fallback;
    let ttl = 60_000;
    try {
      const loaded = await load();
      if (loaded !== null) {
        value = loaded;
        ttl = TTL;
      }
    } catch {}
    return { value, ttl };
  }

  private save(key: string, value: T | null, ttl: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttl });
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }
}
