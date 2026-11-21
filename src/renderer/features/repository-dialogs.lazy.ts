import type * as RepositoryDialogs from "./repository-dialogs";
import { lazy } from "react";

export function lazyRepositoryDialog<K extends keyof typeof RepositoryDialogs>(name: K) {
  return lazy(async () => ({ default: (await import("./repository-dialogs"))[name] }));
}
