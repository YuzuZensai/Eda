import { act } from "react";
import { createRoot } from "react-dom/client";
import { AppUpdateNotice } from "@renderer/features/updates/AppUpdateNotice";
import { UpdateStatus } from "@renderer/features/updates/UpdatesSettings";
import { useShellStore } from "@renderer/stores/shell-store";
import type { UpdateState } from "@shared/updates";

it.each(["Homebrew", "APT / dpkg", "RPM", "Pacman"])(
  "opens update details for %s from the same compact banner without replacement actions or instructions",
  async (manager) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const state: UpdateState = {
      revision: 1,
      capability: "managed",
      reason: `Managed by ${manager}.`,
      phase: "available",
      feedUrl: null,
      checkedAt: null,
      release: { version: "1.2.4", name: "Eda 1.2.4", notes: "Changes", releasedAt: null },
      progress: null,
      error: null,
    };
    vi.stubGlobal("eda", { app: { version: { displayVersion: "1.2.2-abcdef" } } });
    const actions = { check: vi.fn(), download: vi.fn(), install: vi.fn() };
    const previousShell = useShellStore.getState();
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      for (const phase of ["available", "ready"] as const) {
        await act(async () =>
          root.render(
            <>
              <AppUpdateNotice state={{ ...state, phase }} preview={false} aboutOpen={false} />
              <UpdateStatus state={{ ...state, phase }} actions={actions} />
            </>,
          ),
        );

        const banner = container.querySelector('aside[aria-label="App update"]')!;
        expect(banner.querySelector('[role="status"]')?.textContent).toBe(
          "Eda 1.2.4 is available.",
        );
        expect(banner.textContent).not.toMatch(/Managed by|Installed:|ready to install/);

        const action = banner.querySelector<HTMLButtonElement>("button")!;

        expect(action.textContent).toBe("View update");
        await act(async () => action.click());
        expect(useShellStore.getState().request).toEqual({ kind: "settings", section: "about" });
        expect(container.textContent).toContain(`Managed by ${manager}.`);
        expect(container.textContent).not.toMatch(
          /Restart|Download update|brew upgrade|sudo |Use your package manager/,
        );
      }
      await act(async () =>
        root.render(<UpdateStatus state={{ ...state, phase: "idle" }} actions={actions} />),
      );
      const check = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Check for updates",
      )!;
      await act(async () => check.click());
      expect(actions.check).toHaveBeenCalledOnce();
      expect(actions.download).not.toHaveBeenCalled();
      expect(actions.install).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      useShellStore.setState(previousShell);
      vi.unstubAllGlobals();
    }
  },
);

it.each(["available", "ready"] as const)(
  "shows only the target version and View update for a %s update",
  async (phase) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const previous = useShellStore.getState();
    const state: UpdateState = {
      revision: 1,
      capability: "automatic",
      reason: null,
      phase,
      feedUrl: null,
      checkedAt: null,
      release: { version: "1.2.3", name: "Release name", notes: null, releasedAt: null },
      progress: null,
      error: null,
    };

    const container = document.createElement("div");
    const root = createRoot(container);

    const render = (next: UpdateState, aboutOpen = false) =>
      act(async () =>
        root.render(<AppUpdateNotice state={next} preview={false} aboutOpen={aboutOpen} />),
      );

    try {
      await render(state);

      const banner = container.querySelector('aside[aria-label="App update"]')!;

      expect(banner.querySelector('[role="status"]')?.textContent).toBe("Eda 1.2.3 is available.");
      expect(banner.textContent).not.toMatch(/Installed:|Downloaded|ready to install/);
      expect(banner.textContent).not.toContain("Review what's new before downloading.");
      expect(banner.textContent).not.toContain("Preview");

      const action = banner.querySelector<HTMLButtonElement>("button")!;

      expect(action.dataset["variant"]).toBe("quiet");
      expect(action.textContent).toBe("View update");

      await act(async () => action.click());

      expect(useShellStore.getState().request).toEqual({ kind: "settings", section: "about" });

      await render(state, true);

      expect(container.querySelector("aside")).toBeNull();

      await render(state);
      await render({ ...state, revision: 2, phase: "current" });

      expect(container.querySelector("aside")).toBeNull();

      await render({ ...state, revision: 3, release: null });

      expect(container.textContent).toContain("An update");
      expect(container.textContent).not.toContain("undefined");
    } finally {
      await act(async () => root.unmount());

      useShellStore.setState(previous);
      vi.unstubAllGlobals();
    }
  },
);
