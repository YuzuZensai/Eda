import { err } from "@shared/errors";
import { errorText } from "@shared/error-codes";
import { t } from "@shared/i18n";
import { boundDiff } from "../repository/diff-model";
import { useLayoutStore } from "./layout-store";
import { useSessionStore } from "./session-store";

import type { StoreApi } from "zustand";
import type { RepositoryReadState, RepositorySelection } from "./repository-state";

function readFailure(kind: "commit" | "change") {
  return err({
    kind: "unknown",
    operation: t(kind === "commit" ? "operations.readCommitDiff" : "operations.readWorkingDiff"),
    message: errorText("errors.unexpected"),
  });
}

export function createRepositoryDiff(
  get: StoreApi<RepositoryReadState>["getState"],
  set: StoreApi<RepositoryReadState>["setState"],
) {
  let diffRequest: Promise<void> | null = null;
  let diffRequestKey: string | null = null;
  let commitFileRevision = 0;

  const loadDiff = async (
    selection: Exclude<RepositorySelection, null>,
    { background = false, openConflict = true } = {},
  ) => {
    const { repositoryId, generation } = get();

    if (!repositoryId) return;

    const key = `${generation}:${selection.kind}:${selection.kind === "commit" ? selection.oid : `${selection.area}:${selection.path}`}`;

    if (diffRequestKey === key && diffRequest) return diffRequest;

    const changed = JSON.stringify(get().selection) !== JSON.stringify(selection);
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

    if (conflict) return;

    const request = (async () => {
      const result = await (
        selection.kind === "commit"
          ? window.eda.repository.commitDiff({ repositoryId, oid: selection.oid })
          : window.eda.repository.workingDiff({
              repositoryId,
              paths: [selection.path],
              area: selection.area === "staged" ? "staged" : "unstaged",
            })
      ).catch(() => readFailure(selection.kind));

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

    const result = await window.eda.repository
      .commitDiff({
        repositoryId,
        oid: selection.oid,
        paths: [...new Set([path, ...(file.oldPath ? [file.oldPath] : [])])],
      })
      .catch(() => readFailure("commit"));

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
