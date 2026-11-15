import { errorText } from "@shared/error-codes";
import { AppError } from "@shared/errors";
import { readResponseBytes } from "../network/response";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AvatarImage } from "@shared/identity/avatar";

const DAY = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 128;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024;

export class AvatarCache {
  private readonly entries = new Map<string, AvatarImage>();
  private readonly persistedImages = new Map<string, string>();
  private readonly pending = new Map<string, Promise<AvatarImage>>();
  private readonly slots: Promise<unknown>[] = Array.from({ length: 4 }, () => Promise.resolve());
  private slot = 0;
  private loaded?: Promise<void>;
  private saved: Promise<void> = Promise.resolve();
  private revision = 0;
  private persistedRevision = 0;

  constructor(
    private readonly directory: string,
    private readonly fetchImage: typeof fetch,
    private readonly now = Date.now,
  ) {}

  async clear(): Promise<void> {
    await this.loaded;
    await Promise.allSettled(this.slots);
    await this.saved;
    this.entries.clear();
    this.persistedImages.clear();
    this.pending.clear();
    delete this.loaded;
    this.revision = 0;
    this.persistedRevision = 0;
    await rm(this.directory, { recursive: true, force: true });
  }

  async get(email: string): Promise<AvatarImage> {
    const normalized = email.trim().toLowerCase();

    if (!normalized || normalized.length > 320 || /[\r\n\0]/.test(normalized))
      return { dataUrl: null, expiresAt: this.now() + DAY };

    const hash = createHash("sha256").update(normalized).digest("hex");
    const githubAuthor = normalized.match(
      /^(?:([1-9][0-9]{0,15})\+)?([a-z0-9][a-z0-9-]{0,38})@users\.noreply\.github\.com$/,
    );

    if (githubAuthor) {
      const url = githubAuthor[1]
        ? `https://avatars.githubusercontent.com/u/${githubAuthor[1]}?v=4&s=96`
        : `https://github.com/${githubAuthor[2]}.png?size=96`;
      const image = await this.getImage(`github-author:${hash}`, url, MAX_IMAGE_BYTES);

      if (image.dataUrl) return image;
    }

    return this.getImage(hash, `https://www.gravatar.com/avatar/${hash}?s=96&d=404&r=g`);
  }

  getGitHub(accountId: string, avatarUrl: string | null): Promise<AvatarImage> {
    return this.getProviderImage("github", accountId, avatarUrl);
  }

  getGitLab(accountId: string, avatarUrl: string | null): Promise<AvatarImage> {
    return this.getProviderImage("gitlab", accountId, avatarUrl);
  }

  private async getProviderImage(
    provider: "github" | "gitlab",
    accountId: string,
    avatarUrl: string | null,
  ): Promise<AvatarImage> {
    const fallback = { dataUrl: null, expiresAt: this.now() + DAY };
    if (!/^[1-9][0-9]{0,15}$/.test(accountId) || !avatarUrl || avatarUrl.length > 4096)
      return fallback;
    let url: URL;

    try {
      url = new URL(avatarUrl);
    } catch {
      return fallback;
    }

    if (url.protocol !== "https:" || url.username || url.password || url.hash) return fallback;
    const version = createHash("sha256").update(url.href).digest("hex");
    return this.getImage(`${provider}:${accountId}:${version}`, url.href, MAX_IMAGE_BYTES);
  }

  private async getImage(
    hash: string,
    url: string,
    maxImageBytes = 64 * 1024,
  ): Promise<AvatarImage> {
    await (this.loaded ??= this.load());

    const cached = this.entries.get(hash);

    if (cached && cached.expiresAt > this.now()) return cached;

    const pending = this.pending.get(hash);

    if (pending) return pending;
    if (this.pending.size >= MAX_ENTRIES) return { dataUrl: null, expiresAt: this.now() + 60_000 };

    const slot = this.slot++ % this.slots.length;

    const work = this.slots[slot]!.then(async () => {
      const image = await this.download(url, maxImageBytes);

      this.entries.delete(hash);
      this.entries.set(hash, image);

      while (this.entries.size > MAX_ENTRIES)
        this.entries.delete(this.entries.keys().next().value!);

      const revision = ++this.revision;

      this.saved = this.saved
        .then(async () => {
          if (this.persistedRevision >= revision) return;

          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          const snapshotRevision = this.revision;
          const snapshot = [...this.entries];
          const records = [];
          const retained = new Set(["index", "index.tmp"]);

          for (const [key, entry] of snapshot) {
            const name = createHash("sha256").update(key).digest("hex");
            const type = entry.dataUrl?.slice(5, entry.dataUrl.indexOf(";")) ?? null;

            if (entry.dataUrl) {
              retained.add(name);

              if (this.persistedImages.get(key) !== entry.dataUrl) {
                await writeFile(
                  join(this.directory, `${name}.tmp`),
                  Buffer.from(entry.dataUrl.split(",")[1]!, "base64"),
                  { mode: 0o600 },
                );

                await rename(join(this.directory, `${name}.tmp`), join(this.directory, name));
                this.persistedImages.set(key, entry.dataUrl);
              }
            }

            records.push([key, { type, expiresAt: entry.expiresAt }]);
          }

          await writeFile(join(this.directory, "index.tmp"), JSON.stringify(records), {
            mode: 0o600,
          });

          await rename(join(this.directory, "index.tmp"), join(this.directory, "index"));

          for (const name of await readdir(this.directory)) {
            if (!retained.has(name)) await rm(join(this.directory, name), { force: true });
          }

          for (const key of this.persistedImages.keys()) {
            if (!this.entries.get(key)?.dataUrl) this.persistedImages.delete(key);
          }

          this.persistedRevision = snapshotRevision;
        })
        .catch(() => {});

      await this.saved;

      return image;
    }).finally(() => this.pending.delete(hash));

    this.slots[slot] = work.catch(() => {});
    this.pending.set(hash, work);

    return work;
  }

  private async load(): Promise<void> {
    try {
      const index = join(this.directory, "index");
      if ((await stat(index)).size > MAX_FILE_BYTES) return;

      const records: unknown = JSON.parse(await readFile(index, "utf8"));

      if (!Array.isArray(records)) return;

      for (const record of records.slice(-MAX_ENTRIES)) {
        if (!Array.isArray(record) || record.length !== 2) continue;

        const [hash, image] = record as [unknown, { type?: unknown; expiresAt?: unknown } | null];

        if (
          typeof hash !== "string" ||
          !/^(?:[a-f0-9]{64}|github-author:[a-f0-9]{64}|github:[1-9][0-9]{0,15}|(?:github|gitlab):[1-9][0-9]{0,15}:[a-f0-9]{64})$/.test(
            hash,
          ) ||
          !image ||
          typeof image.expiresAt !== "number" ||
          image.expiresAt <= this.now() ||
          image.expiresAt > this.now() + DAY ||
          !(
            image.type === null ||
            (typeof image.type === "string" && /^image\/(png|jpeg|gif|webp)$/.test(image.type))
          )
        )
          continue;

        if (image.type === null && hash.includes(":") && !hash.startsWith("github-author:"))
          continue;

        try {
          let dataUrl: string | null = null;

          if (image.type !== null) {
            const name = createHash("sha256").update(hash).digest("hex");
            const file = join(this.directory, name);
            if ((await stat(file)).size > MAX_IMAGE_BYTES) continue;
            const bytes = await readFile(file);
            if (!bytes.length) continue;
            dataUrl = `data:${image.type};base64,${bytes.toString("base64")}`;
            this.persistedImages.set(hash, dataUrl);
          }

          this.entries.set(hash, { dataUrl, expiresAt: image.expiresAt });
        } catch {}
      }
    } catch {}
  }

  private async download(url: string, maxImageBytes: number): Promise<AvatarImage> {
    const fallback = { dataUrl: null, expiresAt: this.now() + 5 * 60_000 };

    try {
      const response = await this.fetchImage(url, {
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
        credentials: "omit",
      });

      if (response.status === 404) {
        await response.body?.cancel();
        return { dataUrl: null, expiresAt: this.now() + 60 * 60_000 };
      }

      const type = response.headers.get("content-type")?.split(";")[0]?.trim();

      if (!response.ok || !type || !/^image\/(png|jpeg|gif|webp)$/.test(type) || !response.body) {
        await response.body?.cancel();
        return fallback;
      }

      const bytes = await readResponseBytes(
        response.body,
        maxImageBytes,
        () => new AppError(errorText("main.avatarCache.imageExceedsSizeLimit")),
      );

      if (!bytes.length) return fallback;

      return {
        dataUrl: `data:${type};base64,${bytes.toString("base64")}`,
        expiresAt: this.now() + DAY,
      };
    } catch {
      return fallback;
    }
  }
}
