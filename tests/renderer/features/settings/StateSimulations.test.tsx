import { chooseOption, fillInput } from "../../../helpers/form-controls";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { StateSimulations } from "@renderer/features/settings/debug/StateSimulations";
import { AppNotices } from "@renderer/app/AppNotices";
import { UpdatesSettings } from "@renderer/features/updates/UpdatesSettings";
import { usePreferencesStore } from "@renderer/stores/preferences-store";
import { useSessionStore } from "@renderer/stores/session-store";
import { useShellStore } from "@renderer/stores/shell-store";
import { useSimulationStore } from "@renderer/stores/simulation-store";
import { builtInSetting, type SettingKey } from "@shared/preferences/settings";
import type { UpdateState } from "@shared/updates";

it("previews update banners and actions throughout the app, then restores the latest live status", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const previous = usePreferencesStore.getState();
  const previousShell = useShellStore.getState();
  const listeners = new Set<(state: UpdateState) => void>();
  const check = vi.fn();
  const download = vi.fn();
  const install = vi.fn();
  const flush = vi.spyOn(useSessionStore.getState(), "flush");
  const live: UpdateState = {
    revision: 1,
    capability: "development",
    reason: "Development build",
    phase: "idle",
    feedUrl: null,
    checkedAt: null,
    release: null,
    progress: null,
    error: null,
  };

  vi.stubGlobal("eda", {
    app: { version: { version: "0.0.2", displayVersion: "0.0.2-abcdef-dirty" } },
    settings: {
      resolve: async (key: SettingKey) => ({ ok: true, value: builtInSetting(key) }),
    },
    updates: { state: async () => ({ ok: true, value: live }), check, download, install },
    events: {
      onUpdateChanged: (listener: (state: UpdateState) => void) => {
        listeners.add(listener);

        return () => listeners.delete(listener);
      },
    },
  });
  usePreferencesStore.setState({
    values: {
      ...previous.values,
      developerSettingsEnabled: { ...builtInSetting("developerSettingsEnabled"), value: true },
    },
  });

  const container = document.createElement("div");

  document.body.append(container);

  const root = createRoot(container);
  const debug = () => container.querySelector<HTMLElement>("#debug-panel")!;
  const banner = () => container.querySelector<HTMLElement>("#app-banner")!;
  const about = () => container.querySelector<HTMLElement>("#about-panel")!;
  const click = async (within: HTMLElement, label: string) => {
    const button = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === label || item.getAttribute("aria-label") === label,
    );

    expect(button, label).toBeDefined();

    await act(async () => button!.click());
  };
  const choose = (label: string, control = "Update state") =>
    chooseOption(debug().querySelector<HTMLElement>(`[aria-label="${control}"]`)!, label);

  try {
    await act(async () =>
      root.render(
        <>
          <div id="debug-panel">
            <StateSimulations />
          </div>

          <div id="app-banner">
            <AppNotices aboutOpen={false} onReviewGitSettings={() => {}} />
          </div>

          <div id="about-panel">
            <UpdatesSettings />
          </div>
        </>,
      ),
    );

    expect(banner().textContent).toBe("");

    await choose("Update available");

    expect(banner().textContent).toContain("Eda 0.0.3 is available");
    expect(banner().textContent).not.toContain("Installed:");
    expect(about().textContent).toContain("Installed: 0.0.2-abcdef-dirty");
    expect(banner().textContent).not.toContain("Preview");
    expect(about().textContent).not.toContain("Update preview is active");
    expect(container.textContent).not.toContain("Reset preview");
    expect(debug().querySelector('[aria-label="Download update"]')).toBeNull();

    await click(debug(), "View update");

    expect(useShellStore.getState().request).toEqual({ kind: "settings", section: "about" });

    await click(banner(), "View update");

    expect(useShellStore.getState().request).toEqual({ kind: "settings", section: "about" });

    await click(about(), "Download update");

    expect(useSimulationStore.getState().update?.phase).toBe("downloading");
    expect(about().querySelector("progress")?.value).toBe(45);
    expect(banner().textContent).toBe("");

    const slider = debug().querySelector<HTMLInputElement>('input[type="range"]')!;

    await fillInput(slider, "75");

    expect(about().querySelector("progress")?.value).toBe(75);

    await click(debug(), "Preview completed download");

    expect(banner().textContent).toContain("Eda 0.0.3 is available");
    expect(banner().textContent).not.toContain("Downloaded and verified");
    expect(about().textContent).toContain("Downloaded and verified. Restart to install.");

    await choose("Homebrew", "Installation method");

    expect(useSimulationStore.getState().update?.phase).toBe("available");
    expect(about().querySelector("progress")).toBeNull();

    for (const manager of ["Homebrew", "APT / dpkg", "RPM", "Pacman"]) {
      await choose(manager, "Installation method");

      expect(banner().textContent).not.toContain("Managed by");
      expect(banner().querySelectorAll("button")).toHaveLength(2);
      await click(banner(), "View update");

      expect(useShellStore.getState().request).toEqual({ kind: "settings", section: "about" });
      expect(about().textContent).toContain(`Managed by ${manager}.`);
      expect(about().textContent).not.toMatch(
        /Download update|Restart and install|brew upgrade|sudo /,
      );
      expect(useSimulationStore.getState().runUpdateAction("download")).toBe(false);

      if (manager === "Homebrew") {
        await click(about(), "Update with Homebrew");
        expect(useSimulationStore.getState().update?.phase).toBe("installing");
        expect(about().textContent).toContain("Updating with Homebrew");
        await choose("Update available");
      } else {
        expect(useSimulationStore.getState().runUpdateAction("install")).toBe(false);
      }

      await click(banner(), "Dismiss App update");

      expect(banner().textContent).toBe("");
    }

    await choose("Update check failed.");
    await click(about(), "Check for updates");

    expect(useSimulationStore.getState().update?.phase).toBe("current");
    expect(about().textContent).toContain("Managed by Pacman.");

    await choose("Update available");
    await choose("Direct download", "Installation method");

    expect(banner().textContent).not.toContain("Managed by");
    expect(about().querySelector('[aria-label="Download update"]')).not.toBeNull();

    await choose("Ready to install");
    await click(about(), "Restart and install");

    expect(useSimulationStore.getState().update?.phase).toBe("installing");

    await choose("Update check failed.");

    expect(about().querySelector('[role="alert"]')?.textContent).toContain(
      "Simulated update failure",
    );

    await click(about(), "Check for updates");

    expect(useSimulationStore.getState().update?.phase).toBe("current");

    for (const label of ["Idle", "Checking for updates..."]) await choose(label);

    expect(useSimulationStore.getState().update?.phase).toBe("checking");

    await choose("Update available");
    await act(async () => {
      for (const listener of listeners)
        listener({ ...live, revision: 2, phase: "current", reason: "Latest live status" });
    });

    expect(banner().textContent).toContain("Eda 0.0.3 is available");

    await choose("Use live status");

    expect(useSimulationStore.getState().updateInstallation).toBe("direct");
    expect(about().textContent).toContain("Latest live status");
    expect(banner().textContent).toBe("");

    await choose("Update available");
    await act(async () => {
      about().querySelector<HTMLButtonElement>('[aria-label="Download update"]')!.click();
      useSimulationStore.getState().setUpdatePhase(null);
    });

    expect(useSimulationStore.getState().update).toBeNull();
    expect(download).not.toHaveBeenCalled();

    await choose("Ready to install");
    await choose("Homebrew", "Installation method");
    await act(async () => usePreferencesStore.setState({ values: previous.values }));

    expect(useSimulationStore.getState().update).toBeNull();
    expect(useSimulationStore.getState().updateInstallation).toBe("direct");
    expect(banner().textContent).toBe("");
    expect(about().textContent).toContain("Latest live status");
    expect(check).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());

    expect(listeners.size).toBe(0);

    container.remove();
    useSimulationStore.getState().setUpdatePhase(null);
    usePreferencesStore.setState(previous);
    useShellStore.setState(previousShell);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
