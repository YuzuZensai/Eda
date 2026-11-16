import { emptySession, emptyView } from "@shared/identity/profile-session";
import { useSessionStore } from "@renderer/stores/session-store";
import { errorFixture } from "../../helpers/error";
import { deferred } from "../../helpers/deferred";
import type { EdaApi } from "@shared/ipc";
import type { HistoryCommit, UnifiedDiff } from "@shared/repository/repository-read";
import type { Result } from "@shared/errors";
import { err, ok } from "@shared/errors";
import { layoutCommitPages } from "@renderer/repository/dag-layout";
import {
  HISTORY_PAGE_SIZE,
  MAX_HISTORY_PAGES,
  MAX_STATUS_CHANGES,
  categorizeChanges,
  useRepositoryStore,
} from "@renderer/stores/repository-store";

const makeCommit = (index: number): HistoryCommit => ({
  oid: `oid-${index}`,
  parents: [],
  subject: `commit ${index}`,
  body: "",
  decorations: [],
  author: { name: "A", email: "a@example.com", timestamp: "2026-01-01T00:00:00Z" },
  committerTimestamp: "2026-01-01T00:00:00Z",
});

function api(history: EdaApi["repository"]["history"]): EdaApi {
  return {
    repository: {
      status: async () =>
        ok({ branch: { ahead: 0, behind: 0, detached: false, unborn: false }, changes: [] }),
      history,
      workingDiff: async () => ok({ files: [] }),
      commitDiff: async () => ok({ files: [] }),
    },
  } as unknown as EdaApi;
}

describe("repository read store", () => {
  beforeEach(() => useRepositoryStore.getState().clear());

  it("refreshes in place while keeping the current view and diff visible", async () => {
    const bridge = api(async () => ok({ commits: [makeCommit(0)], nextOffset: null }));
    vi.stubGlobal("eda", bridge);
    const store = useRepositoryStore.getState();
    await store.open("repo", "identity", true);
    await store.selectChange(
      { kind: "ordinary", path: "file.txt", index: ".", worktree: "M", submodule: "N..." },
      "unstaged",
    );
    const before = useRepositoryStore.getState();
    const status = deferred<Awaited<ReturnType<typeof bridge.repository.status>>>();
    const diff = deferred<Awaited<ReturnType<typeof bridge.repository.workingDiff>>>();
    const readDiff = vi.spyOn(bridge.repository, "workingDiff").mockReturnValueOnce(diff.promise);
    vi.spyOn(bridge.repository, "status").mockReturnValueOnce(status.promise);

    const refresh = store.refresh();

    expect(useRepositoryStore.getState()).toMatchObject({
      phase: "ready",
      generation: before.generation,
      status: before.status,
      pages: before.pages,
      selection: before.selection,
      contentView: "diff",
      diff: before.diff,
      diffLoading: false,
      navigation: before.navigation,
    });

    status.resolve(
      ok({ ...before.status!, branch: { ...before.status!.branch, head: "updated" } }),
    );
    await vi.waitFor(() => expect(readDiff).toHaveBeenCalled());

    expect(useRepositoryStore.getState().diff).toBe(before.diff);
    expect(useRepositoryStore.getState().diffLoading).toBe(false);
    const updatedDiff: UnifiedDiff = {
      files: [{ newPath: "file.txt", status: "modified", binary: false, hunks: [] }],
    };
    diff.resolve(ok(updatedDiff));
    await refresh;

    expect(useRepositoryStore.getState()).toMatchObject({
      phase: "ready",
      generation: before.generation,
      status: { branch: { head: "updated" } },
      selection: before.selection,
      contentView: "diff",
      diff: updatedDiff,
      diffLoading: false,
      navigation: before.navigation,
    });
  });

  it("keeps an inspected commit file selected when refreshing", async () => {
    const bridge = api(async () => ok({ commits: [makeCommit(0)], nextOffset: null }));
    bridge.repository.commitDiff = async () =>
      ok({ files: [{ newPath: "file.txt", status: "added", binary: false, hunks: [] }] });
    vi.stubGlobal("eda", bridge);
    const store = useRepositoryStore.getState();
    await store.open("repo", "identity", true);
    await store.selectCommit("oid-0");
    await store.selectCommitFile("file.txt");
    const before = useRepositoryStore.getState();

    await store.refresh();

    expect(useRepositoryStore.getState()).toMatchObject({
      generation: before.generation,
      selection: before.selection,
      contentView: "diff",
      commitFilePath: "file.txt",
      commitFileDiff: before.commitFileDiff,
      commitFileLoading: false,
      navigation: before.navigation,
    });
  });

  it("discards an in-place refresh after switching profiles", async () => {
    const bridge = api(async () => ok({ commits: [makeCommit(0)], nextOffset: null }));
    vi.stubGlobal("eda", bridge);
    const store = useRepositoryStore.getState();
    await store.open("repo", "identity", true);
    const status = deferred<Awaited<ReturnType<typeof bridge.repository.status>>>();
    vi.spyOn(bridge.repository, "status").mockReturnValueOnce(status.promise);
    const refresh = store.refresh();

    await store.open("repo", "other-profile", true);
    const current = useRepositoryStore.getState();
    status.resolve(err(errorFixture({ message: "Stale refresh failure" })));
    await refresh;

    expect(useRepositoryStore.getState()).toBe(current);
  });

  it("preserves topology after evicting and reloading a page with parallel ancestry", async () => {
    const commits = Array.from({ length: 600 }, (_, index) => ({
      ...makeCommit(index),
      parents: index < 598 ? [`oid-${index + 2}`] : [],
    }));
    const expected = layoutCommitPages([commits]);

    Object.defineProperty(window, "eda", {
      configurable: true,
      value: api(async ({ offset = 0 }) =>
        ok({
          commits: commits.slice(offset, offset + 100),
          nextOffset: offset + 100 < commits.length ? offset + 100 : null,
        }),
      ),
    });
    await useRepositoryStore.getState().open("repo", "identity", true);

    for (let page = 0; page < 4; page++) await useRepositoryStore.getState().loadMore();

    const assertTopology = () => {
      const state = useRepositoryStore.getState();
      const rows = layoutCommitPages(
        state.pages.map((page) => page.commits),
        state.dagBoundary,
      );
      expect(rows).toEqual(expected.slice(state.baseOffset, state.baseOffset + rows.length));
    };

    assertTopology();
    await useRepositoryStore.getState().loadPrevious();
    assertTopology();
  });

  it("keeps working changes available when only history fails", async () => {
    Object.defineProperty(window, "eda", {
      configurable: true,
      value: api(async () =>
        err(
          errorFixture({
            kind: "repository-corrupt",
            operation: "history",
            message: "Missing object",
          }),
        ),
      ),
    });
    await useRepositoryStore.getState().open("repo", "identity", true);
    expect(useRepositoryStore.getState().phase).toBe("ready");
    expect(useRepositoryStore.getState().status).not.toBeNull();
    expect(useRepositoryStore.getState().historyError?.message).toBe("Missing object");
  });

  it("reports truncated working changes even when the initial history load fails", async () => {
    const bridge = api(async () => err(errorFixture({ message: "Missing object" })));
    bridge.repository.status = async () =>
      ok({
        branch: { ahead: 0, behind: 0, detached: false, unborn: false },
        changes: Array.from({ length: MAX_STATUS_CHANGES + 1 }, (_, index) => ({
          kind: "untracked",
          path: `file-${index}`,
          index: "?",
          worktree: "?",
          submodule: "N...",
        })),
      });
    vi.stubGlobal("eda", bridge);

    await useRepositoryStore.getState().open("repo", "identity", true);

    expect(useRepositoryStore.getState().status?.changes).toHaveLength(MAX_STATUS_CHANGES);
    expect(useRepositoryStore.getState().truncatedChanges).toBe(true);
    expect(useRepositoryStore.getState().historyError?.message).toBe("Missing object");
  });

  it.each(["available", "missing", "corrupt"] as const)(
    "handles a saved commit that is %s, clearing only a missing selection after recloning",
    async (availability) => {
      const selection = { kind: "commit" as const, oid: "a".repeat(40) };
      const setView = vi.fn();
      const session = vi.spyOn(useSessionStore, "getState").mockReturnValue({
        ...useSessionStore.getState(),
        setView,
        snapshot: {
          context: { profileId: "identity", windowId: "primary", generation: 1 },
          session: {
            ...emptySession(),
            views: { repo: { ...emptyView(), selection } },
          },
          drafts: {},
          recovery: null,
        },
      });
      const failure = errorFixture({
        kind: availability === "missing" ? "invalid-input" : "repository-corrupt",
        code:
          availability === "missing"
            ? "main.git.gitService.theCommitIsNoLongerAvailable"
            : "main.git.errorMapping.thisRepositoryHasCorruptOrMissingObjects",
        message: availability,
      });
      const eda = api(async () => ok({ commits: [makeCommit(0)], nextOffset: null }));
      eda.repository.commitDiff = async () =>
        availability === "available" ? ok({ files: [] }) : { ok: false, error: failure };
      Object.defineProperty(window, "eda", { configurable: true, value: eda });

      try {
        await useRepositoryStore.getState().open("repo", "identity", true);

        const state = useRepositoryStore.getState();
        expect(state.phase).toBe("ready");
        expect(state.pages[0]?.commits).toEqual([makeCommit(0)]);
        expect(state.selection).toEqual(availability === "missing" ? null : selection);
        expect(state.error).toEqual(availability === "corrupt" ? failure : null);

        if (availability === "missing")
          expect(setView).toHaveBeenLastCalledWith("repo", { selection: null });
        else expect(setView).not.toHaveBeenCalledWith("repo", { selection: null });
      } finally {
        session.mockRestore();
      }
    },
  );

  it.each([0, MAX_STATUS_CHANGES])(
    "restores a saved working selection only if it is in the bounded status (index %i)",
    async (index) => {
      const selection = { kind: "change", area: "unstaged", path: `file-${index}` } as const;
      const session = vi.spyOn(useSessionStore, "getState").mockReturnValue({
        ...useSessionStore.getState(),
        setView: vi.fn(),
        snapshot: {
          context: { profileId: "identity", windowId: "primary", generation: 1 },
          session: { ...emptySession(), views: { repo: { ...emptyView(), selection } } },
          drafts: {},
          recovery: null,
        },
      });
      const bridge = api(async () => ok({ commits: [], nextOffset: null }));
      bridge.repository.status = async () =>
        ok({
          branch: { ahead: 0, behind: 0, detached: false, unborn: false },
          changes: Array.from({ length: MAX_STATUS_CHANGES + 1 }, (_, changeIndex) => ({
            kind: "ordinary",
            path: `file-${changeIndex}`,
            index: ".",
            worktree: "M",
            submodule: "N...",
          })),
        });
      vi.stubGlobal("eda", bridge);

      try {
        await useRepositoryStore.getState().open("repo", "identity", true);

        expect(useRepositoryStore.getState().selection).toEqual(index === 0 ? selection : null);
        expect(useRepositoryStore.getState().truncatedChanges).toBe(true);
      } finally {
        session.mockRestore();
      }
    },
  );

  it("jumps to an uncached commit with bounded ancestry pages and restores the saved graph on refresh", async () => {
    const read = vi.fn(async ({ refs }: { refs?: string[] }) =>
      ok({ commits: [{ ...makeCommit(0), oid: refs?.[0] ?? "head" }], nextOffset: null }),
    );

    Object.defineProperty(window, "eda", { configurable: true, value: api(read) });
    await useRepositoryStore.getState().open("repo", "identity", true);
    await useRepositoryStore.getState().jumpToCommit("a".repeat(40));
    expect(useRepositoryStore.getState().historyTip).toBe("a".repeat(40));
    expect(useRepositoryStore.getState().pages[0]?.commits[0]?.oid).toBe("a".repeat(40));

    await useRepositoryStore.getState().refresh();
    expect(useRepositoryStore.getState().historyTip).toBeNull();
    expect(useRepositoryStore.getState().pages[0]?.commits[0]?.oid).toBe("head");
  });

  it("restores the pinned graph lane when refreshing after inspecting another commit", async () => {
    const pinnedOid = "b".repeat(40);
    const session = vi.spyOn(useSessionStore, "getState").mockReturnValue({
      ...useSessionStore.getState(),
      setView: vi.fn(),
      snapshot: {
        context: { profileId: "identity", windowId: "primary", generation: 1 },
        session: {
          ...emptySession(),
          views: {
            repo: {
              ...emptyView(),
              graphFilter: { refs: [], hiddenRefs: [], pinnedRef: null, pinnedOid },
            },
          },
        },
        drafts: {},
        recovery: null,
      },
    });
    Object.defineProperty(window, "eda", {
      configurable: true,
      value: api(async ({ refs }) =>
        ok({ commits: [{ ...makeCommit(0), oid: refs?.[0] ?? "head" }], nextOffset: null }),
      ),
    });
    try {
      const store = useRepositoryStore.getState();
      await store.open("repo", "identity", true);
      await store.jumpToCommit("a".repeat(40));
      expect(useRepositoryStore.getState().dagBoundary).toEqual({ lanes: [] });
      await store.refresh();
      expect(useRepositoryStore.getState().dagBoundary).toEqual({
        lanes: [pinnedOid],
        pinned: true,
      });
    } finally {
      session.mockRestore();
    }
  });

  it("keeps bounded back/forward selections and drops the forward branch after a new selection", async () => {
    Object.defineProperty(window, "eda", {
      configurable: true,
      value: api(async () => ok({ commits: [], nextOffset: null })),
    });
    await useRepositoryStore.getState().open("repo", "identity", true);

    for (const oid of ["aaaa", "bbbb", "cccc"])
      await useRepositoryStore.getState().selectCommit(oid);

    await useRepositoryStore.getState().navigate(-1);
    expect(useRepositoryStore.getState().selection).toEqual({ kind: "commit", oid: "bbbb" });

    await useRepositoryStore.getState().navigate(1);
    expect(useRepositoryStore.getState().selection).toEqual({ kind: "commit", oid: "cccc" });

    await useRepositoryStore.getState().navigate(-1);
    await useRepositoryStore.getState().selectCommit("dddd");
    expect(useRepositoryStore.getState().navigation).toEqual(
      ["aaaa", "bbbb", "dddd"].map((oid) => ({ kind: "commit", oid })),
    );

    await useRepositoryStore.getState().open("other", "other-profile", true);
    expect(useRepositoryStore.getState().navigation).toEqual([]);
  });

  it("loads selected commit files with independent budgets and rejects stale file and profile responses", async () => {
    const summaries: UnifiedDiff = {
      files: [
        { newPath: "late.ts", status: "added", binary: false, hunks: [], truncated: true },
        { oldPath: "old.ts", newPath: "new.ts", status: "renamed", binary: false, hunks: [] },
      ],
    };

    const preview = (path: string, content: string): UnifiedDiff => ({
      files: [
        {
          newPath: path,
          status: "added",
          binary: false,
          hunks: [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              heading: "",
              lines: [{ type: "addition", content, newLineNumber: 1 }],
            },
          ],
        },
      ],
    });

    const requests: { paths: string[]; finish: (result: Result<UnifiedDiff>) => void }[] = [];
    const bridge = api(async () => ok({ commits: [], nextOffset: null }));

    bridge.repository.commitDiff = async ({ paths }) => {
      if (!paths) return ok(summaries);
      return new Promise((finish) => requests.push({ paths, finish }));
    };
    Object.defineProperty(window, "eda", { configurable: true, value: bridge });

    const store = useRepositoryStore.getState();

    await store.open("repo", "profile", true);
    await store.selectCommit("commit-a");

    const late = store.selectCommitFile("late.ts");

    expect(requests[0]!.paths).toEqual(["late.ts"]);

    const renamed = store.selectCommitFile("new.ts");

    expect(requests[1]!.paths).toEqual(["new.ts", "old.ts"]);

    requests[1]!.finish(ok(preview("new.ts", "renamed content")));
    await renamed;
    requests[0]!.finish(
      err(
        errorFixture({
          kind: "repository-corrupt",
          operation: "commit diff",
          message: "stale failure",
        }),
      ),
    );
    await late;
    expect(useRepositoryStore.getState()).toMatchObject({
      commitFilePath: "new.ts",
      commitFileDiff: preview("new.ts", "renamed content"),
      commitFileError: null,
      commitFileLoading: false,
      diff: summaries,
    });

    const small = store.selectCommitFile("late.ts");

    requests[2]!.finish(ok(preview("late.ts", "complete small file")));
    await small;
    expect(useRepositoryStore.getState().commitFileDiff).toMatchObject(
      preview("late.ts", "complete small file"),
    );

    const oldCommit = store.selectCommitFile("late.ts");

    await store.selectCommit("commit-b");
    requests[3]!.finish(ok(preview("late.ts", "old commit")));
    await oldCommit;
    expect(useRepositoryStore.getState()).toMatchObject({
      selection: { oid: "commit-b" },
      commitFileDiff: null,
    });

    const oldProfile = store.selectCommitFile("late.ts");

    await store.open("other-repo", "other-profile", true);
    requests[4]!.finish(ok(preview("late.ts", "old profile")));
    await oldProfile;
    expect(useRepositoryStore.getState()).toMatchObject({
      repositoryId: "other-repo",
      identityId: "other-profile",
      commitFileDiff: null,
      commitFileLoading: false,
    });
  });

  it("discards stale repository results", async () => {
    let release:
      | ((value: ReturnType<typeof ok<{ commits: HistoryCommit[]; nextOffset: null }>>) => void)
      | undefined;
    const first = new Promise<
      ReturnType<typeof ok<{ commits: HistoryCommit[]; nextOffset: null }>>
    >((resolve) => {
      release = resolve;
    });

    Object.defineProperty(window, "eda", {
      configurable: true,
      value: api(async ({ repositoryId }) =>
        repositoryId === "old" ? first : ok({ commits: [makeCommit(2)], nextOffset: null }),
      ),
    });

    const oldLoad = useRepositoryStore.getState().open("old", "identity", true);

    await useRepositoryStore.getState().open("new", "identity", true);
    release?.(ok({ commits: [makeCommit(1)], nextOffset: null }));
    await oldLoad;
    expect(useRepositoryStore.getState().repositoryId).toBe("new");
    expect(useRepositoryStore.getState().pages[0]?.commits[0]?.oid).toBe("oid-2");
  });

  it("coalesces page loads and slides through history while retaining at most three pages", async () => {
    let calls = 0;

    Object.defineProperty(window, "eda", {
      configurable: true,
      value: api(async ({ offset = 0 }) => {
        calls += 1;
        return ok({
          commits: Array.from({ length: HISTORY_PAGE_SIZE + 20 }, (_, i) => makeCommit(offset + i)),
          nextOffset: offset + HISTORY_PAGE_SIZE,
        });
      }),
    });
    await useRepositoryStore.getState().open("repo", "identity", true);
    await Promise.all([
      useRepositoryStore.getState().loadMore(),
      useRepositoryStore.getState().loadMore(),
    ]);
    await useRepositoryStore.getState().loadMore();
    await useRepositoryStore.getState().loadMore();
    await useRepositoryStore.getState().loadMore();

    const state = useRepositoryStore.getState();

    expect(calls).toBe(MAX_HISTORY_PAGES + 2);
    expect(state.pages).toHaveLength(MAX_HISTORY_PAGES);
    expect(state.pages.flatMap((page) => page.commits)).toHaveLength(
      MAX_HISTORY_PAGES * HISTORY_PAGE_SIZE,
    );
    expect(state.baseOffset).toBe(HISTORY_PAGE_SIZE * 2);
    expect(state.nextOffset).toBe(HISTORY_PAGE_SIZE * 5);

    await useRepositoryStore.getState().loadPrevious();
    expect(useRepositoryStore.getState().baseOffset).toBe(HISTORY_PAGE_SIZE);
    expect(useRepositoryStore.getState().pages).toHaveLength(MAX_HISTORY_PAGES);
  });

  it("drops an in-flight page from the old history after a disk refresh replaces the first page", async () => {
    let finishRefresh!: () => void;
    let finishPage!: () => void;
    let opened = false;
    const bridge = api(async ({ offset }) => {
      if (offset) {
        await new Promise<void>((resolve) => {
          finishPage = resolve;
        });
        return ok({ commits: [makeCommit(2)], nextOffset: null });
      }
      if (opened) {
        await new Promise<void>((resolve) => {
          finishRefresh = resolve;
        });
        return ok({ commits: [makeCommit(3)], nextOffset: null });
      }
      opened = true;
      return ok({ commits: [makeCommit(1)], nextOffset: 1 });
    });
    Object.defineProperty(window, "eda", { configurable: true, value: bridge });
    const store = useRepositoryStore.getState();
    await store.open("repo", "identity", true);
    const refresh = store.syncFromDisk();
    const page = store.loadMore();
    finishRefresh();
    await refresh;
    finishPage();
    await page;
    expect(useRepositoryStore.getState().pages).toEqual([
      { commits: [makeCommit(3)], nextOffset: null },
    ]);
  });

  it("keeps a history paging failure out of the diff surface", async () => {
    Object.defineProperty(window, "eda", {
      configurable: true,
      value: api(async ({ offset = 0 }) =>
        offset === 0
          ? ok({ commits: [makeCommit(0)], nextOffset: HISTORY_PAGE_SIZE })
          : err(
              errorFixture({
                kind: "unknown",
                operation: "read history",
                message: "paging blew up",
                suggestedAction: "retry",
              }),
            ),
      ),
    });
    await useRepositoryStore.getState().open("repo", "identity", true);
    await useRepositoryStore.getState().selectCommit("oid-0");
    await useRepositoryStore.getState().loadMore();

    const state = useRepositoryStore.getState();

    expect(state.historyError?.message).toBe("paging blew up");
    expect(state.error).toBeNull();
    expect(state.diff).not.toBeNull();
  });

  it("re-reads status from Git after a write instead of patching cached state", async () => {
    let staged = false;

    Object.defineProperty(window, "eda", {
      configurable: true,
      value: {
        repository: {
          status: async () =>
            ok({
              branch: { ahead: 0, behind: 0, detached: false, unborn: false },
              changes: staged
                ? [
                    {
                      kind: "ordinary" as const,
                      path: "a",
                      index: "M" as const,
                      worktree: "." as const,
                      submodule: "N...",
                    },
                  ]
                : [
                    {
                      kind: "ordinary" as const,
                      path: "a",
                      index: "." as const,
                      worktree: "M" as const,
                      submodule: "N...",
                    },
                  ],
            }),
          history: async () => ok({ commits: [makeCommit(0)], nextOffset: null }),
          workingDiff: async () => ok({ files: [] }),
          commitDiff: async () => ok({ files: [] }),
          stage: async () => {
            staged = true;
            return ok(undefined);
          },
        },
      } as unknown as EdaApi,
    });

    await useRepositoryStore.getState().open("repo", "identity", true);
    expect(useRepositoryStore.getState().status?.changes[0]?.index).toBe(".");

    await useRepositoryStore.getState().stage(["a"]);
    expect(useRepositoryStore.getState().status?.changes[0]?.index).toBe("M");
    expect(useRepositoryStore.getState().writing).toBe(false);
  });

  it("surfaces a failed write without refreshing", async () => {
    const failure = errorFixture({
      kind: "identity-mismatch" as const,
      operation: "commit",
      message: "wrong identity",
      suggestedAction: "fix it",
    });

    Object.defineProperty(window, "eda", {
      configurable: true,
      value: {
        repository: {
          status: async () =>
            ok({ branch: { ahead: 0, behind: 0, detached: false, unborn: false }, changes: [] }),
          history: async () => ok({ commits: [], nextOffset: null }),
          workingDiff: async () => ok({ files: [] }),
          commitDiff: async () => ok({ files: [] }),
          commit: async () => err(failure),
        },
      } as unknown as EdaApi,
    });

    await useRepositoryStore.getState().open("repo", "identity", true);

    const committed = await useRepositoryStore.getState().commit("feat: nope");

    expect(committed).toBe(false);
    expect(useRepositoryStore.getState().writeError?.kind).toBe("identity-mismatch");
    expect(useRepositoryStore.getState().writing).toBe(false);
  });

  it("reloads the remaining unstaged hunk after partially staging the selected file", async () => {
    const bridge = api(async () => ok({ commits: [], nextOffset: null }));
    const change = {
      kind: "ordinary",
      path: "a",
      index: ".",
      worktree: "M",
      submodule: "N...",
    } as const;
    const status = await bridge.repository.status("repo");
    if (!status.ok) throw new Error("fixture status");
    bridge.repository.status = async () => ok({ ...status.value, changes: [change] });
    let lines = ["first hunk", "second hunk"];
    bridge.repository.workingDiff = async () =>
      ok({
        files: [
          {
            newPath: "a",
            status: "modified",
            binary: false,
            hunks: lines.map((heading) => ({
              oldStart: 1,
              newStart: 1,
              oldLines: 1,
              newLines: 1,
              heading,
              lines: [],
            })),
          },
        ],
      });
    bridge.repository.applyPartial = async () => {
      lines = ["second hunk"];
      return ok(undefined);
    };
    Object.defineProperty(window, "eda", { configurable: true, value: bridge });
    const store = useRepositoryStore.getState();
    await store.open("repo", "identity", true);
    await store.selectChange(change, "unstaged");
    await store.applyPartial("token");
    expect(useRepositoryStore.getState().diff?.files[0]?.hunks.map((h) => h.heading)).toEqual([
      "second hunk",
    ]);
  });

  it("previews the next file in the same area after staging the selected one", async () => {
    const unstaged = (path: string) => ({
      kind: "ordinary" as const,
      path,
      index: "." as const,
      worktree: "M" as const,
      submodule: "N...",
    });

    let staged = false;

    Object.defineProperty(window, "eda", {
      configurable: true,
      value: {
        repository: {
          status: async () =>
            ok({
              branch: { ahead: 0, behind: 0, detached: false, unborn: false },
              changes: staged
                ? [unstaged("b.ts"), unstaged("c.ts")]
                : [unstaged("a.ts"), unstaged("b.ts"), unstaged("c.ts")],
            }),
          history: async () => ok({ commits: [], nextOffset: null }),
          workingDiff: async () => ok({ files: [] }),
          commitDiff: async () => ok({ files: [] }),
          stage: async () => {
            staged = true;
            return ok(undefined);
          },
        },
      } as unknown as EdaApi,
    });

    await useRepositoryStore.getState().open("repo", "identity", true);
    await useRepositoryStore.getState().selectChange(unstaged("a.ts"), "unstaged");
    await useRepositoryStore.getState().stage(["a.ts"]);

    const selection = useRepositoryStore.getState().selection;

    expect(selection).toMatchObject({ kind: "change", path: "b.ts", area: "unstaged" });
  });

  it.each(["same", "different"])(
    "keeps a newer selection in the %s repository while staging refreshes",
    async (target) => {
      const bridge = api(async () => ok({ commits: [], nextOffset: null }));
      bridge.repository.stage = async () => ok(undefined);
      Object.defineProperty(window, "eda", { configurable: true, value: bridge });
      const store = useRepositoryStore.getState();
      await store.open("repo", "identity", true);
      await store.selectChange(
        { kind: "ordinary", path: "a", index: ".", worktree: "M", submodule: "N..." },
        "unstaged",
      );

      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const status = bridge.repository.status;
      const refresh = vi.spyOn(bridge.repository, "status").mockImplementationOnce(async (id) => {
        await pending;
        return status(id);
      });
      const staging = store.stage(["a"]);
      await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
      if (target === "different") await store.open("other", "identity", true);
      await store.selectCommit("selected");
      finish();
      await staging;

      expect(useRepositoryStore.getState().selection).toEqual({ kind: "commit", oid: "selected" });
    },
  );

  it("clears the preview when the staged file was the last one in its area", async () => {
    const unstaged = (path: string) => ({
      kind: "ordinary" as const,
      path,
      index: "." as const,
      worktree: "M" as const,
      submodule: "N...",
    });

    let staged = false;

    Object.defineProperty(window, "eda", {
      configurable: true,
      value: {
        repository: {
          status: async () =>
            ok({
              branch: { ahead: 0, behind: 0, detached: false, unborn: false },
              changes: staged ? [] : [unstaged("only.ts")],
            }),
          history: async () => ok({ commits: [], nextOffset: null }),
          workingDiff: async () => ok({ files: [] }),
          commitDiff: async () => ok({ files: [] }),
          stage: async () => {
            staged = true;
            return ok(undefined);
          },
        },
      } as unknown as EdaApi,
    });

    await useRepositoryStore.getState().open("repo", "identity", true);
    await useRepositoryStore.getState().selectChange(unstaged("only.ts"), "unstaged");
    await useRepositoryStore.getState().stage(["only.ts"]);

    expect(useRepositoryStore.getState().selection).toBeNull();
  });

  it("categorizes dual-state files into both correct diff areas", () => {
    const change = {
      kind: "ordinary" as const,
      path: "a",
      index: "M" as const,
      worktree: "M" as const,
      submodule: "N...",
    };

    const categorized = categorizeChanges([
      change,
      { ...change, path: "new", kind: "untracked", index: "?", worktree: "?" },
    ]);

    expect(categorized.staged).toEqual([change]);
    expect(categorized.unstaged).toEqual([change]);
    expect(categorized.untracked).toHaveLength(1);
  });
});

describe("direct stash actions", () => {
  const entry = { selector: "stash@{0}", oid: "a".repeat(40), message: "latest", timestamp: 1 };
  const stashes = {
    create: vi.fn(),
    list: vi.fn(),
    inspect: vi.fn(),
    apply: vi.fn(),
  };

  beforeEach(async () => {
    useRepositoryStore.getState().clear();
    vi.resetAllMocks();
    stashes.create.mockResolvedValue(ok(undefined));
    stashes.list.mockResolvedValue(ok({ entries: [entry], truncated: false }));
    stashes.inspect.mockResolvedValue(ok({ token: "latest-review" }));
    stashes.apply.mockResolvedValue(ok({ applied: true, kept: false }));
    const eda = api(async () => ok({ commits: [], nextOffset: null }));
    eda.stashes = stashes as unknown as EdaApi["stashes"];
    Object.defineProperty(window, "eda", { configurable: true, value: eda });
    await useRepositoryStore.getState().open("repo", "identity", true);
    const status = useRepositoryStore.getState().status!;
    useRepositoryStore.setState({
      status: { ...status, branch: { ...status.branch, head: "main" } },
    });
  });

  it("stashes all changes including untracked files with an automatic name, or only the selected paths", async () => {
    await useRepositoryStore.getState().stash();
    expect(stashes.create).toHaveBeenLastCalledWith("repo", "WIP on main", "untracked", undefined);
    await useRepositoryStore.getState().stash(["selected.txt"]);
    expect(stashes.create).toHaveBeenLastCalledWith("repo", expect.any(String), "untracked", {
      paths: ["selected.txt"],
    });
  });

  it("pops the latest stash even when older entries exist", async () => {
    stashes.list.mockResolvedValue(
      ok({
        entries: [entry, { ...entry, selector: "stash@{1}", oid: "b".repeat(40) }],
        truncated: false,
      }),
    );
    await useRepositoryStore.getState().popStash();
    expect(stashes.inspect).toHaveBeenCalledExactlyOnceWith("repo", entry.selector, entry.oid);
    expect(stashes.apply).toHaveBeenCalledExactlyOnceWith("repo", "latest-review", true, false);
    expect(useRepositoryStore.getState().stashNotice).toContain("latest stash removed");
  });

  it("reports conflicts with the source stash retained and refreshes repository state", async () => {
    stashes.apply.mockResolvedValue(ok({ applied: false, kept: true }));
    const status = vi.spyOn(window.eda.repository, "status");
    await useRepositoryStore.getState().popStash();
    expect(useRepositoryStore.getState().stashNotice).toContain("stash was kept");
    expect(status).toHaveBeenCalledWith("repo");
    expect(useRepositoryStore.getState().writing).toBe(false);
  });

  it("handles an empty stash list without applying anything", async () => {
    stashes.list.mockResolvedValue(ok({ entries: [], truncated: false }));
    await useRepositoryStore.getState().popStash();
    expect(stashes.inspect).not.toHaveBeenCalled();
    expect(stashes.apply).not.toHaveBeenCalled();
    expect(useRepositoryStore.getState().stashNotice).toContain("no saved stashes");
  });

  it.each(["list", "inspect"] as const)(
    "stops before applying if the repository changes during %s",
    async (step) => {
      let finish!: (result: unknown) => void;
      stashes[step].mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = useRepositoryStore.getState().popStash();
      await vi.waitFor(() => expect(stashes[step]).toHaveBeenCalled());
      useRepositoryStore.getState().clear();
      finish(
        step === "list"
          ? ok({ entries: [entry], truncated: false })
          : ok({ token: "stale-review" }),
      );
      await pending;
      expect(stashes.apply).not.toHaveBeenCalled();
      expect(useRepositoryStore.getState().stashNotice).toBeNull();
      expect(useRepositoryStore.getState().writing).toBe(false);
    },
  );

  it("blocks duplicate writes immediately and clears busy state after a rejected request", async () => {
    let finish!: (value: Result<void>) => void;
    stashes.create.mockImplementationOnce(
      () =>
        new Promise<Result<void>>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = useRepositoryStore.getState().stash();
    await useRepositoryStore.getState().stash();
    await useRepositoryStore.getState().popStash();
    expect(stashes.create).toHaveBeenCalledOnce();
    expect(stashes.list).not.toHaveBeenCalled();
    finish(ok(undefined));
    await pending;
    stashes.create.mockRejectedValueOnce(new Error("Transport closed"));
    await useRepositoryStore.getState().stash();
    expect(useRepositoryStore.getState().writing).toBe(false);
    expect(useRepositoryStore.getState().writeError).not.toBeNull();
  });
});
