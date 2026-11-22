import {
  UNVERIFIED_COMMIT_SIGNATURE,
  type CommitSignatureVerification,
} from "@shared/repository/repository-read";
import { useCallback, useSyncExternalStore } from "react";
import { useRepositoryStore } from "../../stores/repository-store";
import { useAppStore } from "../../stores/app-store";

interface Entry {
  key: string;
  repositoryId: string;
  identityId: string | null;
  oid: string;
  tagName?: string | undefined;
  // null: manual recheck. undefined: no cached result.
  signature: CommitSignatureVerification | null | undefined;
  listeners: Set<() => void>;
  running: boolean;
  revision: number;
  needsRefresh: boolean;
}

const entries = new Map<string, Entry>();
const queue = new Set<Entry>();
let running = 0;
let subscriptions = 0;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function signatureKey(
  repositoryId: string,
  identityId: string | null,
  oid: string,
  tagName?: string,
) {
  return JSON.stringify([identityId, repositoryId, oid, tagName]);
}

function entryFor(repositoryId: string, identityId: string | null, oid: string, tagName?: string) {
  const key = signatureKey(repositoryId, identityId, oid, tagName);
  let entry = entries.get(key);

  if (!entry) {
    entry = {
      key,
      repositoryId,
      identityId,
      oid,
      tagName,
      signature: undefined,
      listeners: new Set(),
      running: false,
      revision: 0,
      needsRefresh: true,
    };
  }

  entries.delete(key);
  entries.set(key, entry);

  for (const [candidateKey, candidate] of entries) {
    if (entries.size <= 512) break;
    if (!candidate.listeners.size && !candidate.running && candidate !== entry)
      entries.delete(candidateKey);
  }

  return entry;
}

function notify(entry: Entry) {
  for (const listener of entry.listeners) listener();
}

async function load(entry: Entry) {
  const revision = entry.revision;

  try {
    const result = entry.tagName
      ? await window.eda.repository.verifyTag({
          repositoryId: entry.repositoryId,
          name: entry.tagName,
        })
      : await window.eda.repository.commitSignature(entry.repositoryId, entry.oid);

    if (entry.revision !== revision) return;

    const signature =
      result.ok && (!("oid" in result.value) || result.value.oid === entry.oid)
        ? result.value
        : null;
    entry.signature = signature ?? UNVERIFIED_COMMIT_SIGNATURE;
    entry.needsRefresh = signature === null;
  } catch {
    if (entry.revision !== revision) return;

    entry.signature = UNVERIFIED_COMMIT_SIGNATURE;
    entry.needsRefresh = true;
  } finally {
    entry.running = false;
    running--;
    notify(entry);
    drain();
  }
}

function drain() {
  for (const entry of queue) {
    if (running >= 2) break;
    if (entry.running) continue;

    queue.delete(entry);
    if (!entry.needsRefresh) continue;

    entry.running = true;
    running++;
    void load(entry);
  }
}

export function cacheCommitSignature(
  repositoryId: string,
  identityId: string | null,
  oid: string,
  signature: CommitSignatureVerification | null,
  {
    expectedRevision,
    failed = false,
  }: { expectedRevision?: number | undefined; failed?: boolean } = {},
) {
  const entry =
    signature === null && expectedRevision === undefined
      ? entryFor(repositoryId, identityId, oid)
      : entries.get(signatureKey(repositoryId, identityId, oid));
  if (!entry || (expectedRevision !== undefined && entry.revision !== expectedRevision)) return;

  entry.revision++;
  entry.signature = signature;
  entry.needsRefresh = failed;
  notify(entry);
  return entry.revision;
}

export function invalidateRepositorySignatures(clear = true) {
  for (const entry of entries.values()) {
    if (clear) {
      entry.revision++;
      entry.signature = undefined;
      notify(entry);
    } else if (entry.signature === null || entry.running) continue;

    entry.needsRefresh = true;
    if (entry.listeners.size) queue.add(entry);
  }
  drain();
}

export function useCommitSignature(oid: string) {
  const repositoryId = useRepositoryStore((state) => state.repositoryId);
  const identityId = useRepositoryStore((state) => state.identityId);
  return useRepositorySignature(repositoryId, identityId, oid);
}

export function useTagSignature(
  repositoryId: string,
  identityId: string | null,
  name: string,
  oid: string | undefined,
  visible: boolean,
) {
  return useRepositorySignature(repositoryId, identityId, oid, name, visible);
}

function useRepositorySignature(
  repositoryId: string | null,
  identityId: string | null,
  oid: string | undefined,
  tagName?: string,
  enabled = true,
) {
  const key = repositoryId && oid ? signatureKey(repositoryId, identityId, oid, tagName) : null;

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!repositoryId || !oid || !enabled) return () => {};

      const entry = entryFor(repositoryId, identityId, oid, tagName);
      entry.listeners.add(listener);
      subscriptions++;
      refreshTimer ??= setInterval(() => {
        if (document.visibilityState === "visible") invalidateRepositorySignatures(false);
      }, 60_000);

      if (entry.needsRefresh && !entry.running) {
        queue.add(entry);
        drain();
      }

      return () => {
        entry.listeners.delete(listener);
        subscriptions--;
        if (subscriptions === 0) {
          clearInterval(refreshTimer);
          refreshTimer = undefined;
        }

        if (!entry.listeners.size) queue.delete(entry);
      };
    },
    [repositoryId, identityId, oid, tagName, enabled],
  );

  const snapshot = useCallback(() => (key ? entries.get(key)?.signature : undefined), [key]);
  return useSyncExternalStore(subscribe, snapshot);
}

useAppStore.subscribe((state, previous) => {
  const identityId = state.activeIdentity?.id;
  if (
    !identityId ||
    identityId !== previous.activeIdentity?.id ||
    state.switchingIdentityId !== null ||
    state.repositories === previous.repositories
  )
    return;

  const live = new Set(state.repositories.map((repository) => repository.id));
  for (const entry of entries.values()) {
    if (entry.identityId !== identityId || live.has(entry.repositoryId)) continue;

    entry.revision++;
    entries.delete(entry.key);
    queue.delete(entry);
    notify(entry);
  }
});
