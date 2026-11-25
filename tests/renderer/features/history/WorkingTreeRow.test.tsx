import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok } from "@shared/errors";
import { emptyDraft, emptySession } from "@shared/identity/profile-session";
import { CommitBox } from "@renderer/features/changes/CommitBox";
import { useAppStore } from "@renderer/stores/app-store";
import { usePreferencesStore } from "@renderer/stores/preferences-store";
import { useSessionStore } from "@renderer/stores/session-store";
import type { HistoryCommit, RepositoryStatus } from "@shared/repository/repository-read";
import { CommitGraph } from "@renderer/features/history/CommitGraph";
import { laneX, ROW_HEIGHT } from "@renderer/repository/graph-geometry";
import { useLayoutStore } from "@renderer/stores/layout-store";
import { useRepositoryStore } from "@renderer/stores/repository-store";

const commit: HistoryCommit = {
  oid: "a".repeat(40),
  subject: "Current HEAD",
  body: "",
  parents: [],
  decorations: [],
  author: { name: "Author", email: "author@example.test", timestamp: "2026-11-18" },
  committerTimestamp: "2026-11-18",
};
const status: RepositoryStatus = {
  branch: { head: "main", oid: commit.oid, ahead: 0, behind: 0, detached: false, unborn: false },
  changes: [{ kind: "ordinary", path: "file.txt", index: "M", worktree: "M", submodule: "N..." }],
};

let root: Root;
let container: HTMLDivElement;
let previous: ReturnType<typeof useRepositoryStore.getState>;
let previousLayout: ReturnType<typeof useLayoutStore.getState>;
let previousApp: ReturnType<typeof useAppStore.getState>;
let previousSession: ReturnType<typeof useSessionStore.getState>;
let previousPreferences: ReturnType<typeof usePreferencesStore.getState>;
const workingRow = () =>
  container.querySelector<HTMLDivElement>('[data-tour="history-working-tree"]');
const workingButton = () => workingRow()!.querySelector<HTMLButtonElement>("button")!;
const titleInput = () =>
  workingRow()!.querySelector<HTMLInputElement>('[aria-label="Working tree title"]')!;
const commitRows = () =>
  container.querySelectorAll<HTMLButtonElement>('[data-tour="history-commit"]');

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", {
    sessions: { change: vi.fn(async () => ok(undefined)) },
    repository: {
      commitDiff: async () => ok({ files: [] }),
      previewCommit: async () =>
        ok({
          author: {},
          matchesProfile: true,
          signing: "",
          signingEnabled: false,
          additions: 1,
          deletions: 0,
          binaryFiles: 0,
          sharedRefs: [],
        }),
    },
  });
  previous = useRepositoryStore.getState();
  previousLayout = useLayoutStore.getState();
  previousApp = useAppStore.getState();
  previousSession = useSessionStore.getState();
  previousPreferences = usePreferencesStore.getState();
  useAppStore.setState({
    selectedRepositoryId: "repo",
    activeIdentity: {
      id: "profile",
      name: "Work",
      gitName: "Yuzu",
      gitEmail: "yuzu@example.test",
      hue: 210,
      signing: { format: "none", signCommits: false },
      createdAt: "",
      updatedAt: "",
    },
  });
  useSessionStore.setState({
    transitioning: false,
    snapshot: {
      context: { profileId: "profile", windowId: "primary", generation: 1 },
      session: { ...emptySession(), selectedRepositoryId: "repo" },
      drafts: { repo: emptyDraft() },
      recovery: null,
    },
  });
  useRepositoryStore.setState({
    repositoryId: "repo",
    phase: "ready",
    writing: false,
    identityId: "profile",
    status,
    pages: [{ commits: [commit], nextOffset: null }],
    dagBoundary: { lanes: [] },
    baseOffset: 0,
    nextOffset: null,
    selection: { kind: "commit", oid: commit.oid },
    diff: { files: [] },
    historyError: null,
    historyLoading: false,
    historyTip: null,
    truncatedChanges: false,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<CommitGraph />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await useSessionStore.getState().flush();
  useAppStore.setState(previousApp);
  useSessionStore.setState(previousSession);
  usePreferencesStore.setState(previousPreferences);
  useRepositoryStore.setState(previous);
  useLayoutStore.setState(previousLayout);
  vi.unstubAllGlobals();
});

async function key(key: string) {
  await act(async () =>
    container
      .querySelector('[data-testid="commit-graph"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
  );
}

it("shows pending changes above HEAD and counts a file changed in both index and working tree once", () => {
  expect(workingButton().getAttribute("aria-label")).toBe(
    "View working changes: 1 file change in working tree",
  );
  expect(workingRow()!.textContent).toBe("1");
  expect(titleInput().placeholder).toBe("Working tree");
  expect(workingRow()!.nextElementSibling).toBe(commitRows()[0]);
  expect(container.textContent).toContain("1 to 1");
  expect(workingButton().getAttribute("aria-pressed")).toBe("false");
  const node = workingRow()!.querySelector("circle")!;
  expect(node.getAttribute("cx")).toBe(
    commitRows()[0]!.querySelector("circle")!.getAttribute("cx"),
  );
  expect(workingButton().querySelector(":scope > svg > path")!.getAttribute("d")).toBe(
    `M ${laneX(0)} ${ROW_HEIGHT / 2} V ${ROW_HEIGHT}`,
  );
});

it("shows green added counts for untracked and staged new files without double-counting tracked changes", async () => {
  await act(async () =>
    useRepositoryStore.setState({
      status: {
        ...status,
        changes: [
          ...status.changes,
          { kind: "untracked", path: "new.txt", index: "?", worktree: "?", submodule: "N..." },
          { kind: "ordinary", path: "added.txt", index: "A", worktree: "M", submodule: "N..." },
        ],
      },
    }),
  );

  expect(workingButton().getAttribute("aria-label")).toBe(
    "View working changes: 3 file changes in working tree",
  );
  const added = workingRow()!.querySelector('[title="Added"]')!;
  const other = workingRow()!.querySelector(".text-git-modified")!;
  expect(added.classList.contains("text-git-added")).toBe(true);
  expect(added.textContent).toBe("2");
  expect(other.textContent).toBe("1");
  expect(other.getAttribute("title")).toBe("1 file change in working tree");

  await act(async () => useRepositoryStore.setState({ truncatedChanges: true }));
  expect(added.textContent).toBe("2+");
  expect(other.textContent).toBe("1+");
});

it("shows only a green added count when all working files are new", async () => {
  await act(async () =>
    useRepositoryStore.setState({
      status: {
        ...status,
        changes: [
          { kind: "untracked", path: "new.txt", index: "?", worktree: "?", submodule: "N..." },
        ],
      },
    }),
  );

  expect(workingRow()!.querySelector('[title="Added"]')!.textContent).toBe("1");
  expect(workingRow()!.querySelector(".text-git-modified")).toBeNull();
});

it("counts conflicts separately from added, modified and deleted files and exposes them on the WIP row", async () => {
  await act(async () =>
    useRepositoryStore.setState({
      status: {
        ...status,
        changes: [
          ...status.changes,
          { kind: "untracked", path: "new.txt", index: "?", worktree: "?", submodule: "N..." },
          { kind: "ordinary", path: "staged.txt", index: "D", worktree: ".", submodule: "N..." },
          { kind: "ordinary", path: "unstaged.txt", index: "M", worktree: "D", submodule: "N..." },
          {
            kind: "ordinary",
            path: "added-deleted.txt",
            index: "A",
            worktree: "D",
            submodule: "N...",
          },
          { kind: "unmerged", path: "conflict.txt", index: "D", worktree: "D", submodule: "N..." },
        ],
      },
    }),
  );

  expect(workingButton().getAttribute("aria-label")).toBe(
    "View working changes: 6 file changes in working tree",
  );
  expect(workingRow()!.querySelector('[title="Added"]')!.textContent).toBe("1");
  expect(workingRow()!.querySelector(".text-git-modified")!.textContent).toBe("1");
  expect(
    [...workingRow()!.querySelectorAll("button")].map((button) => button.textContent),
  ).toContain("1 conflicted file");
  const deleted = workingRow()!.querySelector('[title="Deleted"]')!;
  expect(deleted.classList.contains("text-git-deleted")).toBe(true);
  expect(deleted.textContent).toBe("3");

  await act(async () => useRepositoryStore.setState({ truncatedChanges: true }));
  expect(deleted.textContent).toBe("3+");
});

it("shows only a red deletion count when all working files are deleted", async () => {
  await act(async () =>
    useRepositoryStore.setState({
      status: {
        ...status,
        changes: [
          { kind: "ordinary", path: "deleted.txt", index: ".", worktree: "D", submodule: "N..." },
        ],
      },
    }),
  );

  expect(workingRow()!.querySelector('[title="Deleted"]')!.textContent).toBe("1");
  expect(workingRow()!.querySelector('[title="Added"]')).toBeNull();
  expect(workingRow()!.querySelector(".text-git-modified")).toBeNull();
});

it("opens working changes and reveals their panel when the graph is maximized", async () => {
  useLayoutStore.setState({
    maximized: "graph",
    collapsed: { graph: false, diff: false, rail: true },
  });
  await act(async () => workingButton().click());
  expect(useRepositoryStore.getState()).toMatchObject({
    selection: null,
    diff: null,
    contentView: "history",
  });
  expect(useLayoutStore.getState().isVisible("rail")).toBe(true);
  expect(useLayoutStore.getState().isVisible("graph")).toBe(true);
  expect(workingButton().getAttribute("aria-pressed")).toBe("true");
});

it("includes working changes in arrow and Home navigation without treating them as a commit", async () => {
  await key("ArrowUp");
  expect(useRepositoryStore.getState().selection).toBeNull();
  await key("ArrowDown");
  expect(useRepositoryStore.getState().selection).toEqual({ kind: "commit", oid: commit.oid });
  await key("Home");
  expect(useRepositoryStore.getState().selection).toBeNull();
  await key("End");
  expect(useRepositoryStore.getState().selection).toEqual({ kind: "commit", oid: commit.oid });
});

it("removes the row when clean and keeps it usable before the first commit", async () => {
  await act(async () => useRepositoryStore.setState({ status: { ...status, changes: [] } }));
  expect(workingRow()).toBeNull();
  expect(commitRows()).toHaveLength(1);
  await act(async () =>
    useRepositoryStore.setState({
      status: { ...status, branch: { ahead: 0, behind: 0, detached: false, unborn: true } },
      pages: [],
    }),
  );
  expect(workingRow()).not.toBeNull();
  expect(workingButton().querySelector(":scope > svg > path")).toBeNull();
  await act(async () => workingButton().click());
  expect(useRepositoryStore.getState().selection).toBeNull();
});

it("does not connect changes to another branch when HEAD is filtered out", async () => {
  await act(async () =>
    useRepositoryStore.setState({
      status: { ...status, branch: { ...status.branch, oid: "b".repeat(40) } },
      truncatedChanges: true,
    }),
  );
  expect(workingButton().querySelector(":scope > svg > path")).toBeNull();
  expect(workingButton().getAttribute("aria-label")).toContain("At least 1 file changes");
  expect(workingRow()!.textContent).toBe("1+");
});

it("connects to HEAD below newer commits without changing their graph lanes", async () => {
  const newer = { ...commit, oid: "b".repeat(40), subject: "Other branch" };
  await act(async () =>
    useRepositoryStore.setState({ pages: [{ commits: [newer, commit], nextOffset: null }] }),
  );
  expect(workingRow()!.querySelector("circle")!.getAttribute("cx")).toBe(String(laneX(1)));
  expect(commitRows()[0]!.querySelector("circle")!.getAttribute("cx")).toBe(String(laneX(0)));
  expect(commitRows()[1]!.querySelector("circle")!.getAttribute("cx")).toBe(String(laneX(0)));
  const connection = commitRows()[1]!.querySelector(":scope > svg > path")!.getAttribute("d")!;
  expect(connection.startsWith(`M ${laneX(1)} 0`)).toBe(true);
  expect(connection.endsWith(`${laneX(0)} ${ROW_HEIGHT / 2}`)).toBe(true);
});

it("keeps pagination offsets in commit units while reserving one virtual working-changes row", async () => {
  const loadPrevious = vi.fn(async () => {});
  await act(async () => useRepositoryStore.setState({ baseOffset: 100, loadPrevious }));
  const list = container.querySelector("[data-virtual-list]")!;
  expect(list.getAttribute("data-item-offset")).toBe("101");
  expect(list.getAttribute("data-retained-count")).toBe("1");
  expect(workingRow()).toBeNull();
  expect(loadPrevious).toHaveBeenCalled();
});

async function typeTitle(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("edits the same saved commit title from the graph and commit section, preserving prefixes, body and options", async () => {
  await act(async () => {
    usePreferencesStore.setState({
      values: {
        ...previousPreferences.values,
        conventionalCommitsEnabled: {
          ...previousPreferences.values.conventionalCommitsEnabled,
          value: true,
        },
      },
    });
    useSessionStore.getState().setDraft("repo", {
      ...emptyDraft(),
      message: "feat(core)!: Original title\n\nKeep this description\n",
      amend: false,
      signOff: true,
    });
    root.render(
      <>
        <CommitGraph />
        <CommitBox />
      </>,
    );
  });

  const commitTitle = () =>
    container.querySelector<HTMLInputElement>('[aria-label="Commit title"]')!;
  const description = () =>
    container.querySelector<HTMLTextAreaElement>('[aria-label="Commit description"]')!;

  expect(titleInput().value).toBe("feat(core)!: Original title");
  expect(commitTitle().value).toBe("Original title");
  await act(async () => titleInput().focus());
  expect(useRepositoryStore.getState().selection).toBeNull();
  await typeTitle(titleInput(), "fix(core): Title from graph");
  expect(commitTitle().value).toBe("Title from graph");
  expect(description().value).toBe("Keep this description\n");
  expect(useSessionStore.getState().snapshot?.drafts["repo"]).toEqual({
    ...emptyDraft(),
    message: "fix(core): Title from graph\n\nKeep this description\n",
    amend: false,
    signOff: true,
  });

  await typeTitle(commitTitle(), "Title from commit section");
  expect(titleInput().value).toBe("fix(core): Title from commit section");
  await act(async () =>
    titleInput().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(useRepositoryStore.getState().selection).toBeNull();
  expect(document.activeElement).toBe(titleInput());

  const saveCommit = vi.fn(async () => true);
  await act(async () => useRepositoryStore.setState({ commit: saveCommit }));
  const submit = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === "Commit",
  )!;
  await act(async () => submit.click());
  expect(saveCommit).toHaveBeenCalledWith(
    "fix(core): Title from commit section\n\nKeep this description\n",
    { amend: false, signOff: true },
  );
  expect(titleInput().value).toBe("");
  expect(commitTitle().value).toBe("");
});

it("pastes a multiline message from the graph without losing the saved description", async () => {
  await act(async () =>
    useSessionStore.getState().setDraft("repo", {
      ...emptyDraft(),
      message: "Old title\n\nSaved description",
      amend: true,
      signOff: true,
    }),
  );
  const input = titleInput();
  input.setSelectionRange(0, input.value.length);
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", "New title\r\n\r\nPasted description");
  await act(async () =>
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(titleInput().value).toBe("New title");
  expect(useSessionStore.getState().snapshot?.drafts["repo"]).toEqual({
    ...emptyDraft(),
    message: "New title\n\nPasted description\n\nSaved description",
    amend: true,
    signOff: true,
  });
});

it("keeps drafts isolated between repositories and profiles and disables edits during transitions", async () => {
  await act(async () =>
    useSessionStore.getState().setDraft("repo", {
      ...emptyDraft(),
      message: "Repository draft",
    }),
  );
  await act(async () => useSessionStore.setState({ transitioning: true }));
  expect(titleInput().disabled).toBe(true);
  await act(async () => useSessionStore.setState({ transitioning: false }));
  expect(titleInput().disabled).toBe(false);
  const snapshot = useSessionStore.getState().snapshot!;
  await act(async () =>
    useSessionStore.setState({ snapshot: { ...snapshot, recovery: "Recover session" } }),
  );
  expect(titleInput().disabled).toBe(true);
  await act(async () => useSessionStore.setState({ snapshot }));
  await act(async () => useAppStore.setState({ selectedRepositoryId: "other" }));
  expect(titleInput().disabled).toBe(true);
  await act(async () => useRepositoryStore.setState({ repositoryId: "other" }));
  expect(titleInput().disabled).toBe(true);
  await act(async () =>
    useSessionStore
      .getState()
      .change({ kind: "tabs", tabs: ["repo", "other"], selectedRepositoryId: "other" }),
  );
  expect(titleInput().value).toBe("");
  await typeTitle(titleInput(), "Other repository draft");
  expect(useSessionStore.getState().snapshot?.drafts["other"]?.message).toBe(
    "Other repository draft",
  );
  expect(useSessionStore.getState().snapshot?.drafts["repo"]?.message).toBe("Repository draft");
  await act(async () =>
    useSessionStore.setState({
      snapshot: {
        context: { profileId: "other-profile", windowId: "primary", generation: 2 },
        session: { ...emptySession(), selectedRepositoryId: "other" },
        drafts: { other: { ...emptyDraft(), message: "Other profile draft" } },
        recovery: null,
      },
    }),
  );
  expect(titleInput().disabled).toBe(true);
  expect(titleInput().value).toBe("");
  await act(async () => {
    const profile = useAppStore.getState().activeIdentity!;
    useAppStore.setState({ activeIdentity: { ...profile, id: "other-profile" } });
    useRepositoryStore.setState({ identityId: "other-profile" });
  });
  expect(titleInput().value).toBe("Other profile draft");
  await act(async () => useSessionStore.setState({ snapshot: null }));
  expect(titleInput().disabled).toBe(true);
});
