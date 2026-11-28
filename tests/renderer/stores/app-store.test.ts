import type { EdaApi } from "@shared/ipc";
import type { Identity } from "@shared/identity/identity";
import type { RepositorySummary } from "@shared/repository/repository";
import { err, ok, type Result } from "@shared/errors";
import { useAppStore } from "@renderer/stores/app-store";
import { errorFixture } from "../../helpers/error";
import { deferred } from "../../helpers/deferred";

const identity = (id: string): Identity => ({
  id,
  name: id,
  gitName: "Eda",
  gitEmail: `${id}@example.com`,
  hue: 210,
  signing: { format: "none", signCommits: false },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const repo = (id: string): RepositorySummary =>
  ({
    id,
    name: id,
    path: `/repos/${id}`,
    available: true,
  }) as RepositorySummary;

function install(active: Identity, repositories: RepositorySummary[]) {
  Object.defineProperty(window, "eda", {
    configurable: true,
    value: {
      repository: { list: async () => ok(repositories) },
      identity: { list: async () => ok([active]), getActive: async () => ok(active) },
    } as unknown as EdaApi,
  });
}

const reset = () =>
  useAppStore.setState({
    activeIdentity: null,
    repositories: [],
    selectedRepositoryId: null,
    openTabsByIdentity: {},
    closedTabsByIdentity: {},
    switchingIdentityId: null,
  });

describe("repository tabs", () => {
  beforeEach(reset);

  it("reorders without changing selection, reopens at its old position, and isolates closed tabs", () => {
    useAppStore.setState({
      activeIdentity: identity("work"),
      repositories: [repo("a"), repo("b"), repo("c")],
    });

    for (const id of ["a", "b", "c"]) useAppStore.getState().selectRepository(id);

    useAppStore.getState().moveTab("c", 0);
    expect(useAppStore.getState().openTabsByIdentity["work"]).toEqual(["c", "a", "b"]);
    expect(useAppStore.getState().selectedRepositoryId).toBe("c");

    useAppStore.getState().closeTab("a");
    useAppStore.setState({ activeIdentity: identity("home"), repositories: [repo("z")] });
    useAppStore.getState().reopenTab();
    expect(useAppStore.getState().openTabsByIdentity["home"]).toBeUndefined();

    useAppStore.setState({
      activeIdentity: identity("work"),
      repositories: [repo("a"), repo("b"), repo("c")],
    });
    useAppStore.getState().reopenTab();
    expect(useAppStore.getState().openTabsByIdentity["work"]).toEqual(["c", "a", "b"]);
    expect(useAppStore.getState().selectedRepositoryId).toBe("a");
  });

  it("cannot reopen removed memberships or change tabs during profile transition", () => {
    useAppStore.setState({
      activeIdentity: identity("work"),
      repositories: [repo("a"), repo("b")],
    });

    for (const id of ["a", "b"]) useAppStore.getState().selectRepository(id);

    useAppStore.getState().closeTab("a");
    useAppStore.setState({ repositories: [repo("b")] });
    useAppStore.getState().reopenTab();
    useAppStore.getState().selectRepository("foreign");
    expect(useAppStore.getState().openTabsByIdentity["work"]).toEqual(["b"]);

    useAppStore.setState({ switchingIdentityId: "home" });
    useAppStore.getState().closeTab("b");
    useAppStore.getState().moveTab("b", 0);
    useAppStore.getState().selectRepository(null);
    expect(useAppStore.getState().selectedRepositoryId).toBe("b");
    expect(useAppStore.getState().openTabsByIdentity["work"]).toEqual(["b"]);
  });

  it("waits for a newer membership refresh before opening a just-cloned repository", async () => {
    const owner = identity("work");
    useAppStore.setState({ activeIdentity: owner });
    install(owner, []);
    const first = deferred<Result<RepositorySummary[]>>(),
      latest = deferred<Result<RepositorySummary[]>>();
    vi.spyOn(window.eda.repository, "list")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const cloneNavigation = useAppStore
      .getState()
      .refreshRepositories()
      .then(() => useAppStore.getState().selectRepository("cloned"));
    const notification = useAppStore.getState().refreshRepositories();
    first.resolve(ok([]));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    latest.resolve(ok([repo("existing"), repo("cloned")]));
    await Promise.all([cloneNavigation, notification]);
    expect(useAppStore.getState().selectedRepositoryId).toBe("cloned");
  });

  it("opens a tab when a repository is selected and does not duplicate it", () => {
    useAppStore.setState({
      activeIdentity: identity("work"),
      repositories: [repo("a"), repo("b")],
    });
    useAppStore.getState().selectRepository("a");
    useAppStore.getState().selectRepository("b");
    useAppStore.getState().selectRepository("a");

    expect(useAppStore.getState().openTabsByIdentity["work"]).toEqual(["a", "b"]);
    expect(useAppStore.getState().selectedRepositoryId).toBe("a");
  });

  it("opens available collection members in background tabs and keeps Home selected", () => {
    useAppStore.setState({
      activeIdentity: identity("work"),
      repositories: [repo("a"), repo("b"), { ...repo("c"), available: false }],
    });
    for (const id of ["a", "c", "b", "foreign", "a"])
      useAppStore.getState().selectRepository(id, true);
    expect(useAppStore.getState().openTabsByIdentity["work"]).toEqual(["a", "b"]);
    expect(useAppStore.getState().selectedRepositoryId).toBeNull();
  });

  it("keeps each identity tab set separate", () => {
    useAppStore.setState({ activeIdentity: identity("work"), repositories: [repo("a")] });
    useAppStore.getState().selectRepository("a");
    useAppStore.setState({ activeIdentity: identity("oss"), repositories: [repo("z")] });
    useAppStore.getState().selectRepository("z");

    expect(useAppStore.getState().openTabsByIdentity).toEqual({ work: ["a"], oss: ["z"] });
  });

  it("selects the neighbouring tab when the active one closes", () => {
    useAppStore.setState({
      activeIdentity: identity("work"),
      repositories: [repo("a"), repo("b"), repo("c")],
    });

    for (const id of ["a", "b", "c"]) useAppStore.getState().selectRepository(id);

    useAppStore.getState().selectRepository("b");
    useAppStore.getState().closeTab("b");

    expect(useAppStore.getState().openTabsByIdentity["work"]).toEqual(["a", "c"]);
    expect(useAppStore.getState().selectedRepositoryId).toBe("c");
  });

  it("keeps the selection when a background tab closes", () => {
    useAppStore.setState({
      activeIdentity: identity("work"),
      repositories: [repo("a"), repo("b")],
    });

    for (const id of ["a", "b"]) useAppStore.getState().selectRepository(id);

    useAppStore.getState().closeTab("a");

    expect(useAppStore.getState().selectedRepositoryId).toBe("b");
  });

  it("clears the selection when the last tab closes", () => {
    useAppStore.setState({ activeIdentity: identity("work"), repositories: [repo("a")] });
    useAppStore.getState().selectRepository("a");
    useAppStore.getState().closeTab("a");

    expect(useAppStore.getState().openTabsByIdentity["work"]).toEqual([]);
    expect(useAppStore.getState().selectedRepositoryId).toBeNull();
  });

  it("drops tabs for repositories the identity no longer owns", async () => {
    const work = identity("work");
    useAppStore.setState({ activeIdentity: work, openTabsByIdentity: { work: ["a", "gone"] } });
    install(work, [repo("a")]);
    await useAppStore.getState().refreshRepositories();

    expect(useAppStore.getState().openTabsByIdentity["work"]).toEqual(["a"]);
  });

  it("opens a tab for a selection restored by a refresh", async () => {
    const work = identity("work");

    useAppStore.setState({ activeIdentity: work, openTabsByIdentity: {} });
    install(work, [repo("a")]);
    await useAppStore.getState().refreshRepositories();

    expect(useAppStore.getState().selectedRepositoryId).toBe("a");
    expect(useAppStore.getState().openTabsByIdentity["work"]).toEqual(["a"]);
  });
});

it("ignores an older identity refresh after a newer profile response", async () => {
  const { useSessionStore } = await import("@renderer/stores/session-store");
  const { usePreferencesStore } = await import("@renderer/stores/preferences-store");
  const { emptySession } = await import("@shared/identity/profile-session");
  const app = useAppStore.getState();
  const session = useSessionStore.getState();
  const preferences = usePreferencesStore.getState();
  let finish!: (result: ReturnType<typeof ok<Identity>>) => void;
  const active = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(ok(identity("new")));
  const load = vi.fn(async () => {});
  Object.defineProperty(window, "eda", {
    configurable: true,
    value: {
      identity: { list: async () => ok([identity("new")]), getActive: active },
    },
  });

  try {
    useSessionStore.setState({
      snapshot: {
        context: { profileId: "new", windowId: "window", generation: 2 },
        session: emptySession(),
        drafts: {},
        recovery: null,
      },
    });
    usePreferencesStore.setState({ load });
    const oldRequest = useAppStore.getState().refreshIdentities();
    await useAppStore.getState().refreshIdentities();
    finish(ok(identity("old")));
    await oldRequest;
    expect(useAppStore.getState().activeIdentity?.id).toBe("new");
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({ profileId: "new" });
  } finally {
    useAppStore.setState(app);
    useSessionStore.setState(session);
    usePreferencesStore.setState(preferences);
  }
});

it.each(["success", "failure"])(
  "ignores an older repository refresh %s after a newer list arrives",
  async (outcome) => {
    const { useSessionStore } = await import("@renderer/stores/session-store");
    const app = useAppStore.getState();
    const session = useSessionStore.getState();
    const pending = deferred<Result<RepositorySummary[]>>();

    install(identity("work"), [repo("a"), repo("b")]);
    const list = vi.spyOn(window.eda.repository, "list").mockReturnValueOnce(pending.promise);

    try {
      reset();
      useSessionStore.setState({ snapshot: null });
      useAppStore.setState({ activeIdentity: identity("work"), error: null });
      const previous = useAppStore.getState().refreshRepositories();
      await useAppStore.getState().refreshRepositories();
      useAppStore.getState().selectRepository("b");

      pending.resolve(
        outcome === "success"
          ? ok([repo("a")])
          : err(errorFixture({ message: "Obsolete list failure" })),
      );
      await previous;

      expect(useAppStore.getState().repositories.map((repository) => repository.id)).toEqual([
        "a",
        "b",
      ]);
      expect(useAppStore.getState().selectedRepositoryId).toBe("b");
      expect(useAppStore.getState().openTabsByIdentity["work"]).toEqual(["a", "b"]);
      expect(useAppStore.getState().error).toBeNull();
    } finally {
      list.mockRestore();
      useAppStore.setState(app);
      useSessionStore.setState(session);
    }
  },
);

it("keeps a profile switch from starting while deletion flushes the session", async () => {
  const { useSessionStore } = await import("@renderer/stores/session-store");
  const flush = deferred<boolean>();
  const saving = vi.spyOn(useSessionStore.getState(), "flush").mockReturnValue(flush.promise);
  const app = useAppStore.getState();
  try {
    reset();
    const deleting = app.deleteIdentity("work", "token");
    const switching = app.setActiveIdentity("home");
    expect(useAppStore.getState().switchingIdentityId).toBe("work");
    expect(useSessionStore.getState().transitioning).toBe(true);
    flush.resolve(false);
    expect(await deleting).toBe(false);
    await switching;
    expect(useSessionStore.getState().transitioning).toBe(false);
    expect(useAppStore.getState().switchingIdentityId).toBeNull();
  } finally {
    flush.resolve(false);
    saving.mockRestore();
    useAppStore.setState(app);
  }
});

it("discards a folder chosen for a profile that is no longer active", async () => {
  const folder = deferred<Result<string | null>>();
  const open = vi.fn(async () => ok(repo("a")));
  const app = useAppStore.getState();
  install(identity("work"), []);
  window.eda.repository.chooseFolder = () => folder.promise;
  window.eda.repository.open = open;
  try {
    useAppStore.setState({ activeIdentity: identity("work") });
    const adding = app.addRepository();
    useAppStore.setState({ activeIdentity: identity("home") });
    folder.resolve(ok("/work/repo"));
    await adding;
    expect(open).not.toHaveBeenCalled();
  } finally {
    useAppStore.setState(app);
  }
});

it("reports a failed startup profile read before treating the list as empty", async () => {
  install(identity("work"), []);
  vi.spyOn(window.eda.identity, "list").mockResolvedValue(
    err(errorFixture({ message: "Profiles unavailable" })),
  );
  await expect(useAppStore.getState().refreshIdentities(true)).rejects.toThrow(
    "Profiles unavailable",
  );
});
