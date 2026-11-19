import { act } from "react";
import { createRoot } from "react-dom/client";
import { RepositoryTabs } from "@renderer/features/repositories/RepositoryTabs";
import { useAppStore } from "@renderer/stores/app-store";
import type { RepositorySummary } from "@shared/repository/repository";
import type { Identity } from "@shared/identity/identity";

it("navigates tabs and returns home without closing them or showing a reopen button", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = useAppStore.getState();
  const repositories: RepositorySummary[] = ["one", "two", "three"].map((id) => ({
    id,
    identityId: "profile",
    name: id,
    path: `/repos/${id}`,
    available: true,
    favourite: false,
  }));
  const identity: Identity = {
    id: "profile",
    name: "Work",
    gitName: "Author",
    gitEmail: "author@example.test",
    hue: 210,
    signing: { format: "none", signCommits: false },
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    useAppStore.setState({
      activeIdentity: identity,
      repositories,
      selectedRepositoryId: "one",
      openTabsByIdentity: { profile: ["one", "two", "three"] },
      closedTabsByIdentity: {},
      selectRepository: (id) => useAppStore.setState({ selectedRepositoryId: id }),
      closeTab: (id) =>
        useAppStore.setState({
          selectedRepositoryId: "three",
          openTabsByIdentity: { profile: ["one", "two", "three"].filter((item) => item !== id) },
          closedTabsByIdentity: { profile: [{ id, index: 1 }] },
        }),
    });
    await act(async () => root.render(<RepositoryTabs />));
    const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    await act(async () => {
      tabs()[0]!.focus();
      tabs()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(useAppStore.getState().selectedRepositoryId).toBe("two");
    expect(document.activeElement).toBe(tabs()[1]);
    await act(async () =>
      tabs()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })),
    );
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain("three"));
    expect(tabs()).toHaveLength(2);
    expect(document.activeElement).toBe(tabs()[1]);
    expect(container.querySelector('[aria-label="Reopen closed repository"]')).toBeNull();

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Open a repository"]')!.click(),
    );
    expect(useAppStore.getState().selectedRepositoryId).toBeNull();
    expect(useAppStore.getState().openTabsByIdentity["profile"]).toEqual(["one", "three"]);
    expect(tabs().every((tab) => tab.getAttribute("aria-selected") === "false")).toBe(true);

    await act(async () => tabs()[0]!.click());
    expect(useAppStore.getState().selectedRepositoryId).toBe("one");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useAppStore.setState(previous);
    vi.unstubAllGlobals();
  }
});
