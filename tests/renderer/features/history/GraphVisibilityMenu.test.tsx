import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { emptySession, emptyView } from "@shared/identity/profile-session";
import { defaultGraphFilter, isGraphFilter } from "@shared/preferences/graph-view";
import { GraphFilterDialog } from "@renderer/features/history/GraphFilterDialog";
import { deferred } from "../../../helpers/deferred";
import { ok } from "@shared/errors";
import { GraphVisibilityMenu } from "@renderer/features/history/GraphVisibilityMenu";
import { useSessionStore } from "@renderer/stores/session-store";
import { usePreferencesStore } from "@renderer/stores/preferences-store";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { useShellStore } from "@renderer/stores/shell-store";

let root: Root;
let container: HTMLDivElement;
let previousSession: ReturnType<typeof useSessionStore.getState>;
let previousPreferences: ReturnType<typeof usePreferencesStore.getState>;
const onFilter = vi.fn();
const setView = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previousSession = useSessionStore.getState();
  previousPreferences = usePreferencesStore.getState();
  useShellStore.setState({ request: null });
  setView.mockReset().mockImplementation((id, patch) => {
    const snapshot = useSessionStore.getState().snapshot!;
    useSessionStore.setState({
      snapshot: {
        ...snapshot,
        session: {
          ...snapshot.session,
          views: { ...snapshot.session.views, [id]: { ...emptyView(), ...patch } },
        },
      },
    });
  });
  useSessionStore.setState({
    setView,
    snapshot: {
      context: { profileId: "profile", windowId: "main", generation: 1 },
      session: {
        ...emptySession(),
        views: { repo: { ...emptyView(), graphFilter: defaultGraphFilter() } },
      },
      drafts: {},
      recovery: null,
    },
  });
  usePreferencesStore.setState({
    values: {
      ...previousPreferences.values,
      showInternalRefs: { ...previousPreferences.values.showInternalRefs, value: false },
    },
  });
  vi.spyOn(useRepositoryStore.getState(), "refresh").mockResolvedValue();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(<GraphVisibilityMenu repositoryId="repo" disabled={false} onFilter={onFilter} />),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSessionStore.setState(previousSession);
  usePreferencesStore.setState(previousPreferences);
  useShellStore.setState({ request: null });
  onFilter.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

it("shows internal refs from the toolbar without changing the global default", async () => {
  await click("All branches...");
  await click("All references");
  const filter = useSessionStore.getState().snapshot!.session.views["repo"]!.graphFilter!;
  expect(filter.showInternalRefs).toBe(true);
  expect(isGraphFilter(filter)).toBe(true);
  expect(usePreferencesStore.getState().values.showInternalRefs.value).toBe(false);
  expect(useRepositoryStore.getState().refresh).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("All references...");

  await click("All references...");
  await click("Branches and tags");
  expect(
    useSessionStore.getState().snapshot!.session.views["repo"]!.graphFilter!.showInternalRefs,
  ).toBe(false);
});

it("returns to the global default and clears custom branch filters while keeping the stash choice", async () => {
  await act(async () => {
    usePreferencesStore.setState({
      values: {
        ...usePreferencesStore.getState().values,
        showInternalRefs: { ...previousPreferences.values.showInternalRefs, value: true },
      },
    });
    setView("repo", {
      graphFilter: {
        ...defaultGraphFilter(),
        refs: ["refs/heads/main"],
        showStashes: false,
        showInternalRefs: false,
      },
    });
  });
  await click("Filtered graph...");
  await click("Use global default (All references)");
  const filter = useSessionStore.getState().snapshot!.session.views["repo"]!.graphFilter!;
  expect(filter.showInternalRefs).toBeUndefined();
  expect(filter.refs).toEqual([]);
  expect(filter.showStashes).toBe(false);
  expect(container.textContent).toContain("All references...");
});

it("keeps detailed filters and global settings reachable from the same menu", async () => {
  await click("All branches...");
  await click("Filter and pin references...");
  expect(onFilter).toHaveBeenCalledOnce();
  await click("All branches...");
  await click("Global history settings...");
  expect(useShellStore.getState().request).toEqual({ kind: "settings", section: "global-git" });
});

it("keeps a saved pin while references load or fail and applies its refreshed commit after retry", async () => {
  const { snapshot } = useSessionStore.getState();
  const pinnedRef = "refs/heads/main";
  const pinnedOid = "1".repeat(40);
  const nextOid = "2".repeat(40);
  useSessionStore.setState({
    snapshot: {
      ...snapshot!,
      session: {
        ...snapshot!.session,
        views: {
          repo: {
            ...emptyView(),
            graphFilter: { ...defaultGraphFilter(), pinnedRef, pinnedOid },
          },
        },
      },
    },
  });
  const pending = deferred<void>();
  vi.stubGlobal("eda", {
    repository: {
      listBranches: vi
        .fn()
        .mockReturnValueOnce(
          pending.promise.then(() => {
            throw new Error("Read failed");
          }),
        )
        .mockResolvedValueOnce(ok([{ name: "main", oid: nextOid, remote: false, isHead: true }])),
      listTags: vi.fn().mockResolvedValue(ok([])),
    },
  });
  await act(async () => root.render(<GraphFilterDialog repositoryId="repo" onClose={() => {}} />));
  const apply = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Apply graph view",
  )!;
  expect(apply.disabled).toBe(true);
  await act(async () => pending.resolve());
  expect(apply.disabled).toBe(true);
  expect(setView).not.toHaveBeenCalled();
  await click("Retry");
  await act(async () => apply.click());
  expect(setView).toHaveBeenCalledWith("repo", {
    graphFilter: expect.objectContaining({ pinnedRef, pinnedOid: nextOid }),
  });
});
