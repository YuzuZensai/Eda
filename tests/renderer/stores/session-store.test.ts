import { deferred } from "../../helpers/deferred";
import { errorFixture } from "../../helpers/error";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err, ok, type Result } from "@shared/errors";
import {
  emptySession,
  emptyView,
  isSessionChange,
  type SessionSnapshot,
  type SessionContext,
  type SessionChange,
} from "@shared/identity/profile-session";
import { useSessionStore } from "@renderer/stores/session-store";

const snapshot = (profileId = "work"): SessionSnapshot => ({
  context: { profileId, windowId: "primary", generation: 1 },
  session: emptySession(),
  drafts: {},
  recovery: null,
});

const save = vi.fn<(context: SessionContext, change: SessionChange) => Promise<Result<void>>>(
  async () => ok(undefined),
);

function validateSaves() {
  const persisted: SessionChange[] = [];
  save.mockImplementation(async (_context, change) => {
    if (!isSessionChange(change))
      return err(errorFixture({ kind: "invalid-input", message: "Invalid saved state update" }));
    persisted.push(change);
    return ok(undefined);
  });
  return persisted;
}

beforeEach(() => {
  save.mockReset().mockResolvedValue(ok(undefined));
  Object.defineProperty(window, "eda", {
    configurable: true,
    value: { sessions: { change: save, open: async () => ok(snapshot("home")) } },
  });
  useSessionStore.setState({
    snapshot: snapshot(),
    error: null,
    saving: false,
    transitioning: false,
    draftRevisions: {},
  });
});

afterEach(async () => {
  save.mockResolvedValue(ok(undefined));
  await useSessionStore.getState().flush();
});

describe("session save acknowledgements", () => {
  it("ignores late view updates after a switch starts, preserving the prepared session", () => {
    useSessionStore.setState({ transitioning: true });
    useSessionStore
      .getState()
      .change({ kind: "tabs", tabs: ["old-repo"], selectedRepositoryId: "old-repo" });
    expect(save).not.toHaveBeenCalled();
    expect(useSessionStore.getState().snapshot?.session.tabs).toEqual([]);
  });

  it("shares layout across existing and new repositories without sharing selections or profiles", async () => {
    const initial = snapshot();

    initial.session.selectedRepositoryId = "a";
    initial.session.views = {
      a: { ...emptyView(), selection: { kind: "commit", oid: "first" } },
      b: { ...emptyView(), selection: { kind: "commit", oid: "second" } },
    };
    useSessionStore.setState({ snapshot: initial });

    const store = useSessionStore.getState();

    store.setView("a", {
      collapsed: { graph: false, diff: true, rail: false },
      splits: { rail: 0.6 },
      references: { hidden: true, locals: false, remotes: true, tags: true },
    });
    store.change({ kind: "tabs", tabs: ["a", "b", "c"], selectedRepositoryId: "c" });
    expect(await store.flush()).toBe(true);

    const views = useSessionStore.getState().snapshot!.session.views;

    expect(views["b"]?.selection).toEqual({ kind: "commit", oid: "second" });
    expect(views["a"]?.selection).toEqual({ kind: "commit", oid: "first" });

    for (const id of ["b", "c"]) {
      expect(views[id]?.collapsed.diff).toBe(true);
      expect(views[id]?.splits).toEqual({ rail: 0.6 });
      expect(views[id]?.references?.hidden).toBe(true);
    }

    expect(
      save.mock.calls
        .filter(([, change]) => change.kind === "view" && change.repositoryId === "c")
        .at(-1)?.[1],
    ).toMatchObject({ view: { collapsed: { diff: true } } });
    expect(await store.load()).toBe(true);
    expect(useSessionStore.getState().snapshot?.session.views).toEqual({});
  });

  it("captures the original profile when draft writes wait in a queue", async () => {
    const saving = deferred<void>();

    save.mockImplementationOnce(async () => {
      await saving.promise;
      return ok(undefined);
    });

    const store = useSessionStore.getState();

    store.setDraft("repo", { version: 1, message: "first", amend: false });
    store.setDraft("repo", { version: 1, message: "second", amend: true });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    saving.resolve();
    expect(await store.flush()).toBe(true);
    expect(save.mock.calls.map((call) => call[0].profileId)).toEqual(["work", "work"]);
    expect(useSessionStore.getState().snapshot?.drafts["repo"]).toEqual({
      version: 1,
      message: "second",
      amend: true,
    });
  });

  it("keeps input and the old context after a failed save and acknowledges it on retry", async () => {
    save.mockResolvedValueOnce(
      err(errorFixture({ kind: "unknown", operation: "save", message: "Disk full" })),
    );

    const store = useSessionStore.getState();

    store.setDraft("repo", { version: 1, message: "keep my text", amend: false });
    expect(await store.flush()).toBe(false);
    expect(useSessionStore.getState().snapshot?.drafts["repo"]?.message).toBe("keep my text");
    expect(useSessionStore.getState().error).toBe("Disk full");
    expect(await store.flush()).toBe(true);
    expect(useSessionStore.getState().error).toBeNull();
  });

  it("saves a corrected draft and intervening edits after an oversized draft is rejected", async () => {
    const persisted = validateSaves();
    const store = useSessionStore.getState();
    const draft = { version: 1, amend: false } as const;
    store.setDraft("a", { ...draft, message: "x".repeat(100_001) });
    expect(await store.flush()).toBe(false);
    store.setDraft("b", { ...draft, message: "another repository" });
    expect(await store.flush()).toBe(false);
    store.setDraft("a", { ...draft, message: "corrected" });

    expect(await store.flush()).toBe(true);
    expect(persisted).toEqual([
      { kind: "draft", repositoryId: "b", draft: { ...draft, message: "another repository" } },
      { kind: "draft", repositoryId: "a", draft: { ...draft, message: "corrected" } },
    ]);
    expect(await store.load()).toBe(true);
  });

  it.each([false, true])(
    "persists the shared layout when a rejected view is corrected (intervening resize=%s)",
    async (resize) => {
      const persisted = validateSaves();
      const store = useSessionStore.getState();
      store.setView("a", { maximized: "diff", selection: { kind: "commit", oid: "invalid" } });
      expect(await store.flush()).toBe(false);
      if (resize) store.setView("b", { maximized: "graph" });
      store.setView("a", { selection: null });
      expect(await store.flush()).toBe(true);
      const shared = persisted.filter((change) => change.kind === "view" && change.shareLayout);
      expect(shared).toHaveLength(1);
      expect(shared[0]).toMatchObject({
        repositoryId: resize ? "b" : "a",
        view: { maximized: resize ? "graph" : "diff" },
      });
    },
  );

  it("saves the corrected tab list after the session limit is exceeded", async () => {
    validateSaves();
    const store = useSessionStore.getState();
    const tabs = Array.from({ length: 501 }, (_, index) => String(index));
    store.change({ kind: "tabs", tabs, selectedRepositoryId: "0" });
    expect(await store.flush()).toBe(false);
    store.change({ kind: "tabs", tabs: tabs.slice(1), selectedRepositoryId: "1" });
    expect(await store.flush()).toBe(true);
  });

  it("does not load the next profile when the previous session cannot save", async () => {
    save.mockResolvedValue(
      err(errorFixture({ kind: "unknown", operation: "save", message: "read-only" })),
    );
    useSessionStore
      .getState()
      .setDraft("repo", { version: 1, message: "unacknowledged", amend: false });
    expect(await useSessionStore.getState().load()).toBe(false);
    expect(useSessionStore.getState().snapshot?.context.profileId).toBe("work");
  });

  it("restores a different profile only after all pending draft writes finish", async () => {
    useSessionStore
      .getState()
      .setDraft("repo", { version: 1, message: "saved before switching", amend: false });
    expect(await useSessionStore.getState().load()).toBe(true);
    expect(useSessionStore.getState().snapshot?.context.profileId).toBe("home");
    expect(useSessionStore.getState().snapshot?.drafts).toEqual({});
  });

  it("preserves unsupported state until recovery instead of autosaving over it", async () => {
    useSessionStore.setState({ snapshot: { ...snapshot(), recovery: "Newer version" } });
    useSessionStore
      .getState()
      .setDraft("repo", { version: 1, message: "must not overwrite", amend: false });
    expect(save).not.toHaveBeenCalled();
    expect(useSessionStore.getState().snapshot?.drafts).toEqual({});
  });
});

it("keeps a newer switched session when an earlier session load finishes", async () => {
  let finish!: (result: Result<SessionSnapshot | null>) => void;
  window.eda.sessions.open = vi.fn(
    () =>
      new Promise<Result<SessionSnapshot | null>>((resolve) => {
        finish = resolve;
      }),
  );
  const loading = useSessionStore.getState().load();
  await vi.waitFor(() => expect(window.eda.sessions.open).toHaveBeenCalled());
  useSessionStore.setState({
    snapshot: {
      ...snapshot("new"),
      context: { profileId: "new", windowId: "primary", generation: 2 },
    },
  });
  finish(ok(snapshot("old")));
  expect(await loading).toBe(false);
  expect(useSessionStore.getState().snapshot?.context.profileId).toBe("new");
});

it.each(["reset", "load"])(
  "restores the new profile when %s finishes first during a recovery reset",
  async (first) => {
    const reset = deferred<Result<SessionSnapshot | null>>();
    const open = deferred<Result<SessionSnapshot | null>>();
    window.eda.sessions.reset = () => reset.promise;
    window.eda.sessions.open = vi.fn(() => open.promise);
    useSessionStore.setState({ snapshot: { ...snapshot(), recovery: "Unsupported layout" } });
    const store = useSessionStore.getState();
    const resetting = store.reset();
    const loading = store.load();
    await vi.waitFor(() => expect(window.eda.sessions.open).toHaveBeenCalled());
    if (first === "reset") {
      reset.resolve(ok(snapshot()));
      await resetting;
    }
    open.resolve(ok(snapshot("home")));
    await loading;
    reset.resolve(ok(snapshot()));
    expect(await resetting).toBe(false);
    expect(await loading).toBe(true);
    expect(useSessionStore.getState().snapshot?.context.profileId).toBe("home");
  },
);

it("reports a rejected recovery request and allows retry", async () => {
  window.eda.sessions.reset = vi
    .fn()
    .mockRejectedValueOnce(new Error())
    .mockResolvedValue(ok(snapshot()));
  useSessionStore.setState({ snapshot: { ...snapshot(), recovery: "Unsupported layout" } });
  const store = useSessionStore.getState();
  expect(await store.reset()).toBe(false);
  expect(useSessionStore.getState().error).toBeTruthy();
  expect(await store.reset()).toBe(true);
  expect(useSessionStore.getState().error).toBeNull();
});

it("waits for edits made as a previous save completes before acknowledging a flush", async () => {
  const last = deferred<Result<void>>();
  save.mockResolvedValueOnce(ok(undefined)).mockReturnValueOnce(last.promise);
  const store = useSessionStore.getState();
  const unsubscribe = useSessionStore.subscribe((state, previous) => {
    if (previous.saving && !state.saving) {
      unsubscribe();
      store.setDraft("repo", { version: 1, message: "second", amend: false });
    }
  });
  try {
    store.setDraft("repo", { version: 1, message: "first", amend: false });
    const flushing = store.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    last.resolve(err(errorFixture({ message: "Disk full" })));
    expect(await flushing).toBe(false);
  } finally {
    unsubscribe();
    last.resolve(ok(undefined));
  }
});

it("persists nested draft changes in the same order as the visible edits", async () => {
  const store = useSessionStore.getState();
  const unsubscribe = useSessionStore.subscribe((state) => {
    if (state.snapshot?.drafts["repo"]?.message === "first") {
      unsubscribe();
      store.setDraft("repo", { version: 1, message: "second", amend: true });
    }
  });
  try {
    store.setDraft("repo", { version: 1, message: "first", amend: false });
    expect(await store.flush()).toBe(true);
    expect(save.mock.calls.at(-1)?.[1]).toMatchObject({ draft: { message: "second" } });
  } finally {
    unsubscribe();
  }
});
