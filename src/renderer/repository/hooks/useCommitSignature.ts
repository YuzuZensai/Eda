import {
  UNVERIFIED_COMMIT_SIGNATURE,
  type CommitSignatureVerification,
} from "@shared/repository/repository-read";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useRepositoryStore } from "../../stores/repository-store";
import { useAppStore } from "../../stores/app-store";

interface Entry {
  key: string;
  repositoryId: string;
  identityId: string | null;
  oid: string;
  signature: CommitSignatureVerification | null;
  listeners: Set<() => void>;
  running: boolean;
  revision: number;
  failed: boolean;
  discarded: boolean;
}

const entries = new Map<string, Entry>();
const queue: Entry[] = [];
let running = 0;
let subscriptions = 0;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function signatureKey(repositoryId: string, identityId: string | null, oid: string) {
  return JSON.stringify([identityId, repositoryId, oid]);
}

function entryFor(repositoryId: string, identityId: string | null, oid: string) {
  const key = signatureKey(repositoryId, identityId, oid);
  let entry = entries.get(key);

  if (!entry) {
    entry = {
      key,
      repositoryId,
      identityId,
      oid,
      signature: null,
      listeners: new Set(),
      running: false,
      revision: 0,
      failed: false,
      discarded: false,
    };
    entries.set(key, entry);
  }

  // Retain recently viewed commits without growing with the entire repository history.
  entries.delete(key);
  entries.set(key, entry);

  for (const [candidateKey, candidate] of entries) {
    if (entries.size <= 256) break;
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
    const result = await window.eda.repository.commitSignature(entry.repositoryId, entry.oid);

    if (entry.discarded || entry.revision !== revision) return;

    entry.signature = result.ok ? result.value : UNVERIFIED_COMMIT_SIGNATURE;
    entry.failed = !result.ok;
  } catch {
    if (entry.discarded || entry.revision !== revision) return;

    entry.signature = UNVERIFIED_COMMIT_SIGNATURE;
    entry.failed = true;
  } finally {
    entry.running = false;
    running--;
    notify(entry);
    drain();
  }
}

function drain() {
  while (running < 2 && queue.length) {
    const entry = queue.shift()!;
    if (entry.discarded || !entry.listeners.size || entry.signature) continue;
    if (entry.running) {
      queue.push(entry);
      break;
    }

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
  entry.failed = failed;
  notify(entry);
  return entry.revision;
}

export function invalidateCommitSignatures() {
  for (const entry of entries.values()) {
    entry.revision++;
    entry.signature = null;
    entry.failed = false;
    notify(entry);
    if (entry.listeners.size && !queue.includes(entry)) queue.push(entry);
  }
  drain();
}

export function useCommitSignature(oid: string) {
  const repositoryId = useRepositoryStore((state) => state.repositoryId);
  const identityId = useRepositoryStore((state) => state.identityId);
  const entry = useMemo(
    () => (repositoryId ? entryFor(repositoryId, identityId, oid) : null),
    [repositoryId, identityId, oid],
  );

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!entry) return () => {};

      entry.listeners.add(listener);
      subscriptions++;
      refreshTimer ??= setInterval(() => {
        if (document.visibilityState === "visible") invalidateCommitSignatures();
      }, 60_000);

      if (entry.failed) {
        entry.signature = null;
        entry.failed = false;
        notify(entry);
      }

      if (!entry.signature && !entry.running && !queue.includes(entry)) {
        queue.push(entry);
        drain();
      }

      return () => {
        entry.listeners.delete(listener);
        subscriptions--;
        if (subscriptions === 0) {
          clearInterval(refreshTimer);
          refreshTimer = undefined;
        }

        if (!entry.listeners.size) {
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
        }
      };
    },
    [entry],
  );

  const snapshot = useCallback(() => entry?.signature ?? null, [entry]);
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

    entry.discarded = true;
    entry.signature = null;
    entries.delete(entry.key);
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    notify(entry);
  }
});
