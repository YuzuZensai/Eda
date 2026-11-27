import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ok } from "@shared/errors";
import {
  builtInSetting,
  SETTING_DEFINITIONS,
  type SettingKey,
  type SettingScope,
  type SettingValues,
} from "@shared/preferences/settings";
import { HistoryColumnsSettings } from "@renderer/features/settings/appearance/HistoryColumnsSettings";
import { usePreferencesStore } from "@renderer/stores/preferences-store";
import { useAppStore } from "@renderer/stores/app-store";

let root: Root;
let container: HTMLDivElement;
let previous: ReturnType<typeof usePreferencesStore.getState>;
let previousApp: ReturnType<typeof useAppStore.getState>;
let visible: SettingValues["historyVisibleColumns"];
let source: SettingScope;
const save = vi.fn(
  async (key: SettingKey, scope: SettingScope, value: SettingValues[SettingKey]) => {
    if (
      key === "historyVisibleColumns" &&
      SETTING_DEFINITIONS.historyVisibleColumns.validate(value)
    ) {
      visible = value;
      source = scope;
      const store = usePreferencesStore.getState();
      usePreferencesStore.setState({
        values: {
          ...store.values,
          historyVisibleColumns: { ...builtInSetting("historyVisibleColumns"), value, source },
        },
      });
    }
    return true;
  },
);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  previous = usePreferencesStore.getState();
  previousApp = useAppStore.getState();
  visible = ["author", "date", "sha"];
  source = { kind: "application" };
  save.mockClear();
  vi.stubGlobal("eda", {
    settings: {
      resolve: vi.fn(async (key: SettingKey) =>
        ok(
          key === "historyVisibleColumns"
            ? { ...builtInSetting("historyVisibleColumns"), value: visible, source }
            : builtInSetting(key),
        ),
      ),
    },
  });
  useAppStore.setState({
    switchingIdentityId: null,
    activeIdentity: {
      id: "work",
      name: "Work",
      gitName: "Eda",
      gitEmail: "work@example.test",
      hue: 210,
      signing: { format: "none", signCommits: false },
      createdAt: "now",
      updatedAt: "now",
    },
  });
  usePreferencesStore.setState({ set: save, saving: false });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<HistoryColumnsSettings />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  usePreferencesStore.setState(previous);
  useAppStore.setState(previousApp);
  vi.unstubAllGlobals();
});

const checkbox = (label: string) =>
  [...container.querySelectorAll("label")]
    .find((item) => item.textContent === label)!
    .querySelector<HTMLInputElement>("input")!;

it("saves visibility globally and preserves the other column choices", async () => {
  await act(async () => checkbox("Author").click());
  expect(save).toHaveBeenLastCalledWith("historyVisibleColumns", { kind: "application" }, [
    "date",
    "sha",
  ]);
  expect(checkbox("Author").checked).toBe(false);
  expect(checkbox("Date").checked).toBe(true);
  expect(checkbox("SHA").checked).toBe(true);
  await act(async () => checkbox("Date").click());
  await act(async () => checkbox("SHA").click());
  expect(save).toHaveBeenLastCalledWith("historyVisibleColumns", { kind: "application" }, []);
  expect(container.querySelectorAll('input[type="range"]')).toHaveLength(0);
});

it("updates visibility while saving and restores it when the write fails", async () => {
  let finish!: (saved: boolean) => void;
  save.mockReturnValueOnce(new Promise<boolean>((resolve) => (finish = resolve)));
  await act(async () => checkbox("Author").click());
  expect(checkbox("Author").checked).toBe(false);
  await act(async () => finish(false));
  expect(checkbox("Author").checked).toBe(true);
  expect(visible).toEqual(["author", "date", "sha"]);
});

it("saves customized visibility for the active profile", async () => {
  source = { kind: "profile", profileId: "work" };
  await act(async () => root.render(<HistoryColumnsSettings key="profile" owner="profile" />));
  await act(async () => checkbox("Author").click());
  expect(save).toHaveBeenLastCalledWith(
    "historyVisibleColumns",
    { kind: "profile", profileId: "work" },
    ["date", "sha"],
  );
  expect(checkbox("Author").checked).toBe(false);
  expect(container.querySelector('[aria-label="Column visibility source"]')?.textContent).toContain(
    "Customize",
  );
});
