import { isAbsolute, resolve } from "node:path";
import type { RepositoryNavigation } from "@shared/repository/repository";
import { isValidObjectId, isValidRefName } from "../../git/validation";

export function parseRepositoryLink(value: string): RepositoryNavigation | null {
  try {
    const url = new URL(value);

    if (
      url.protocol !== "eda:" ||
      url.hostname !== "open" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return null;

    if (
      [...url.searchParams.keys()].some((key) => !["path", "commit", "ref"].includes(key)) ||
      [...new Set(url.searchParams.keys())].some((key) => url.searchParams.getAll(key).length !== 1)
    )
      return null;

    const path = url.searchParams.get("path");
    const commit = url.searchParams.get("commit");
    const ref = url.searchParams.get("ref");

    if (
      !path ||
      !isAbsolute(path) ||
      /^[\\/]{2}/.test(path) ||
      path.length > 4096 ||
      /[\x00-\x1f]/.test(path) ||
      (commit && ref)
    )
      return null;

    if (commit && !isValidObjectId(commit)) return null;
    if (ref && (!isValidRefName(ref) || ref.startsWith("-"))) return null;

    return { path, ...(commit ? { commit } : {}), ...(ref ? { ref } : {}) };
  } catch {
    return null;
  }
}

export function navigationFromArguments(args: string[], cwd: string): RepositoryNavigation[] {
  return args
    .filter((arg) => arg && !arg.startsWith("-"))
    .flatMap((arg) => {
      if (arg.startsWith("eda:")) {
        const target = parseRepositoryLink(arg);
        return target ? [target] : [];
      }
      if (/^[a-z]+:\/\//i.test(arg) || /[\x00-\x1f]/.test(arg) || arg.length > 4096) return [];
      return [{ path: resolve(cwd, arg) }];
    })
    .slice(0, 20);
}

export class RepositoryNavigationQueue {
  private targets: RepositoryNavigation[] = [];
  private listeners = new Set<() => void>();

  push(targets: RepositoryNavigation[]) {
    this.targets = [...this.targets, ...targets].slice(-20);
    for (const listener of this.listeners) listener();
  }

  take() {
    const targets = this.targets;
    this.targets = [];
    return targets;
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
