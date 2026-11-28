import { join, relative, isAbsolute, sep } from "node:path";
import { t } from "@shared/i18n";
import { watch, type FSWatcher } from "node:fs";

const DEFAULT_DEBOUNCE_MS = 150;
const POLL_INTERVAL_MS = 5_000;

interface Entry {
  watchers?: FSWatcher[];
  timer?: NodeJS.Timeout;
  deadline?: number;
  poll?: NodeJS.Timeout;
}

export class RepositoryWatcher {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly onChange: (repositoryId: string, warning?: string) => void,
    private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS,
  ) {}

  watch(
    repositoryId: string,
    repositoryPath: string,
    metadata?: { gitDir: string; commonDir: string },
  ): void {
    this.unwatch(repositoryId);
    const watchers: FSWatcher[] = [];
    const entry: Entry = { watchers };
    this.entries.set(repositoryId, entry);

    const subscribe = (path: string, recursive: boolean, prefix: string) => {
      const watcher = watch(path, { recursive, persistent: false });
      watchers.push(watcher);
      watcher.on("error", () => {
        if (this.entries.get(repositoryId) !== entry) return;
        this.unwatch(repositoryId);
        this.poll(repositoryId);
      });
      watcher.on("change", (_event, name) => {
        if (this.entries.get(repositoryId) !== entry) return;
        if (name != null && isIgnoredWatchPath(prefix + name.toString())) return;
        this.schedule(repositoryId);
      });
    };

    try {
      subscribe(repositoryPath, true, "");
      if (metadata) {
        const outside = (path: string) => {
          const local = relative(repositoryPath, path);
          return isAbsolute(local) || local === ".." || local.startsWith(".." + sep);
        };
        for (const directory of new Set([metadata.commonDir, metadata.gitDir])) {
          if (outside(directory)) subscribe(directory, false, ".git/");
        }
        if (outside(metadata.commonDir))
          subscribe(join(metadata.commonDir, "refs"), true, ".git/refs/");
      }
    } catch {
      this.unwatch(repositoryId);
      this.poll(repositoryId);
    }
  }

  unwatch(repositoryId: string): void {
    const entry = this.entries.get(repositoryId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.poll) clearInterval(entry.poll);
    for (const watcher of entry.watchers ?? []) watcher.close();
    this.entries.delete(repositoryId);
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.unwatch(id);
  }

  private poll(repositoryId: string): void {
    const poll = setInterval(() => this.onChange(repositoryId), POLL_INTERVAL_MS);

    poll.unref();
    this.entries.set(repositoryId, { poll });

    this.onChange(
      repositoryId,
      t("main.repositoryWatcher.fileWatchingIsUnavailableEdaRefreshesEveryFive"),
    );
  }

  private schedule(repositoryId: string): void {
    const entry = this.entries.get(repositoryId);

    if (!entry) return;
    // Keep the usual quiet period, but give busy worktrees the same latency bound as polling.
    const now = performance.now();
    entry.deadline ??= now + POLL_INTERVAL_MS;
    const delay = Math.min(this.debounceMs, entry.deadline - now);
    if (entry.timer) {
      if (delay <= 0) return;
      clearTimeout(entry.timer);
    }

    entry.timer = setTimeout(() => {
      const current = this.entries.get(repositoryId);
      if (current !== entry) return;
      delete current.timer;
      delete current.deadline;
      this.onChange(repositoryId);
    }, delay);
  }
}

const IGNORED_GIT_ENTRIES = new Set([
  "COMMIT_EDITMSG",
  "FETCH_HEAD",
  "ORIG_HEAD",
  "MERGE_MSG",
  "SQUASH_MSG",
  "TAG_EDITMSG",
]);

export function isIgnoredWatchPath(relativePath: string): boolean {
  const path = relativePath.replaceAll("\\", "/");
  const segments = path.split("/");

  if (segments[0] !== ".git") return false;
  if (path.endsWith(".lock")) return true;

  const entry = segments[1];

  if (entry === undefined) return true;
  if (entry === "objects" || entry === "logs") return true;

  return IGNORED_GIT_ENTRIES.has(entry);
}
