import { errorFixture } from "../../../helpers/error";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok, err } from "@shared/errors";
import type { BranchSummary } from "@shared/repository/repository-write";
import { emptySession } from "@shared/identity/profile-session";
import { ReferenceMenu } from "@renderer/features/references/ReferenceMenu";
import { useTagReferences } from "@renderer/features/references/hooks/useTagReferences";
import { ReferenceRow } from "@renderer/features/references/ReferenceRow";
import { ReferenceSidebar } from "@renderer/features/references/ReferenceSidebar";
import { useAppStore } from "@renderer/stores/app-store";
import { useRepositoryStore } from "@renderer/stores/repository-store";
import { useSessionStore } from "@renderer/stores/session-store";

let root: Root;
let container: HTMLDivElement;

const local: BranchSummary = {
  name: "feature/topic",
  oid: "a".repeat(40),
  isHead: false,
  remote: false,
  upstream: "upstream/review/topic",
};

const remote: BranchSummary = {
  name: "upstream/review/topic",
  oid: local.oid,
  isHead: false,
  remote: true,
};

const remotes = [
  {
    name: "upstream",
    fetchUrls: ["https://example.com/repo"],
    pushUrls: ["https://example.com/repo"],
  },
];

const copyText = vi.fn();
const referenceUrl = vi.fn();
const inspect = vi.fn();
const deleteBranch = vi.fn();
const checkoutBranch = vi.fn();
const deleteTag = vi.fn();
const listTags = vi.fn();
const remoteTags = vi.fn();
const preparePush = vi.fn();
const push = vi.fn();
const renameBranch = vi.fn();
const close = vi.fn();
const refresh = vi.fn();

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  )!;

const click = (label: string) => act(async () => button(label).click());

const selectScope = (scope: string) =>
  act(async () => document.querySelector<HTMLInputElement>(`input[value="${scope}"]`)!.click());

const render = (ref = local) =>
  act(async () =>
    root.render(
      <ReferenceMenu
        repositoryId="repo"
        target={{ kind: "branch", ref, x: 100, y: 100 }}
        onClose={close}
      />,
    ),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  useAppStore.setState({
    activeIdentity: { id: "profile" } as never,
    selectedRepositoryId: "repo",
    switchingIdentityId: null,
  });

  refresh.mockReset().mockResolvedValue(undefined);

  useRepositoryStore.setState({
    repositoryId: "repo",
    identityId: "profile",
    phase: "ready",
    writing: false,
    status: null,
    refresh,
    selection: null,
  });

  useSessionStore.setState({
    transitioning: false,
    snapshot: {
      context: { profileId: "profile", windowId: "window", generation: 1 },
      session: emptySession(),
      drafts: {},
      recovery: null,
    },
  });

  inspect.mockReset().mockResolvedValue(ok({ branches: [local, remote], remotes }));
  deleteTag.mockReset().mockResolvedValue(ok(undefined));
  listTags.mockReset().mockResolvedValue(ok([{ name: "v1", oid: local.oid }]));
  remoteTags.mockReset().mockResolvedValue(ok([{ name: "v1", oid: local.oid }]));
  deleteBranch.mockReset().mockResolvedValue(ok(undefined));
  checkoutBranch.mockReset().mockResolvedValue(ok(undefined));
  preparePush.mockReset().mockResolvedValue(ok({ token: "delete-preview" }));
  push.mockReset().mockResolvedValue(ok("Deleted"));
  renameBranch.mockReset().mockResolvedValue(ok(undefined));
  close.mockReset();
  copyText.mockReset().mockResolvedValue(ok(undefined));

  referenceUrl
    .mockReset()
    .mockResolvedValue(ok("https://github.com/example/repo/tree/feature/topic"));

  vi.stubGlobal("eda", {
    app: { copyText },
    operations: { list: vi.fn().mockResolvedValue(ok([])) },
    events: { onOperationsChanged: vi.fn().mockReturnValue(() => {}) },
    repository: {
      referenceUrl,
      deleteBranch,
      checkoutBranch,
      deleteTag,
      renameBranch,
      listBranches: vi.fn().mockResolvedValue(ok([local, remote])),
      listTags,
    },
    remotes: { inspect, preparePush, push, listTags: remoteTags },
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("opens the shared history menu surface on right-click and keyboard context-menu requests", async () => {
  await act(async () => root.render(<ReferenceSidebar repositoryId="repo" />));

  const row = container.querySelector<HTMLButtonElement>(
    '[aria-label="Inspect branch feature/topic"]',
  )!;

  await act(async () =>
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 70 })),
  );

  await act(() => vi.dynamicImportSettled());

  expect(
    document
      .querySelector('[role="menu"][aria-label="Branch actions"]')
      ?.classList.contains("ui-popover-in"),
  ).toBe(true);

  expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(4);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");

  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    ),
  );

  expect(document.querySelector('[role="menu"]')).toBeNull();

  await act(async () =>
    row.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "F10", shiftKey: true })),
  );

  expect(document.querySelector('[role="menu"][aria-label="Branch actions"]')).not.toBeNull();
});

it("checks out a local branch on double-click while a single click still inspects it", async () => {
  const jumpToCommit = vi.fn().mockResolvedValue(undefined);
  useRepositoryStore.setState({ jumpToCommit });
  await act(async () => root.render(<ReferenceSidebar repositoryId="repo" />));

  const row = container.querySelector<HTMLButtonElement>(
    '[aria-label="Inspect branch feature/topic"]',
  )!;

  await act(async () => row.click());
  expect(jumpToCommit).toHaveBeenCalledWith(local.oid);
  expect(checkoutBranch).not.toHaveBeenCalled();

  await act(async () =>
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 })),
  );

  expect(checkoutBranch).toHaveBeenCalledOnce();
  expect(checkoutBranch).toHaveBeenCalledWith({ repositoryId: "repo", name: local.name });
  expect(refresh).toHaveBeenCalledOnce();
  expect(vi.mocked(window.eda.repository.listBranches).mock.calls.length).toBeGreaterThan(1);
});

it.each([
  { name: "current branch", branch: { ...local, isHead: true } },
  { name: "branch in another worktree", branch: { ...local, worktreePath: "/elsewhere" } },
  { name: "remote branch", branch: remote },
])("does not check out a $name on double-click", async ({ branch }) => {
  vi.mocked(window.eda.repository.listBranches).mockResolvedValue(ok([branch]));
  await act(async () => root.render(<ReferenceSidebar repositoryId="repo" />));

  const row = container.querySelector<HTMLButtonElement>(
    `[aria-label="Inspect branch ${branch.name}"]`,
  )!;

  await act(async () =>
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 })),
  );

  expect(checkoutBranch).not.toHaveBeenCalled();
});

it("shows a checkout failure and does not refresh the repository", async () => {
  checkoutBranch.mockResolvedValueOnce(
    err(errorFixture({ kind: "invalid-input", message: "Branch cannot be checked out" })),
  );

  await act(async () => root.render(<ReferenceSidebar repositoryId="repo" />));
  const row = container.querySelector<HTMLButtonElement>(
    '[aria-label="Inspect branch feature/topic"]',
  )!;

  await act(async () =>
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 })),
  );

  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "Branch cannot be checked out",
  );
  expect(refresh).not.toHaveBeenCalled();
});

it("does not start another checkout while the first double-click checkout is pending", async () => {
  let finish!: (result: ReturnType<typeof ok<void>>) => void;
  checkoutBranch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );

  await act(async () => root.render(<ReferenceSidebar repositoryId="repo" />));
  const row = container.querySelector<HTMLButtonElement>(
    '[aria-label="Inspect branch feature/topic"]',
  )!;

  await act(async () => {
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 }));
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, button: 0 }));
  });

  expect(checkoutBranch).toHaveBeenCalledOnce();
  await act(async () => finish(ok(undefined)));
  expect(refresh).toHaveBeenCalledOnce();
});

it.each([
  {
    change: "leaves the current worktree",
    before: { ...local, isHead: true, worktreePath: "/current/worktree" },
    after: local,
    disabled: false,
  },
  {
    change: "becomes the current branch",
    before: local,
    after: { ...local, isHead: true, worktreePath: "/current/worktree" },
    disabled: true,
  },
  {
    change: "is checked out in another worktree",
    before: local,
    after: { ...local, worktreePath: "/another/worktree" },
    disabled: true,
  },
])(
  "updates an open checkout action when its branch $change",
  async ({ before, after, disabled }) => {
    vi.mocked(window.eda.repository.listBranches).mockResolvedValue(ok([before, remote]));
    await act(async () => root.render(<ReferenceSidebar repositoryId="repo" />));

    let finish!: (result: ReturnType<typeof ok<BranchSummary[]>>) => void;

    vi.mocked(window.eda.repository.listBranches).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    await act(async () => useRepositoryStore.setState({ status: {} as never }));

    const row = container.querySelector<HTMLButtonElement>(
      '[aria-label="Inspect branch feature/topic"]',
    )!;

    await act(async () =>
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 70 })),
    );

    await act(() => vi.dynamicImportSettled());
    expect(button("Check out branch").disabled).toBe(!disabled);

    await act(async () => finish(ok([after, remote])));
    expect(button("Check out branch").disabled).toBe(disabled);
  },
);

it.each(["local", "remote", "both"])(
  "deletes the selected %s scope using the tracked destination",
  async (scope) => {
    await render();
    await click("Delete branch...");
    await selectScope(scope);

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "upstream/review/topic",
    );

    await click(
      scope === "both"
        ? "Delete local and remote"
        : scope === "local"
          ? "Delete locally"
          : "Delete remotely",
    );

    if (scope !== "remote")
      expect(deleteBranch).toHaveBeenCalledWith({ repositoryId: "repo", name: "feature/topic" });
    else expect(deleteBranch).not.toHaveBeenCalled();

    if (scope !== "local") {
      expect(preparePush).toHaveBeenCalledWith({
        repositoryId: "repo",
        remote: "upstream",
        branch: "review/topic",
        destination: "review/topic",
        mode: "delete",
        setUpstream: false,
      });

      expect(push).toHaveBeenCalledWith("repo", "delete-preview", undefined);
    } else expect(push).not.toHaveBeenCalled();

    expect(close).toHaveBeenCalledOnce();
  },
);

it("allows remote deletion for a remote branch and resolves its differently named local branch", async () => {
  await render(remote);
  await click("Delete branch...");
  expect(document.querySelector<HTMLInputElement>('input[value="remote"]')?.checked).toBe(true);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Local: feature/topic");
  await click("Delete remotely");
  expect(push).toHaveBeenCalledOnce();
  expect(deleteBranch).not.toHaveBeenCalled();
});

it.each([
  { ...local, isHead: true },
  { ...local, worktreePath: "/another/worktree" },
])("explains why checked-out branches cannot be deleted locally", async (branch) => {
  inspect.mockResolvedValue(ok({ branches: [branch, remote], remotes }));
  await render(branch);
  await click("Delete branch...");
  expect(document.querySelector('input[value="local"]')).toBeNull();
  expect(document.querySelector('input[value="both"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/another branch/);
  await click("Delete remotely");
  expect(deleteBranch).not.toHaveBeenCalled();
});

it("retains the local branch if remote deletion fails", async () => {
  push.mockResolvedValue(
    err(errorFixture({ kind: "network-failed", operation: "push", message: "Remote unavailable" })),
  );

  await render();
  await click("Delete branch...");
  await selectScope("both");
  await click("Delete local and remote");
  expect(deleteBranch).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Remote unavailable");
});

it("reports partial completion and retries only the remaining local deletion, with force opt-in", async () => {
  deleteBranch.mockResolvedValueOnce(
    err(
      errorFixture({
        kind: "invalid-input",
        operation: "delete",
        message: "Branch is not fully merged",
      }),
    ),
  );

  await render();
  await click("Delete branch...");
  await selectScope("both");
  await click("Delete local and remote");
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Remote branch deleted");
  expect(close).not.toHaveBeenCalled();

  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );

  await click("Delete locally");
  expect(push).toHaveBeenCalledOnce();

  expect(deleteBranch).toHaveBeenLastCalledWith({
    repositoryId: "repo",
    name: local.name,
    force: true,
  });

  expect(close).toHaveBeenCalledOnce();
});

it("stops before push when the profile changes during remote preview", async () => {
  preparePush.mockImplementation(async () => {
    useAppStore.setState({ selectedRepositoryId: "other" });
    return ok({ token: "delete-preview" });
  });

  await render();
  await click("Delete branch...");
  await selectScope("both");
  await click("Delete local and remote");
  expect(push).not.toHaveBeenCalled();
  expect(deleteBranch).not.toHaveBeenCalled();
});

it("does not offer remote deletion for an untracked local branch", async () => {
  const branch = { ...local };
  delete branch.upstream;
  inspect.mockResolvedValue(ok({ branches: [branch, remote], remotes }));
  await render(branch);
  await click("Delete branch...");
  expect(document.querySelector('input[value="remote"]')).toBeNull();
  expect(document.querySelector('input[value="both"]')).toBeNull();
});

it("cancels branch deletion with Escape without changing any references", async () => {
  await render();
  await click("Delete branch...");

  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );

  expect(close).toHaveBeenCalledOnce();
  expect(push).not.toHaveBeenCalled();
  expect(deleteBranch).not.toHaveBeenCalled();
});

it("retains tag checkout, verification, and local deletion in the context menu", async () => {
  await act(async () =>
    root.render(
      <ReferenceMenu
        repositoryId="repo"
        target={{ kind: "tag", ref: { name: "v1", oid: local.oid }, x: 100, y: 100 }}
        onClose={close}
      />,
    ),
  );

  expect(button("Check out tag (detached HEAD)")).toBeDefined();
  expect(button("Verify tag signature...")).toBeDefined();
  expect(button("Verify tag signature...")?.querySelector("svg")).not.toBeNull();
  await click("Delete tag...");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Delete tag from");
  expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  await click("Delete locally");
  expect(deleteTag).toHaveBeenCalledWith({ repositoryId: "repo", name: "v1" });
  expect(push).not.toHaveBeenCalled();
});

it("retries HTTPS remote deletion with supplied credentials without deleting locally", async () => {
  preparePush.mockResolvedValueOnce(
    err(
      errorFixture({ kind: "auth-failed", operation: "delete", message: "Authentication failed" }),
    ),
  );

  await render(remote);
  await click("Delete branch...");
  await click("Delete remotely");
  expect(push).not.toHaveBeenCalled();

  await act(async () => {
    const fields = [...document.querySelectorAll<HTMLInputElement>('input:not([type="radio"])')];

    for (const [index, field] of fields.entries()) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        field,
        index === 0 ? "user" : "token",
      );

      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  await click("Delete remotely");
  const credentials = { username: "user", password: "token" };
  expect(preparePush).toHaveBeenLastCalledWith(expect.objectContaining({ credentials }));
  expect(push).toHaveBeenCalledWith("repo", "delete-preview", credentials);
  expect(deleteBranch).not.toHaveBeenCalled();
});

it.each([
  ["Copy name", local.name],
  ["Copy SHA", local.oid],
  ["Copy browser URL", "https://github.com/example/repo/tree/feature/topic"],
])("copies %s through the native clipboard and closes the menu", async (label, value) => {
  await render();
  await click(label);
  expect(copyText).toHaveBeenCalledExactlyOnceWith(value);
  expect(close).toHaveBeenCalledOnce();
  expect(refresh).not.toHaveBeenCalled();
});

it("shows a dismissible dialog instead of raw clipboard diagnostics in the menu", async () => {
  copyText.mockRejectedValueOnce(new Error("Write permission denied"));
  await render();
  await click("Copy name");
  expect(close).not.toHaveBeenCalled();

  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
    "Clipboard copy failed",
  );

  expect(document.body.textContent).not.toContain("Write permission denied");
  await click("Dismiss");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click("Copy name");
  expect(close).toHaveBeenCalledOnce();
});

const renderTag = (options: { remoteName?: string; local?: boolean; remoteOid?: string } = {}) =>
  act(async () =>
    root.render(
      <ReferenceMenu
        repositoryId="repo"
        target={{ kind: "tag", ref: { name: "v1", oid: local.oid }, ...options, x: 100, y: 100 }}
        onClose={close}
      />,
    ),
  );

it.each(["local", "remote", "both"])(
  "deletes the selected %s tag scope using the tag namespace",
  async (scope) => {
    await renderTag();
    await click("Delete tag...");
    expect(document.querySelector<HTMLInputElement>('input[value="remote"]')?.disabled).toBe(false);
    await selectScope(scope);

    await click(
      scope === "both"
        ? "Delete local and remote"
        : scope === "local"
          ? "Delete locally"
          : "Delete remotely",
    );

    if (scope !== "local") {
      expect(preparePush).toHaveBeenCalledWith({
        repositoryId: "repo",
        remote: "upstream",
        branch: "v1",
        destination: "v1",
        refKind: "tag",
        mode: "delete",
        setUpstream: false,
      });

      expect(push).toHaveBeenCalledOnce();
    } else expect(push).not.toHaveBeenCalled();

    if (scope !== "remote")
      expect(deleteTag).toHaveBeenCalledWith({ repositoryId: "repo", name: "v1" });
    else expect(deleteTag).not.toHaveBeenCalled();

    expect(close).toHaveBeenCalledOnce();
  },
);

it("preserves the local tag after remote failure and retries only local deletion after partial success", async () => {
  push.mockResolvedValueOnce(
    err(errorFixture({ kind: "network-failed", message: "Remote unavailable" })),
  );

  await renderTag();
  await click("Delete tag...");
  await selectScope("both");
  await click("Delete local and remote");
  expect(deleteTag).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();

  deleteTag.mockResolvedValueOnce(
    err(errorFixture({ kind: "unknown", message: "Local tag is locked" })),
  );

  await click("Delete local and remote");
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Remote tag deleted");

  expect(
    document.querySelector<HTMLInputElement>('input[value="local"]')?.closest("fieldset")?.disabled,
  ).toBe(false);

  await click("Delete locally");
  expect(document.querySelector('input[value="remote"]')).toBeNull();
  expect(document.querySelector('input[value="both"]')).toBeNull();
  expect(push).toHaveBeenCalledTimes(2);
  expect(deleteTag).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
});

it("uses the branch popover surface without a remote check, URL, or authentication form", async () => {
  await renderTag();
  await click("Delete tag...");
  const surface = document.querySelector('[role="dialog"][aria-label="Delete tag"]')!;
  expect(surface.classList.contains("ui-popover-in")).toBe(true);
  expect(surface.getAttribute("aria-modal")).not.toBe("true");
  expect(surface.textContent).toContain("Remote: upstream/v1");
  expect(surface.textContent).not.toMatch(/https:|Check remote tags|HTTPS authentication/);
  expect(surface.querySelector('[role="combobox"]')).toBeNull();
  expect(surface.querySelector('input[type="password"]')).toBeNull();
  expect(remoteTags).toHaveBeenCalledWith({ repositoryId: "repo", remote: "upstream" });
});

it("keeps the local tag when the remote ref is absent and offers authentication only after rejection", async () => {
  preparePush.mockResolvedValueOnce(
    err(errorFixture({ kind: "invalid-input", message: "That remote ref no longer exists" })),
  );

  await renderTag();
  await click("Delete tag...");
  await selectScope("both");
  await click("Delete local and remote");
  expect(deleteTag).not.toHaveBeenCalled();
  expect(document.querySelector('input[type="password"]')).toBeNull();

  preparePush.mockResolvedValueOnce(
    err(errorFixture({ kind: "auth-failed", message: "Authentication failed" })),
  );

  await click("Delete local and remote");
  expect(document.querySelector('input[type="password"]')).not.toBeNull();
  expect(deleteTag).not.toHaveBeenCalled();
});

it("does not delete either tag if the profile changes during preview", async () => {
  preparePush.mockImplementationOnce(async () => {
    useAppStore.setState({ selectedRepositoryId: "other" });
    return ok({ token: "delete-preview" });
  });

  await renderTag();
  await click("Delete tag...");
  await selectScope("both");
  await click("Delete local and remote");
  expect(push).not.toHaveBeenCalled();
  expect(deleteTag).not.toHaveBeenCalled();
});

it("preselects the tag in the push review without configuring branch upstream tracking", async () => {
  await renderTag({ remoteName: "upstream" });
  await click("Push tag...");
  expect(document.querySelector('[aria-label="Local tag"]')?.textContent).toContain("v1");

  expect(document.querySelector<HTMLInputElement>('[aria-label="Destination tag"]')?.value).toBe(
    "v1",
  );

  await click("Review push");

  expect(preparePush).toHaveBeenCalledWith(
    expect.objectContaining({
      branch: "v1",
      destination: "v1",
      refKind: "tag",
      remote: "upstream",
      mode: "normal",
      setUpstream: false,
    }),
  );
});

it("disables actions requiring a local copy for remote-only tags and deletes remotely", async () => {
  listTags.mockResolvedValue(ok([]));
  await renderTag({ remoteName: "upstream", local: false });
  expect(button("Check out tag (detached HEAD)").disabled).toBe(true);
  expect(button("Verify tag signature...").disabled).toBe(true);
  expect(button("Push tag...").disabled).toBe(true);
  await click("Delete tag...");
  expect(document.querySelector('input[value="local"]')).toBeNull();
  expect(document.querySelector<HTMLInputElement>('input[value="remote"]')?.checked).toBe(true);
  await click("Delete remotely");
  expect(push).toHaveBeenCalledOnce();
  expect(deleteTag).not.toHaveBeenCalled();
});

it("copies the actual remote tag object ID when its local copy differs", async () => {
  await renderTag({ remoteName: "upstream", remoteOid: "b".repeat(40) });
  await click("Copy SHA");
  expect(copyText).toHaveBeenCalledWith("b".repeat(40));
});

it("labels local and remote tags directly in one Tags list", async () => {
  remoteTags.mockResolvedValue(
    ok([
      { name: "v1", oid: local.oid },
      { name: "remote-only", oid: "b".repeat(40) },
    ]),
  );

  await act(async () => root.render(<ReferenceSidebar repositoryId="repo" />));

  const tagGroups = [...container.querySelectorAll("summary")].filter((summary) =>
    summary.textContent?.includes("Tags"),
  );

  expect(tagGroups).toHaveLength(1);

  expect(container.textContent).not.toMatch(
    /Local tags|Remote tags|Check remote tags|HTTPS authentication/,
  );

  expect(remoteTags).toHaveBeenCalledWith({ repositoryId: "repo", remote: "upstream" });
  const shared = container.querySelector('[aria-label="Inspect tag v1"]')!;
  expect(shared.textContent).toBe("v1");
  expect(container.textContent).not.toContain("Both");
  expect(shared.getAttribute("title")).toContain("Remote tag: upstream");
  expect(shared.querySelector("svg")).toBeNull();
  expect(container.querySelectorAll('[aria-label="Inspect tag v1"]')).toHaveLength(1);
  await act(async () => useRepositoryStore.setState({ status: {} as never }));
  expect(remoteTags).toHaveBeenCalledOnce();
  const row = container.querySelector<HTMLButtonElement>('[aria-label="Inspect tag remote-only"]')!;
  expect(row.textContent).toBe("upstream/remote-only");
  expect(row.querySelector("svg")).toBeNull();
  await act(async () => row.click());
  expect(button("Check out tag (detached HEAD)").disabled).toBe(true);
});

it("leaves local tags usable and discloses unavailable remote status in the tooltip", async () => {
  remoteTags.mockResolvedValue(
    err(errorFixture({ kind: "auth-failed", message: "Authentication failed" })),
  );

  await act(async () => root.render(<ReferenceSidebar repositoryId="repo" />));
  const row = container.querySelector('[aria-label="Inspect tag v1"]')!;
  expect(row.getAttribute("title")).toContain("Remote status unavailable: upstream");
  expect(row.textContent).toBe("v1");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps the deletion popover open when choosing another remote", async () => {
  inspect.mockResolvedValue(
    ok({
      branches: [local, remote],
      remotes: [...remotes, { name: "origin", fetchUrls: [], pushUrls: [] }],
    }),
  );

  await renderTag();
  await click("Delete tag...");
  const control = document.querySelector<HTMLElement>('[role="combobox"][aria-label="Remote"]')!;

  await act(async () =>
    control.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );

  const option = document.querySelector<HTMLElement>('[data-eda-select-value="origin"]')!;

  await act(async () => {
    option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    option.click();
  });

  expect(close).not.toHaveBeenCalled();

  expect(document.querySelector('[aria-label="Delete tag"]')?.textContent).toContain(
    "Remote: origin/v1",
  );

  await selectScope("remote");
  await click("Delete remotely");

  expect(preparePush).toHaveBeenCalledWith(
    expect.objectContaining({ remote: "origin", refKind: "tag" }),
  );
});

it("uses branch sections and qualified names without repeated status lines", async () => {
  vi.mocked(window.eda.repository.listBranches).mockResolvedValue(
    ok([{ ...local, isHead: true }, remote]),
  );

  await act(async () => root.render(<ReferenceSidebar repositoryId="repo" />));
  const localRow = container.querySelector('[aria-label="Inspect branch feature/topic"]')!;
  const remoteRow = container.querySelector('[aria-label="Inspect branch upstream/review/topic"]')!;
  expect(localRow.textContent).toBe("feature/topic");
  expect(remoteRow.textContent).toBe("upstream/review/topic");

  expect(localRow.closest("details")?.querySelector("summary")?.textContent).toContain(
    "Local branches",
  );

  expect(remoteRow.closest("details")?.querySelector("summary")?.textContent).toContain(
    "Remote branches",
  );

  expect(localRow.getAttribute("title")).toContain("Current branch");
  expect(localRow.querySelector("svg")).toBeNull();
  expect(remoteRow.querySelector("svg")).toBeNull();
});

it("labels a tag that exists only locally without a remote badge", async () => {
  remoteTags.mockResolvedValue(ok([]));
  await act(async () => root.render(<ReferenceSidebar repositoryId="repo" />));
  const row = container.querySelector('[aria-label="Inspect tag v1"]')!;
  expect(row.textContent).toBe("v1Local");
  expect(row.querySelector("svg")).toBeNull();
});

it("does not mark a tag local-only while remote lookup is pending", async () => {
  let finish!: (result: ReturnType<typeof ok<never[]>>) => void;

  remoteTags.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );

  await act(async () => root.render(<ReferenceSidebar repositoryId="repo" />));
  expect(container.querySelector('[aria-label="Inspect tag v1"]')?.textContent).toBe("v1");
  await act(async () => finish(ok([])));
  expect(container.querySelector('[aria-label="Inspect tag v1"]')?.textContent).toBe("v1Local");
});

it("does not mark a tag local-only if any configured remote is unavailable", async () => {
  inspect.mockResolvedValue(
    ok({
      branches: [local, remote],
      remotes: [...remotes, { name: "backup", fetchUrls: [], pushUrls: [] }],
    }),
  );

  remoteTags.mockImplementation(async ({ remote }: { remote: string }) =>
    remote === "upstream"
      ? ok([])
      : err(errorFixture({ kind: "network-failed", message: "Unavailable" })),
  );

  await act(async () => root.render(<ReferenceSidebar repositoryId="repo" />));
  expect(container.querySelector('[aria-label="Inspect tag v1"]')?.textContent).toBe("v1");
});

it("hides remote deletion and omits the remote target for a local-only tag", async () => {
  remoteTags.mockResolvedValue(ok([]));
  await renderTag();
  await click("Delete tag...");
  expect(document.querySelector<HTMLInputElement>('input[value="local"]')?.disabled).toBe(false);
  expect(document.querySelector('input[value="remote"]')).toBeNull();
  expect(document.querySelector('input[value="both"]')).toBeNull();

  expect(document.querySelector('[aria-label="Delete tag"]')?.textContent).not.toContain(
    "Remote: upstream/v1",
  );

  await click("Delete locally");
  expect(deleteTag).toHaveBeenCalledOnce();
  expect(preparePush).not.toHaveBeenCalled();
});

it("shows only remote deletion for a remote-only tag", async () => {
  listTags.mockResolvedValue(ok([]));
  await renderTag({ remoteName: "upstream", local: false });
  await click("Delete tag...");
  expect(document.querySelector('input[value="local"]')).toBeNull();
  expect(document.querySelector<HTMLInputElement>('input[value="remote"]')?.disabled).toBe(false);
  expect(document.querySelector('input[value="both"]')).toBeNull();
});

it("waits for remote presence before enabling remote scopes, without blocking local deletion", async () => {
  let finish!: (result: ReturnType<typeof ok<never[]>>) => void;

  remoteTags.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );

  await renderTag();
  await click("Delete tag...");
  expect(document.querySelector('input[value="remote"]')).toBeNull();
  expect(document.querySelector('input[value="both"]')).toBeNull();
  expect(button("Delete locally").disabled).toBe(false);

  expect(
    document.querySelector('[role="status"][aria-label="Loading tag targets..."]'),
  ).not.toBeNull();

  await act(async () => finish(ok([])));
  expect(document.querySelector('[role="status"][aria-label="Loading tag targets..."]')).toBeNull();
  expect(document.querySelector('input[value="remote"]')).toBeNull();
});

it("updates deletion scopes when the selected remote does not contain the tag", async () => {
  inspect.mockResolvedValue(
    ok({
      branches: [local, remote],
      remotes: [...remotes, { name: "backup", fetchUrls: [], pushUrls: [] }],
    }),
  );

  remoteTags.mockImplementation(async ({ remote }: { remote: string }) =>
    ok(remote === "upstream" ? [{ name: "v1", oid: local.oid }] : []),
  );

  await renderTag();
  await click("Delete tag...");
  await selectScope("both");
  const control = document.querySelector<HTMLElement>('[role="combobox"][aria-label="Remote"]')!;

  await act(async () =>
    control.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );

  await act(async () =>
    document.querySelector<HTMLElement>('[data-eda-select-value="backup"]')!.click(),
  );

  expect(document.querySelector<HTMLInputElement>('input[value="local"]')?.checked).toBe(true);
  expect(document.querySelector('input[value="remote"]')).toBeNull();
  expect(document.querySelector('input[value="both"]')).toBeNull();

  expect(document.querySelector('[aria-label="Delete tag"]')?.textContent).not.toContain(
    "Remote: backup/v1",
  );
});

it("shows no deletion action when a branch has no deletable target", async () => {
  const branch = { ...local, isHead: true };
  delete branch.upstream;
  inspect.mockResolvedValue(ok({ branches: [branch], remotes: [] }));
  await render(branch);
  await click("Delete branch...");
  expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  expect(button("Delete locally")).toBeUndefined();

  expect(document.querySelector('[aria-label="Delete branch"]')?.textContent).toContain(
    "Check out another branch",
  );

  await click("Cancel");
  expect(deleteBranch).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

it("shows no deletion action after a tag disappears from both locations", async () => {
  listTags.mockResolvedValue(ok([]));
  remoteTags.mockResolvedValue(ok([]));
  await renderTag({ local: false, remoteName: "upstream" });
  await click("Delete tag...");
  expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  expect(button("Delete remotely")).toBeUndefined();

  expect(document.querySelector('[aria-label="Delete tag"]')?.textContent).toContain(
    "This tag is no longer available",
  );

  expect(document.querySelector('[aria-label="Delete tag"]')?.textContent).not.toContain(
    "This removes the tag",
  );

  await click("Cancel");
  expect(deleteTag).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

it.each(["rejected", "reported"])(
  "clears stale local-only status after a %s remote refresh failure and recovers on retry",
  async (failure) => {
    const tags = [{ name: "v1", oid: local.oid }];

    function References({ revision }: { revision: number }) {
      const references = useTagReferences("repo", "profile", tags, revision, false);
      return (
        <ReferenceRow
          item={references[0]!}
          selected={false}
          onActions={() => {}}
          onCheckout={() => {}}
        />
      );
    }

    remoteTags.mockResolvedValue(ok([]));
    await act(async () => root.render(<References revision={0} />));
    expect(container.textContent).toBe("v1Local");

    if (failure === "rejected") inspect.mockRejectedValueOnce(new Error("offline"));
    else
      inspect.mockResolvedValueOnce(
        err(errorFixture({ kind: "network-failed", message: "offline" })),
      );

    await act(async () => root.render(<References revision={1} />));
    expect(container.textContent).toBe("v1");
    expect(container.querySelector("button")?.title).toContain("Remote tag status is unavailable");

    remoteTags.mockResolvedValue(ok([{ name: "v1", oid: local.oid }]));
    await act(async () => root.render(<References revision={2} />));
    expect(container.textContent).toBe("v1");
    expect(container.querySelector("button")?.title).toContain("Remote tag: upstream");
    expect(container.querySelector("button")?.title).not.toContain("unavailable");
  },
);
