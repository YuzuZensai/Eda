import { act } from "react";
import { createRoot } from "react-dom/client";
import { ok } from "@shared/errors";
import { RepositoryHome } from "@renderer/features/repositories/RepositoryHome";
import { useSessionStore } from "@renderer/stores/session-store";
import { useAppStore } from "@renderer/stores/app-store";

it("keeps trust actions out of repository rows and reviews only the repository being edited", async () => {
  const previous = useAppStore.getState();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const reviewTrust = vi.fn(async () => ok(undefined));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", { app: { platform: "mac" }, repository: { reviewTrust } });
  useAppStore.setState({
    repositories: ["first", "second"].map((name) => ({
      id: name,
      identityId: "profile",
      name,
      path: `/repos/${name}`,
      favourite: false,
      available: true,
    })),
  });

  try {
    await act(async () => root.render(<RepositoryHome />));
    expect(container.querySelector("kbd")?.textContent).toBe("Cmd+P");
    expect(container.textContent).not.toMatch(/trust/i);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Edit second"]')!.click();
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Repository settings");
    const actions = Array.from(dialog.querySelectorAll("button")).filter((button) =>
      button.textContent?.includes("Review trust"),
    );
    expect(actions).toHaveLength(1);
    await act(async () => actions[0]!.click());
    expect(reviewTrust).toHaveBeenCalledExactlyOnceWith("second");
    expect(dialog.querySelector<HTMLInputElement>("input")?.value).toBe("second");
  } finally {
    await act(async () => root.unmount());
    useAppStore.setState(previous, true);
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("removes a missing repository directly from its row only after confirmation", async () => {
  const previous = useAppStore.getState();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const remove = vi.fn(async () => ok(undefined));
  const refreshRepositories = vi.fn(async () => useAppStore.setState({ repositories: [] }));
  const flush = vi.spyOn(useSessionStore.getState(), "flush").mockResolvedValue(true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", { app: { platform: "mac" }, repository: { remove } });
  useAppStore.setState({
    refreshRepositories,
    repositories: [
      {
        id: "missing",
        identityId: "profile",
        name: "Missing",
        path: "/missing",
        favourite: false,
        available: false,
      },
    ],
  });
  const click = async (label: string) => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent === label || item.getAttribute("aria-label") === label,
    )!;
    expect(button).toBeTruthy();
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(<RepositoryHome />));
    await click("Remove Missing from profile");
    expect(remove).not.toHaveBeenCalled();
    await click("Cancel");
    expect(remove).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click("Remove Missing from profile");
    await click("Remove from profile");
    expect(remove).toHaveBeenCalledExactlyOnceWith("missing");
    expect(refreshRepositories).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    flush.mockRestore();
    useAppStore.setState(previous, true);
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps Home open and reports each collection member after bulk open, fetch, pull and clone", async () => {
  const previous = useAppStore.getState();
  const member = {
    id: "a",
    identityId: "work",
    name: "Local",
    path: "/a",
    favourite: false,
    available: true,
  };
  const imported = { name: "Imported", remote: "https://example.test/org/b.git" };
  const collection = {
    id: "collection",
    name: "Tools",
    description: "",
    icon: "●",
    color: "#ffffff",
    members: [{ name: member.name, repositoryId: member.id }, imported],
  };
  const cloned = { ...member, id: "b", path: "/clones/Imported", name: "Imported" };
  const fetch = vi.fn(async () => ok(undefined));
  const execute = vi.fn(async () => ok(undefined));
  const clone = vi.fn(async () => ok(cloned));
  const saveCollections = vi.fn(async () => ok(undefined));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eda", {
    app: { platform: "linux" },
    settings: { resolve: async () => ok({ value: [collection] }), saveCollections },
    remotes: { fetch, clone },
    pull: { prepare: async () => ok({ token: "review" }), execute },
    repository: { chooseFolder: async () => ok("/clones") },
  });
  useAppStore.setState({
    activeIdentity: {
      id: "work",
      name: "Work",
      gitName: "Work",
      gitEmail: "work@example.test",
      hue: 210,
      signing: { format: "none", signCommits: false },
      createdAt: "",
      updatedAt: "",
    },
    repositories: [member],
    selectedRepositoryId: null,
    refreshRepositories: async () => {
      useAppStore.setState({ repositories: [member, cloned] });
    },
  });
  const click = async (label: string) => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  try {
    await act(async () => root.render(<RepositoryHome />));
    await click("Local collections");
    await act(() => vi.dynamicImportSettled());
    await click("● Tools");
    await click("Open tabs");
    const results = () => document.querySelector('[role="dialog"] ul[role="status"]')?.textContent;
    expect(results()).toContain("Local · Done");
    expect(results()).toContain("Imported · Map this entry");
    expect(useAppStore.getState().selectedRepositoryId).toBeNull();
    expect(useAppStore.getState().openTabsByIdentity["work"]).toContain("a");
    await click("Fetch all remotes");
    expect(fetch).toHaveBeenCalledExactlyOnceWith({
      repositoryId: "a",
      remote: null,
      prune: false,
      tags: false,
    });
    await click("Pull (fast-forward only)");
    expect(execute).toHaveBeenCalledExactlyOnceWith("a", "review");
    await click("Clone missing repositories into a folder");
    expect(results()).toContain("Local · Already available locally");
    expect(results()).toContain("Imported · Done");
    expect(clone).toHaveBeenCalledExactlyOnceWith({
      profileId: "work",
      parent: "/clones",
      name: "Imported",
      url: imported.remote,
    });
    expect(saveCollections).toHaveBeenCalledWith(
      "work",
      [collection],
      [
        {
          ...collection,
          members: [
            collection.members[0],
            { ...imported, repositoryId: "b", pathHint: "/clones/Imported" },
          ],
        },
      ],
    );
  } finally {
    await act(async () => root.unmount());
    useAppStore.setState(previous, true);
    container.remove();
    vi.unstubAllGlobals();
  }
});
