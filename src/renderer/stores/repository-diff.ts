import { boundDiff } from "../repository/diff-model";
import { useLayoutStore } from "./layout-store";
import { useSessionStore } from "./session-store";

import type { StoreApi } from "zustand";
import type { RepositoryReadState, RepositorySelection } from "./repository-state";

export function createRepositoryDiff(
  get: StoreApi<RepositoryReadState>["getState"],
  set: StoreApi<RepositoryReadState>["setState"],
) {
  let diffRequest: Promise<void> | null = null;
  let diffRequestKey: string | null = null;
  let commitFileRevision = 0;

  const loadDiff = async (
    selection: Exclude<RepositorySelection, null>,
    { background = false } = {},
  ) => {
    const { repositoryId, generation } = get();

    if (!repositoryId) return;

    const key = `${generation}:${selection.kind}:${selection.kind === "commit" ? selection.oid : `${selection.area}:${selection.path}`}`;

    if (diffRequestKey === key && diffRequest) return diffRequest;

    const changed = JSON.stringify(get().selection) !== JSON.stringify(selection);
    const keepDiff = background && !changed && get().diff !== null;

    set({
      selection,
      ...(!keepDiff && { diff: null }),
      diffLoading: !keepDiff,
      error: null,
      ...(changed && {
        contentView: selection.kind === "change" ? "diff" : "history",
        commitFilePath: null,
        commitFileDiff: null,
        commitFileLoading: false,
        commitFileError: null,
      }),
    });

    if (changed) useLayoutStore.getState().reveal(selection.kind === "change" ? "diff" : "graph");
    if (get().identityId === useSessionStore.getState().snapshot?.context.profileId)
      useSessionStore.getState().setView(repositoryId, { selection });

    const request = (async () => {
      const result =
        selection.kind === "commit"
          ? await window.eda.repository.commitDiff({ repositoryId, oid: selection.oid })
          : await window.eda.repository.workingDiff({
              repositoryId,
              paths: [selection.path],
              area: selection.area === "staged" ? "staged" : "unstaged",
            });

      if (
        get().generation !== generation ||
        get().repositoryId !== repositoryId ||
        get().selection !== selection
      )
        return;

      if (result.ok) set({ diff: boundDiff(result.value), diffLoading: false });
      else set({ error: result.error, diffLoading: false });
    })();

    diffRequest = request;
    diffRequestKey = key;

    await request.finally(() => {
      if (diffRequest === request) {
        diffRequest = null;
        diffRequestKey = null;
      }
    });
  };

  const selectFile = async (path: string) => {
    const { repositoryId, generation, selection, diff, diffLoading } = get();

    if (!repositoryId || selection?.kind !== "commit" || diffLoading) return;

    const file = diff?.files.find((file) => (file.newPath ?? file.oldPath) === path);

    if (!file) return;

    const revision = ++commitFileRevision;

    set({
      contentView: "diff",
      commitFilePath: path,
      commitFileDiff: null,
      commitFileLoading: true,
      commitFileError: null,
    });

    useLayoutStore.getState().reveal("diff");

    const result = await window.eda.repository.commitDiff({
      repositoryId,
      oid: selection.oid,
      paths: [...new Set([path, ...(file.oldPath ? [file.oldPath] : [])])],
    });

    const current = get();

    if (
      revision !== commitFileRevision ||
      current.generation !== generation ||
      current.repositoryId !== repositoryId ||
      current.selection?.kind !== "commit" ||
      current.selection.oid !== selection.oid ||
      current.commitFilePath !== path
    )
      return;

    set(
      result.ok
        ? { commitFileDiff: boundDiff(result.value), commitFileLoading: false }
        : { commitFileError: result.error, commitFileLoading: false },
    );
  };

  return {
    load: loadDiff,
    selectFile,
    invalidate() {
      diffRequest = null;
      diffRequestKey = null;
    },
  };
}
