import { act } from "react";
import { createRoot } from "react-dom/client";
import { AppNotices } from "@renderer/app/AppNotices";
import { useAppStore } from "@renderer/stores/app-store";
import { usePreferencesStore } from "@renderer/stores/preferences-store";
import { useSimulationStore } from "@renderer/stores/simulation-store";
import { builtInSetting } from "@shared/preferences/settings";
import type { UpdateState } from "@shared/updates";

it("stacks notices, dismisses an update independently, and resurfaces changed update states", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const previousApp = useAppStore.getState();
  const previousPreferences = usePreferencesStore.getState();
  const inspect = vi.fn();
  const apply = vi.fn();
  const live: UpdateState = {
    revision: 0,
    capability: "development",
    phase: "idle",
    reason: null,
    feedUrl: null,
    checkedAt: null,
    release: null,
    progress: null,
    error: null,
  };

  const readStatus = vi.fn(async () => ({ ok: true, value: live }));
  const subscribe = vi.fn(() => () => {});

  vi.stubGlobal("eda", {
    app: { version: { version: "0.0.2", displayVersion: "0.0.2" } },
    identity: { inspectGit: inspect, reapplyGlobal: apply },
    updates: { state: readStatus },
    events: { onUpdateChanged: subscribe },
  });

  useAppStore.setState({
    activeIdentity: {
      id: "work",
      name: "Work",
      gitName: "Work Author",
      gitEmail: "work@example.com",
      hue: 210,
      signing: { format: "none", signCommits: false },
      createdAt: "now",
      updatedAt: "now",
    },
    switchingIdentityId: null,
  });
  usePreferencesStore.setState({
    values: {
      ...previousPreferences.values,
      developerSettingsEnabled: { ...builtInSetting("developerSettingsEnabled"), value: true },
    },
  });
  useSimulationStore.getState().setGitIdentity("mismatch");
  useSimulationStore.getState().setUpdatePhase("available");

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (aboutOpen = false) =>
    act(async () =>
      root.render(<AppNotices aboutOpen={aboutOpen} onReviewGitSettings={() => {}} />),
    );
  const rows = () => [...container.querySelectorAll("aside")];
  const dismiss = async () =>
    act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Dismiss App update"]')!.click(),
    );

  try {
    await render();
    expect(readStatus).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();

    expect(container.querySelector('[aria-label="App notifications"]')).not.toBeNull();
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "Global Git configuration warning",
      "App update",
    ]);
    expect(rows()[0]!.querySelector('[aria-label^="Dismiss"]')).toBeNull();

    await dismiss();

    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain("Global Git settings differ from Work");

    await render(true);
    await render();

    expect(rows()).toHaveLength(1);

    await act(async () => useSimulationStore.getState().setUpdatePhase("ready"));

    expect(rows()).toHaveLength(2);
    expect(rows()[1]!.querySelector('[role="status"]')?.textContent).toBe(
      "Eda 0.0.3 is available.",
    );
    expect(rows()[1]!.querySelector("button")?.textContent).toBe("View update");

    await dismiss();
    await act(async () => useSimulationStore.getState().setUpdatePhase(null));
    await act(async () => useSimulationStore.getState().setUpdatePhase("ready"));

    expect(rows()).toHaveLength(2);

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Review global Git settings"]')!
        .click(),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => useSimulationStore.getState().setUpdatePhase("installing"));

    expect(rows()).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => useSimulationStore.getState().setUpdatePhase("ready"));
    expect(rows()).toHaveLength(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => useSimulationStore.getState().reset());

    expect(rows()).toHaveLength(0);
    expect(inspect).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());

    container.remove();
    useSimulationStore.getState().reset();
    useAppStore.setState(previousApp);
    usePreferencesStore.setState(previousPreferences);
    vi.unstubAllGlobals();
  }
});
