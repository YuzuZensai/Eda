import { preferredRemote, type RemoteTagSummary } from "@shared/integrations/remotes";
import type { TagSummary } from "@shared/repository/repository-write";
import { useEffect, useMemo, useState } from "react";

const tagNames = new Intl.Collator(undefined, { numeric: true });

export interface TagReference extends TagSummary {
  local: boolean;
  localOnly: boolean;
  remotes: { name: string; oid: string }[];
  unknownRemotes: string[];
  remoteStatusUnavailable: boolean;
}

export function useTagReferences(
  repositoryId: string,
  profileId: string | undefined,
  localTags: TagSummary[],
  revision: number,
  pending: boolean,
) {
  const [snapshot, setSnapshot] = useState<{
    repositoryId: string;
    profileId: string | undefined;
    revision: number;
    failed: boolean;
    remotes: { name: string; tags: RemoteTagSummary[] | null }[];
  } | null>(null);

  useEffect(() => {
    if (pending) return;

    let cancelled = false;
    const context = { repositoryId, profileId, revision };

    void (async () => {
      const state = await window.eda.remotes.inspect(repositoryId);
      if (cancelled) return;
      if (!state.ok) throw state.error;

      const preferred = preferredRemote(state.value)?.name;
      const remotes = [...state.value.remotes].sort(
        (a, b) => Number(b.name === preferred) - Number(a.name === preferred),
      );

      setSnapshot({
        ...context,
        failed: false,
        remotes: remotes.map((remote) => ({ name: remote.name, tags: null })),
      });

      await Promise.all(
        remotes.map(async (remote) => {
          const result = await window.eda.remotes
            .listTags({ repositoryId, remote: remote.name })
            .catch(() => null);

          if (cancelled) return;

          const tags = result?.ok ? result.value : null;
          setSnapshot(
            (old) =>
              old && {
                ...old,
                remotes: old.remotes.map((item) =>
                  item.name === remote.name ? { ...item, tags } : item,
                ),
              },
          );
        }),
      );
    })().catch(() => {
      if (!cancelled) setSnapshot({ ...context, failed: true, remotes: [] });
    });

    return () => {
      cancelled = true;
    };
  }, [repositoryId, profileId, revision, pending]);

  const current =
    !pending &&
    snapshot?.repositoryId === repositoryId &&
    snapshot.profileId === profileId &&
    snapshot.revision === revision
      ? snapshot
      : null;
  return useMemo(() => {
    const remoteStatusKnown = current !== null && !current.failed;
    const remoteStatusUnavailable = current?.failed === true;
    const remotes = current?.remotes ?? [];
    const unknownRemotes = remotes
      .filter((remote) => remote.tags === null)
      .map((remote) => remote.name);
    const merged = new Map<string, TagReference>(
      localTags.map((tag) => [
        tag.name,
        {
          ...tag,
          local: true,
          localOnly: false,
          remotes: [],
          unknownRemotes,
          remoteStatusUnavailable,
        },
      ]),
    );

    for (const remote of remotes) {
      for (const tag of remote.tags ?? []) {
        let reference = merged.get(tag.name);
        if (!reference) {
          reference = {
            ...tag,
            local: false,
            localOnly: false,
            remotes: [],
            unknownRemotes,
            remoteStatusUnavailable,
          };
          merged.set(tag.name, reference);
        }
        reference.remotes.push({ name: remote.name, oid: tag.oid });
      }
    }

    for (const tag of merged.values()) {
      tag.localOnly =
        tag.local && remoteStatusKnown && unknownRemotes.length === 0 && tag.remotes.length === 0;
    }

    return [...merged.values()].sort((a, b) => {
      const aDate = a.createdAt ? Date.parse(a.createdAt) : -Infinity;
      const bDate = b.createdAt ? Date.parse(b.createdAt) : -Infinity;

      return bDate - aDate || tagNames.compare(b.name, a.name);
    });
  }, [current, localTags]);
}
