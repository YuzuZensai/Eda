import { boundDiff } from "../repository/diff-model";
import { useLayoutStore } from "./layout-store";
import { useSessionStore } from "./session-store";

import type { StoreApi } from "zustand";
import {
  sameSelection,
  repositoryRequestFailure,
  type RepositoryReadState,
  type RepositorySelection,
} from "./repository-state";

export function createRepositoryDiff(
  get: StoreApi<RepositoryReadState>["getState"],
  set: StoreApi<RepositoryReadState>["setState"],
) {
  let diffRequest: Promise<void> | null = null;
  let commitFileRevision = 0;

  const loadDiff = async (
    selection: Exclude<RepositorySelection, null>,
    { background = false, openConflict = true } = {},
  ) => {
    const { repositoryId, generation } = get();

    if (!repositoryId) return;

    const changed = !sameSelection(get().selection, selection);
    if (!changed && diffRequest) return diffRequest;

    const conflict = selection.kind === "change" && selection.area === "conflicted";
    const focused = selection.kind === "change" && (!conflict || openConflict);
    const keepDiff = background && !changed && get().diff !== null;

    set({
      selection,
      ...(!keepDiff && { diff: null }),
      diffLoading: !conflict && !keepDiff,
      error: null,
      ...(changed && {
        contentView: focused ? "diff" : "history",
        commitFilePath: null,
        commitFileDiff: null,
        commitFileLoading: false,
        commitFileError: null,
      }),
    });

    if (changed) useLayoutStore.getState().reveal(focused ? "diff" : "graph");
    if (get().identityId === useSessionStore.getState().snapshot?.context.profileId)
      useSessionStore.getState().setView(repositoryId, { selection });

    if (conflict) {
      diffRequest = null;
      return;
    }

    const request: Promise<void> = (
      selection.kind === "commit"
        ? window.eda.repository.commitDiff({ repositoryId, oid: selection.oid })
        : window.eda.repository.workingDiff({
            repositoryId,
            paths: [selection.path],
            area: selection.area === "staged" ? "staged" : "unstaged",
          })
    )
      .catch(() =>
        repositoryRequestFailure(
          selection.kind === "commit" ? "operations.readCommitDiff" : "operations.readWorkingDiff",
        ),
      )
      .then((result) => {
        if (
          diffRequest !== request ||
          get().generation !== generation ||
          get().repositoryId !== repositoryId ||
          get().selection !== selection
        )
          return;

        if (result.ok) set({ diff: boundDiff(result.value), diffLoading: false });
        else set({ error: result.error, diffLoading: false });
      });

    diffRequest = request;

    await request.finally(() => {
      if (diffRequest === request) diffRequest = null;
    });
  };

  const selectFile = async (path: string) => {
    const { repositoryId, generation, selection, diff, diffLoading } = get();

    if (!repositoryId || selection?.kind !== "commit" || !diff || diffLoading) return;

    const file = diff.files.find((file) => (file.newPath ?? file.oldPath) === path);

    if (!file) return;

    const revision = ++commitFileRevision;
    const paths = [...new Set([path, ...(file.oldPath ? [file.oldPath] : [])])];
    // Git also matches descendants when a file was replaced by a directory.
    const matchesPath = (candidate?: string) =>
      paths.some((path) => candidate === path || candidate?.startsWith(path + "/"));
    const complete =
      !file.truncated &&
      !diff.omittedFiles &&
      !diff.files.some(
        (other) => other !== file && (matchesPath(other.oldPath) || matchesPath(other.newPath)),
      );

    set({
      contentView: "diff",
      commitFilePath: path,
      commitFileDiff: complete ? { files: [file] } : null,
      commitFileLoading: !complete,
      commitFileError: null,
    });

    useLayoutStore.getState().reveal("diff");

    if (complete) return;

    const result = await window.eda.repository
      .commitDiff({ repositoryId, oid: selection.oid, paths })
      .catch(() => repositoryRequestFailure("operations.readCommitDiff"));

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
    },
  };
}
