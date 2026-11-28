import { fillInput } from "../../../helpers/form-controls";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { err, ok } from "@shared/errors";
import { builtInSetting, type SettingKey } from "@shared/preferences/settings";
import { GitEngineSettings } from "@renderer/features/settings/git/GitEngineSettings";
import { RepositoryPullSettings } from "@renderer/features/settings/repository/RepositoryPullSettings";
import { useAppStore } from "@renderer/stores/app-store";
import { deferred } from "../../../helpers/deferred";
import { errorFixture } from "../../../helpers/error";
import { Settings } from "@renderer/features/settings/Settings";
import { usePreferencesStore } from "@renderer/stores/preferences-store";

vi.mock("@renderer/features/settings/application/AboutSettings", () => ({
  AboutSettings: () => <div>About Eda</div>,
}));

it("mounts only the selected settings panel without starting unrelated IPC work", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const unexpectedIpc = vi.fn(() => {
    throw new Error("An inactive settings panel requested IPC");
  });
  vi.stubGlobal("eda", new Proxy({}, { get: unexpectedIpc }));
  const previous = usePreferencesStore.getState();
  usePreferencesStore.setState({
    values: {
      ...previous.values,
      developerSettingsEnabled: { ...previous.values.developerSettingsEnabled, value: true },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Settings selected="debug-failures" onSelect={() => {}} />));
    expect(container.querySelectorAll("section[id^='settings-']")).toHaveLength(1);
    expect(container.querySelector("#settings-debug-failures")).not.toBeNull();
    expect(container.querySelector("[aria-current='page']")?.textContent).toBe(
      "Resilience testing",
    );

    await act(async () => root.render(<Settings selected="debug-reset" onSelect={() => {}} />));
    expect(container.querySelectorAll("section[id^='settings-']")).toHaveLength(1);
    expect(container.querySelector("#settings-debug-failures")).toBeNull();
    expect(container.querySelector("#settings-debug-reset")).not.toBeNull();
    expect(container.querySelector("[aria-current='page']")?.textContent).toBe("App data");
    expect(container.textContent).toContain("Copy release data and restart...");
    expect(unexpectedIpc).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    usePreferencesStore.setState(previous);
    vi.unstubAllGlobals();
  }
});

it("gates debug navigation, search, and direct selection behind developer settings", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = usePreferencesStore.getState();
  const onSelect = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const enable = (value: boolean) =>
    usePreferencesStore.setState({
      values: {
        ...previous.values,
        developerSettingsEnabled: { ...previous.values.developerSettingsEnabled, value },
      },
    });

  try {
    enable(false);
    for (const selected of ["debug", "debug-states", "debug-failures", "debug-reset"] as const) {
      onSelect.mockClear();
      await act(async () => root.render(<Settings selected={selected} onSelect={onSelect} />));
      expect(container.querySelector("#settings-about")).not.toBeNull();
      expect(container.querySelector("[id^='settings-debug']")).toBeNull();
      expect(container.querySelector("[aria-controls^='settings-debug']")).toBeNull();
      expect(onSelect).toHaveBeenCalledWith("about");
      await act(async () => root.render(<Settings selected="about" onSelect={onSelect} />));
    }

    const search = container.querySelector<HTMLInputElement>('[aria-label="Search settings"]')!;
    await fillInput(search, "resilience");
    expect(container.querySelector("[aria-controls='settings-debug-failures']")).toBeNull();
    expect(container.textContent).toContain("No settings match");

    await act(async () => enable(true));
    expect(container.querySelector("[aria-controls='settings-debug-failures']")).not.toBeNull();

    await act(async () => root.render(<Settings selected="debug-failures" onSelect={onSelect} />));
    expect(container.querySelector("#settings-debug-failures")).not.toBeNull();
    onSelect.mockClear();
    await act(async () => enable(false));
    expect(container.querySelector("#settings-debug-failures")).toBeNull();
    expect(container.querySelector("#settings-about")).not.toBeNull();
    expect(onSelect).toHaveBeenCalledWith("about");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    usePreferencesStore.setState(previous);
    vi.unstubAllGlobals();
  }
});

it("keeps a late global preview error out of the next settings page", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pending = deferred<void>();
  const preview = vi.fn(async (enabled: boolean) => {
    if (enabled) {
      await pending.promise;
      throw new Error("Preview disconnected");
    }
    return ok(undefined);
  });
  vi.stubGlobal("eda", {
    app: { platform: "darwin" },
    settings: {
      resolve: async (key: SettingKey) => ok(builtInSetting(key)),
      previewGlobalAppearance: preview,
    },
  });
  const previous = usePreferencesStore.getState();
  usePreferencesStore.setState({ error: null });
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Settings selected="global" onSelect={() => {}} />));
    expect(preview).toHaveBeenCalledWith(true);
    await act(async () => root.render(<Settings selected="about" onSelect={() => {}} />));
    expect(preview).toHaveBeenLastCalledWith(false);
    await act(async () => pending.resolve());
    expect(usePreferencesStore.getState().error).toBeNull();
  } finally {
    await act(async () => root.unmount());
    usePreferencesStore.setState(previous);
    vi.unstubAllGlobals();
  }
});

it("checks the chosen Git engine during save and refresh and restores the last confirmed choice on failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const write = deferred<void>();
  const refresh = deferred<void>();
  const failedWrite = deferred<void>();
  const failure = errorFixture({ message: "Git preference write failed" });
  let saved = false;
  const set = vi
    .fn()
    .mockImplementationOnce(async () => {
      await write.promise;
      saved = true;
      return ok(undefined);
    })
    .mockImplementationOnce(async () => {
      await failedWrite.promise;
      return err(failure);
    });
  vi.stubGlobal("eda", {
    settings: {
      set,
      resolve: async (key: SettingKey) => {
        if (key === "gitEngine" && saved) {
          await refresh.promise;
          return ok({ ...builtInSetting(key), value: "system" });
        }
        return ok(builtInSetting(key));
      },
    },
  });
  const previous = usePreferencesStore.getState();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const radio = (value: string) =>
    container.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
  try {
    await act(async () => root.render(<GitEngineSettings />));
    expect(radio("bundled").checked).toBe(true);
    await act(async () => radio("system").click());
    expect(set).toHaveBeenCalledWith("gitEngine", { kind: "application" }, "system");
    expect(radio("system").checked).toBe(true);

    await act(async () => write.resolve());
    expect(radio("system").checked).toBe(true);
    await act(async () => refresh.resolve());
    expect(radio("system").checked).toBe(true);

    await act(async () => radio("custom").click());
    expect(radio("custom").checked).toBe(true);
    await act(async () => failedWrite.resolve());
    expect(radio("system").checked).toBe(true);
    expect(usePreferencesStore.getState().error?.message).toBe(failure.message);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    usePreferencesStore.setState(previous);
    vi.unstubAllGlobals();
  }
});

it("refreshes the displayed Git engine and pull strategy when preferences change elsewhere", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let changed = false;
  const resolve = async (key: SettingKey) => {
    const setting = builtInSetting(key);
    if (changed && key === "gitEngine") return ok({ ...setting, value: "system" });
    if (changed && key === "pullStrategy") return ok({ ...setting, value: "rebase" });
    return ok(setting);
  };
  vi.stubGlobal("eda", { settings: { resolve } });
  const app = useAppStore.getState();
  const preferences = usePreferencesStore.getState();
  useAppStore.setState({
    activeIdentity: {
      id: "profile",
      name: "Work",
      gitName: "Test",
      gitEmail: "test@example.com",
      hue: 210,
      signing: { format: "none", signCommits: false },
      createdAt: "now",
      updatedAt: "now",
    },
    selectedRepositoryId: "repo",
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <>
          <GitEngineSettings />
          <RepositoryPullSettings repositoryId="repo" />
        </>,
      ),
    );
    expect(container.querySelector<HTMLInputElement>('input[value="bundled"]')?.checked).toBe(true);
    expect(container.querySelector('[role="combobox"]')?.textContent).toContain("Fast-forward");
    changed = true;
    await act(async () => usePreferencesStore.setState({ values: { ...preferences.values } }));
    expect(container.querySelector<HTMLInputElement>('input[value="system"]')?.checked).toBe(true);
    expect(container.querySelector('[role="combobox"]')?.textContent).toContain("Rebase");
  } finally {
    await act(async () => root.unmount());
    useAppStore.setState(app);
    usePreferencesStore.setState(preferences);
    vi.unstubAllGlobals();
  }
});
